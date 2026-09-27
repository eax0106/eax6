from __future__ import annotations

import os
from concurrent import futures

import grpc
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from alter.adsq.v1 import adsq_pb2_grpc
from src.config import get_settings
from src.ingestion.embedding_client import GrpcEmbeddingClient
from src.service_auth import SyncServiceAuthInterceptor, assert_configured_at_startup

from .grpc_service import AdsqGrpcService
from .repository import SqlAlchemyRetrievalRepository
from .service import RetrievalService


def serve() -> None:
    settings = get_settings()
    # A missing credential is a boot failure, never a per-RPC surprise.
    assert_configured_at_startup()
    engine = create_engine(settings.ads_db_url_sync, pool_pre_ping=True)
    embeddings = GrpcEmbeddingClient(settings.model_gateway_grpc_target)
    service = RetrievalService(
        repository=SqlAlchemyRetrievalRepository(
            sessionmaker(bind=engine, class_=Session, expire_on_commit=False)
        ),
        embeddings=embeddings,
        max_concurrency=settings.ads_q_max_concurrency,
    )
    # Every RPC requires the internal service credential -- interceptor, not
    # per-RPC checks, so a new RPC cannot forget it.
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=16),
        interceptors=[SyncServiceAuthInterceptor()],
    )
    adsq_pb2_grpc.add_AdsqServiceServicer_to_server(  # type: ignore[no-untyped-call]
        AdsqGrpcService(service), server
    )
    # 50050, not 50057: sandbox-service's SANDBOX_GRPC_BIND_ADDRESS also
    # defaults to 0.0.0.0:50057, so on a single host -- the documented local
    # stack, and any one-VPS deployment -- whichever of the two started
    # second could not bind. Real service surfaces now occupy 50050-50069
    # contiguously; 50070 upwards belongs to the eval harness, which binds
    # its own servers on ports it chooses per run.
    server.add_insecure_port(os.environ.get("ADS_Q_GRPC_BIND_ADDRESS", "0.0.0.0:50050"))
    server.start()
    try:
        server.wait_for_termination()
    finally:
        server.stop(grace=5)
        embeddings.close()
        engine.dispose()


if __name__ == "__main__":
    serve()

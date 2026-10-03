from __future__ import annotations

import asyncio
import os

import grpc
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from alter.memory.v1 import memory_pb2_grpc
from src.config import get_settings
from src.m2m_auth import lazy_auth0_m2m_token_provider_from_settings
from src.memory_grpc_service import MemoryGrpcService
from src.memory_learning.extraction import MemoryLearningKernel
from src.memory_learning.orchestration_client import HttpxOrchestrationRunClient
from src.memory_learning.repository import SqlAlchemyMemoryCandidateRepository
from src.memory_settings.redaction import GrpcMemoryRedactor
from src.memory_settings.repository import MemorySettingsRepository
from src.policy_store.ads_core_client import HttpxAdsCoreMemoryClient
from src.policy_store.repository import SqlAlchemyPolicyStoreRepository
from src.policy_store.service import PolicyStoreService
from src.service_auth import ServiceAuthInterceptor, assert_configured_at_startup


async def serve() -> None:
    assert_configured_at_startup()
    settings = get_settings()
    tenant_engine = create_engine(settings.policy_db_url_sync, pool_pre_ping=True)
    system_engine = create_engine(settings.policy_db_system_url_sync, pool_pre_ping=True)
    tenant_sessions = sessionmaker(tenant_engine, class_=Session, expire_on_commit=False)
    system_sessions = sessionmaker(system_engine, class_=Session, expire_on_commit=False)
    orchestration = HttpxOrchestrationRunClient(
        str(settings.orchestration_service_base_url),
        settings.orchestration_service_timeout_seconds,
        access_token_provider=lazy_auth0_m2m_token_provider_from_settings(settings),
    )
    ads_core = HttpxAdsCoreMemoryClient(
        str(settings.ads_core_base_url),
        settings.ads_core_timeout_seconds,
        access_token_provider=lazy_auth0_m2m_token_provider_from_settings(settings),
    )
    redactor = GrpcMemoryRedactor(
        settings.model_gateway_grpc_target, lazy_auth0_m2m_token_provider_from_settings(settings)
    )
    service = MemoryGrpcService(
        MemoryLearningKernel(
            orchestration,
            SqlAlchemyMemoryCandidateRepository(tenant_sessions),
            redactor.redact,
        ),
        PolicyStoreService(
            SqlAlchemyPolicyStoreRepository(tenant_sessions, system_sessions),
            ads_core,
        ),
        MemorySettingsRepository(tenant_sessions),
        redactor.redact,
    )
    # Interceptor rather than a per-RPC check: MemoryService.UpdatePolicy,
    # PromoteMemory and ProposeWriteback all took their tenant from the request
    # message with no credential behind it.
    server = grpc.aio.server(interceptors=[ServiceAuthInterceptor()])
    memory_pb2_grpc.add_MemoryServiceServicer_to_server(service, server)  # type: ignore[no-untyped-call]
    server.add_insecure_port(os.environ.get("MEMORY_GRPC_BIND_ADDRESS", "0.0.0.0:50060"))
    await server.start()
    try:
        await server.wait_for_termination()
    finally:
        await server.stop(grace=5)
        await orchestration.close()
        await ads_core.close()
        await redactor.close()
        tenant_engine.dispose()
        system_engine.dispose()


if __name__ == "__main__":
    asyncio.run(serve())

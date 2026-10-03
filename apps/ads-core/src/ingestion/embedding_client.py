from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

import grpc

from alter.modelgw.v1 import modelgw_pb2, modelgw_pb2_grpc
from src.m2m_auth import AccessTokenProvider

EmbeddingDimensions = Literal[512, 1024]


class EmbeddingTransportError(RuntimeError):
    pass


@dataclass(frozen=True)
class EmbeddingResult:
    vector: tuple[float, ...]
    model_id: str


class EmbeddingClient(Protocol):
    def embed(
        self, *, tenant_id: str, text: str, dimensions: EmbeddingDimensions
    ) -> EmbeddingResult: ...


class GrpcEmbeddingClient:
    """Real, synchronous Python caller over alter.modelgw.v1.ModelgwService.Embed.

    Synchronous (not grpc.aio) to match the rest of this pipeline --
    IngestionPipeline.ingest() and SqlAlchemyIngestionRepository are both
    plain sync code, run off the event loop via run_in_threadpool
    (router.py); introducing an async client here would need the whole
    pipeline to become async for no real benefit.

    Before this RPC existed (KNOW-5), model-gateway's real Titan embedding
    provider was only ever reachable from its own internal semantic-cache
    path; intelligence-service's embedding_client.py (PLAN-7/HEAL-6) had to
    ship a NotImplementedEmbeddingClient stub for exactly this reason. This
    client closes that gap for ads-core specifically -- it does not retrofit
    intelligence-service's own stub, which is a separate, disclosed follow-up.
    """

    def __init__(
        self,
        target: str,
        *,
        timeout_seconds: float = 15,
        channel: grpc.Channel | None = None,
        access_token_provider: AccessTokenProvider | None = None,
    ) -> None:
        self._channel = channel or grpc.insecure_channel(target)
        self._owns_channel = channel is None
        self._stub = modelgw_pb2_grpc.ModelgwServiceStub(  # type: ignore[no-untyped-call]
            self._channel
        )
        self._timeout_seconds = timeout_seconds
        self._access_token_provider = access_token_provider

    def close(self) -> None:
        if self._owns_channel:
            self._channel.close()

    def redact(self, tenant_id: str, content: str) -> str:
        try:
            if self._access_token_provider is None:
                raise EmbeddingTransportError("Redaction caller identity is unavailable")
            response = self._stub.Redact(
                modelgw_pb2.RedactRequest(tenant_id=tenant_id, content=content),
                metadata=self._access_token_provider.metadata(),
                timeout=self._timeout_seconds,
            )
            content = response.redacted_content
            if not isinstance(content, str):
                raise EmbeddingTransportError("Invalid redaction response")
            return content
        except Exception as error:
            raise EmbeddingTransportError("Redaction RPC call failed") from error

    def embed(
        self, *, tenant_id: str, text: str, dimensions: EmbeddingDimensions
    ) -> EmbeddingResult:
        try:
            kwargs: dict[str, object] = {"timeout": self._timeout_seconds}
            if self._access_token_provider is not None:
                kwargs["metadata"] = self._access_token_provider.metadata()
            response = self._stub.Embed(
                modelgw_pb2.EmbedRequest(
                    tenant_id=tenant_id,
                    text=text,
                    dimensions=dimensions,
                ),
                **kwargs,
            )
        except Exception as error:
            raise EmbeddingTransportError("Embed RPC call failed") from error
        vector = tuple(response.embedding)
        if len(vector) != dimensions:
            raise EmbeddingTransportError(
                f"Embed RPC returned {len(vector)} dimensions, expected {dimensions}"
            )
        return EmbeddingResult(vector=vector, model_id=response.model_id)

"""Embedding dependency for PLAN-7.

GrpcEmbeddingClient closes the transport gap this module used to flag as
missing: it calls the real, unmodified alter.modelgw.v1.ModelgwService.Embed
RPC (the same real RPC ads-core's own GrpcEmbeddingClient in
apps/ads-core/src/ingestion/embedding_client.py calls for ingestion embedding
-- that module's own docstring named this exact gap as a separate, disclosed
follow-up). Async here (unlike ads-core's sync client) to match
SelectionBindingEngine.bind's own async call site and this service's existing
async gRPC convention (see ads_client/client.py's GrpcAdsClient).
"""

import math
from collections.abc import Sequence
from typing import Any, NamedTuple, Protocol, runtime_checkable

from src.m2m_auth import AccessTokenProvider

CAPABILITY_QUERY_DIMENSIONS = 512


class EmbeddingResult(NamedTuple):
    """A capability-query embedding and the model that produced it.

    model_id is the identifier the Embed RPC returned (EmbedResponse.model_id,
    field 3 of alter.modelgw.v1.EmbedResponse). It is recorded on every stored
    capability_embeddings row so selection can fail closed: a query vector is
    only ever compared against stored vectors produced by the same model,
    because vectors live in the embedding space of whatever produced them.
    """

    vector: Sequence[float]
    model_id: str


@runtime_checkable
class EmbeddingClient(Protocol):
    async def embed(self, *, tenant_id: str, text: str) -> EmbeddingResult:
        """Return one 512-dimensional capability-query vector and its model."""
        ...


class EmbeddingTransportUnavailableError(RuntimeError):
    """Raised by NotImplementedEmbeddingClient and GrpcEmbeddingClient alike
    (transport down/unreachable) -- see their own docstrings."""


class NotImplementedEmbeddingClient:
    """Honest default for tests and any deployment without a reachable Model
    Gateway. The capability-similarity ranked-match path in
    SelectionBindingEngine.bind fails closed with a clear, specific error
    instead of silently having no default embedding_client at all. The
    `preferred_agent_id` path (SelectionBindingEngine._bind_preferred) never
    calls this and works today regardless.
    """

    async def embed(self, *, tenant_id: str, text: str) -> EmbeddingResult:
        raise EmbeddingTransportUnavailableError(
            "Python-to-EmbeddingProvider transport is not configured for this "
            "deployment -- only preferred_agent_id-based binding is available"
        )


class GrpcEmbeddingClient:
    """Real, async caller over alter.modelgw.v1.ModelgwService.Embed.

    Mirrors GrpcAdsClient's deferred-import pattern (ads_client/client.py) so
    the optional grpc/generated-stub dependency is only imported when a real
    client is actually constructed, not at module import time.
    """

    def __init__(
        self,
        target: str,
        *,
        timeout_seconds: float = 15.0,
        channel: Any | None = None,
        access_token_provider: AccessTokenProvider | None = None,
    ) -> None:
        grpc, modelgw_pb2, modelgw_pb2_grpc = _load_grpc_bindings()
        self._grpc = grpc
        self._modelgw_pb2 = modelgw_pb2
        self._timeout_seconds = timeout_seconds
        self._channel = channel or grpc.aio.insecure_channel(target)
        self._stub = modelgw_pb2_grpc.ModelgwServiceStub(self._channel)
        self._access_token_provider = access_token_provider

    async def close(self) -> None:
        await self._channel.close()

    async def embed(self, *, tenant_id: str, text: str) -> EmbeddingResult:
        try:
            kwargs: dict[str, object] = {
                "timeout": self._timeout_seconds,
            }
            if self._access_token_provider is not None:
                kwargs["metadata"] = self._access_token_provider.metadata()
            response = await self._stub.Embed(
                self._modelgw_pb2.EmbedRequest(
                    tenant_id=tenant_id,
                    text=text,
                    dimensions=CAPABILITY_QUERY_DIMENSIONS,
                ),
                **kwargs,
            )
        except Exception as exc:
            raise EmbeddingTransportUnavailableError(
                "Embed RPC call to Model Gateway failed"
            ) from exc
        return EmbeddingResult(
            vector=tuple(response.embedding),
            model_id=response.model_id,
        )


def _load_grpc_bindings() -> tuple[Any, Any, Any]:
    """Defer the optional transport imports until the production client starts."""
    try:
        import grpc

        from alter.modelgw.v1 import modelgw_pb2, modelgw_pb2_grpc
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "GrpcEmbeddingClient requires the intelligence-service dependencies"
        ) from exc
    return grpc, modelgw_pb2, modelgw_pb2_grpc


class EmbeddingResultError(ValueError):
    pass


def embedding_vector_literal(values: Sequence[float]) -> str:
    vector = list(values)
    if len(vector) != CAPABILITY_QUERY_DIMENSIONS:
        raise EmbeddingResultError(
            f"embedding must contain exactly {CAPABILITY_QUERY_DIMENSIONS} values"
        )
    if any(
        isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
        for value in vector
    ):
        raise EmbeddingResultError("embedding values must be finite numbers")
    if not any(value != 0 for value in vector):
        raise EmbeddingResultError("embedding must not be the zero vector")
    return "[" + ",".join(str(float(value)) for value in vector) + "]"

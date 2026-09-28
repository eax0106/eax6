"""Moved to src.agent_contracts.embedding_client (task C7): the embedding port
is shared by Selection & Binding and the Agent Factory, so it lives in neither.
Re-exported here so existing imports keep working."""

from src.agent_contracts.embedding_client import (
    CAPABILITY_QUERY_DIMENSIONS,
    EmbeddingClient,
    EmbeddingResult,
    EmbeddingTransportUnavailableError,
    GrpcEmbeddingClient,
    NotImplementedEmbeddingClient,
)

__all__ = [
    "CAPABILITY_QUERY_DIMENSIONS",
    "EmbeddingClient",
    "EmbeddingResult",
    "EmbeddingTransportUnavailableError",
    "GrpcEmbeddingClient",
    "NotImplementedEmbeddingClient",
]

"""L4 agent contracts shared by Selection & Binding and the Agent Factory (C7)."""

from src.agent_contracts.embedding_client import (
    EmbeddingClient,
    EmbeddingResult,
    EmbeddingResultError,
    embedding_vector_literal,
)
from src.agent_contracts.types import NoAgentMatch, NoMatchReason

__all__ = [
    "EmbeddingClient",
    "EmbeddingResult",
    "EmbeddingResultError",
    "NoAgentMatch",
    "NoMatchReason",
    "embedding_vector_literal",
]

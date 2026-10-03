from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

MemoryNamespaceKind = Literal["business_rule", "preference", "project_fact", "constraint"]


class _MemoryNamespaceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class RecordMemoryNamespaceRequest(_MemoryNamespaceModel):
    tenant_id: str
    scope_id: str
    project_ref: str | None = None
    kind: MemoryNamespaceKind
    statement: str = Field(min_length=1, max_length=8_000)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    provenance: dict[str, object]


class RecordMemoryNamespaceResponse(_MemoryNamespaceModel):
    id: str
    skipped: bool = False


class MemoryFact(_MemoryNamespaceModel):
    id: str
    kind: MemoryNamespaceKind
    statement: str
    confidence: float | None
    provenance: dict[str, object]

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

IngestionStage = Literal[
    "received",
    "validated",
    "scanned",
    "normalized",
    "deduplicated",
    "chunked",
    "indexed",
    "failed",
]


class _StrictFrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class IngestionError(_StrictFrozenModel):
    code: str
    detail: str


class CreateSourceRequest(_StrictFrozenModel):
    """Connector-backed source shape used by the documented ADS endpoint."""

    connector: Literal["drive", "shopify"]
    settings: dict[str, object] = Field(default_factory=dict)


class SourceResponse(_StrictFrozenModel):
    id: str
    scope_id: str
    connector: str
    status: str
    created: Literal[True] = True


class IngestionJobResponse(_StrictFrozenModel):
    ingestion_job_id: str
    source_id: str
    # ENGINE-FIX-B5-2: additive -- owning workspace (source_id -> sources
    # .scope_id -> scopes.workspace_id), consumed by platform-api's
    # workspace-bound RBAC resolver so ingestion-job reads can be checked
    # against the workspace that owns them instead of any workspace in the
    # tenant. Optional (unlike the read route's own field) so the several
    # other call sites building this response from a bare StoredIngestionJob
    # (uploads/presign, uploads/complete, sync) aren't forced to plumb a
    # tenant-scoped workspace lookup through paths that don't otherwise need
    # one -- only GET /ingestion/jobs/{id} populates it.
    workspace_id: str | None = None
    stage: IngestionStage
    stats: dict[str, object]
    error: IngestionError | None
    created_at: datetime
    completed_at: datetime | None


class SourceDetailResponse(_StrictFrozenModel):
    """Real source read -- unlike ResourceWorkspaceResponse below, this is
    the actual resource, not just an RBAC-resolution stub. Served from a
    different path (`/detail`) so it never collides with or changes
    GET /sources/{source_id}'s existing contract (see that route's
    docstring and ENGINE-FIX-B5-2)."""

    id: str
    scope_id: str
    workspace_id: str
    kind: str
    provider: str | None
    sync_config: dict[str, object] | None
    status: str | None
    last_sync_at: datetime | None
    document_count: int
    chunk_count: int
    created_at: datetime
    updated_at: datetime


class SourcePageInfo(_StrictFrozenModel):
    next_cursor: str | None
    has_more: bool


class SourcePageResponse(_StrictFrozenModel):
    data: tuple[SourceDetailResponse, ...]
    page: SourcePageInfo


class DocumentSummaryResponse(_StrictFrozenModel):
    """One document in a workspace's knowledge list: what it is and where it
    came from, never its content (chunks stay behind retrieval)."""

    id: str
    source_id: str
    kind: str
    title: str | None
    status: str | None
    current_version: int
    created_at: datetime
    updated_at: datetime


class DocumentPageResponse(_StrictFrozenModel):
    data: tuple[DocumentSummaryResponse, ...]
    page: SourcePageInfo


class ResourceWorkspaceResponse(_StrictFrozenModel):
    """Minimal shape for RBAC workspace-ownership resolution only (ENGINE-
    FIX-B5-2) -- not a general source/document read API. Sources and
    documents have no other route that always returns 200 with a non-null
    body when the resource exists (their /permissions routes return `null`
    for an unset-but-real resource), so this is a dedicated, narrow
    endpoint rather than overloading that nullable shape. See platform-api's
    param-workspace.resolver.ts."""

    id: str
    workspace_id: str


class ReindexResponse(_StrictFrozenModel):
    document_id: str
    previous_document_version: int
    document_version: int
    embedding_version: str
    chunk_count: int


@dataclass(frozen=True)
class IngestionPayload:
    tenant_id: str
    source_id: str
    content_type: str
    content: bytes


class PresignUploadRequest(_StrictFrozenModel):
    source_id: str
    content_type: str


class PresignUploadResponse(_StrictFrozenModel):
    ingestion_job_id: str
    upload_url: str
    upload_fields: dict[str, str]
    upload_key: str
    max_content_bytes: int
    expires_at: datetime


class CompleteUploadRequest(_StrictFrozenModel):
    ingestion_job_id: str
    source_id: str
    upload_key: str


@dataclass(frozen=True)
class ScanResult:
    accepted: bool
    scanned_by: str
    limitations: tuple[str, ...]
    error_code: str | None = None

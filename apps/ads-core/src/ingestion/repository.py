from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol, cast

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session, sessionmaker

from src.db.ids import new_prefixed_id, validate_prefixed_id
from src.db.models import Chunk, Document, DocumentVersion, IngestionJob, Scope, Source

from .models import IngestionStage
from .permissions import DocumentPermissions, DocumentPermissionsPatch, SourcePermissions

_SET_TENANT = text("SELECT set_config('app.current_tenant_id', :tenant_id, true)")
_LOCK_CONTENT = text(
    "SELECT pg_advisory_xact_lock(hashtextextended(:idempotency_key, 0))"
)


class SourceNotFoundError(LookupError):
    pass


class IngestionJobNotFoundError(LookupError):
    pass


class DocumentNotFoundError(LookupError):
    pass


class ReindexConflictError(RuntimeError):
    pass


@dataclass(frozen=True)
class StoredIngestionJob:
    ingestion_job_id: str
    source_id: str
    stage: IngestionStage
    stats: dict[str, object]
    error: dict[str, object] | None
    created_at: datetime
    completed_at: datetime | None


@dataclass(frozen=True)
class StoredSource:
    source_id: str
    scope_id: str
    connector: str
    status: str


@dataclass(frozen=True)
class StoredDocumentSummary:
    document_id: str
    source_id: str
    kind: str
    title: str | None
    status: str | None
    current_version: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class StoredSourceDetail:
    """A source row plus the fields the platform-web read UI actually needs
    (document_count/chunk_count) that have no columns of their own on
    `sources` -- these are real COUNT(*) aggregates against `documents`/
    `chunks`, computed here rather than faked. `workspace_id` is resolved
    via `scopes` (sources have no workspace_id column directly)."""

    source_id: str
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


@dataclass(frozen=True)
class EmbeddedChunk:
    chunk_id: str
    seq: int
    text: str
    embedding: tuple[float, ...]
    embedding_provider: str
    embedding_model: str
    embedding_version: str


@dataclass(frozen=True)
class StoredDocumentContent:
    document_id: str
    scope_id: str
    document_version: int
    content_ref: str
    normalized_ref: str | None
    content_type: str


@dataclass(frozen=True)
class StoredReindex:
    document_id: str
    previous_document_version: int
    document_version: int
    embedding_version: str
    chunk_count: int


class IngestionRepository(Protocol):
    def create_source(
        self,
        *,
        tenant_uuid: str,
        workspace_id: str,
        connector: str,
        settings: dict[str, object],
    ) -> StoredSource: ...

    def reserve_upload(
        self,
        *,
        ingestion_job_id: str,
        tenant_uuid: str,
        source_id: str,
        upload_key: str,
        content_type: str,
    ) -> StoredIngestionJob: ...

    def receive(
        self,
        *,
        ingestion_job_id: str,
        tenant_uuid: str,
        source_id: str,
        content_hash: str,
        content_bytes: int,
        content_type: str,
    ) -> StoredIngestionJob: ...

    def transition(
        self,
        *,
        tenant_uuid: str,
        ingestion_job_id: str,
        expected_stage: IngestionStage,
        target_stage: IngestionStage,
        stats: dict[str, object],
    ) -> StoredIngestionJob: ...

    def fail(
        self,
        *,
        tenant_uuid: str,
        ingestion_job_id: str,
        expected_stage: IngestionStage,
        error: dict[str, object],
        stats: dict[str, object] | None = None,
    ) -> StoredIngestionJob: ...

    def complete_deduplication(
        self,
        *,
        tenant_uuid: str,
        ingestion_job_id: str,
        source_id: str,
        candidate_document_id: str,
        normalized_content_hash: str,
        content_ref: str,
        normalized_ref: str,
        provenance: dict[str, object],
        permissions: dict[str, object],
    ) -> StoredIngestionJob: ...

    def get(
        self,
        *,
        tenant_uuid: str,
        ingestion_job_id: str,
    ) -> StoredIngestionJob: ...

    def get_source_workspace_id(self, *, tenant_uuid: str, source_id: str) -> str: ...

    def list_sources(
        self,
        *,
        tenant_uuid: str,
        workspace_id: str,
        cursor: str | None,
        limit: int,
    ) -> tuple[list[StoredSourceDetail], bool]: ...

    def get_source_detail(
        self, *, tenant_uuid: str, source_id: str
    ) -> StoredSourceDetail: ...

    def list_documents(
        self,
        *,
        tenant_uuid: str,
        workspace_id: str,
        source_id: str | None,
        cursor: str | None,
        limit: int,
    ) -> tuple[list[StoredDocumentSummary], bool]: ...

    def get_document_workspace_id(self, *, tenant_uuid: str, document_id: str) -> str: ...

    def get_ingestion_job_workspace_id(
        self, *, tenant_uuid: str, ingestion_job_id: str
    ) -> str: ...

    def mark_indexed_as_duplicate(
        self, *, tenant_uuid: str, ingestion_job_id: str
    ) -> StoredIngestionJob: ...

    def create_chunks_and_index(
        self,
        *,
        tenant_uuid: str,
        ingestion_job_id: str,
        scope_id: str,
        document_id: str,
        document_version: int,
        chunks: Sequence[EmbeddedChunk],
    ) -> StoredIngestionJob: ...

    def get_current_document_content(
        self, *, tenant_uuid: str, document_id: str
    ) -> StoredDocumentContent: ...

    def activate_reindex(
        self,
        *,
        tenant_uuid: str,
        document_id: str,
        expected_document_version: int,
        chunks: Sequence[EmbeddedChunk],
    ) -> StoredReindex: ...


class SqlAlchemyIngestionRepository:
    def __init__(self, sessions: sessionmaker[Session]) -> None:
        self._sessions = sessions

    def create_source(
        self,
        *,
        tenant_uuid: str,
        workspace_id: str,
        connector: str,
        settings: dict[str, object],
    ) -> StoredSource:
        validate_prefixed_id("ws", workspace_id)
        provider = {"drive": "google_drive", "shopify": "shopify"}.get(connector)
        if provider is None:
            raise ValueError("connector must be drive or shopify")

        source_id = new_prefixed_id("src")
        scope_id = new_prefixed_id("scp")
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            session.add(
                Scope(
                    id=scope_id,
                    tenant_id=tenant_uuid,
                    workspace_id=workspace_id.removeprefix("ws_"),
                )
            )
            session.add(
                Source(
                    id=source_id,
                    tenant_id=tenant_uuid,
                    scope_id=scope_id,
                    kind="connector",
                    provider=provider,
                    sync_config=settings,
                    status="active",
                )
            )
        return StoredSource(
            source_id=source_id,
            scope_id=scope_id,
            connector=connector,
            status="active",
        )

    def receive(
        self,
        *,
        ingestion_job_id: str,
        tenant_uuid: str,
        source_id: str,
        content_hash: str,
        content_bytes: int,
        content_type: str,
    ) -> StoredIngestionJob:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            session.execute(
                _LOCK_CONTENT,
                {
                    "idempotency_key": (
                        f"ads-ingestion-stage1:{tenant_uuid}:{source_id}:{content_hash}"
                    )
                },
            )
            source_exists = session.scalar(
                select(Source.id).where(
                    Source.tenant_id == tenant_uuid,
                    Source.id == source_id,
                )
            )
            if source_exists is None:
                raise SourceNotFoundError("Source does not exist for requesting tenant")

            reserved = session.scalar(
                select(IngestionJob).where(
                    IngestionJob.tenant_id == tenant_uuid,
                    IngestionJob.id == ingestion_job_id,
                )
            )
            if reserved is not None:
                if reserved.source_id != source_id or reserved.stage != "received":
                    raise ValueError("Reserved ingestion job cannot accept this upload")
                current_stats = dict(reserved.stats or {})
                current_stats.update(
                    {
                        "content_hash": content_hash,
                        "content_bytes": content_bytes,
                        "content_type": content_type,
                        "upload_pending": False,
                    }
                )
                reserved.stats = current_stats
                session.flush()
                return self._stored(reserved)

            existing = session.scalar(
                select(IngestionJob).where(
                    IngestionJob.tenant_id == tenant_uuid,
                    IngestionJob.source_id == source_id,
                    IngestionJob.stats["content_hash"].astext == content_hash,
                )
            )
            if existing is not None:
                return self._stored(existing)

            job = IngestionJob(
                id=ingestion_job_id,
                tenant_id=tenant_uuid,
                source_id=source_id,
                stage="received",
                stats={
                    "content_hash": content_hash,
                    "content_bytes": content_bytes,
                    "content_type": content_type,
                    "stage_history": ["received"],
                },
                error=None,
                completed_at=None,
            )
            session.add(job)
            session.flush()
            return self._stored(job)

    def reserve_upload(
        self,
        *,
        ingestion_job_id: str,
        tenant_uuid: str,
        source_id: str,
        upload_key: str,
        content_type: str,
    ) -> StoredIngestionJob:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            source_exists = session.scalar(
                select(Source.id).where(
                    Source.tenant_id == tenant_uuid,
                    Source.id == source_id,
                )
            )
            if source_exists is None:
                raise SourceNotFoundError("Source does not exist for requesting tenant")
            job = IngestionJob(
                id=ingestion_job_id,
                tenant_id=tenant_uuid,
                source_id=source_id,
                stage="received",
                stats={
                    "content_type": content_type,
                    "upload_key": upload_key,
                    "upload_pending": True,
                    "stage_history": ["received"],
                },
                error=None,
                completed_at=None,
            )
            session.add(job)
            session.flush()
            return self._stored(job)

    def transition(
        self,
        *,
        tenant_uuid: str,
        ingestion_job_id: str,
        expected_stage: IngestionStage,
        target_stage: IngestionStage,
        stats: dict[str, object],
    ) -> StoredIngestionJob:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            job = self._get(session, tenant_uuid, ingestion_job_id, for_update=True)
            if job.stage != expected_stage:
                return self._stored(job)
            current_stats = dict(job.stats or {})
            history = list(cast(list[object], current_stats.get("stage_history", [])))
            history.append(target_stage)
            current_stats.update(stats)
            current_stats["stage_history"] = history
            job.stats = current_stats
            job.stage = target_stage
            session.flush()
            return self._stored(job)

    def fail(
        self,
        *,
        tenant_uuid: str,
        ingestion_job_id: str,
        expected_stage: IngestionStage,
        error: dict[str, object],
        stats: dict[str, object] | None = None,
    ) -> StoredIngestionJob:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            job = self._get(session, tenant_uuid, ingestion_job_id, for_update=True)
            if job.stage != expected_stage:
                return self._stored(job)
            current_stats = dict(job.stats or {})
            history = list(cast(list[object], current_stats.get("stage_history", [])))
            history.append("failed")
            current_stats.update(stats or {})
            current_stats["stage_history"] = history
            job.stats = current_stats
            job.error = error
            job.stage = "failed"
            job.completed_at = datetime.now(UTC)
            session.flush()
            return self._stored(job)

    def complete_deduplication(
        self,
        *,
        tenant_uuid: str,
        ingestion_job_id: str,
        source_id: str,
        candidate_document_id: str,
        normalized_content_hash: str,
        content_ref: str,
        normalized_ref: str,
        provenance: dict[str, object],
        permissions: dict[str, object],
    ) -> StoredIngestionJob:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            job = self._get(session, tenant_uuid, ingestion_job_id, for_update=True)
            if job.stage != "normalized":
                return self._stored(job)

            scope_id = session.scalar(
                select(Source.scope_id).where(
                    Source.tenant_id == tenant_uuid, Source.id == source_id
                )
            )
            if scope_id is None:
                raise SourceNotFoundError("Source does not exist for requesting tenant")

            existing_document_id = session.scalar(
                select(DocumentVersion.document_id)
                .join(Document, Document.id == DocumentVersion.document_id)
                .where(
                    Document.tenant_id == tenant_uuid,
                    Document.scope_id == scope_id,
                    Document.source_id == source_id,
                    DocumentVersion.content_hash == normalized_content_hash,
                )
                .limit(1)
            )

            current_stats = dict(job.stats or {})
            history = list(cast(list[object], current_stats.get("stage_history", [])))
            history.append("deduplicated")

            if existing_document_id is not None:
                current_stats["deduplication"] = {
                    "is_duplicate": True,
                    "duplicate_of_document_id": existing_document_id,
                    "scope_id": scope_id,
                }
            else:
                session.add(
                    Document(
                        id=candidate_document_id,
                        tenant_id=tenant_uuid,
                        scope_id=scope_id,
                        source_id=source_id,
                        kind="file",
                        current_version=1,
                        permissions=permissions,
                        status="active",
                    )
                )
                session.flush()
                session.add(
                    DocumentVersion(
                        document_id=candidate_document_id,
                        version=1,
                        content_ref=content_ref,
                        content_hash=normalized_content_hash,
                        normalized_ref=normalized_ref,
                        provenance=provenance,
                        ingestion_job_id=ingestion_job_id,
                    )
                )
                current_stats["deduplication"] = {
                    "is_duplicate": False,
                    "document_id": candidate_document_id,
                    "scope_id": scope_id,
                }

            current_stats["stage_history"] = history
            job.stats = current_stats
            job.stage = "deduplicated"
            session.flush()
            return self._stored(job)

    def get(
        self,
        *,
        tenant_uuid: str,
        ingestion_job_id: str,
    ) -> StoredIngestionJob:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            job = self._get(session, tenant_uuid, ingestion_job_id, for_update=False)
            return self._stored(job)

    def get_source_workspace_id(self, *, tenant_uuid: str, source_id: str) -> str:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            workspace_id = session.execute(
                select(Scope.workspace_id)
                .join(Source, (Source.scope_id == Scope.id) & (Source.tenant_id == Scope.tenant_id))
                .where(Source.tenant_id == tenant_uuid, Source.id == source_id)
            ).scalar_one_or_none()
            if workspace_id is None:
                raise SourceNotFoundError("Source does not exist for requesting tenant")
            return workspace_id

    def list_sources(
        self,
        *,
        tenant_uuid: str,
        workspace_id: str,
        cursor: str | None,
        limit: int,
    ) -> tuple[list[StoredSourceDetail], bool]:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            bare_workspace = workspace_id.removeprefix("ws_")

            cursor_position: tuple[datetime, str] | None = None
            if cursor is not None:
                cursor_row = session.execute(
                    select(Source.created_at, Source.id).where(
                        Source.tenant_id == tenant_uuid, Source.id == cursor
                    )
                ).one_or_none()
                if cursor_row is None:
                    raise SourceNotFoundError(
                        "cursor does not belong to this tenant's sources"
                    )
                cursor_position = (cursor_row.created_at, cursor_row.id)

            document_counts = (
                select(
                    Document.source_id.label("source_id"),
                    func.count().label("document_count"),
                )
                .where(Document.tenant_id == tenant_uuid)
                .group_by(Document.source_id)
                .subquery()
            )
            chunk_counts = (
                select(
                    Document.source_id.label("source_id"),
                    func.count().label("chunk_count"),
                )
                .select_from(Chunk)
                .join(Document, Document.id == Chunk.document_id)
                .where(Chunk.tenant_id == tenant_uuid)
                .group_by(Document.source_id)
                .subquery()
            )
            statement = (
                select(Source, document_counts.c.document_count, chunk_counts.c.chunk_count)
                .join(
                    Scope,
                    (Source.scope_id == Scope.id) & (Source.tenant_id == Scope.tenant_id),
                )
                .outerjoin(document_counts, document_counts.c.source_id == Source.id)
                .outerjoin(chunk_counts, chunk_counts.c.source_id == Source.id)
                .where(Source.tenant_id == tenant_uuid, Scope.workspace_id == bare_workspace)
                .order_by(Source.created_at.desc(), Source.id.desc())
            )
            if cursor_position is not None:
                created_at, source_id = cursor_position
                statement = statement.where(
                    (Source.created_at < created_at)
                    | ((Source.created_at == created_at) & (Source.id < source_id))
                )
            rows = session.execute(statement.limit(limit + 1)).all()
            has_more = len(rows) > limit
            page = rows[:limit]
            sources = [
                StoredSourceDetail(
                    source_id=row.Source.id,
                    scope_id=row.Source.scope_id,
                    workspace_id=bare_workspace,
                    kind=row.Source.kind,
                    provider=row.Source.provider,
                    sync_config=row.Source.sync_config,
                    status=row.Source.status,
                    last_sync_at=row.Source.last_sync_at,
                    document_count=row.document_count or 0,
                    chunk_count=row.chunk_count or 0,
                    created_at=row.Source.created_at,
                    updated_at=row.Source.updated_at,
                )
                for row in page
            ]
            return sources, has_more

    def list_documents(
        self,
        *,
        tenant_uuid: str,
        workspace_id: str,
        source_id: str | None,
        cursor: str | None,
        limit: int,
    ) -> tuple[list[StoredDocumentSummary], bool]:
        """A workspace's documents, newest first, optionally for one source.
        Workspace comes through the document's scope, the same way sources
        resolve it."""
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            bare_workspace = workspace_id.removeprefix("ws_")
            statement = (
                select(Document)
                .join(
                    Scope,
                    (Document.scope_id == Scope.id) & (Document.tenant_id == Scope.tenant_id),
                )
                .where(Document.tenant_id == tenant_uuid, Scope.workspace_id == bare_workspace)
                .order_by(Document.created_at.desc(), Document.id.desc())
            )
            if source_id is not None:
                statement = statement.where(Document.source_id == source_id)
            if cursor is not None:
                cursor_row = session.execute(
                    select(Document.created_at, Document.id).where(
                        Document.tenant_id == tenant_uuid, Document.id == cursor
                    )
                ).one_or_none()
                if cursor_row is None:
                    raise DocumentNotFoundError(
                        "cursor does not belong to this tenant's documents"
                    )
                statement = statement.where(
                    (Document.created_at < cursor_row.created_at)
                    | (
                        (Document.created_at == cursor_row.created_at)
                        & (Document.id < cursor_row.id)
                    )
                )
            rows = session.execute(statement.limit(limit + 1)).scalars().all()
            has_more = len(rows) > limit
            return [
                StoredDocumentSummary(
                    document_id=row.id,
                    source_id=row.source_id,
                    kind=row.kind,
                    title=row.title,
                    status=row.status,
                    current_version=row.current_version,
                    created_at=row.created_at,
                    updated_at=row.updated_at,
                )
                for row in rows[:limit]
            ], has_more

    def get_source_detail(self, *, tenant_uuid: str, source_id: str) -> StoredSourceDetail:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            row = session.execute(
                select(Source, Scope.workspace_id)
                .join(
                    Scope,
                    (Source.scope_id == Scope.id) & (Source.tenant_id == Scope.tenant_id),
                )
                .where(Source.tenant_id == tenant_uuid, Source.id == source_id)
            ).one_or_none()
            if row is None:
                raise SourceNotFoundError("Source does not exist for requesting tenant")
            source, workspace_id = row
            document_count = (
                session.scalar(
                    select(func.count())
                    .select_from(Document)
                    .where(
                        Document.tenant_id == tenant_uuid,
                        Document.source_id == source_id,
                    )
                )
                or 0
            )
            chunk_count = (
                session.scalar(
                    select(func.count())
                    .select_from(Chunk)
                    .join(Document, Document.id == Chunk.document_id)
                    .where(
                        Chunk.tenant_id == tenant_uuid,
                        Document.source_id == source_id,
                    )
                )
                or 0
            )
            return StoredSourceDetail(
                source_id=source.id,
                scope_id=source.scope_id,
                workspace_id=workspace_id,
                kind=source.kind,
                provider=source.provider,
                sync_config=source.sync_config,
                status=source.status,
                last_sync_at=source.last_sync_at,
                document_count=document_count,
                chunk_count=chunk_count,
                created_at=source.created_at,
                updated_at=source.updated_at,
            )

    def get_document_workspace_id(self, *, tenant_uuid: str, document_id: str) -> str:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            document_scope_match = (Document.scope_id == Scope.id) & (
                Document.tenant_id == Scope.tenant_id
            )
            workspace_id = session.execute(
                select(Scope.workspace_id)
                .join(Document, document_scope_match)
                .where(Document.tenant_id == tenant_uuid, Document.id == document_id)
            ).scalar_one_or_none()
            if workspace_id is None:
                raise DocumentNotFoundError("Document does not exist for requesting tenant")
            return workspace_id

    def get_ingestion_job_workspace_id(self, *, tenant_uuid: str, ingestion_job_id: str) -> str:
        # Two hops: IngestionJob has no scope_id of its own, only source_id
        # (see IngestionJob's model docstring / ENGINE-FIX-B5-2 finding) --
        # so this joins through Source to reach Scope.workspace_id.
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            source_scope_match = (Source.scope_id == Scope.id) & (
                Source.tenant_id == Scope.tenant_id
            )
            job_source_match = (IngestionJob.source_id == Source.id) & (
                IngestionJob.tenant_id == Source.tenant_id
            )
            workspace_id = session.execute(
                select(Scope.workspace_id)
                .join(Source, source_scope_match)
                .join(IngestionJob, job_source_match)
                .where(
                    IngestionJob.tenant_id == tenant_uuid,
                    IngestionJob.id == ingestion_job_id,
                )
            ).scalar_one_or_none()
            if workspace_id is None:
                raise IngestionJobNotFoundError(
                    "Ingestion job does not exist for requesting tenant"
                )
            return workspace_id

    def get_document_permissions(
        self,
        *,
        tenant_uuid: str,
        document_id: str,
    ) -> DocumentPermissions | None:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            document = self._get_document(session, tenant_uuid, document_id)
            if document.permissions is None:
                return None
            return DocumentPermissions.model_validate(document.permissions)

    def update_document_permissions(
        self,
        *,
        tenant_uuid: str,
        document_id: str,
        patch: DocumentPermissionsPatch,
    ) -> DocumentPermissions:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            document = self._get_document(
                session,
                tenant_uuid,
                document_id,
                for_update=True,
            )
            current = (
                {}
                if document.permissions is None
                else DocumentPermissions.model_validate(document.permissions).model_dump(
                    mode="json"
                )
            )
            updated = DocumentPermissions.model_validate(
                {
                    **current,
                    **patch.model_dump(mode="json", exclude_none=True),
                }
            )
            document.permissions = updated.model_dump(mode="json")
            document.updated_at = datetime.now(UTC)
            session.flush()
            return updated

    def get_source_permissions(
        self,
        *,
        tenant_uuid: str,
        source_id: str,
    ) -> SourcePermissions | None:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            source = self._get_source(session, tenant_uuid, source_id)
            if source.permissions is None:
                return None
            return SourcePermissions.model_validate(source.permissions)

    def replace_source_permissions(
        self,
        *,
        tenant_uuid: str,
        source_id: str,
        permissions: SourcePermissions,
    ) -> SourcePermissions:
        """Full replace (PUT), not a merge -- the stored object is exactly the
        validated body, so a caller can never be surprised by a field it did
        not send surviving from an earlier write.
        """
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            source = self._get_source(session, tenant_uuid, source_id, for_update=True)
            source.permissions = permissions.model_dump(mode="json")
            source.updated_at = datetime.now(UTC)
            session.flush()
            return permissions

    def mark_indexed_as_duplicate(
        self, *, tenant_uuid: str, ingestion_job_id: str
    ) -> StoredIngestionJob:
        """Duplicate content: chunks/embeddings already exist for the original
        document. No new chunk rows -- disclosed via `indexing.reused_existing_
        chunks` rather than silently re-embedding (and re-billing) identical
        content."""
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            job = self._get(session, tenant_uuid, ingestion_job_id, for_update=True)
            if job.stage != "deduplicated":
                return self._stored(job)

            current_stats = dict(job.stats or {})
            history = list(cast(list[object], current_stats.get("stage_history", [])))
            history.extend(["chunked", "indexed"])
            current_stats["stage_history"] = history
            current_stats["indexing"] = {"chunk_count": 0, "reused_existing_chunks": True}
            job.stats = current_stats
            job.stage = "indexed"
            job.completed_at = datetime.now(UTC)
            session.flush()
            return self._stored(job)

    def create_chunks_and_index(
        self,
        *,
        tenant_uuid: str,
        ingestion_job_id: str,
        scope_id: str,
        document_id: str,
        document_version: int,
        chunks: Sequence[EmbeddedChunk],
    ) -> StoredIngestionJob:
        """One atomic transition: chunked -> indexed. There is no durable
        "chunked but not embedded" state, because chunks.embedding is
        NOT NULL (KNOW-2 schema) -- embeddings are computed by the caller
        BEFORE this call (real network I/O to model-gateway's Embed RPC
        never happens inside this DB transaction), so by the time a chunk
        row can be written it is already fully indexed. Disclosed design
        decision, not an accidental stage-skip."""
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            job = self._get(session, tenant_uuid, ingestion_job_id, for_update=True)
            if job.stage != "deduplicated":
                return self._stored(job)

            for chunk in chunks:
                session.add(
                    Chunk(
                        id=chunk.chunk_id,
                        tenant_id=tenant_uuid,
                        scope_id=scope_id,
                        document_id=document_id,
                        document_version=document_version,
                        seq=chunk.seq,
                        text_content=chunk.text,
                        embedding=list(chunk.embedding),
                        embedding_provider=chunk.embedding_provider,
                        embedding_model=chunk.embedding_model,
                        embedding_version=chunk.embedding_version,
                    )
                )

            current_stats = dict(job.stats or {})
            history = list(cast(list[object], current_stats.get("stage_history", [])))
            history.extend(["chunked", "indexed"])
            current_stats["stage_history"] = history
            current_stats["indexing"] = {
                "chunk_count": len(chunks),
                "reused_existing_chunks": False,
            }
            job.stats = current_stats
            job.stage = "indexed"
            job.completed_at = datetime.now(UTC)
            session.flush()
            return self._stored(job)

    def get_current_document_content(
        self, *, tenant_uuid: str, document_id: str
    ) -> StoredDocumentContent:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            row = session.execute(
                select(Document, DocumentVersion)
                .join(
                    DocumentVersion,
                    (DocumentVersion.document_id == Document.id)
                    & (DocumentVersion.version == Document.current_version),
                )
                .where(
                    Document.tenant_id == tenant_uuid,
                    Document.id == document_id,
                    Document.status == "active",
                )
            ).one_or_none()
            if row is None:
                raise DocumentNotFoundError("Document does not exist for requesting tenant")
            document, version = row
            provenance = dict(version.provenance or {})
            content_type = provenance.get("content_type")
            if not isinstance(content_type, str) or not content_type:
                raise ValueError("Current document version has no content type")
            return StoredDocumentContent(
                document_id=document.id,
                scope_id=document.scope_id,
                document_version=document.current_version,
                content_ref=version.content_ref,
                normalized_ref=version.normalized_ref,
                content_type=content_type,
            )

    def activate_reindex(
        self,
        *,
        tenant_uuid: str,
        document_id: str,
        expected_document_version: int,
        chunks: Sequence[EmbeddedChunk],
    ) -> StoredReindex:
        if not chunks:
            raise ValueError("Reindex produced no chunks")
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            document = session.scalar(
                select(Document)
                .where(
                    Document.tenant_id == tenant_uuid,
                    Document.id == document_id,
                    Document.status == "active",
                )
                .with_for_update()
            )
            if document is None:
                raise DocumentNotFoundError("Document does not exist for requesting tenant")
            if document.current_version != expected_document_version:
                raise ReindexConflictError("Document changed during reindex")

            previous = session.scalar(
                select(DocumentVersion).where(
                    DocumentVersion.document_id == document_id,
                    DocumentVersion.version == expected_document_version,
                )
            )
            if previous is None:
                raise DocumentNotFoundError("Current document version does not exist")

            next_version = expected_document_version + 1
            provenance = dict(previous.provenance or {})
            provenance["reindex"] = {
                "from_document_version": expected_document_version,
                "embedding_version": chunks[0].embedding_version,
            }
            session.add(
                DocumentVersion(
                    document_id=document_id,
                    version=next_version,
                    content_ref=previous.content_ref,
                    content_hash=previous.content_hash,
                    normalized_ref=previous.normalized_ref,
                    freshness_at=previous.freshness_at,
                    provenance=provenance,
                    ingestion_job_id=previous.ingestion_job_id,
                )
            )
            session.flush()
            for chunk in chunks:
                session.add(
                    Chunk(
                        id=chunk.chunk_id,
                        tenant_id=tenant_uuid,
                        scope_id=document.scope_id,
                        document_id=document_id,
                        document_version=next_version,
                        seq=chunk.seq,
                        text_content=chunk.text,
                        embedding=list(chunk.embedding),
                        embedding_provider=chunk.embedding_provider,
                        embedding_model=chunk.embedding_model,
                        embedding_version=chunk.embedding_version,
                    )
                )

            # Explicit flush order matters because these mappings do not
            # declare ORM relationships: version FK target first, then all
            # chunks, then active pointer. One transaction keeps swap atomic.
            session.flush()
            document.current_version = next_version
            document.updated_at = datetime.now(UTC)
            session.flush()
            return StoredReindex(
                document_id=document_id,
                previous_document_version=expected_document_version,
                document_version=next_version,
                embedding_version=chunks[0].embedding_version,
                chunk_count=len(chunks),
            )

    @staticmethod
    def _set_tenant(session: Session, tenant_uuid: str) -> None:
        session.execute(_SET_TENANT, {"tenant_id": tenant_uuid})

    @staticmethod
    def _get(
        session: Session,
        tenant_uuid: str,
        ingestion_job_id: str,
        *,
        for_update: bool,
    ) -> IngestionJob:
        statement = select(IngestionJob).where(
            IngestionJob.tenant_id == tenant_uuid,
            IngestionJob.id == ingestion_job_id,
        )
        if for_update:
            statement = statement.with_for_update()
        job = session.scalar(statement)
        if job is None:
            raise IngestionJobNotFoundError("Ingestion job does not exist for requesting tenant")
        return job

    @staticmethod
    def _get_document(
        session: Session,
        tenant_uuid: str,
        document_id: str,
        *,
        for_update: bool = False,
    ) -> Document:
        statement = select(Document).where(
            Document.tenant_id == tenant_uuid,
            Document.id == document_id,
        )
        if for_update:
            statement = statement.with_for_update()
        document = session.scalar(statement)
        if document is None:
            raise DocumentNotFoundError(
                "Document does not exist for requesting tenant"
            )
        return document

    @staticmethod
    def _get_source(
        session: Session,
        tenant_uuid: str,
        source_id: str,
        *,
        for_update: bool = False,
    ) -> Source:
        statement = select(Source).where(
            Source.tenant_id == tenant_uuid,
            Source.id == source_id,
        )
        if for_update:
            statement = statement.with_for_update()
        source = session.scalar(statement)
        if source is None:
            raise SourceNotFoundError("Source does not exist for requesting tenant")
        return source

    @staticmethod
    def _stored(job: IngestionJob) -> StoredIngestionJob:
        return StoredIngestionJob(
            ingestion_job_id=job.id,
            source_id=job.source_id,
            stage=cast(IngestionStage, job.stage),
            stats=dict(job.stats or {}),
            error=dict(job.error) if job.error is not None else None,
            created_at=job.created_at,
            completed_at=job.completed_at,
        )

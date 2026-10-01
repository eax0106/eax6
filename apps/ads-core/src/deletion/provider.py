from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Protocol

from sqlalchemy import bindparam, text
from sqlalchemy.orm import Session, sessionmaker

from src.db.ids import validate_prefixed_id

from .models import DeletionResult, RetentionSweepResult, SubjectDataLocation, VerificationResult
from .workspace_scope import plan_workspace_scope

STORE = "ads-core"
# Children first, so their parents still exist for the scope predicates.
WORKSPACE_DELETE_ORDER = (
    "retrieval_audit",
    "chunks",
    "memory_namespace",
    "records",
    "document_versions",
    "ingestion_jobs",
    "documents",
    "sources",
    "scopes",
)
TABLES = (
    "scopes",
    "sources",
    "documents",
    "document_versions",
    "chunks",
    "records",
    "memory_namespace",
    "ingestion_jobs",
    "retrieval_audit",
)


class ObjectStorageLike(Protocol):
    def delete_object(self, reference: str) -> None: ...

    def object_exists(self, reference: str) -> bool: ...


class AuditOrchestratedObjectStorage:
    """Marks object deletion as owned by audit-service's coordinating adapter.

    The internal ADS HTTP surface is not an independently callable public
    deletion API. Audit-service deletes and verifies the located object refs
    before invoking the ADS row purge. Direct provider tests inject a real or
    mock object adapter and exercise the complete behavior.
    """

    def delete_object(self, reference: str) -> None:
        del reference

    def object_exists(self, reference: str) -> bool:
        del reference
        return False


class AdsDeletionProvider:
    def __init__(
        self,
        sessions: sessionmaker[Session],
        objects: ObjectStorageLike,
        system_sessions: sessionmaker[Session] | None = None,
    ) -> None:
        self._sessions = sessions
        self._objects = objects
        self._system_sessions = system_sessions

    def locate_subject_data(self, tenant_id: str) -> tuple[SubjectDataLocation, ...]:
        tenant_uuid = _tenant_uuid(tenant_id)
        with self._sessions.begin() as session:
            _set_tenant(session, tenant_uuid)
            refs = _object_references(session, tenant_uuid)
            locations = []
            for table in TABLES:
                count = _count(session, table, tenant_uuid)
                locations.append(
                    SubjectDataLocation(
                        store=STORE,
                        table=table,
                        rowCount=count,
                        objectReferences=refs if table == "document_versions" else (),
                    )
                )
            return tuple(locations)

    def delete_subject_data(self, tenant_id: str, manifest_id: str) -> DeletionResult:
        tenant_uuid = _tenant_uuid(tenant_id)
        _require_manifest(manifest_id)
        with self._sessions.begin() as session:
            _set_tenant(session, tenant_uuid)
            references = _object_references(session, tenant_uuid)
        for reference in references:
            self._objects.delete_object(reference)
        deleted = 0
        with self._sessions.begin() as session:
            _set_tenant(session, tenant_uuid)
            for statement in _DELETE_STATEMENTS:
                deleted += _rowcount(session.execute(text(statement), {"tenant": tenant_uuid}))
        return DeletionResult(
            store=STORE,
            manifestId=manifest_id,
            deletedRows=deleted,
            deletedObjects=len(references),
        )

    def verify_deletion(self, tenant_id: str, manifest_id: str) -> VerificationResult:
        remaining = tuple(item for item in self.locate_subject_data(tenant_id) if item.rowCount > 0)
        object_refs = {ref for item in remaining for ref in item.objectReferences}
        surviving = tuple(ref for ref in object_refs if self._objects.object_exists(ref))
        if surviving:
            remaining += (
                SubjectDataLocation(
                    store=STORE,
                    table="object_storage",
                    rowCount=len(surviving),
                    objectReferences=surviving,
                ),
            )
        return VerificationResult(
            store=STORE, manifestId=manifest_id, deleted=not remaining, remaining=remaining
        )

    # D2: one workspace's erasure at the end of its undo window, through the
    # same audit-service orchestration as a tenant's: located object refs are
    # purged by the orchestrator before the rows, then verified absent.
    def locate_workspace_data(
        self, tenant_id: str, workspace_id: str
    ) -> tuple[SubjectDataLocation, ...]:
        tenant_uuid, workspace_uuid = _tenant_uuid(tenant_id), _workspace_uuid(workspace_id)
        params = {"tenant": tenant_uuid, "workspace": workspace_uuid}
        with self._sessions.begin() as session:
            _set_tenant(session, tenant_uuid)
            scope = _workspace_scope(session)
            refs = _workspace_object_references(session, scope, params)
            locations = []
            for table in TABLES:
                count = int(
                    session.scalar(
                        text(f"SELECT count(*) FROM {table} WHERE {scope[table]}"), params
                    )
                    or 0
                )
                locations.append(
                    SubjectDataLocation(
                        store=STORE,
                        table=table,
                        rowCount=count,
                        objectReferences=refs if table == "document_versions" else (),
                    )
                )
            return tuple(locations)

    def delete_workspace_data(
        self, tenant_id: str, workspace_id: str, manifest_id: str
    ) -> DeletionResult:
        tenant_uuid, workspace_uuid = _tenant_uuid(tenant_id), _workspace_uuid(workspace_id)
        _require_manifest(manifest_id)
        params = {"tenant": tenant_uuid, "workspace": workspace_uuid}
        with self._sessions.begin() as session:
            _set_tenant(session, tenant_uuid)
            scope = _workspace_scope(session)
            references = _workspace_object_references(session, scope, params)
        for reference in references:
            self._objects.delete_object(reference)
        deleted = 0
        with self._sessions.begin() as session:
            _set_tenant(session, tenant_uuid)
            scope = _workspace_scope(session)
            for table in WORKSPACE_DELETE_ORDER:
                deleted += _rowcount(
                    session.execute(text(f"DELETE FROM {table} WHERE {scope[table]}"), params)
                )
        return DeletionResult(
            store=STORE,
            manifestId=manifest_id,
            deletedRows=deleted,
            deletedObjects=len(references),
        )

    def verify_workspace_deletion(
        self, tenant_id: str, workspace_id: str, manifest_id: str
    ) -> VerificationResult:
        _require_manifest(manifest_id)
        remaining = tuple(
            item
            for item in self.locate_workspace_data(tenant_id, workspace_id)
            if item.rowCount > 0
        )
        return VerificationResult(
            store=STORE, manifestId=manifest_id, deleted=not remaining, remaining=remaining
        )

    def apply_retention_policy(self) -> RetentionSweepResult:
        if self._system_sessions is None:
            raise RuntimeError("system deletion database connection is required for retention")
        deleted = 0
        # Source-level retention (sources.permissions.retention_days, written
        # through PUT /ads/sources/{id}/permissions) is enforced here, not
        # merely stored: documents from a source past its configured window
        # are purged along with their versions, chunks, and stored objects.
        expired_documents, document_references = self._expired_by_source_retention()
        for reference in document_references:
            self._objects.delete_object(reference)
        if expired_documents:
            with self._system_sessions.begin() as session:
                for statement in _RETENTION_DOCUMENT_DELETES:
                    deleted += _rowcount(
                        session.execute(
                            text(statement).bindparams(bindparam("documents", expanding=True)),
                            {"documents": list(expired_documents)},
                        )
                    )
        with self._system_sessions.begin() as session:
            # Retrieval audit is retained 13 months; completed ingestion diagnostics 90 days.
            deleted += _rowcount(
                session.execute(
                    text(
                        "DELETE FROM retrieval_audit WHERE created_at < now() "
                        "- interval '13 months'"
                    )
                )
            )
            deleted += _rowcount(
                session.execute(
                    text(
                        "DELETE FROM ingestion_jobs WHERE completed_at IS NOT NULL "
                        "AND completed_at < now() - interval '90 days'"
                    )
                )
            )
        return RetentionSweepResult(
            store=STORE,
            deletedRows=deleted,
            deletedObjects=len(document_references),
            sweptAt=datetime.now(UTC).isoformat(),
        )

    def _expired_by_source_retention(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        """Documents past their source's `retention_days`, plus their object refs."""

        assert self._system_sessions is not None
        with self._system_sessions.begin() as session:
            documents = tuple(session.scalars(text(_RETENTION_EXPIRED_DOCUMENTS)).all())
            if not documents:
                return (), ()
            rows = session.execute(
                text(
                    "SELECT content_ref,normalized_ref FROM document_versions "
                    "WHERE document_id IN :documents"
                ).bindparams(bindparam("documents", expanding=True)),
                {"documents": list(documents)},
            ).all()
        references = tuple(
            sorted(
                {
                    ref
                    for row in rows
                    for ref in row
                    if isinstance(ref, str) and ref.startswith("s3://")
                }
            )
        )
        return documents, references

    def list_subject_ids(self) -> tuple[str, ...]:
        if self._system_sessions is None:
            raise RuntimeError(
                "system deletion database connection is required for subject listing"
            )
        with self._system_sessions.begin() as session:
            rows = session.scalars(
                text(
                    "SELECT DISTINCT tenant_id::text FROM ("
                    "SELECT tenant_id FROM scopes UNION SELECT tenant_id FROM sources "
                    "UNION SELECT tenant_id FROM documents UNION SELECT tenant_id FROM chunks "
                    "UNION SELECT tenant_id FROM records "
                    "UNION SELECT tenant_id FROM memory_namespace "
                    "UNION SELECT tenant_id FROM ingestion_jobs "
                    "UNION SELECT tenant_id FROM retrieval_audit"
                    ") subjects ORDER BY tenant_id"
                )
            ).all()
            return tuple(f"ten_{value}" for value in rows)


def _tenant_uuid(tenant_id: str) -> str:
    validate_prefixed_id("ten", tenant_id)
    return tenant_id.removeprefix("ten_")


def _workspace_uuid(workspace_id: str) -> str:
    validate_prefixed_id("ws", workspace_id)
    return workspace_id.removeprefix("ws_")


def _workspace_scope(session: Session) -> dict[str, str]:
    plan = plan_workspace_scope(session, TABLES)
    if plan.unscoped:
        raise RuntimeError(f"Workspace erasure cannot scope tables: {', '.join(plan.unscoped)}")
    return plan.scoped


def _workspace_object_references(
    session: Session, scope: dict[str, str], params: dict[str, str]
) -> tuple[str, ...]:
    rows = session.execute(
        text(
            "SELECT content_ref,normalized_ref FROM document_versions "
            f"WHERE {scope['document_versions']}"
        ),
        params,
    ).all()
    return tuple(
        sorted(
            {ref for row in rows for ref in row if isinstance(ref, str) and ref.startswith("s3://")}
        )
    )


def _require_manifest(manifest_id: str) -> None:
    validate_prefixed_id("del", manifest_id)


def _set_tenant(session: Session, tenant_uuid: str) -> None:
    session.execute(
        text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
        {"tenant": tenant_uuid},
    )


def _rowcount(result: object) -> int:
    value = getattr(result, "rowcount", 0)
    return value if isinstance(value, int) else 0


def _count(session: Session, table: str, tenant_uuid: str) -> int:
    if table == "document_versions":
        statement = (
            "SELECT count(*) FROM document_versions dv JOIN documents d "
            "ON d.id=dv.document_id WHERE d.tenant_id=:tenant"
        )
    else:
        statement = f"SELECT count(*) FROM {table} WHERE tenant_id=:tenant"
    return int(session.scalar(text(statement), {"tenant": tenant_uuid}) or 0)


def _object_references(session: Session, tenant_uuid: str) -> tuple[str, ...]:
    rows = session.execute(
        text(
            "SELECT dv.content_ref,dv.normalized_ref FROM document_versions dv "
            "JOIN documents d ON d.id=dv.document_id WHERE d.tenant_id=:tenant"
        ),
        {"tenant": tenant_uuid},
    ).all()
    return tuple(
        sorted(
            {ref for row in rows for ref in row if isinstance(ref, str) and ref.startswith("s3://")}
        )
    )


# A source's retention window applies to its documents' last write
# (documents.updated_at), so a re-ingested/updated document restarts the clock
# rather than being purged on its original creation date.
_RETENTION_EXPIRED_DOCUMENTS = (
    "SELECT d.id FROM documents d "
    "JOIN sources s ON s.tenant_id=d.tenant_id AND s.id=d.source_id "
    "WHERE jsonb_typeof(s.permissions->'retention_days')='number' "
    "AND d.updated_at < now() - "
    "((s.permissions->>'retention_days')::int * interval '1 day')"
)

_RETENTION_DOCUMENT_DELETES: Sequence[str] = (
    "DELETE FROM chunks WHERE document_id IN :documents",
    "DELETE FROM document_versions WHERE document_id IN :documents",
    "DELETE FROM documents WHERE id IN :documents",
)

_DELETE_STATEMENTS: Sequence[str] = (
    "DELETE FROM retrieval_audit WHERE tenant_id=:tenant",
    "DELETE FROM chunks WHERE tenant_id=:tenant",
    "DELETE FROM memory_namespace WHERE tenant_id=:tenant",
    "DELETE FROM records WHERE tenant_id=:tenant",
    "DELETE FROM document_versions WHERE document_id IN "
    "(SELECT id FROM documents WHERE tenant_id=:tenant)",
    "DELETE FROM ingestion_jobs WHERE tenant_id=:tenant",
    "DELETE FROM documents WHERE tenant_id=:tenant",
    "DELETE FROM sources WHERE tenant_id=:tenant",
    "DELETE FROM scopes WHERE tenant_id=:tenant",
)

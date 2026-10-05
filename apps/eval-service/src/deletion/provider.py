"""Erasure of eval_db tenant content (D2): the D25 tenant benchmarks.

Alter's own golden sets, runs and release records carry no tenant and are not
customer data; the deletion registry declares them exempt.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.engine import CursorResult
from sqlalchemy.orm import Session, sessionmaker

from .models import DeletionResult, RetentionSweepResult, SubjectDataLocation, VerificationResult

STORE = "eval-service"
# scripts/deletion/certify.ts parses this exact block against the deletion registry.
TABLES = (
    "benchmark_case_results",
    "benchmark_cases",
    "benchmark_datasets",
    "benchmark_runs",
)

# Children before the rows they reference.
_DELETE_ORDER = (
    "benchmark_case_results",
    "benchmark_runs",
    "benchmark_cases",
    "benchmark_datasets",
)


class EvalDeletionProvider:
    def __init__(self, sessions: sessionmaker[Session]) -> None:
        self._sessions = sessions

    def _count(self, tenant: str, workspace: str | None) -> tuple[SubjectDataLocation, ...]:
        with self._sessions.begin() as session:
            _set_tenant(session, tenant)
            return tuple(
                SubjectDataLocation(
                    store=STORE,
                    table=table,
                    rowCount=int(
                        session.scalar(
                            text(f"SELECT count(*) FROM {table} WHERE {_predicate(workspace)}"),
                            {"tenant": tenant, "workspace": workspace},
                        )
                        or 0
                    ),
                )
                for table in TABLES
            )

    def _delete(self, tenant: str, workspace: str | None, manifest_id: str) -> DeletionResult:
        _require_manifest(manifest_id)
        deleted = 0
        with self._sessions.begin() as session:
            _set_tenant(session, tenant)
            for table in _DELETE_ORDER:
                result = session.execute(
                    text(f"DELETE FROM {table} WHERE {_predicate(workspace)}"),
                    {"tenant": tenant, "workspace": workspace},
                )
                deleted += result.rowcount if isinstance(result, CursorResult) else 0
        return DeletionResult(
            store=STORE, manifestId=manifest_id, deletedRows=deleted, deletedObjects=0
        )

    def _verify(self, tenant: str, workspace: str | None, manifest_id: str) -> VerificationResult:
        _require_manifest(manifest_id)
        remaining = tuple(item for item in self._count(tenant, workspace) if item.rowCount > 0)
        return VerificationResult(
            store=STORE, manifestId=manifest_id, deleted=not remaining, remaining=remaining
        )

    def locate_subject_data(self, tenant_id: str) -> tuple[SubjectDataLocation, ...]:
        return self._count(_tenant_uuid(tenant_id), None)

    def delete_subject_data(self, tenant_id: str, manifest_id: str) -> DeletionResult:
        return self._delete(_tenant_uuid(tenant_id), None, manifest_id)

    def verify_deletion(self, tenant_id: str, manifest_id: str) -> VerificationResult:
        return self._verify(_tenant_uuid(tenant_id), None, manifest_id)

    def locate_workspace_data(
        self, tenant_id: str, workspace_id: str
    ) -> tuple[SubjectDataLocation, ...]:
        return self._count(_tenant_uuid(tenant_id), _workspace_uuid(workspace_id))

    def delete_workspace_data(
        self, tenant_id: str, workspace_id: str, manifest_id: str
    ) -> DeletionResult:
        return self._delete(_tenant_uuid(tenant_id), _workspace_uuid(workspace_id), manifest_id)

    def verify_workspace_deletion(
        self, tenant_id: str, workspace_id: str, manifest_id: str
    ) -> VerificationResult:
        return self._verify(_tenant_uuid(tenant_id), _workspace_uuid(workspace_id), manifest_id)

    def apply_retention_policy(self) -> RetentionSweepResult:
        return RetentionSweepResult(
            store=STORE, deletedRows=0, deletedObjects=0, sweptAt=datetime.now(UTC).isoformat()
        )

    def list_subject_ids(self) -> tuple[str, ...]:
        selects = " UNION ".join(f"SELECT tenant_id FROM {table}" for table in TABLES)
        with self._sessions.begin() as session:
            session.execute(text("SELECT set_config('app.eval_tenant_inventory', 'on', true)"))
            rows = session.scalars(
                text(f"SELECT DISTINCT tenant_id::text FROM ({selects}) subjects ORDER BY 1")
            ).all()
            return tuple(f"ten_{value}" for value in rows)


def _predicate(workspace: str | None) -> str:
    if workspace is None:
        return "tenant_id = CAST(:tenant AS uuid)"
    return "tenant_id = CAST(:tenant AS uuid) AND workspace_id = CAST(:workspace AS uuid)"


def _set_tenant(session: Session, tenant: str) -> None:
    session.execute(
        text("SELECT set_config('app.current_tenant_id', :tenant, true)"), {"tenant": tenant}
    )


def _prefixed_uuid7(value: str, prefix: str, label: str) -> str:
    if not value.startswith(f"{prefix}_"):
        raise ValueError(f"{label} must be a {prefix}_ prefixed UUIDv7")
    raw = value.removeprefix(f"{prefix}_")
    try:
        parsed = uuid.UUID(raw)
    except ValueError as error:
        raise ValueError(f"{label} must be a {prefix}_ prefixed UUIDv7") from error
    if parsed.version != 7:
        raise ValueError(f"{label} must be a {prefix}_ prefixed UUIDv7")
    return raw


def _tenant_uuid(tenant_id: str) -> str:
    return _prefixed_uuid7(tenant_id, "ten", "tenantId")


def _workspace_uuid(workspace_id: str) -> str:
    return _prefixed_uuid7(workspace_id, "ws", "workspaceId")


def _require_manifest(manifest_id: str) -> None:
    if not manifest_id.startswith("del_"):
        raise ValueError("manifestId must be del_ prefixed UUID")
    try:
        uuid.UUID(manifest_id.removeprefix("del_"))
    except ValueError as error:
        raise ValueError("manifestId must be del_ prefixed UUID") from error

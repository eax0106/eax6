from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from .models import DeletionResult, RetentionSweepResult, SubjectDataLocation, VerificationResult

STORE = "memory-service"
# scripts/deletion/certify.ts parses this exact block against the deletion registry.
TABLES = (
    "drift_scores",
    "memory_records",
    "policies",
    "policy_promotions",
)


class MemoryDeletionProvider:
    """Erasure of policy_db (D2, C3b).

    Row security decides who may touch what, and erasure works inside it:
    memory records, tenant-scoped policies and their promotions are removed in
    the tenant's own session; a tenant's agent drift scores can be written only
    by `policy_system_writer`, so that role removes them. The global tier
    (tenant-less, content-free by construction, migration 0007) belongs to no
    tenant and is never touched. Policies scoped to a workspace or workflow are
    keyed by an id this database cannot attribute to a tenant; they are not
    reached (none is created by v1).
    """

    def __init__(
        self,
        sessions: sessionmaker[Session],
        system_sessions: sessionmaker[Session],
    ) -> None:
        self._sessions = sessions
        self._system_sessions = system_sessions

    def locate_subject_data(self, tenant_id: str) -> tuple[SubjectDataLocation, ...]:
        tenant = _tenant_uuid(tenant_id)
        with self._sessions.begin() as session:
            _set_tenant(session, tenant)
            counts = {
                "memory_records": _scalar(
                    session, "SELECT count(*) FROM memory_records WHERE tenant_id=:t", tenant
                ),
                "policies": _scalar(
                    session,
                    "SELECT count(*) FROM policies WHERE scope='tenant' AND scope_id=:t",
                    tenant,
                ),
                "policy_promotions": _scalar(session, _PROMOTIONS_COUNT, tenant),
            }
        with self._system_sessions.begin() as session:
            counts["drift_scores"] = _scalar(
                session, "SELECT count(*) FROM drift_scores WHERE tenant_id=:t", tenant
            )
        return tuple(
            SubjectDataLocation(store=STORE, table=table, rowCount=counts[table])
            for table in TABLES
        )

    def delete_subject_data(self, tenant_id: str, manifest_id: str) -> DeletionResult:
        tenant = _tenant_uuid(tenant_id)
        _require_manifest(manifest_id)
        deleted = 0
        with self._sessions.begin() as session:
            _set_tenant(session, tenant)
            for statement in _TENANT_DELETES:
                deleted += _rowcount(session.execute(text(statement), {"t": tenant}))
        with self._system_sessions.begin() as session:
            deleted += _rowcount(
                session.execute(text("DELETE FROM drift_scores WHERE tenant_id=:t"), {"t": tenant})
            )
        return DeletionResult(
            store=STORE, manifestId=manifest_id, deletedRows=deleted, deletedObjects=0
        )

    def verify_deletion(self, tenant_id: str, manifest_id: str) -> VerificationResult:
        remaining = tuple(item for item in self.locate_subject_data(tenant_id) if item.rowCount > 0)
        return VerificationResult(
            store=STORE, manifestId=manifest_id, deleted=not remaining, remaining=remaining
        )

    def apply_retention_policy(self) -> RetentionSweepResult:
        return RetentionSweepResult(
            store=STORE, deletedRows=0, deletedObjects=0, sweptAt=datetime.now(UTC).isoformat()
        )

    def list_subject_ids(self) -> tuple[str, ...]:
        """Tenants the system role can see.

        Row security hides other tenants' memory and policies from every role in this
        database, so the deletion-ledger replay covers the tenants that have agent drift
        rows until a dedicated cross-tenant reader exists.
        """
        with self._system_sessions.begin() as session:
            rows = session.scalars(
                text(
                    "SELECT DISTINCT tenant_id::text FROM drift_scores "
                    "WHERE tenant_id IS NOT NULL ORDER BY 1"
                )
            ).all()
        return tuple(f"ten_{value}" for value in rows)


_PROMOTIONS_COUNT = (
    "SELECT count(*) FROM policy_promotions WHERE policy_id IN "
    "(SELECT id FROM policies WHERE scope='tenant' AND scope_id=:t)"
)

_TENANT_DELETES = (
    "DELETE FROM policy_promotions WHERE policy_id IN "
    "(SELECT id FROM policies WHERE scope='tenant' AND scope_id=:t)",
    "DELETE FROM policies WHERE scope='tenant' AND scope_id=:t",
    "DELETE FROM memory_records WHERE tenant_id=:t",
)


def _tenant_uuid(tenant_id: str) -> str:
    if not tenant_id.startswith("ten_"):
        raise ValueError("tenantId must be a ten_ prefixed UUIDv7")
    raw = tenant_id.removeprefix("ten_")
    try:
        parsed = uuid.UUID(raw)
    except ValueError as error:
        raise ValueError("tenantId must be a ten_ prefixed UUIDv7") from error
    if parsed.version != 7:
        raise ValueError("tenantId must be a ten_ prefixed UUIDv7")
    return raw


def _require_manifest(manifest_id: str) -> None:
    if not manifest_id.startswith("del_"):
        raise ValueError("manifestId must be del_ prefixed UUID")
    try:
        uuid.UUID(manifest_id.removeprefix("del_"))
    except ValueError as error:
        raise ValueError("manifestId must be del_ prefixed UUID") from error


def _set_tenant(session: Session, tenant: str) -> None:
    session.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": tenant})


def _scalar(session: Session, statement: str, tenant: str) -> int:
    return int(session.scalar(text(statement), {"t": tenant}) or 0)


def _rowcount(result: object) -> int:
    value = getattr(result, "rowcount", 0)
    return value if isinstance(value, int) else 0

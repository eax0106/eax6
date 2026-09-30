from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from src.db.ids import PLATFORM_TENANT_ID

from .models import DeletionResult, RetentionSweepResult, SubjectDataLocation, VerificationResult

STORE = "intelligence-service"
# scripts/deletion/certify.ts parses this exact block against the deletion registry.
TABLES = (
    "agent_versions",
    "agents",
    "capability_embeddings",
    "capability_registry_versions",
    "performance_records",
)

# Every table names its tenant `tenant_id`, except the registry, which names its owner.
_TENANT_COLUMN = {"capability_registry_versions": "owner_tenant_id"}

# Children before the agents they reference.
_DELETE_ORDER = (
    "capability_embeddings",
    "agent_versions",
    "performance_records",
    "agents",
    "capability_registry_versions",
)


class IntelligenceDeletionProvider:
    """Erasure of intelligence_db (D2, C3b).

    Tenant rows only: rows of the platform sentinel tenant (global agents and
    registry versions) belong to no customer and are never touched.
    """

    def __init__(
        self,
        sessions: sessionmaker[Session],
        system_sessions: sessionmaker[Session] | None = None,
    ) -> None:
        self._sessions = sessions
        self._system_sessions = system_sessions

    def locate_subject_data(self, tenant_id: str) -> tuple[SubjectDataLocation, ...]:
        tenant = _tenant_uuid(tenant_id)
        with self._sessions.begin() as session:
            _set_tenant(session, tenant)
            return tuple(
                SubjectDataLocation(
                    store=STORE, table=table, rowCount=_count(session, table, tenant)
                )
                for table in TABLES
            )

    def delete_subject_data(self, tenant_id: str, manifest_id: str) -> DeletionResult:
        tenant = _tenant_uuid(tenant_id)
        _require_manifest(manifest_id)
        deleted = 0
        with self._sessions.begin() as session:
            _set_tenant(session, tenant)
            for table in _DELETE_ORDER:
                result = session.execute(
                    text(f"DELETE FROM {table} WHERE {_column(table)}=:tenant"), {"tenant": tenant}
                )
                deleted += _rowcount(result)
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
        if self._system_sessions is None:
            raise RuntimeError(
                "system deletion database connection is required for subject listing"
            )
        selects = " UNION ".join(
            f"SELECT {_column(table)} AS tenant_id FROM {table}" for table in TABLES
        )
        with self._system_sessions.begin() as session:
            rows = session.scalars(
                text(
                    f"SELECT DISTINCT tenant_id::text FROM ({selects}) subjects "
                    "WHERE tenant_id::text <> :platform ORDER BY 1"
                ),
                {"platform": PLATFORM_TENANT_ID},
            ).all()
            return tuple(f"ten_{value}" for value in rows)


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
    if raw == PLATFORM_TENANT_ID:
        raise ValueError("the platform tenant has no erasure")
    return raw


def _require_manifest(manifest_id: str) -> None:
    if not manifest_id.startswith("del_"):
        raise ValueError("manifestId must be del_ prefixed UUID")
    try:
        uuid.UUID(manifest_id.removeprefix("del_"))
    except ValueError as error:
        raise ValueError("manifestId must be del_ prefixed UUID") from error


def _set_tenant(session: Session, tenant: str) -> None:
    session.execute(
        text("SELECT set_config('app.current_tenant_id', :tenant, true)"), {"tenant": tenant}
    )


def _count(session: Session, table: str, tenant: str) -> int:
    return int(
        session.scalar(
            text(f"SELECT count(*) FROM {table} WHERE {_column(table)}=:tenant"), {"tenant": tenant}
        )
        or 0
    )


def _rowcount(result: object) -> int:
    value = getattr(result, "rowcount", 0)
    return value if isinstance(value, int) else 0


def _column(table: str) -> str:
    return _TENANT_COLUMN.get(table, "tenant_id")

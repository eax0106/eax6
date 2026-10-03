from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from src.db.models import MemoryRecord
from src.memory_learning.ids import raw_uuid7
from src.memory_settings.repository import MemorySettingsRepository

_SET_TENANT = text("SELECT set_config('app.current_tenant_id', :tenant_id, true)")
_LOCK_RUN = text("SELECT pg_advisory_xact_lock(hashtextextended(:idempotency_key, 0))")
_FIND_EXISTING = text(
    """
    SELECT id, content
      FROM memory_records
     WHERE tenant_id = :tenant_id
       AND status = 'candidate'
       AND provenance->>'run_id' = :run_id
       AND (CAST(:workspace AS uuid) IS NULL OR (workspace_id=CAST(:workspace AS uuid)
         AND created_at >= now()-make_interval(days=>:days)))
     ORDER BY created_at ASC
     LIMIT 1
    """
)


@dataclass(frozen=True)
class StoredCandidate:
    memory_id: str
    content: dict[str, object]
    skipped: bool = False


class MemoryCandidateRepository(Protocol):
    def workflow_enabled(self, tenant_id: str, workspace_id: str) -> bool: ...

    def propose(
        self,
        *,
        memory_id: str,
        tenant_uuid: str,
        run_id: str,
        scope: str,
        content: dict[str, object],
        provenance: dict[str, object],
    ) -> StoredCandidate: ...


class SqlAlchemyMemoryCandidateRepository:
    def __init__(self, sessions: sessionmaker[Session]) -> None:
        self._sessions = sessions

    def workflow_enabled(self, tenant_id: str, workspace_id: str) -> bool:
        return MemorySettingsRepository(self._sessions).access(
            tenant_id, workspace_id, "workflow"
        )[0]

    def propose(
        self,
        *,
        memory_id: str,
        tenant_uuid: str,
        run_id: str,
        scope: str,
        content: dict[str, object],
        provenance: dict[str, object],
    ) -> StoredCandidate:
        with self._sessions.begin() as session:
            session.execute(_SET_TENANT, {"tenant_id": tenant_uuid})
            workspace: str | None = None
            days = 90
            if scope != "global":
                workspace_id = provenance.get("workspace_id")
                if not isinstance(workspace_id, str):
                    raise ValueError("Local memory requires its actual workspace")
                workspace = raw_uuid7(workspace_id, "ws")
                memory_scope = {"tenant": tenant_uuid, "workspace": workspace}
                session.execute(
                    text(
                        "INSERT INTO workspace_memory_settings(tenant_id,workspace_id) "
                        "VALUES(:tenant,:workspace) ON CONFLICT DO NOTHING"
                    ),
                    memory_scope,
                )
                settings = MemorySettingsRepository.read(session, memory_scope, lock=True)
                if not settings.workflowMemoryEnabled:
                    return StoredCandidate(memory_id="", content={}, skipped=True)
                days = settings.retentionDays
            session.execute(
                _LOCK_RUN,
                {"idempotency_key": f"memory-writeback:{tenant_uuid}:{run_id}"},
            )
            existing = (
                session.execute(
                    _FIND_EXISTING,
                    {
                        "tenant_id": tenant_uuid,
                        "run_id": run_id,
                        "workspace": workspace,
                        "days": days,
                    },
                )
                .mappings()
                .one_or_none()
            )
            if existing is not None:
                return StoredCandidate(
                    memory_id=str(existing["id"]),
                    content=dict(existing["content"]),
                )

            session.add(
                MemoryRecord(
                    id=memory_id,
                    tenant_id=tenant_uuid,
                    workspace_id=workspace,
                    memory_kind="workflow" if scope != "global" else None,
                    scope=scope,
                    content=content,
                    provenance=provenance,
                    status="candidate",
                    destination=None,
                )
            )
            session.flush()
            return StoredCandidate(memory_id=memory_id, content=content)

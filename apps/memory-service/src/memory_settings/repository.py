from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from src.memory_learning.ids import new_prefixed_uuid7, raw_uuid7


class WorkspaceMemoryValues(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)
    conversationMemoryEnabled: bool = True
    workflowMemoryEnabled: bool = True
    workspaceMemoryEnabled: bool = True
    retentionDays: int = Field(default=90, ge=7, le=365)


class WorkspaceMemoryView(WorkspaceMemoryValues):
    etag: str


class MemorySettingsPreconditionError(ValueError):
    def __init__(self, status: int) -> None:
        self.status = status
        super().__init__(
            "If-Match required" if status == 428 else "Memory settings changed; reload"
        )


MemoryKind = Literal["chat", "workflow", "workspace"]
_SWITCH = {
    "chat": "conversationMemoryEnabled",
    "workflow": "workflowMemoryEnabled",
    "workspace": "workspaceMemoryEnabled",
}
_COLUMNS = "chat_enabled, workflow_enabled, workspace_enabled, retention_days, version"


def view(row: dict[str, object] | None) -> WorkspaceMemoryView:
    if row is None:
        return WorkspaceMemoryView(etag='"memory-0"')
    return WorkspaceMemoryView.model_validate(
        {
            "conversationMemoryEnabled": row["chat_enabled"],
            "workflowMemoryEnabled": row["workflow_enabled"],
            "workspaceMemoryEnabled": row["workspace_enabled"],
            "retentionDays": row["retention_days"],
            "etag": f'"memory-{row["version"]}"',
        }
    )


class MemorySettingsRepository:
    def __init__(self, sessions: sessionmaker[Session]) -> None:
        self.sessions = sessions

    @staticmethod
    def scope(session: Session, tenant_id: str, workspace_id: str) -> dict[str, str]:
        tenant = raw_uuid7(tenant_id, "ten")
        workspace = raw_uuid7(workspace_id, "ws")
        session.execute(
            text("SELECT set_config('app.current_tenant_id', :tenant, true)"), {"tenant": tenant}
        )
        return {"tenant": tenant, "workspace": workspace}

    @staticmethod
    def read(session: Session, scope: dict[str, str], *, lock: bool = False) -> WorkspaceMemoryView:
        row = (
            session.execute(
                text(
                    f"SELECT {_COLUMNS} FROM workspace_memory_settings "
                    "WHERE tenant_id=:tenant AND workspace_id=:workspace"
                    + (" FOR UPDATE" if lock else "")
                ),
                scope,
            )
            .mappings()
            .one_or_none()
        )
        return view(dict(row) if row is not None else None)

    def get(self, tenant_id: str, workspace_id: str) -> WorkspaceMemoryView:
        with self.sessions.begin() as session:
            return self.read(session, self.scope(session, tenant_id, workspace_id))

    def access(self, tenant_id: str, workspace_id: str, kind: str) -> tuple[bool, int]:
        if kind not in _SWITCH:
            raise ValueError("Invalid memory kind")
        settings = self.get(tenant_id, workspace_id)
        return bool(getattr(settings, _SWITCH[kind])), settings.retentionDays

    def update(
        self,
        tenant_id: str,
        workspace_id: str,
        actor_id: str,
        values: WorkspaceMemoryValues,
        if_match: str,
    ) -> WorkspaceMemoryView:
        if not if_match.strip():
            raise MemorySettingsPreconditionError(428)
        raw_uuid7(actor_id, "usr")
        with self.sessions.begin() as session:
            scope = self.scope(session, tenant_id, workspace_id)
            session.execute(
                text(
                    "INSERT INTO memory_retention_tenants(tenant_id) VALUES(:tenant) "
                    "ON CONFLICT DO NOTHING"
                ),
                scope,
            )
            session.execute(
                text(
                    "INSERT INTO workspace_memory_settings(tenant_id,workspace_id) "
                    "VALUES(:tenant,:workspace) ON CONFLICT DO NOTHING"
                ),
                scope,
            )
            before = self.read(session, scope, lock=True)
            if if_match != before.etag:
                raise MemorySettingsPreconditionError(412)
            session.execute(
                text(
                    "UPDATE workspace_memory_settings SET chat_enabled=:chat, "
                    "workflow_enabled=:workflow_enabled, workspace_enabled=:workspace_enabled, "
                    "retention_days=:days, version=version+1, updated_at=clock_timestamp() "
                    "WHERE tenant_id=:tenant AND workspace_id=:workspace"
                ),
                {
                    **scope,
                    "chat": values.conversationMemoryEnabled,
                    "workflow_enabled": values.workflowMemoryEnabled,
                    "workspace_enabled": values.workspaceMemoryEnabled,
                    "days": values.retentionDays,
                },
            )
            after = self.read(session, scope)
            session.execute(
                text(
                    "INSERT INTO memory_settings_audit"
                    "(id,tenant_id,workspace_id,actor_ref,before_value,after_value) "
                    "VALUES(:id,:tenant,:workspace,:actor,"
                    "CAST(:before AS jsonb),CAST(:after AS jsonb))"
                ),
                {
                    **scope,
                    "id": new_prefixed_uuid7("aud"),
                    "actor": actor_id,
                    "before": json.dumps(before.model_dump()),
                    "after": json.dumps(after.model_dump()),
                },
            )
            return after

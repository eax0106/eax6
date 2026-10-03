from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Literal, Self

from pydantic import TypeAdapter, model_validator
from sqlalchemy import text

from src.memory_learning.ids import new_prefixed_uuid7, raw_uuid7
from src.memory_learning.models import StrictModel
from src.memory_settings.repository import MemorySettingsRepository


class ChatMemoryMessage(StrictModel):
    id: str
    conversationId: str
    role: Literal["user", "assistant", "system"]
    kind: Literal["text", "clarification", "workflow", "project", "run", "artifact", "action"]
    content: str | dict[str, object]
    createdAt: datetime

    @model_validator(mode="after")
    def identity(self) -> Self:
        raw_uuid7(self.id, "msg")
        raw_uuid7(self.conversationId, "cnv")
        if self.createdAt.tzinfo is None:
            raise ValueError("Memory timestamp requires timezone")
        return self


CHAT_MESSAGES = TypeAdapter(list[ChatMemoryMessage])


def chat_messages(raw: str, conversation_id: str) -> list[ChatMemoryMessage]:
    raw_uuid7(conversation_id, "cnv")
    if len(raw.encode()) > 64_000:
        raise ValueError("Chat memory exceeds 64000 bytes")
    messages = CHAT_MESSAGES.validate_json(raw)
    if len(messages) > 1000 or any(row.conversationId != conversation_id for row in messages):
        raise ValueError("Invalid chat memory scope")
    return messages


def store_and_recall_chat(
    repository: MemorySettingsRepository,
    tenant_id: str,
    workspace_id: str,
    conversation_id: str,
    redacted_json: str,
) -> str:
    messages = chat_messages(redacted_json, conversation_id)
    with repository.sessions.begin() as session:
        scope = repository.scope(session, tenant_id, workspace_id)
        session.execute(
            text(
                "INSERT INTO workspace_memory_settings(tenant_id,workspace_id) "
                "VALUES(:tenant,:workspace) ON CONFLICT DO NOTHING"
            ),
            scope,
        )
        settings = repository.read(session, scope, lock=True)
        if not settings.conversationMemoryEnabled:
            return "[]"
        now = session.scalar(text("SELECT now()"))
        assert isinstance(now, datetime)
        cutoff = now - timedelta(days=settings.retentionDays)
        retained = [row for row in messages if cutoff <= row.createdAt <= now]
        if not retained:
            return "[]"
        content = CHAT_MESSAGES.dump_json(retained).decode()
        session.execute(
            text(
                "INSERT INTO memory_records(id,tenant_id,workspace_id,memory_kind,context_id,"
                "scope,content,provenance,status,created_at) VALUES(:id,:tenant,:workspace,'chat',"
                ":conversation,'project',jsonb_build_object('messages',CAST(:content AS jsonb)),"
                "jsonb_build_object('conversation_id',CAST(:conversation AS text)),"
                "'candidate',:created) "
                "ON CONFLICT(tenant_id,workspace_id,context_id) WHERE memory_kind='chat' "
                "DO UPDATE SET content=excluded.content,created_at=excluded.created_at "
                "WHERE memory_records.tenant_id=:tenant AND memory_records.workspace_id=:workspace"
            ),
            {
                **scope,
                "id": new_prefixed_uuid7("mem"),
                "conversation": conversation_id,
                "content": content,
                "created": max(row.createdAt for row in retained),
            },
        )
        stored = session.scalar(
            text(
                "SELECT content->'messages' FROM memory_records WHERE tenant_id=:tenant "
                "AND workspace_id=:workspace AND memory_kind='chat' AND context_id=:conversation"
            ),
            {**scope, "conversation": conversation_id},
        )
        return json.dumps(stored, separators=(",", ":"))


def recall_workflow(
    repository: MemorySettingsRepository, tenant_id: str, workspace_id: str, workflow_id: str
) -> str:
    raw_uuid7(workflow_id, "wf")
    with repository.sessions.begin() as session:
        scope = repository.scope(session, tenant_id, workspace_id)
        settings = repository.read(session, scope)
        if not settings.workflowMemoryEnabled:
            return "[]"
        rows = session.execute(
            text(
                "SELECT id,content FROM memory_records WHERE tenant_id=:tenant "
                "AND workspace_id=:workspace AND memory_kind='workflow' "
                "AND provenance->>'namespace'=:namespace "
                "AND status IN ('candidate','verified','promoted') "
                "AND created_at >= now()-make_interval(days=>:days) "
                "AND created_at <= now() ORDER BY created_at DESC,id DESC LIMIT 20"
            ),
            {**scope, "namespace": f"workflow:{workflow_id}", "days": settings.retentionDays},
        ).mappings()
        memories: list[dict[str, object]] = []
        for row in rows:
            candidate = {"id": row["id"], "content": row["content"]}
            if len(json.dumps([*memories, candidate]).encode()) <= 16_000:
                memories.append(candidate)
        return json.dumps(memories, separators=(",", ":"))

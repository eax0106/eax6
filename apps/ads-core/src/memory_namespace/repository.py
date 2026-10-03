from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from src.db.ids import new_prefixed_id
from src.db.models import MemoryNamespace, Scope

from .client import MemoryAccess, MemoryUnavailableError
from .models import MemoryFact, MemoryNamespaceKind

_SET_TENANT = text("SELECT set_config('app.current_tenant_id', :tenant_id, true)")


class ScopeNotFoundError(ValueError):
    pass


class _RedactedMemory(BaseModel):
    model_config = ConfigDict(extra="forbid")
    statement: str = Field(min_length=1, max_length=8_000)
    provenance: dict[str, object]


class SqlAlchemyMemoryNamespaceRepository:
    def __init__(
        self,
        sessions: sessionmaker[Session],
        *,
        access: MemoryAccess | None = None,
        redact: Callable[[str, str], str] | None = None,
    ) -> None:
        self._sessions = sessions
        self._access = access
        self._redact = redact

    def record(
        self,
        *,
        tenant_uuid: str,
        scope_id: str,
        project_ref: str | None,
        kind: MemoryNamespaceKind,
        statement: str,
        confidence: float | None,
        provenance: dict[str, object],
    ) -> str:
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            workspace = session.scalar(
                select(Scope.workspace_id).where(
                    Scope.tenant_id == tenant_uuid, Scope.id == scope_id
                )
            )
            if workspace is None:
                raise ScopeNotFoundError("Scope does not exist for requesting tenant")
            if self._access is None:
                raise MemoryUnavailableError("Workspace memory settings unavailable")
            allowed, _ = self._access(f"ten_{tenant_uuid}", f"ws_{workspace}")
            if not allowed:
                return ""
            redacted = self._redacted(tenant_uuid, statement, provenance)
            record_id = new_prefixed_id("mns")
            session.add(
                MemoryNamespace(
                    id=record_id,
                    tenant_id=tenant_uuid,
                    scope_id=scope_id,
                    project_ref=project_ref,
                    kind=kind,
                    statement=redacted.statement,
                    confidence=confidence,
                    provenance=redacted.provenance,
                    status="active",
                )
            )
            session.flush()
            return record_id

    def list_active_for_scopes(
        self, *, tenant_uuid: str, workspace_uuid: str, scope_ids: tuple[str, ...], limit: int
    ) -> tuple[MemoryFact, ...]:
        """Scoped by scope_id, not project_ref -- scope_id is the real,
        FK-validated concept record() already requires and the same
        concept RetrievalRequest.scope_ids already uses to gate document
        chunks, so this reuses an existing mechanism rather than inventing
        a project_ref mapping memory-service has no data to support."""
        if not scope_ids or self._access is None:
            return ()
        try:
            allowed, days = self._access(f"ten_{tenant_uuid}", f"ws_{workspace_uuid}")
        except MemoryUnavailableError:
            return ()
        if not allowed:
            return ()
        cutoff = datetime.now(UTC) - timedelta(days=days)
        with self._sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            rows = session.scalars(
                select(MemoryNamespace)
                .join(
                    Scope,
                    (Scope.id == MemoryNamespace.scope_id)
                    & (Scope.tenant_id == MemoryNamespace.tenant_id),
                )
                .where(
                    MemoryNamespace.tenant_id == tenant_uuid,
                    MemoryNamespace.scope_id.in_(scope_ids),
                    MemoryNamespace.status == "active",
                    Scope.workspace_id == workspace_uuid,
                    MemoryNamespace.created_at >= cutoff,
                    MemoryNamespace.created_at <= datetime.now(UTC),
                )
                .order_by(MemoryNamespace.created_at.desc())
                .limit(limit)
            ).all()
            facts = []
            for row in rows:
                try:
                    redacted = self._redacted(tenant_uuid, row.statement, row.provenance)
                except MemoryUnavailableError:
                    return ()
                facts.append(
                    MemoryFact(
                        id=row.id,
                        kind=row.kind,  # type: ignore[arg-type]
                        statement=redacted.statement,
                        confidence=float(row.confidence) if row.confidence is not None else None,
                        provenance=redacted.provenance,
                    )
                )
            return tuple(facts)

    def _redacted(
        self, tenant_uuid: str, statement: str, provenance: dict[str, object]
    ) -> _RedactedMemory:
        try:
            if self._redact is None:
                raise MemoryUnavailableError("Workspace memory redaction unavailable")
            content = json.dumps({"statement": statement, "provenance": provenance})
            return _RedactedMemory.model_validate_json(self._redact(f"ten_{tenant_uuid}", content))
        except Exception as error:
            raise MemoryUnavailableError("Workspace memory redaction unavailable") from error

    @staticmethod
    def _set_tenant(session: Session, tenant_id: str) -> None:
        session.execute(_SET_TENANT, {"tenant_id": tenant_id})

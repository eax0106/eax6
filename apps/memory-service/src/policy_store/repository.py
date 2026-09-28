from __future__ import annotations

from datetime import UTC, datetime
from typing import cast

from sqlalchemy import case, func, select, text
from sqlalchemy.orm import Session, sessionmaker

from src.db.models import MemoryRecord, Policy, PolicyPromotion
from src.memory_learning.ids import new_prefixed_uuid7

from .anonymization import anonymize_global_content, anonymized_global_provenance
from .models import (
    CreateDraftPolicyResponse,
    PolicyPatch,
    PolicyStatus,
    StoredMemoryPromotion,
    StoredMemoryRevocation,
    StoredPolicyUpdate,
)

_SET_TENANT = text("SELECT set_config('app.current_tenant_id', :tenant_id, true)")


class PolicyNotFoundError(LookupError):
    pass


class MemoryNotFoundError(LookupError):
    pass


class PolicyVersionConflictError(RuntimeError):
    pass


class PolicyTransitionError(RuntimeError):
    pass


class MemoryPromotionConflictError(RuntimeError):
    pass


class MemoryRevertConflictError(RuntimeError):
    pass


class PolicyPermissionError(PermissionError):
    pass


_VALID_TRANSITIONS: dict[PolicyStatus, frozenset[PolicyStatus]] = {
    "draft": frozenset({"draft", "canary"}),
    "canary": frozenset({"canary", "active"}),
    "active": frozenset({"rolled_back"}),
    "rolled_back": frozenset(),
    "retired": frozenset(),
}


class SqlAlchemyPolicyStoreRepository:
    def __init__(
        self,
        tenant_sessions: sessionmaker[Session],
        system_sessions: sessionmaker[Session],
    ) -> None:
        self._tenant_sessions = tenant_sessions
        self._system_sessions = system_sessions

    def update_policy(
        self,
        *,
        tenant_uuid: str,
        policy_id: str,
        current_version: int,
        patch: PolicyPatch,
        actor: str,
        global_write_authorized: bool = False,
    ) -> StoredPolicyUpdate:
        scope = self._visible_policy_scope(tenant_uuid, policy_id)
        if scope == "global" and not global_write_authorized:
            raise PolicyPermissionError(
                "global-scope policy writes require the privileged write credential"
            )
        sessions = self._system_sessions if scope == "global" else self._tenant_sessions
        with sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            policy = session.scalar(
                select(Policy).where(Policy.id == policy_id).with_for_update()
            )
            if policy is None:
                raise PolicyNotFoundError("Policy does not exist for requesting tenant")
            if policy.version != current_version:
                raise PolicyVersionConflictError(
                    f"Policy version conflict: expected {current_version}, found {policy.version}"
                )
            from_status = cast(PolicyStatus, policy.status)
            target_status = patch.status or from_status
            if target_status not in _VALID_TRANSITIONS[from_status]:
                raise PolicyTransitionError(
                    f"Illegal policy transition {from_status} -> {target_status}"
                )
            if from_status == "active" and patch.body is not None:
                raise PolicyTransitionError("Active policy body cannot be edited in place")

            old_version = policy.version
            policy.version += 1
            if patch.body is not None:
                policy.body = {**policy.body, **patch.body}
            policy.status = target_status
            if target_status != from_status:
                action = "rollback" if target_status == "rolled_back" else "promote"
                session.add(
                    PolicyPromotion(
                        id=new_prefixed_uuid7("prom"),
                        policy_id=policy.id,
                        from_version=old_version,
                        to_version=policy.version,
                        action=action,
                        reason=patch.reason or f"{from_status} -> {target_status}",
                        actor=actor,
                    )
                )
            session.flush()
            return StoredPolicyUpdate(
                policy_id=policy.id,
                new_version=policy.version,
                status=target_status,
            )

    def create_draft_policy_from_active(
        self, *, tenant_uuid: str, kind: str, body: dict[str, object]
    ) -> CreateDraftPolicyResponse:
        active_scope = self._active_policy_scope(tenant_uuid, kind)
        sessions = (
            self._system_sessions if active_scope == "global" else self._tenant_sessions
        )
        with sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            active = session.scalar(
                select(Policy)
                .where(Policy.kind == kind, Policy.status == "active")
                .order_by(
                    case((Policy.scope == "global", 0), else_=1).desc(),
                    Policy.version.desc(),
                )
                .limit(1)
                .with_for_update()
            )
            if active is None:
                raise PolicyNotFoundError("No active policy exists for this kind")
            next_version = session.scalar(
                select(func.coalesce(func.max(Policy.version), 0) + 1).where(
                    Policy.scope == active.scope,
                    Policy.scope_id == active.scope_id,
                    Policy.kind == active.kind,
                )
            )
            policy = Policy(
                id=new_prefixed_uuid7("pol"),
                scope=active.scope,
                scope_id=active.scope_id,
                kind=active.kind,
                version=next_version or 1,
                body=body,
                status="draft",
                source="drift_detector",
            )
            session.add(policy)
            session.flush()
            return CreateDraftPolicyResponse(
                policy_id=policy.id,
                version=policy.version,
            )

    def _active_policy_scope(self, tenant_uuid: str, kind: str) -> str:
        with self._tenant_sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            scope = session.scalar(
                select(Policy.scope)
                .where(Policy.kind == kind, Policy.status == "active")
                .order_by(
                    case((Policy.scope == "global", 0), else_=1).desc(),
                    Policy.version.desc(),
                )
                .limit(1)
            )
        if scope is None:
            raise PolicyNotFoundError("No active policy exists for this kind")
        return scope

    def promote_memory(
        self,
        *,
        tenant_uuid: str,
        memory_id: str,
        evaluation_run_id: str,
        global_write_authorized: bool = False,
    ) -> StoredMemoryPromotion:
        scope = self._visible_memory_scope(tenant_uuid, memory_id)
        if scope == "global" and not global_write_authorized:
            raise PolicyPermissionError(
                "global-scope memory promotion requires the privileged write credential"
            )
        sessions = self._system_sessions if scope == "global" else self._tenant_sessions
        with sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            record = session.scalar(
                select(MemoryRecord).where(MemoryRecord.id == memory_id).with_for_update()
            )
            if record is None:
                raise MemoryNotFoundError("Memory record does not exist for requesting tenant")
            if record.status == "promoted" and record.promoted_at is not None:
                # Idempotent re-call: no new promotion happened, so no new
                # ADS Core delivery should happen either -- destination=None
                # tells the service layer to skip delivery here (the real
                # destination this record has, if any, was already acted on
                # by whichever call first transitioned it to "promoted").
                return StoredMemoryPromotion(
                    memory_id=record.id,
                    promoted_at=record.promoted_at,
                    destination=None,
                    content=record.content,
                    scope=record.scope,
                )
            if record.status != "candidate":
                raise MemoryPromotionConflictError(
                    f"Memory status {record.status!r} cannot be promoted"
                )

            promoted_at = datetime.now(UTC)
            if record.scope == "global":
                record.content = anonymize_global_content(record.content)
                record.provenance = anonymized_global_provenance(evaluation_run_id)
                record.tenant_id = None
                record.destination = "policy_store"
            else:
                record.provenance = {
                    **record.provenance,
                    "promotion": {"evaluation_run_id": evaluation_run_id},
                }
                record.destination = (
                    "ads_memory_namespace" if record.scope == "project" else "policy_store"
                )
            record.status = "promoted"
            record.promoted_at = promoted_at
            session.flush()
            return StoredMemoryPromotion(
                memory_id=record.id,
                promoted_at=promoted_at,
                destination=record.destination,
                content=record.content,
                scope=record.scope,
            )

    def revert_memory(
        self,
        *,
        tenant_uuid: str,
        memory_id: str,
        reason: str,
        global_write_authorized: bool = False,
    ) -> StoredMemoryRevocation:
        """Real, symmetric reverse of promote_memory: promoted -> reverted.

        Same scope-gated privileged-write rule as promotion (a global
        memory can only be reverted by policy_system_writer). Never
        touches tenant_id -- a globally-promoted record's original
        tenant_id and pre-anonymization content are already gone
        (anonymize_global_content overwrote them at promotion time), so
        reverting a global record un-publishes it going forward without
        pretending to restore what promotion irreversibly discarded.
        destination is cleared: an already-reverted record no longer
        claims to live anywhere.
        """
        scope = self._visible_memory_scope(tenant_uuid, memory_id)
        if scope == "global" and not global_write_authorized:
            raise PolicyPermissionError(
                "global-scope memory revocation requires the privileged write credential"
            )
        sessions = self._system_sessions if scope == "global" else self._tenant_sessions
        with sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            record = session.scalar(
                select(MemoryRecord).where(MemoryRecord.id == memory_id).with_for_update()
            )
            if record is None:
                raise MemoryNotFoundError("Memory record does not exist for requesting tenant")
            if record.status == "reverted" and record.reverted_at is not None:
                return StoredMemoryRevocation(
                    memory_id=record.id,
                    reverted_at=record.reverted_at,
                )
            if record.status != "promoted":
                raise MemoryRevertConflictError(
                    f"Memory status {record.status!r} cannot be reverted"
                )

            reverted_at = datetime.now(UTC)
            record.status = "reverted"
            record.reverted_at = reverted_at
            record.destination = None
            # A global row is readable by every tenant, and a revocation reason
            # is free text -- often the very tenant detail that made the lesson
            # unsafe. Only the fact of revocation is kept on it (design log §22,
            # enforced by memory_records_global_is_content_free).
            record.provenance = {
                **record.provenance,
                "revocation": {"reverted": True}
                if record.tenant_id is None
                else {"reason": reason},
            }
            session.flush()
            return StoredMemoryRevocation(
                memory_id=record.id,
                reverted_at=reverted_at,
            )

    def get_active_policy(self, *, tenant_uuid: str, kind: str) -> Policy | None:
        """Real read for real-time policy consumption (e.g. HEAL-6's
        recovery-strategy-table). Prefers a more specific scope over
        'global' when both happen to have an active row for the same
        kind (tenant-scoped override wins), then the highest version --
        not just "highest version wins" regardless of scope, which could
        otherwise pick the wrong row. Only 'global' rows are seeded
        today; the scope-preference ordering is real and correct, not
        exercised by real tenant-scoped overrides yet (disclosed)."""
        with self._tenant_sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            return session.scalar(
                select(Policy)
                .where(Policy.kind == kind, Policy.status == "active")
                .order_by(
                    case((Policy.scope == "global", 0), else_=1).desc(),
                    Policy.version.desc(),
                )
                .limit(1)
            )

    def _visible_policy_scope(self, tenant_uuid: str, policy_id: str) -> str:
        with self._tenant_sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            scope = session.scalar(select(Policy.scope).where(Policy.id == policy_id))
        if scope is None:
            raise PolicyNotFoundError("Policy does not exist for requesting tenant")
        return scope

    def _visible_memory_scope(self, tenant_uuid: str, memory_id: str) -> str:
        with self._tenant_sessions.begin() as session:
            self._set_tenant(session, tenant_uuid)
            scope = session.scalar(
                select(MemoryRecord.scope).where(MemoryRecord.id == memory_id)
            )
        if scope is None:
            raise MemoryNotFoundError("Memory record does not exist for requesting tenant")
        return scope

    @staticmethod
    def _set_tenant(session: Session, tenant_uuid: str) -> None:
        session.execute(_SET_TENANT, {"tenant_id": tenant_uuid})

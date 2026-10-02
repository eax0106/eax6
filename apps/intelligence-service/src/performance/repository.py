from __future__ import annotations

from typing import cast

from sqlalchemy import func, insert, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.ids import new_prefixed_id
from src.db.models import PerformanceRecord

from .models import DriftCandidate, PerformanceObservation, PerformanceVerdict

_SET_TENANT = text("SELECT set_config('app.current_tenant_id', :tenant_id, true)")


class AgentTenantMismatchError(Exception):
    pass


class PerformanceAgentNotFoundError(Exception):
    pass


class PerformanceRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def _assert_agent_owner(self, tenant_uuid: str, agent_id: str) -> None:
        owner = (
            await self._session.execute(
                text("SELECT public.agent_owner_tenant(:agent_id)"), {"agent_id": agent_id}
            )
        ).scalar_one()
        if owner is None:
            raise PerformanceAgentNotFoundError("AGENT_NOT_FOUND")
        if str(owner) != tenant_uuid:
            raise AgentTenantMismatchError("SERVICE_TENANT_MISMATCH")

    async def load_agent_observations(
        self,
        *,
        tenant_uuid: str,
        agent_id: str,
        task_class: str,
        limit: int,
    ) -> tuple[PerformanceObservation, ...]:
        await self._session.execute(_SET_TENANT, {"tenant_id": tenant_uuid})
        await self._assert_agent_owner(tenant_uuid, agent_id)
        rows = (
            await self._session.scalars(
                select(PerformanceRecord)
                .where(
                    PerformanceRecord.tenant_id == tenant_uuid,
                    PerformanceRecord.agent_id == agent_id,
                    PerformanceRecord.task_category == task_class,
                )
                .order_by(
                    PerformanceRecord.recorded_at.desc(),
                    PerformanceRecord.created_at.desc(),
                    PerformanceRecord.id.desc(),
                )
                .limit(limit)
            )
        ).all()
        return tuple(
            PerformanceObservation(
                verdict=cast(PerformanceVerdict, row.verdict),
                latency_ms=row.latency_ms,
                token_count=row.token_count,
                recorded_at=row.recorded_at,
            )
            for row in rows
        )

    async def record_observation(
        self,
        *,
        agent_id: str,
        tenant_uuid: str,
        run_id: str | None,
        node_type: str | None,
        task_category: str | None,
        verdict: PerformanceVerdict,
        latency_ms: int | None,
        token_count: int | None,
        draft_promotion_threshold: int,
    ) -> str:
        """The real performance_records writer -- until this call was added,
        the table (and the promotion/drift logic that reads it) had zero
        real writers anywhere in the monorepo. tenant_id/agent_id must
        reference a real row in agents (FK), so an unknown agent fails
        closed via IntegrityError, not a silently-accepted orphan record.

        A success observation also runs the draft->active promotion check
        in the same transaction as the insert, so the count it sees always
        includes the row just written."""
        await self._session.execute(_SET_TENANT, {"tenant_id": tenant_uuid})
        await self._assert_agent_owner(tenant_uuid, agent_id)
        record_id = new_prefixed_id("perf")
        await self._session.execute(
            insert(PerformanceRecord).values(
                id=record_id,
                agent_id=agent_id,
                tenant_id=tenant_uuid,
                run_id=run_id,
                node_type=node_type,
                task_category=task_category,
                verdict=verdict,
                latency_ms=latency_ms,
                token_count=token_count,
            )
        )
        if verdict == "success":
            await self._promote_draft_agent_if_eligible(
                agent_id=agent_id,
                tenant_uuid=tenant_uuid,
                threshold=draft_promotion_threshold,
            )
        await self._session.commit()
        return record_id

    async def _promote_draft_agent_if_eligible(
        self, *, agent_id: str, tenant_uuid: str, threshold: int
    ) -> None:
        status_result = await self._session.execute(
            text(
                "SELECT status FROM agents "
                "WHERE tenant_id = CAST(:tenant_id AS uuid) AND id = :agent_id"
            ),
            {"tenant_id": tenant_uuid, "agent_id": agent_id},
        )
        status = status_result.scalar_one_or_none()
        if status != "draft":
            return
        count_result = await self._session.execute(
            text(
                "SELECT COUNT(*) FROM performance_records "
                "WHERE tenant_id = CAST(:tenant_id AS uuid) AND agent_id = :agent_id "
                "AND verdict = 'success'"
            ),
            {"tenant_id": tenant_uuid, "agent_id": agent_id},
        )
        success_count = int(count_result.scalar_one())
        if success_count < threshold:
            return
        await self._session.execute(
            text(
                "UPDATE agents SET status = 'active' "
                "WHERE tenant_id = CAST(:tenant_id AS uuid) AND id = :agent_id "
                "AND status = 'draft'"
            ),
            {"tenant_id": tenant_uuid, "agent_id": agent_id},
        )

    async def list_drift_candidates(
        self, *, minimum_observations: int
    ) -> tuple[DriftCandidate, ...]:
        rows = (
            await self._session.execute(
                select(
                    PerformanceRecord.tenant_id,
                    PerformanceRecord.agent_id,
                    PerformanceRecord.task_category,
                )
                .where(PerformanceRecord.task_category.is_not(None))
                .group_by(
                    PerformanceRecord.tenant_id,
                    PerformanceRecord.agent_id,
                    PerformanceRecord.task_category,
                )
                .having(func.count() >= minimum_observations)
                .order_by(
                    PerformanceRecord.tenant_id,
                    PerformanceRecord.agent_id,
                    PerformanceRecord.task_category,
                )
            )
        ).all()
        return tuple(
            DriftCandidate(
                tenant_id=f"ten_{tenant_id}",
                agent_id=agent_id,
                task_class=task_class,
            )
            for tenant_id, agent_id, task_class in rows
            if task_class is not None
        )

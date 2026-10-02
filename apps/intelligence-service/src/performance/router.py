from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Path, Query
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from src.config import get_settings
from src.db.ids import validate_prefixed_id
from src.db.session import get_db_session
from src.service_auth import fastapi_dependency

from .audit import audit_tenant_assertion
from .models import (
    AgentPerformanceResponse,
    DriftCandidateResponse,
    RecordPerformanceRequest,
    RecordPerformanceResponse,
)
from .repository import (
    AgentTenantMismatchError,
    PerformanceAgentNotFoundError,
    PerformanceRepository,
)

SessionDep = Annotated[AsyncSession, Depends(get_db_session)]
router = APIRouter(
    prefix="/internal/performance", tags=["performance"], dependencies=[fastapi_dependency()]
)
_drift_session_factory: async_sessionmaker[AsyncSession] | None = None


@asynccontextmanager
async def performance_lifespan(app: FastAPI) -> AsyncIterator[None]:
    del app
    global _drift_session_factory
    engine = create_async_engine(
        get_settings().intelligence_drift_reader_db_url, pool_pre_ping=True
    )
    _drift_session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield
    finally:
        _drift_session_factory = None
        await engine.dispose()


async def get_drift_session() -> AsyncIterator[AsyncSession]:
    if _drift_session_factory is None:
        raise RuntimeError("drift discovery session not initialised")
    async with _drift_session_factory() as session:
        yield session


DriftSessionDep = Annotated[AsyncSession, Depends(get_drift_session)]


@asynccontextmanager
async def audited_assertion(tenant_id: str, agent_id: str, action: str) -> AsyncIterator[None]:
    result, reason = "success", ""
    try:
        yield
    except AgentTenantMismatchError as error:
        result, reason = "denied", "SERVICE_TENANT_MISMATCH"
        raise HTTPException(status_code=403, detail={"error_code": reason}) from error
    except PerformanceAgentNotFoundError as error:
        result, reason = "error", "AGENT_NOT_FOUND"
        raise HTTPException(status_code=404, detail={"error_code": reason}) from error
    except Exception:
        result = "error"
        raise
    finally:
        await audit_tenant_assertion(tenant_id, agent_id, action, result, reason)


@router.get("/agents/{agent_id}", response_model=AgentPerformanceResponse)
async def agent_performance(
    session: SessionDep,
    agent_id: Annotated[str, Path()],
    tenant_id: Annotated[str, Query()],
    task_class: Annotated[str, Query(min_length=1, max_length=100)],
    limit: Annotated[int, Query(ge=4, le=200)] = 40,
) -> AgentPerformanceResponse:
    try:
        validate_prefixed_id("ten", tenant_id)
        validate_prefixed_id("agt", agent_id)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    tenant_uuid = tenant_id.removeprefix("ten_")
    async with audited_assertion(tenant_id, agent_id, "agent.performance.read"):
        observations = await PerformanceRepository(session).load_agent_observations(
            tenant_uuid=tenant_uuid,
            agent_id=agent_id,
            task_class=task_class,
            limit=limit,
        )
    return AgentPerformanceResponse(
        agent_id=agent_id,
        task_class=task_class,
        observations=observations,
    )


@router.post(
    "/agents/{agent_id}/records",
    response_model=RecordPerformanceResponse,
    status_code=201,
)
async def record_agent_performance(
    session: SessionDep,
    agent_id: Annotated[str, Path()],
    body: RecordPerformanceRequest,
) -> RecordPerformanceResponse:
    try:
        validate_prefixed_id("ten", body.tenant_id)
        validate_prefixed_id("agt", agent_id)
        if body.run_id is not None:
            validate_prefixed_id("run", body.run_id)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    tenant_uuid = body.tenant_id.removeprefix("ten_")
    async with audited_assertion(body.tenant_id, agent_id, "agent.performance.record"):
        try:
            record_id = await PerformanceRepository(session).record_observation(
                agent_id=agent_id,
                tenant_uuid=tenant_uuid,
                run_id=body.run_id,
                node_type=body.node_type,
                task_category=body.task_category,
                verdict=body.verdict,
                latency_ms=body.latency_ms,
                token_count=body.token_count,
                draft_promotion_threshold=get_settings().draft_agent_promotion_threshold,
            )
        except IntegrityError as error:
            await session.rollback()
            raise HTTPException(
                status_code=404,
                detail=f"agent {agent_id} does not exist for tenant {body.tenant_id}",
            ) from error
    return RecordPerformanceResponse(id=record_id)


@router.get("/drift-candidates", response_model=DriftCandidateResponse)
async def drift_candidates(
    session: DriftSessionDep,
    minimum_observations: Annotated[int, Query(ge=4, le=200)],
) -> DriftCandidateResponse:
    return DriftCandidateResponse(
        candidates=await PerformanceRepository(session).list_drift_candidates(
            minimum_observations=minimum_observations
        )
    )

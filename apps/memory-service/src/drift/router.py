from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from src.config import get_settings
from src.m2m_auth import lazy_auth0_m2m_token_provider_from_settings
from src.policy_store.router import get_policy_store_service

from .cost_ledger_client import (
    CostLedgerOutcomeUnavailableError,
    HttpxCostLedgerOutcomeClient,
)
from .detector import DriftDetector, DriftValidationError, InsufficientPerformanceDataError
from .intelligence_client import (
    HttpxIntelligencePerformanceClient,
    IntelligencePerformanceUnavailableError,
)
from .models import (
    ComputeAgentDriftRequest,
    ComputeAgentDriftResponse,
    ComputeModelDriftRequest,
    ComputeModelDriftResponse,
    ComputeProviderDriftRequest,
    ComputeProviderDriftResponse,
    ListAgentDriftRequest,
    ListAgentDriftResponse,
    ListModelDriftRequest,
    ListModelDriftResponse,
    ListProviderDriftRequest,
    ListProviderDriftResponse,
)
from .repository import SqlAlchemyDriftRepository

_default_detector: DriftDetector | None = None
_default_client: HttpxIntelligencePerformanceClient | None = None
_default_outcome_client: HttpxCostLedgerOutcomeClient | None = None


@asynccontextmanager
async def drift_lifespan(app: FastAPI) -> AsyncIterator[None]:
    del app
    global _default_client, _default_outcome_client, _default_detector
    settings = get_settings()
    tenant_engine = create_engine(settings.policy_db_url_sync, pool_pre_ping=True)
    system_engine = create_engine(settings.policy_db_system_url_sync, pool_pre_ping=True)
    token_provider = lazy_auth0_m2m_token_provider_from_settings(settings)
    _default_client = HttpxIntelligencePerformanceClient(
        str(settings.intelligence_service_base_url),
        settings.intelligence_service_timeout_seconds,
        service_token=settings.internal_service_token,
    )
    _default_outcome_client = HttpxCostLedgerOutcomeClient(
        str(settings.cost_ledger_service_base_url),
        settings.cost_ledger_service_timeout_seconds,
        access_token_provider=token_provider,
    )
    _default_detector = DriftDetector(
        _default_client,
        SqlAlchemyDriftRepository(
            sessionmaker(tenant_engine, class_=Session, expire_on_commit=False),
            sessionmaker(system_engine, class_=Session, expire_on_commit=False),
        ),
        get_policy_store_service(),
        window_size=settings.drift_window_size,
        failure_threshold=settings.drift_failure_threshold,
        outcome_client=_default_outcome_client,
        significance_level=settings.drift_significance_level,
    )
    try:
        yield
    finally:
        _default_detector = None
        await _default_client.close()
        _default_client = None
        await _default_outcome_client.close()
        _default_outcome_client = None
        system_engine.dispose()
        tenant_engine.dispose()


def get_drift_detector() -> DriftDetector:
    if _default_detector is None:
        raise RuntimeError("DriftDetector not initialised")
    return _default_detector


DetectorDep = Annotated[DriftDetector, Depends(get_drift_detector)]
AuthorizationHeader = Annotated[str, Header(alias="Authorization")]
router = APIRouter(prefix="/drift", tags=["drift"])


@router.post("/agents/score", response_model=ComputeAgentDriftResponse)
async def compute_agent_drift(
    request: ComputeAgentDriftRequest,
    detector: DetectorDep,
    authorization: AuthorizationHeader,
) -> ComputeAgentDriftResponse:
    try:
        return await detector.compute_agent_drift(request, authorization)
    except DriftValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except InsufficientPerformanceDataError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except IntelligencePerformanceUnavailableError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.post("/agents/scores", response_model=ListAgentDriftResponse)
async def list_agent_drift(
    request: ListAgentDriftRequest,
    detector: DetectorDep,
    authorization: AuthorizationHeader,
) -> ListAgentDriftResponse:
    try:
        return await detector.list_agent_drift(request, authorization)
    except DriftValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/models/score", response_model=ComputeModelDriftResponse)
async def compute_model_drift(
    request: ComputeModelDriftRequest,
    detector: DetectorDep,
    authorization: AuthorizationHeader,
) -> ComputeModelDriftResponse:
    try:
        return await detector.compute_model_drift(request, authorization)
    except DriftValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except InsufficientPerformanceDataError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except CostLedgerOutcomeUnavailableError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.post("/models/scores", response_model=ListModelDriftResponse)
async def list_model_drift(
    request: ListModelDriftRequest,
    detector: DetectorDep,
    authorization: AuthorizationHeader,
) -> ListModelDriftResponse:
    try:
        return await detector.list_model_drift(request, authorization)
    except DriftValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/providers/score", response_model=ComputeProviderDriftResponse)
async def compute_provider_drift(
    request: ComputeProviderDriftRequest,
    detector: DetectorDep,
    authorization: AuthorizationHeader,
) -> ComputeProviderDriftResponse:
    try:
        return await detector.compute_provider_drift(request, authorization)
    except DriftValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except InsufficientPerformanceDataError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except CostLedgerOutcomeUnavailableError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.post("/providers/scores", response_model=ListProviderDriftResponse)
async def list_provider_drift(
    request: ListProviderDriftRequest,
    detector: DetectorDep,
    authorization: AuthorizationHeader,
) -> ListProviderDriftResponse:
    try:
        return await detector.list_provider_drift(request, authorization)
    except DriftValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

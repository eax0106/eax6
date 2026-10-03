from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, status
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from src.config import get_settings
from src.m2m_auth import lazy_auth0_m2m_token_provider_from_settings
from src.memory_settings.redaction import GrpcMemoryRedactor, MemoryRedactionUnavailableError

from .extraction import MemoryLearningKernel, MemoryLearningValidationError
from .models import ProposeWritebackRequest, ProposeWritebackResponse
from .orchestration_client import (
    HttpxOrchestrationRunClient,
    OrchestrationUnavailableError,
    RunNotCompletedError,
    RunNotFoundError,
)
from .repository import SqlAlchemyMemoryCandidateRepository

_default_kernel: MemoryLearningKernel | None = None
_default_client: HttpxOrchestrationRunClient | None = None


@asynccontextmanager
async def memory_learning_lifespan(app: FastAPI) -> AsyncIterator[None]:
    del app
    global _default_client, _default_kernel
    settings = get_settings()
    engine = create_engine(settings.policy_db_url_sync, pool_pre_ping=True)
    sessions = sessionmaker(engine, class_=Session, expire_on_commit=False)
    _default_client = HttpxOrchestrationRunClient(
        str(settings.orchestration_service_base_url),
        settings.orchestration_service_timeout_seconds,
        access_token_provider=lazy_auth0_m2m_token_provider_from_settings(settings),
    )
    redactor = GrpcMemoryRedactor(
        settings.model_gateway_grpc_target, lazy_auth0_m2m_token_provider_from_settings(settings)
    )
    _default_kernel = MemoryLearningKernel(
        _default_client,
        SqlAlchemyMemoryCandidateRepository(sessions),
        redactor.redact,
    )
    try:
        yield
    finally:
        _default_kernel = None
        await _default_client.close()
        _default_client = None
        await redactor.close()
        engine.dispose()


def get_kernel() -> MemoryLearningKernel:
    if _default_kernel is None:
        raise RuntimeError("MemoryLearningKernel not initialised")
    return _default_kernel


KernelDep = Annotated[MemoryLearningKernel, Depends(get_kernel)]
AuthorizationHeader = Annotated[str, Header(alias="Authorization")]

router = APIRouter(prefix="/memory", tags=["memory"])


@router.post(
    "/propose-writeback",
    response_model=ProposeWritebackResponse,
    status_code=status.HTTP_200_OK,
)
async def propose_writeback(
    request: ProposeWritebackRequest,
    kernel: KernelDep,
    authorization: AuthorizationHeader,
) -> ProposeWritebackResponse:
    try:
        return await kernel.propose_writeback(request, authorization)
    except RunNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except RunNotCompletedError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except MemoryLearningValidationError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except OrchestrationUnavailableError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except MemoryRedactionUnavailableError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error

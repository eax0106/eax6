from __future__ import annotations

import hashlib
import hmac
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Header
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from starlette.concurrency import run_in_threadpool

from src.config import get_settings

from .errors import DeletionHttpError, deletion_problem
from .models import (
    DeleteRequest,
    DeletionResult,
    RetentionSweepResult,
    SubjectDataLocation,
    VerificationResult,
    VerifyRequest,
    WorkspaceDeleteRequest,
    WorkspaceRequest,
)
from .provider import IntelligenceDeletionProvider

_provider: IntelligenceDeletionProvider | None = None


@asynccontextmanager
async def deletion_lifespan(app: FastAPI) -> AsyncIterator[None]:
    del app
    global _provider
    settings = get_settings()
    engine = create_engine(settings.intelligence_db_url_sync, pool_pre_ping=True)
    system_url = settings.intelligence_deletion_db_url_sync
    system_engine = create_engine(system_url, pool_pre_ping=True) if system_url else None
    _provider = IntelligenceDeletionProvider(
        sessionmaker(engine, class_=Session, expire_on_commit=False),
        sessionmaker(system_engine, class_=Session, expire_on_commit=False)
        if system_engine
        else None,
    )
    try:
        yield
    finally:
        _provider = None
        engine.dispose()
        if system_engine is not None:
            system_engine.dispose()


def get_provider() -> IntelligenceDeletionProvider:
    if _provider is None:
        raise RuntimeError("Intelligence deletion provider is not initialized")
    return _provider


def _authorize(authorization: str | None) -> None:
    token = (
        authorization.removeprefix("Bearer ")
        if authorization is not None and authorization.startswith("Bearer ")
        else ""
    )
    expected = get_settings().deletion_service_token_sha256
    digest = hashlib.sha256(token.encode()).hexdigest()
    if not token or not expected or not hmac.compare_digest(digest, expected):
        raise deletion_problem(status=401, instance="/internal/deletion")


async def _run[T](instance: str, operation: Callable[..., T], *args: object) -> T:
    try:
        return await run_in_threadpool(operation, *args)
    except DeletionHttpError:
        raise
    except ValueError as error:
        raise deletion_problem(status=400, instance=instance) from error
    except Exception as error:
        raise deletion_problem(status=500, instance=instance) from error


ProviderDep = Annotated[IntelligenceDeletionProvider, Depends(get_provider)]
Auth = Annotated[str | None, Header(alias="Authorization")]
router = APIRouter(prefix="/internal/deletion", include_in_schema=False)


@router.get("/locate", response_model=tuple[SubjectDataLocation, ...])
async def locate(
    tenantId: str, provider: ProviderDep, authorization: Auth = None
) -> tuple[SubjectDataLocation, ...]:
    _authorize(authorization)
    return await _run("/internal/deletion/locate", provider.locate_subject_data, tenantId)


@router.post("/delete", response_model=DeletionResult)
async def delete(
    request: DeleteRequest, provider: ProviderDep, authorization: Auth = None
) -> DeletionResult:
    _authorize(authorization)
    return await _run(
        "/internal/deletion/delete",
        provider.delete_subject_data,
        request.tenantId,
        request.manifestId,
    )


@router.post("/verify", response_model=VerificationResult)
async def verify(
    request: VerifyRequest, provider: ProviderDep, authorization: Auth = None
) -> VerificationResult:
    _authorize(authorization)
    return await _run(
        "/internal/deletion/verify", provider.verify_deletion, request.tenantId, request.manifestId
    )


# D2: one workspace's erasure at the end of its undo window.
@router.post("/workspace/locate", response_model=tuple[SubjectDataLocation, ...])
async def locate_workspace(
    request: WorkspaceRequest, provider: ProviderDep, authorization: Auth = None
) -> tuple[SubjectDataLocation, ...]:
    _authorize(authorization)
    return await _run(
        "/internal/deletion/workspace/locate",
        provider.locate_workspace_data,
        request.tenantId,
        request.workspaceId,
    )


@router.post("/workspace/delete", response_model=DeletionResult)
async def delete_workspace(
    request: WorkspaceDeleteRequest, provider: ProviderDep, authorization: Auth = None
) -> DeletionResult:
    _authorize(authorization)
    return await _run(
        "/internal/deletion/workspace/delete",
        provider.delete_workspace_data,
        request.tenantId,
        request.workspaceId,
        request.manifestId,
    )


@router.post("/workspace/verify", response_model=VerificationResult)
async def verify_workspace(
    request: WorkspaceDeleteRequest, provider: ProviderDep, authorization: Auth = None
) -> VerificationResult:
    _authorize(authorization)
    return await _run(
        "/internal/deletion/workspace/verify",
        provider.verify_workspace_deletion,
        request.tenantId,
        request.workspaceId,
        request.manifestId,
    )


@router.post("/retention", response_model=RetentionSweepResult)
async def retention(provider: ProviderDep, authorization: Auth = None) -> RetentionSweepResult:
    _authorize(authorization)
    return await _run("/internal/deletion/retention", provider.apply_retention_policy)


@router.get("/subjects", response_model=tuple[str, ...])
async def subjects(provider: ProviderDep, authorization: Auth = None) -> tuple[str, ...]:
    _authorize(authorization)
    return await _run("/internal/deletion/subjects", provider.list_subject_ids)

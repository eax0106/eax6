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
from src.memory_namespace.client import GrpcWorkspaceMemoryClient

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
from .provider import AdsDeletionProvider, AuditOrchestratedObjectStorage

_provider: AdsDeletionProvider | None = None
_sessions: sessionmaker[Session] | None = None
_system_sessions: sessionmaker[Session] | None = None


@asynccontextmanager
async def deletion_lifespan(app: FastAPI) -> AsyncIterator[None]:
    del app
    global _provider, _sessions, _system_sessions
    settings = get_settings()
    engine = create_engine(settings.ads_db_url_sync, pool_pre_ping=True)
    system_engine = create_engine(settings.ads_deletion_db_url_sync, pool_pre_ping=True)
    _sessions = sessionmaker(engine, class_=Session, expire_on_commit=False)
    _system_sessions = sessionmaker(system_engine, class_=Session, expire_on_commit=False)
    memory_client = GrpcWorkspaceMemoryClient(
        settings.memory_service_address, settings.memory_service_authorization
    )
    _provider = AdsDeletionProvider(
        _sessions,
        AuditOrchestratedObjectStorage(),
        _system_sessions,
        memory_access=memory_client.access,
    )
    try:
        yield
    finally:
        memory_client.close()
        _provider = None
        _sessions = None
        _system_sessions = None
        engine.dispose()
        system_engine.dispose()


def get_provider() -> AdsDeletionProvider:
    if _provider is None:
        raise RuntimeError("ADS deletion provider is not initialized")
    return _provider


def _authorize(authorization: str | None) -> None:
    token = (
        authorization.removeprefix("Bearer ")
        if authorization is not None and authorization.startswith("Bearer ")
        else ""
    )
    digest = hashlib.sha256(token.encode()).hexdigest()
    if not token or not hmac.compare_digest(digest, get_settings().deletion_service_token_sha256):
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


ProviderDep = Annotated[AdsDeletionProvider, Depends(get_provider)]
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
        "/internal/deletion/verify",
        provider.verify_deletion,
        request.tenantId,
        request.manifestId,
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
async def subjects(authorization: Auth = None) -> tuple[str, ...]:
    _authorize(authorization)
    return await _run("/internal/deletion/subjects", get_provider().list_subject_ids)

from __future__ import annotations

import hashlib
import hmac
import os
from collections.abc import Callable
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, Header
from sqlalchemy import Engine
from starlette.concurrency import run_in_threadpool

from src.benchmarks.repository import tenant_eval_sessions
from src.config import DEFAULT_EVAL_DB_URL_SYNC

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
from .provider import EvalDeletionProvider


@lru_cache(maxsize=1)
def deletion_storage() -> tuple[Engine, EvalDeletionProvider]:
    engine, sessions = tenant_eval_sessions(
        os.environ.get("EVAL_DB_URL_SYNC", DEFAULT_EVAL_DB_URL_SYNC)
    )
    return engine, EvalDeletionProvider(sessions)


def get_provider() -> EvalDeletionProvider:
    return deletion_storage()[1]


def _authorize(authorization: str | None) -> None:
    token = (
        authorization.removeprefix("Bearer ")
        if authorization is not None and authorization.startswith("Bearer ")
        else ""
    )
    expected = os.environ.get("DELETION_SERVICE_TOKEN_SHA256", "").strip().lower()
    digest = hashlib.sha256(token.encode()).hexdigest()
    if not token or len(expected) != 64 or not hmac.compare_digest(digest, expected):
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


ProviderDep = Annotated[EvalDeletionProvider, Depends(get_provider)]
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

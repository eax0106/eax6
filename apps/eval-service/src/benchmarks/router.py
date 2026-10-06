"""D25 (b): tenant benchmark routes, called by platform-api on a member's
behalf. The application-level service credential guards every route; the
tenant and workspace travel in the request and scope every statement."""

from __future__ import annotations

import os
import re
from functools import lru_cache
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import Engine

from src.config import DEFAULT_EVAL_DB_URL_SYNC

from .repository import (
    MAX_CASES,
    BenchmarkConflict,
    BenchmarkNotFound,
    BenchmarkRepository,
    Scope,
    tenant_eval_sessions,
)
from .runner import CaseSimulator, HttpCaseSimulator, execute_run

router = APIRouter(prefix="/internal/benchmarks")

_UUID7 = r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
_TENANT = re.compile(rf"^ten_({_UUID7})$")
_WORKSPACE = re.compile(rf"^ws_({_UUID7})$")
_WORKFLOW = re.compile(rf"^wf_{_UUID7}$")
_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


@lru_cache(maxsize=1)
def benchmark_storage() -> tuple[Engine, BenchmarkRepository]:
    engine, sessions = tenant_eval_sessions(
        os.environ.get("EVAL_DB_URL_SYNC", DEFAULT_EVAL_DB_URL_SYNC)
    )
    return engine, BenchmarkRepository(sessions)


def benchmark_repository() -> BenchmarkRepository:
    return benchmark_storage()[1]


def case_simulator() -> CaseSimulator:
    return HttpCaseSimulator(
        os.environ.get("ORCHESTRATION_SERVICE_BASE_URL", "http://127.0.0.1:3010"),
        os.environ.get("INTERNAL_SERVICE_TOKEN", ""),
    )


def _scope(tenant_id: str, workspace_id: str) -> Scope:
    tenant = _TENANT.match(tenant_id.lower())
    workspace = _WORKSPACE.match(workspace_id.lower())
    if tenant is None or workspace is None:
        raise HTTPException(400, "Invalid tenant or workspace")
    return Scope(tenant=tenant.group(1), workspace=workspace.group(1))


def _id(value: str) -> str:
    if not _ID.match(value):
        raise HTTPException(404, "Not found")
    return value


class _Scoped(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: str
    workspace_id: str


class CaseInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    input: dict[str, Any]
    success_criteria: list[Annotated[str, Field(min_length=1, max_length=1000)]] = Field(
        min_length=1, max_length=20
    )

    @field_validator("success_criteria")
    @classmethod
    def criteria_not_blank(cls, value: list[str]) -> list[str]:
        if any(not item.strip() for item in value):
            raise ValueError("success criteria must not be blank")
        return [item.strip() for item in value]


class CreateDataset(_Scoped):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=2000)
    created_by: str = Field(min_length=1, max_length=200)
    cases: list[CaseInput] = Field(min_length=1, max_length=MAX_CASES)


class StartRun(_Scoped):
    workflow_id: str
    requested_by: str = Field(min_length=1, max_length=200)


@router.get("/datasets")
def list_datasets(
    repository: Annotated[BenchmarkRepository, Depends(benchmark_repository)],
    tenant_id: str,
    workspace_id: str,
) -> dict[str, Any]:
    return {"data": repository.list_datasets(_scope(tenant_id, workspace_id))}


@router.post("/datasets", status_code=201)
def create_dataset(
    body: CreateDataset,
    repository: Annotated[BenchmarkRepository, Depends(benchmark_repository)],
) -> dict[str, Any]:
    scope = _scope(body.tenant_id, body.workspace_id)
    if not body.name.strip():
        raise HTTPException(400, "Dataset name is required")
    try:
        return repository.create_dataset(
            scope,
            name=body.name.strip(),
            description=body.description.strip(),
            created_by=body.created_by,
            cases=[(case.input, case.success_criteria) for case in body.cases],
        )
    except BenchmarkConflict as error:
        raise HTTPException(409, "A dataset with this name already exists") from error


@router.get("/datasets/{dataset_id}")
def get_dataset(
    dataset_id: str,
    repository: Annotated[BenchmarkRepository, Depends(benchmark_repository)],
    tenant_id: str,
    workspace_id: str,
) -> dict[str, Any]:
    try:
        return repository.get_dataset(_scope(tenant_id, workspace_id), _id(dataset_id))
    except BenchmarkNotFound as error:
        raise HTTPException(404, "Not found") from error


@router.post("/datasets/{dataset_id}/runs", status_code=202)
async def start_run(
    dataset_id: str,
    body: StartRun,
    repository: Annotated[BenchmarkRepository, Depends(benchmark_repository)],
    simulator: Annotated[CaseSimulator, Depends(case_simulator)],
    background: BackgroundTasks,
) -> dict[str, Any]:
    scope = _scope(body.tenant_id, body.workspace_id)
    if not _WORKFLOW.match(body.workflow_id):
        raise HTTPException(400, "Invalid workflow")
    try:
        run = repository.create_run(
            scope, _id(dataset_id), workflow_id=body.workflow_id, requested_by=body.requested_by
        )
    except BenchmarkNotFound as error:
        raise HTTPException(404, "Not found") from error
    # The run proceeds after the response; its row reports progress.
    background.add_task(execute_run, repository, simulator, scope, run["id"], body.workflow_id)
    return run


@router.get("/runs")
def list_runs(
    repository: Annotated[BenchmarkRepository, Depends(benchmark_repository)],
    tenant_id: str,
    workspace_id: str,
    dataset_id: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
) -> dict[str, Any]:
    scope = _scope(tenant_id, workspace_id)
    dataset = None if dataset_id is None else _id(dataset_id)
    return {"data": repository.list_runs(scope, dataset_id=dataset, limit=limit)}


@router.get("/runs/{run_id}")
def get_run(
    run_id: str,
    repository: Annotated[BenchmarkRepository, Depends(benchmark_repository)],
    tenant_id: str,
    workspace_id: str,
) -> dict[str, Any]:
    try:
        return repository.get_run(_scope(tenant_id, workspace_id), _id(run_id))
    except BenchmarkNotFound as error:
        raise HTTPException(404, "Not found") from error

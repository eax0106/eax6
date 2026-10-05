"""D25 (b): execute a benchmark run, one case at a time, through the engine's
Simulate (orchestration-service /internal/benchmarks/simulate-case)."""

from __future__ import annotations

import logging
from typing import Any, Protocol

import httpx

from .repository import BenchmarkRepository, Scope

logger = logging.getLogger(__name__)


class RunStopped(Exception):
    """The workflow cannot be simulated at all; no later case can succeed."""


class CaseSimulator(Protocol):
    async def simulate(
        self, scope: Scope, workflow_id: str, case: dict[str, Any]
    ) -> dict[str, Any]: ...


class HttpCaseSimulator:
    def __init__(
        self, base_url: str, token: str, *, client: httpx.AsyncClient | None = None
    ) -> None:
        self._url = f"{base_url.rstrip('/')}/internal/benchmarks/simulate-case"
        self._token = token
        self._client = client

    async def simulate(
        self, scope: Scope, workflow_id: str, case: dict[str, Any]
    ) -> dict[str, Any]:
        body = {
            "tenant_id": f"ten_{scope.tenant}",
            "workspace_id": f"ws_{scope.workspace}",
            "workflow_id": workflow_id,
            "case_id": case["id"],
            "input": case["input"],
            "success_criteria": case["successCriteria"],
        }
        headers = {"Authorization": f"Bearer {self._token}"}
        client = self._client or httpx.AsyncClient(timeout=300)
        try:
            response = await client.post(self._url, json=body, headers=headers)
        finally:
            if self._client is None:
                await client.aclose()
        if response.status_code == 404:
            raise RunStopped("The workflow was not found in this workspace")
        if response.status_code == 409:
            raise RunStopped("The workflow has no active version to benchmark")
        response.raise_for_status()
        result: dict[str, Any] = response.json()
        return result


def _case_error(case: dict[str, Any], message: str) -> dict[str, Any]:
    return {"caseId": case["id"], "verdict": "error", "output": {}, "steps": [], "error": message}


async def execute_run(
    repository: BenchmarkRepository,
    simulator: CaseSimulator,
    scope: Scope,
    run_id: str,
    workflow_id: str,
) -> dict[str, Any]:
    """Run every remaining case, record each result, then aggregate the run."""
    repository.start_run(scope, run_id)
    try:
        for case in repository.run_cases(scope, run_id):
            try:
                result = await simulator.simulate(scope, workflow_id, case)
                result = {**result, "caseId": case["id"]}
            except RunStopped:
                raise
            except Exception as error:
                # One case that cannot be simulated does not hide the others.
                logger.warning("benchmark case %s could not be simulated: %s", case["id"], error)
                result = _case_error(case, "The case could not be simulated")
            repository.record_case_result(scope, run_id, result)
    except RunStopped as stopped:
        return repository.finish_run(scope, run_id, error=str(stopped))
    except Exception:
        logger.exception("benchmark run %s stopped", run_id)
        return repository.finish_run(scope, run_id, error="The run stopped before it finished")
    return repository.finish_run(scope, run_id)

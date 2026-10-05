"""D25 (b): tenant benchmark storage. Every statement runs in one tenant's
row-security context; workspace scoping is part of every predicate."""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

MAX_CASES = 100


class BenchmarkNotFound(Exception):
    pass


class BenchmarkConflict(Exception):
    pass


@dataclass(frozen=True)
class Scope:
    """A tenant and workspace, both bare UUIDs."""

    tenant: str
    workspace: str


def tenant_eval_sessions(url: str) -> tuple[Engine, sessionmaker[Session]]:
    """Sessions as eval_service with no internal context: tenant rows only."""
    engine = create_engine(url, pool_pre_ping=True)

    @event.listens_for(engine, "checkout")
    def set_role(dbapi_connection: object, _record: object, _proxy: object) -> None:
        cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
        try:
            cursor.execute("SET ROLE eval_service")
        finally:
            cursor.close()

    return engine, sessionmaker(bind=engine, expire_on_commit=False, class_=Session)


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.astimezone(UTC).isoformat()


def _number(value: Decimal | float | None) -> float | None:
    return None if value is None else float(value)


def _dataset(row: RowMapping) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "description": row["description"],
        "caseCount": int(row["case_count"]),
        "createdBy": row["created_by"],
        "createdAt": _iso(row["created_at"]),
    }


def _run(row: RowMapping) -> dict[str, Any]:
    return {
        "id": str(row["id"]),
        "datasetId": str(row["dataset_id"]),
        "workflowId": row["workflow_id"],
        "workflowVersionId": row["workflow_version_id"],
        "status": row["status"],
        "caseCount": row["case_count"],
        "passed": row["passed"],
        "failed": row["failed"],
        "errored": row["errored"],
        "passRate": _number(row["pass_rate"]),
        "inputTokens": int(row["input_tokens"]),
        "outputTokens": int(row["output_tokens"]),
        "estimatedCostUsd": _number(row["estimated_cost_usd"]),
        "error": row["error"],
        "requestedBy": row["requested_by"],
        "createdAt": _iso(row["created_at"]),
        "startedAt": _iso(row["started_at"]),
        "completedAt": _iso(row["completed_at"]),
    }


class BenchmarkRepository:
    def __init__(self, sessions: sessionmaker[Session]) -> None:
        self._sessions = sessions

    def unfinished_runs(self) -> list[tuple[Scope, str]]:
        """Runs left pending or running, across tenants (read-only inventory)."""
        with self._sessions.begin() as session:
            session.execute(text("SELECT set_config('app.eval_tenant_inventory', 'on', true)"))
            rows = session.execute(
                text(
                    "SELECT tenant_id, workspace_id, id FROM benchmark_runs"
                    " WHERE status IN ('pending', 'running')"
                )
            ).all()
            return [(Scope(str(row[0]), str(row[1])), str(row[2])) for row in rows]

    def close_interrupted_runs(self) -> int:
        """At startup no run of this process can still be executing."""
        runs = self.unfinished_runs()
        for scope, run_id in runs:
            self.finish_run(scope, run_id, error="The run was interrupted before it finished")
        return len(runs)

    @contextmanager
    def _tenant(self, scope: Scope) -> Iterator[Session]:
        with self._sessions.begin() as session:
            session.execute(
                text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
                {"tenant": scope.tenant},
            )
            yield session

    def create_dataset(
        self,
        scope: Scope,
        *,
        name: str,
        description: str,
        created_by: str,
        cases: Sequence[tuple[dict[str, Any], Sequence[str]]],
    ) -> dict[str, Any]:
        if not 1 <= len(cases) <= MAX_CASES:
            raise ValueError(f"a dataset holds 1 to {MAX_CASES} cases")
        dataset_id = str(uuid.uuid4())
        try:
            with self._tenant(scope) as session:
                session.execute(
                    text(
                        "INSERT INTO benchmark_datasets"
                        " (id, tenant_id, workspace_id, name, description, created_by)"
                        " VALUES (:id, :tenant, :workspace, :name, :description, :created_by)"
                    ),
                    {
                        "id": dataset_id,
                        "tenant": scope.tenant,
                        "workspace": scope.workspace,
                        "name": name,
                        "description": description,
                        "created_by": created_by,
                    },
                )
                for position, (case_input, criteria) in enumerate(cases):
                    session.execute(
                        text(
                            "INSERT INTO benchmark_cases (id, tenant_id, workspace_id, dataset_id,"
                            " position, input, success_criteria) VALUES (:id, :tenant, :workspace,"
                            " :dataset, :position, CAST(:input AS jsonb), CAST(:criteria AS jsonb))"
                        ),
                        {
                            "id": str(uuid.uuid4()),
                            "tenant": scope.tenant,
                            "workspace": scope.workspace,
                            "dataset": dataset_id,
                            "position": position,
                            "input": json.dumps(case_input),
                            "criteria": json.dumps(list(criteria)),
                        },
                    )
        except IntegrityError as error:
            raise BenchmarkConflict("a dataset with this name already exists") from error
        return self.get_dataset(scope, dataset_id)

    def list_datasets(self, scope: Scope) -> list[dict[str, Any]]:
        with self._tenant(scope) as session:
            rows = session.execute(
                text(
                    "SELECT d.*, (SELECT count(*) FROM benchmark_cases c WHERE c.dataset_id = d.id)"
                    " AS case_count FROM benchmark_datasets d"
                    " WHERE d.tenant_id = :tenant AND d.workspace_id = :workspace"
                    " ORDER BY d.created_at DESC, d.id DESC LIMIT 200"
                ),
                {"tenant": scope.tenant, "workspace": scope.workspace},
            ).mappings()
            return [_dataset(row) for row in rows]

    def get_dataset(self, scope: Scope, dataset_id: str) -> dict[str, Any]:
        with self._tenant(scope) as session:
            row = (
                session.execute(
                    text(
                        "SELECT d.*, (SELECT count(*) FROM benchmark_cases c"
                        " WHERE c.dataset_id = d.id) AS case_count FROM benchmark_datasets d"
                        " WHERE d.tenant_id = :tenant AND d.workspace_id = :workspace"
                        " AND d.id = :id"
                    ),
                    {"tenant": scope.tenant, "workspace": scope.workspace, "id": dataset_id},
                )
                .mappings()
                .first()
            )
            if row is None:
                raise BenchmarkNotFound(dataset_id)
            cases = session.execute(
                text(
                    "SELECT id, position, input, success_criteria FROM benchmark_cases"
                    " WHERE tenant_id = :tenant AND dataset_id = :id ORDER BY position"
                ),
                {"tenant": scope.tenant, "id": dataset_id},
            ).mappings()
            return {
                **_dataset(row),
                "cases": [
                    {
                        "id": str(case["id"]),
                        "position": case["position"],
                        "input": case["input"],
                        "successCriteria": case["success_criteria"],
                    }
                    for case in cases
                ],
            }

    def create_run(
        self, scope: Scope, dataset_id: str, *, workflow_id: str, requested_by: str
    ) -> dict[str, Any]:
        dataset = self.get_dataset(scope, dataset_id)
        run_id = str(uuid.uuid4())
        with self._tenant(scope) as session:
            session.execute(
                text(
                    "INSERT INTO benchmark_runs (id, tenant_id, workspace_id, dataset_id,"
                    " workflow_id, status, case_count, requested_by) VALUES (:id, :tenant,"
                    " :workspace, :dataset, :workflow, 'pending', :count, :requested_by)"
                ),
                {
                    "id": run_id,
                    "tenant": scope.tenant,
                    "workspace": scope.workspace,
                    "dataset": dataset_id,
                    "workflow": workflow_id,
                    "count": dataset["caseCount"],
                    "requested_by": requested_by,
                },
            )
        return self.get_run(scope, run_id)

    def start_run(self, scope: Scope, run_id: str) -> None:
        with self._tenant(scope) as session:
            session.execute(
                text(
                    "UPDATE benchmark_runs SET status = 'running', started_at = now()"
                    " WHERE tenant_id = :tenant AND id = :id AND status = 'pending'"
                ),
                {"tenant": scope.tenant, "id": run_id},
            )

    def record_case_result(self, scope: Scope, run_id: str, result: dict[str, Any]) -> None:
        usage = result.get("usage") or {}
        with self._tenant(scope) as session:
            session.execute(
                text(
                    "INSERT INTO benchmark_case_results (id, tenant_id, workspace_id, run_id,"
                    " case_id, verdict, score, threshold, reviewer_model, output, steps,"
                    " input_tokens, output_tokens, estimated_cost_usd, duration_ms, error,"
                    " simulation_run_id) VALUES (:id, :tenant, :workspace, :run, :case, :verdict,"
                    " :score, :threshold, :reviewer, CAST(:output AS jsonb), CAST(:steps AS jsonb),"
                    " :input_tokens, :output_tokens, :cost, :duration, :error, :simulation)"
                    " ON CONFLICT (run_id, case_id) DO NOTHING"
                ),
                {
                    "id": str(uuid.uuid4()),
                    "tenant": scope.tenant,
                    "workspace": scope.workspace,
                    "run": run_id,
                    "case": result["caseId"],
                    "verdict": result["verdict"],
                    "score": result.get("score"),
                    "threshold": result.get("threshold"),
                    "reviewer": result.get("reviewerModel"),
                    "output": json.dumps(result.get("output") or {}),
                    "steps": json.dumps(result.get("steps") or []),
                    "input_tokens": int(usage.get("inputTokens") or 0),
                    "output_tokens": int(usage.get("outputTokens") or 0),
                    "cost": usage.get("estimatedCostUsd"),
                    "duration": int(result.get("durationMs") or 0),
                    "error": result.get("error"),
                    "simulation": result.get("simulationRunId"),
                },
            )
            if result.get("workflowVersionId"):
                session.execute(
                    text(
                        "UPDATE benchmark_runs SET workflow_version_id = :version"
                        " WHERE tenant_id = :tenant AND id = :id AND workflow_version_id IS NULL"
                    ),
                    {"tenant": scope.tenant, "id": run_id, "version": result["workflowVersionId"]},
                )

    def finish_run(self, scope: Scope, run_id: str, error: str | None = None) -> dict[str, Any]:
        """Aggregate the recorded case results. A run that could not continue fails."""
        with self._tenant(scope) as session:
            session.execute(
                text(
                    "UPDATE benchmark_runs r SET"
                    " passed = a.passed, failed = a.failed, errored = a.errored,"
                    " pass_rate = CASE WHEN :error IS NULL"
                    "   THEN a.passed::numeric / r.case_count END,"
                    " input_tokens = a.input_tokens, output_tokens = a.output_tokens,"
                    " estimated_cost_usd = a.cost,"
                    " status = CASE WHEN :error IS NULL THEN 'completed' ELSE 'failed' END,"
                    " error = :error, completed_at = now()"
                    " FROM (SELECT count(*) FILTER (WHERE verdict = 'pass') AS passed,"
                    "   count(*) FILTER (WHERE verdict = 'fail') AS failed,"
                    "   count(*) FILTER (WHERE verdict = 'error') AS errored,"
                    "   coalesce(sum(input_tokens), 0) AS input_tokens,"
                    "   coalesce(sum(output_tokens), 0) AS output_tokens,"
                    "   sum(estimated_cost_usd) AS cost"
                    "   FROM benchmark_case_results WHERE tenant_id = :tenant AND run_id = :id) a"
                    " WHERE r.tenant_id = :tenant AND r.id = :id"
                ),
                {"tenant": scope.tenant, "id": run_id, "error": error},
            )
        return self.get_run(scope, run_id)

    def list_runs(
        self, scope: Scope, *, dataset_id: str | None, limit: int
    ) -> list[dict[str, Any]]:
        with self._tenant(scope) as session:
            rows = session.execute(
                text(
                    "SELECT * FROM benchmark_runs WHERE tenant_id = :tenant"
                    " AND workspace_id = :workspace"
                    " AND (CAST(:dataset AS uuid) IS NULL OR dataset_id = CAST(:dataset AS uuid))"
                    " ORDER BY created_at DESC, id DESC LIMIT :limit"
                ),
                {
                    "tenant": scope.tenant,
                    "workspace": scope.workspace,
                    "dataset": dataset_id,
                    "limit": limit,
                },
            ).mappings()
            return [_run(row) for row in rows]

    def get_run(self, scope: Scope, run_id: str) -> dict[str, Any]:
        with self._tenant(scope) as session:
            row = (
                session.execute(
                    text(
                        "SELECT * FROM benchmark_runs WHERE tenant_id = :tenant"
                        " AND workspace_id = :workspace AND id = :id"
                    ),
                    {"tenant": scope.tenant, "workspace": scope.workspace, "id": run_id},
                )
                .mappings()
                .first()
            )
            if row is None:
                raise BenchmarkNotFound(run_id)
            results = session.execute(
                text(
                    "SELECT r.*, c.position FROM benchmark_case_results r"
                    " JOIN benchmark_cases c ON c.tenant_id = r.tenant_id AND c.id = r.case_id"
                    " WHERE r.tenant_id = :tenant AND r.run_id = :id ORDER BY c.position"
                ),
                {"tenant": scope.tenant, "id": run_id},
            ).mappings()
            return {
                **_run(row),
                "results": [
                    {
                        "caseId": str(result["case_id"]),
                        "position": result["position"],
                        "verdict": result["verdict"],
                        "score": _number(result["score"]),
                        "threshold": _number(result["threshold"]),
                        "reviewerModel": result["reviewer_model"],
                        "output": result["output"],
                        "steps": result["steps"],
                        "inputTokens": int(result["input_tokens"]),
                        "outputTokens": int(result["output_tokens"]),
                        "estimatedCostUsd": _number(result["estimated_cost_usd"]),
                        "durationMs": result["duration_ms"],
                        "error": result["error"],
                    }
                    for result in results
                ],
            }

    def run_cases(self, scope: Scope, run_id: str) -> list[dict[str, Any]]:
        """The cases a run executes: its dataset's cases still lacking a result."""
        with self._tenant(scope) as session:
            rows = session.execute(
                text(
                    "SELECT c.id, c.input, c.success_criteria FROM benchmark_runs r"
                    " JOIN benchmark_cases c ON c.tenant_id = r.tenant_id"
                    "  AND c.dataset_id = r.dataset_id"
                    " WHERE r.tenant_id = :tenant AND r.id = :id AND NOT EXISTS ("
                    "  SELECT 1 FROM benchmark_case_results x"
                    "  WHERE x.run_id = r.id AND x.case_id = c.id)"
                    " ORDER BY c.position"
                ),
                {"tenant": scope.tenant, "id": run_id},
            ).mappings()
            return [
                {
                    "id": str(row["id"]),
                    "input": row["input"],
                    "successCriteria": row["success_criteria"],
                }
                for row in rows
            ]

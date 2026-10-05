"""D25 (b): tenant benchmark datasets and runs on real Postgres, held to
forced row security through the non-superuser eval_service role."""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from collections.abc import Generator
from pathlib import Path
from typing import Any

import httpx
import pytest
import sqlalchemy as sa
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.benchmarks.repository import (
    BenchmarkConflict,
    BenchmarkNotFound,
    BenchmarkRepository,
    Scope,
    tenant_eval_sessions,
)
from src.benchmarks.router import benchmark_repository, case_simulator
from src.benchmarks.runner import HttpCaseSimulator, RunStopped, execute_run
from src.db.session import global_eval_sessions
from src.deletion.provider import EvalDeletionProvider
from src.deletion.router import get_provider
from src.main import app

TOKEN = "benchmark-service-test-credential"
DELETION_TOKEN = "benchmark-deletion-test-credential"


def uuid7() -> str:
    raw = bytearray(uuid.uuid4().bytes)
    raw[6] = (raw[6] & 0x0F) | 0x70
    raw[8] = (raw[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(raw)))


TENANT, WORKSPACE, OTHER_WORKSPACE, OTHER_TENANT = uuid7(), uuid7(), uuid7(), uuid7()
SCOPE = Scope(TENANT, WORKSPACE)
WORKFLOW = f"wf_{uuid7()}"


@pytest.fixture(scope="module")
def database() -> Generator[tuple[str, sessionmaker[Session]], None, None]:
    with PostgresContainer("postgres:16-alpine", dbname="eval_db") as postgres:
        url = postgres.get_connection_url()
        config = Config(str(Path(__file__).parent.parent / "alembic.ini"))
        config.set_main_option("script_location", str(Path(__file__).parent.parent / "alembic"))
        config.set_main_option("sqlalchemy.url", url)
        command.upgrade(config, "head")
        admin = sa.create_engine(url)
        with admin.begin() as tx:
            tx.execute(sa.text("CREATE ROLE eval_service NOLOGIN NOBYPASSRLS NOSUPERUSER"))
            tx.execute(sa.text("GRANT eval_service TO CURRENT_USER"))
            tx.execute(sa.text("GRANT USAGE ON SCHEMA public TO eval_service"))
            tx.execute(
                sa.text(
                    "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public "
                    "TO eval_service"
                )
            )
        admin.dispose()
        engine, sessions = tenant_eval_sessions(url)
        yield url, sessions
        engine.dispose()


@pytest.fixture
def repository(database: tuple[str, sessionmaker[Session]]) -> BenchmarkRepository:
    return BenchmarkRepository(database[1])


def dataset(
    repository: BenchmarkRepository, scope: Scope = SCOPE, cases: int = 2
) -> dict[str, Any]:
    return repository.create_dataset(
        scope,
        name=f"leads-{uuid.uuid4()}",
        description="Lead capture checks",
        created_by="usr_member",
        cases=[({"name": f"Lead {i}"}, [f"Greets Lead {i}"]) for i in range(cases)],
    )


class FakeSimulator:
    def __init__(self, verdicts: list[str] | None = None, stop: bool = False) -> None:
        self.verdicts = verdicts or []
        self.stop = stop
        self.calls: list[tuple[Scope, str, dict[str, Any]]] = []

    async def simulate(
        self, scope: Scope, workflow_id: str, case: dict[str, Any]
    ) -> dict[str, Any]:
        self.calls.append((scope, workflow_id, case))
        if self.stop:
            raise RunStopped("The workflow has no active version to benchmark")
        verdict = self.verdicts.pop(0) if self.verdicts else "pass"
        if verdict == "raise":
            raise httpx.ConnectError("engine unreachable")
        return {
            "caseId": case["id"],
            "workflowVersionId": "wfv_1",
            "simulationRunId": "run_1",
            "verdict": verdict,
            "score": 0.9 if verdict == "pass" else 0.2,
            "threshold": 0.7,
            "reviewerModel": "reviewer",
            "output": {"draft": {"text": "Hello"}},
            "steps": [{"key": "send", "type": "ToolCall", "status": "simulated"}],
            "usage": {"inputTokens": 100, "outputTokens": 20, "estimatedCostUsd": 0.001},
            "durationMs": 40,
            "error": None,
        }


def test_dataset_round_trip_and_name_conflict(repository: BenchmarkRepository) -> None:
    created = dataset(repository)
    assert created["caseCount"] == 2
    assert [case["input"] for case in created["cases"]] == [{"name": "Lead 0"}, {"name": "Lead 1"}]
    assert created["cases"][0]["successCriteria"] == ["Greets Lead 0"]
    assert created["id"] in {item["id"] for item in repository.list_datasets(SCOPE)}
    with pytest.raises(BenchmarkConflict):
        repository.create_dataset(
            SCOPE, name=created["name"], description="", created_by="usr", cases=[({}, ["x"])]
        )


def test_other_workspace_and_tenant_cannot_see_a_dataset(repository: BenchmarkRepository) -> None:
    created = dataset(repository)
    with pytest.raises(BenchmarkNotFound):
        repository.get_dataset(Scope(TENANT, OTHER_WORKSPACE), created["id"])
    with pytest.raises(BenchmarkNotFound):
        repository.get_dataset(Scope(OTHER_TENANT, WORKSPACE), created["id"])
    assert created["id"] not in {
        item["id"] for item in repository.list_datasets(Scope(OTHER_TENANT, WORKSPACE))
    }


def test_row_security_hides_tenant_rows_from_other_contexts(
    database: tuple[str, sessionmaker[Session]], repository: BenchmarkRepository
) -> None:
    dataset(repository)
    url, sessions = database
    with sessions.begin() as session:
        # No tenant context: nothing.
        assert session.scalar(sa.text("SELECT count(*) FROM benchmark_datasets")) == 0
    engine, internal = global_eval_sessions(url)
    with internal.begin() as session:
        # Alter's golden-set context never reaches customer benchmarks.
        assert session.scalar(sa.text("SELECT count(*) FROM benchmark_datasets")) == 0
    engine.dispose()
    with sessions.begin() as session:
        session.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": OTHER_TENANT}
        )
        with pytest.raises(sa.exc.ProgrammingError):
            session.execute(
                sa.text(
                    "INSERT INTO benchmark_datasets (id, tenant_id, workspace_id, name, created_by)"
                    " VALUES (:id, :tenant, :workspace, 'x', 'u')"
                ),
                {"id": str(uuid.uuid4()), "tenant": TENANT, "workspace": WORKSPACE},
            )


def test_run_executes_every_case_and_aggregates(repository: BenchmarkRepository) -> None:
    created = dataset(repository, cases=4)
    run = repository.create_run(
        SCOPE, created["id"], workflow_id=WORKFLOW, requested_by="usr_member"
    )
    assert run["status"] == "pending"
    simulator = FakeSimulator(["pass", "fail", "raise", "pass"])

    finished = asyncio.run(execute_run(repository, simulator, SCOPE, run["id"], WORKFLOW))

    assert [call[2]["input"] for call in simulator.calls] == [
        {"name": f"Lead {i}"} for i in range(4)
    ]
    assert all(call[1] == WORKFLOW and call[0] == SCOPE for call in simulator.calls)
    assert finished["status"] == "completed"
    assert (finished["passed"], finished["failed"], finished["errored"]) == (2, 1, 1)
    assert finished["passRate"] == 0.5
    assert (finished["inputTokens"], finished["outputTokens"]) == (300, 60)
    assert finished["estimatedCostUsd"] == pytest.approx(0.003)
    assert finished["workflowVersionId"] == "wfv_1"
    assert [result["verdict"] for result in finished["results"]] == [
        "pass",
        "fail",
        "error",
        "pass",
    ]
    assert finished["results"][2]["error"] == "The case could not be simulated"
    assert finished["results"][0]["steps"] == [
        {"key": "send", "type": "ToolCall", "status": "simulated"}
    ]
    listed = repository.list_runs(SCOPE, dataset_id=created["id"], limit=10)
    assert [item["id"] for item in listed] == [run["id"]]


def test_a_workflow_that_cannot_run_fails_the_run(repository: BenchmarkRepository) -> None:
    created = dataset(repository)
    run = repository.create_run(SCOPE, created["id"], workflow_id=WORKFLOW, requested_by="usr")
    finished = asyncio.run(
        execute_run(repository, FakeSimulator(stop=True), SCOPE, run["id"], WORKFLOW)
    )
    assert finished["status"] == "failed"
    assert finished["error"] == "The workflow has no active version to benchmark"
    assert finished["passRate"] is None


def test_restart_closes_interrupted_runs(repository: BenchmarkRepository) -> None:
    created = dataset(repository)
    run = repository.create_run(SCOPE, created["id"], workflow_id=WORKFLOW, requested_by="usr")
    repository.start_run(SCOPE, run["id"])
    assert repository.close_interrupted_runs() >= 1
    closed = repository.get_run(SCOPE, run["id"])
    assert closed["status"] == "failed"
    assert closed["error"] == "The run was interrupted before it finished"


def test_http_simulator_sends_the_scoped_case_with_the_service_credential() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if b"missing" in request.content:
            return httpx.Response(404)
        return httpx.Response(200, json={"verdict": "pass"})

    async def call(case_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            simulator = HttpCaseSimulator("http://engine.test/", "engine-token", client=client)
            return await simulator.simulate(
                SCOPE, WORKFLOW, {"id": case_id, "input": {"a": 1}, "successCriteria": ["ok"]}
            )

    assert asyncio.run(call("case-1")) == {"verdict": "pass"}
    request = seen[0]
    assert str(request.url) == "http://engine.test/internal/benchmarks/simulate-case"
    assert request.headers["authorization"] == "Bearer engine-token"
    import json

    assert json.loads(request.content) == {
        "tenant_id": f"ten_{TENANT}",
        "workspace_id": f"ws_{WORKSPACE}",
        "workflow_id": WORKFLOW,
        "case_id": "case-1",
        "input": {"a": 1},
        "success_criteria": ["ok"],
    }
    with pytest.raises(RunStopped):
        asyncio.run(call("missing"))


@pytest.fixture
def client(
    repository: BenchmarkRepository,
    database: tuple[str, sessionmaker[Session]],
    monkeypatch: pytest.MonkeyPatch,
) -> Generator[TestClient, None, None]:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN_SHA256", hashlib.sha256(TOKEN.encode()).hexdigest())
    monkeypatch.setenv(
        "DELETION_SERVICE_TOKEN_SHA256", hashlib.sha256(DELETION_TOKEN.encode()).hexdigest()
    )
    simulator = FakeSimulator()
    app.dependency_overrides[benchmark_repository] = lambda: repository
    app.dependency_overrides[case_simulator] = lambda: simulator
    app.dependency_overrides[get_provider] = lambda: EvalDeletionProvider(database[1])
    yield TestClient(app)
    app.dependency_overrides.clear()


def auth(token: str = TOKEN) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def scoped(workspace: str = WORKSPACE) -> dict[str, str]:
    return {"tenant_id": f"ten_{TENANT}", "workspace_id": f"ws_{workspace}"}


def test_routes_require_the_service_credential(client: TestClient) -> None:
    assert client.get("/internal/benchmarks/datasets", params=scoped()).status_code == 401
    assert (
        client.get("/internal/benchmarks/datasets", params=scoped(), headers=auth("x")).status_code
        == 401
    )


def test_routes_create_run_and_read_benchmarks(client: TestClient) -> None:
    body = {
        **scoped(),
        "name": f"route-{uuid.uuid4()}",
        "created_by": "usr_member",
        "cases": [{"input": {"name": "Asha"}, "success_criteria": ["Greets Asha"]}],
    }
    created = client.post("/internal/benchmarks/datasets", json=body, headers=auth())
    assert created.status_code == 201
    dataset_id = created.json()["id"]
    assert (
        client.post("/internal/benchmarks/datasets", json=body, headers=auth()).status_code == 409
    )
    other = client.get(
        f"/internal/benchmarks/datasets/{dataset_id}",
        params=scoped(OTHER_WORKSPACE),
        headers=auth(),
    )
    assert other.status_code == 404

    started = client.post(
        f"/internal/benchmarks/datasets/{dataset_id}/runs",
        json={**scoped(), "workflow_id": WORKFLOW, "requested_by": "usr_member"},
        headers=auth(),
    )
    assert started.status_code == 202
    run_id = started.json()["id"]
    detail = client.get(
        f"/internal/benchmarks/runs/{run_id}", params=scoped(), headers=auth()
    ).json()
    assert detail["status"] == "completed"
    assert detail["passRate"] == 1.0
    runs = client.get(
        "/internal/benchmarks/runs", params={**scoped(), "dataset_id": dataset_id}, headers=auth()
    )
    assert [item["id"] for item in runs.json()["data"]] == [run_id]


@pytest.mark.parametrize(
    "change",
    [
        {"cases": []},
        {"cases": [{"input": {}, "success_criteria": []}]},
        {"cases": [{"input": {}, "success_criteria": ["  "]}]},
        {"tenant_id": "tenant"},
        {"name": ""},
        {"extra": True},
    ],
)
def test_routes_reject_invalid_datasets(client: TestClient, change: dict[str, Any]) -> None:
    body = {
        **scoped(),
        "name": "x",
        "created_by": "u",
        "cases": [{"input": {}, "success_criteria": ["ok"]}],
        **change,
    }
    assert client.post("/internal/benchmarks/datasets", json=body, headers=auth()).status_code in (
        400,
        422,
    )


def test_runs_reject_a_malformed_workflow(
    client: TestClient, repository: BenchmarkRepository
) -> None:
    created = dataset(repository)
    response = client.post(
        f"/internal/benchmarks/datasets/{created['id']}/runs",
        json={**scoped(), "workflow_id": "wf_bad", "requested_by": "u"},
        headers=auth(),
    )
    assert response.status_code == 400


def test_workspace_and_tenant_erasure(client: TestClient, repository: BenchmarkRepository) -> None:
    tenant, workspace, kept_workspace, kept_tenant = uuid7(), uuid7(), uuid7(), uuid7()
    for scope in (
        Scope(tenant, workspace),
        Scope(tenant, kept_workspace),
        Scope(kept_tenant, workspace),
    ):
        created = dataset(repository, scope)
        run = repository.create_run(scope, created["id"], workflow_id=WORKFLOW, requested_by="u")
        asyncio.run(execute_run(repository, FakeSimulator(), scope, run["id"], WORKFLOW))
    deletion = {"Authorization": f"Bearer {DELETION_TOKEN}"}
    manifest = f"del_{uuid.uuid4()}"
    workspace_body = {"tenantId": f"ten_{tenant}", "workspaceId": f"ws_{workspace}"}

    assert (
        client.post(
            "/internal/deletion/workspace/locate", json=workspace_body, headers=auth()
        ).status_code
        == 401
    )
    located = client.post(
        "/internal/deletion/workspace/locate", json=workspace_body, headers=deletion
    ).json()
    assert {item["table"]: item["rowCount"] for item in located} == {
        "benchmark_case_results": 2,
        "benchmark_cases": 2,
        "benchmark_datasets": 1,
        "benchmark_runs": 1,
    }
    deleted = client.post(
        "/internal/deletion/workspace/delete",
        json={**workspace_body, "manifestId": manifest},
        headers=deletion,
    )
    assert deleted.json()["deletedRows"] == 6
    verified = client.post(
        "/internal/deletion/workspace/verify",
        json={**workspace_body, "manifestId": manifest},
        headers=deletion,
    )
    assert verified.json()["deleted"] is True
    assert repository.list_datasets(Scope(tenant, kept_workspace)) != []

    subjects = client.get("/internal/deletion/subjects", headers=deletion).json()
    assert f"ten_{tenant}" in subjects and f"ten_{kept_tenant}" in subjects
    client.post(
        "/internal/deletion/delete",
        json={"tenantId": f"ten_{tenant}", "manifestId": manifest},
        headers=deletion,
    )
    tenant_verified = client.post(
        "/internal/deletion/verify",
        json={"tenantId": f"ten_{tenant}", "manifestId": manifest},
        headers=deletion,
    )
    assert tenant_verified.json()["deleted"] is True
    assert repository.list_datasets(Scope(kept_tenant, workspace)) != []
    assert (
        client.get(
            "/internal/deletion/locate", params={"tenantId": "ten_bad"}, headers=deletion
        ).status_code
        == 400
    )

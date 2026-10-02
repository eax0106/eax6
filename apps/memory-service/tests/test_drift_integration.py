from __future__ import annotations

import asyncio
import hashlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Generator, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
import sqlalchemy as sa
from alembic.config import Config as AlembicConfig
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.drift.cost_ledger_client import CostLedgerOutcomeClient
from src.drift.detector import DriftDetector, InsufficientPerformanceDataError
from src.drift.intelligence_client import HttpxIntelligencePerformanceClient
from src.drift.models import (
    ComputeAgentDriftRequest,
    ComputeAgentDriftResponse,
    ComputeModelDriftRequest,
    ComputeProviderDriftRequest,
    ListAgentDriftRequest,
    ListModelDriftRequest,
    ListProviderDriftRequest,
    ModelOutcomeObservation,
    ModelOutcomeWindow,
    PerformanceVerdict,
)
from src.drift.repository import SqlAlchemyDriftRepository
from src.policy_store.models import GetActivePolicyRequest
from src.policy_store.repository import SqlAlchemyPolicyStoreRepository
from src.policy_store.service import PolicyStoreService

MEMORY_ROOT = Path(__file__).parent.parent
INTELLIGENCE_ROOT = MEMORY_ROOT.parent / "intelligence-service"
TENANT_UUID = "038f4d6e-2b4a-7a3e-8c1a-1234567890ab"
TENANT_ID = f"ten_{TENANT_UUID}"
OTHER_TENANT_ID = "ten_048f4d6e-2b4a-7a3e-8c1a-1234567890ab"
WORKSPACE_UUID = "038f4d6e-2b4a-7a3e-8c1a-1234567890ac"
DRIFTED_AGENT_ID = "agt_038f4d6e-2b4a-7a3e-8c1a-1234567890ad"
STABLE_AGENT_ID = "agt_038f4d6e-2b4a-7a3e-8c1a-1234567890ae"
TASK_CLASS = "analysis"
SYSTEM_PASSWORD = "know15-system-test-only"
TENANT_ROLE = "know15_tenant_writer"
TENANT_PASSWORD = "know15-tenant-test-only"
DRIFT_READER_PASSWORD = "drift-reader-test-only"



class _UnexercisedOutcomeClient:
    """This test file covers agent drift only -- model/provider drift has
    its own dedicated coverage. Satisfies CostLedgerOutcomeClient's real
    Protocol shape without a real cost-ledger-service running."""

    async def load_outcome_window(
        self, *, provider: str, resource: str | None, limit: int
    ) -> ModelOutcomeWindow:
        raise AssertionError("not exercised by this test")


_UNEXERCISED_OUTCOME_CLIENT: CostLedgerOutcomeClient = _UnexercisedOutcomeClient()


def _outcome_window(
    *, baseline: Sequence[PerformanceVerdict], recent: Sequence[PerformanceVerdict]
) -> ModelOutcomeWindow:
    # Real cost-ledger-service returns observations most-recent-first
    # (ORDER BY recorded_at DESC); [*recent, *baseline] with strictly
    # increasing minutes-in-the-past reproduces that ordering directly,
    # without seeding a real table.
    now = datetime.now(UTC)
    observations = tuple(
        ModelOutcomeObservation(verdict=verdict, recorded_at=now - timedelta(minutes=index))
        for index, verdict in enumerate([*recent, *baseline])
    )
    return ModelOutcomeWindow(observations=observations)


class _FakeOutcomeClient:
    def __init__(self, windows: dict[tuple[str, str | None], ModelOutcomeWindow]) -> None:
        self._windows = windows

    async def load_outcome_window(
        self, *, provider: str, resource: str | None, limit: int
    ) -> ModelOutcomeWindow:
        del limit
        return self._windows.get((provider, resource), ModelOutcomeWindow(observations=()))


def _free_port() -> int:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _stop_process_tree(process: subprocess.Popen[str]) -> str:
    """Stop a spawned service and everything it started, then return its output.

    `uv run uvicorn` is not one process. On Windows it is uv, then the venv's
    launcher, then the real interpreter that holds the sockets, and
    `Popen.terminate()` reaches only the first: the interpreter outlived every
    test run, kept its ports, and made the next run fail to bind (#148).
    taskkill /T walks the tree from the root. On POSIX the service is started
    in its own session, so the whole group can be signalled at once.
    """
    # sys.platform rather than os.name: it is what type checkers narrow on, so
    # killpg and SIGKILL are checked only where they exist.
    if sys.platform == "win32":
        if process.poll() is None:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                capture_output=True,
                check=False,
            )
        output, _ = process.communicate(timeout=10)
        return output or ""
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
    try:
        output, _ = process.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        output, _ = process.communicate(timeout=10)
    return output or ""


def _migrate(service_root: Path, url: str) -> None:
    config = AlembicConfig(str(service_root / "alembic.ini"))
    config.set_main_option("script_location", str(service_root / "alembic"))
    config.set_main_option("sqlalchemy.url", url)
    command.upgrade(config, "head")


def _role_url(url: str, username: str, password: str) -> str:
    return make_url(url).set(username=username, password=password).render_as_string(
        hide_password=False
    )


def _async_url(url: str) -> str:
    return make_url(url).set(drivername="postgresql+asyncpg").render_as_string(
        hide_password=False
    )


def _seed_agent_performance(
    url: str,
    *,
    agent_id: str,
    baseline: Sequence[str],
    recent: Sequence[str],
) -> None:
    engine = sa.create_engine(url)
    now = datetime.now(UTC)
    observations = [*baseline, *recent]
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                """
INSERT INTO agents(id,tenant_id,workspace_id,name,tier,status)
VALUES (:agent,CAST(:tenant AS uuid),CAST(:workspace AS uuid),:name,'STANDARD','active')
"""
            ),
            {
                "agent": agent_id,
                "tenant": TENANT_UUID,
                "workspace": WORKSPACE_UUID,
                "name": f"Agent {agent_id[-1]}",
            },
        )
        for index, verdict in enumerate(observations):
            connection.execute(
                sa.text(
                    """
INSERT INTO performance_records(
  id,agent_id,tenant_id,run_id,node_type,task_category,verdict,recorded_at
)
VALUES (
  :id,:agent,CAST(:tenant AS uuid),:run_id,'LLMTask',:task_class,:verdict,:recorded_at
)
"""
                ),
                {
                    "id": f"perf-{agent_id}-{index}",
                    "agent": agent_id,
                    "tenant": TENANT_UUID,
                    "run_id": f"run-seeded-{index}",
                    "task_class": TASK_CLASS,
                    "verdict": verdict,
                    "recorded_at": now - timedelta(minutes=len(observations) - index),
                },
            )
    engine.dispose()


@pytest.fixture(scope="module")
def drift_stack() -> Generator[dict[str, str], None, None]:
    with (
        PostgresContainer(
            image="pgvector/pgvector:pg16",
            dbname="intelligence_db",
            username="intelligence_service",
            password="testpass",
        ) as intelligence_postgres,
        PostgresContainer(
            image="postgres:16-alpine", dbname="policy_db"
        ) as policy_postgres,
    ):
        intelligence_url = intelligence_postgres.get_connection_url()
        policy_admin_url = policy_postgres.get_connection_url()
        _migrate(INTELLIGENCE_ROOT, intelligence_url)
        _migrate(MEMORY_ROOT, policy_admin_url)
        intelligence_admin = sa.create_engine(intelligence_url, isolation_level="AUTOCOMMIT")
        with intelligence_admin.connect() as connection:
            connection.execute(
                sa.text(
                    "ALTER ROLE intelligence_drift_reader LOGIN PASSWORD "
                    f"'{DRIFT_READER_PASSWORD}'"
                )
            )
        intelligence_admin.dispose()
        _seed_agent_performance(
            intelligence_url,
            agent_id=DRIFTED_AGENT_ID,
            baseline=("success", "success", "success", "success"),
            recent=("failure", "failure", "failure", "failure"),
        )
        _seed_agent_performance(
            intelligence_url,
            agent_id=STABLE_AGENT_ID,
            baseline=("success", "success", "success", "failure"),
            recent=("success", "success", "success", "failure"),
        )

        policy_admin = sa.create_engine(policy_admin_url, isolation_level="AUTOCOMMIT")
        with policy_admin.connect() as connection:
            connection.execute(
                sa.text(
                    "CREATE ROLE policy_system_writer LOGIN PASSWORD "
                    f"'{SYSTEM_PASSWORD}'"
                )
            )
            connection.execute(
                sa.text("GRANT CONNECT ON DATABASE policy_db TO policy_system_writer")
            )
            connection.execute(
                sa.text("GRANT USAGE ON SCHEMA public TO policy_system_writer")
            )
            connection.execute(
                sa.text(
                    "GRANT SELECT, INSERT ON drift_scores TO policy_system_writer"
                )
            )
            connection.execute(
                sa.text(f"CREATE ROLE {TENANT_ROLE} LOGIN PASSWORD '{TENANT_PASSWORD}'")
            )
            connection.execute(
                sa.text(f"GRANT CONNECT ON DATABASE policy_db TO {TENANT_ROLE}")
            )
            connection.execute(sa.text(f"GRANT USAGE ON SCHEMA public TO {TENANT_ROLE}"))
            connection.execute(
                sa.text(f"GRANT SELECT, INSERT ON drift_scores TO {TENANT_ROLE}")
            )
            connection.execute(
                sa.text(
                    f"GRANT SELECT, INSERT, UPDATE ON policies, policy_promotions "
                    f"TO {TENANT_ROLE}"
                )
            )
        policy_admin.dispose()

        port = _free_port()
        environment = os.environ.copy()
        environment["INTELLIGENCE_DB_URL"] = _async_url(intelligence_url)
        environment["INTELLIGENCE_DB_URL_SYNC"] = intelligence_url
        environment["INTELLIGENCE_DRIFT_READER_DB_URL"] = _async_url(
            _role_url(
                intelligence_url,
                "intelligence_drift_reader",
                DRIFT_READER_PASSWORD,
            )
        )
        environment["INTERNAL_SERVICE_TOKEN_SHA256"] = hashlib.sha256(
            b"integration-token"
        ).hexdigest()
        # intelligence-service also serves the Capability Resolver over gRPC,
        # on 0.0.0.0:50061 unless told otherwise. The HTTP port was already
        # ephemeral; the gRPC one was not, so a single surviving process -- or
        # two fixtures alive at once -- failed every later bind (#148).
        environment["CAPABILITY_GRPC_BIND_ADDRESS"] = f"127.0.0.1:{_free_port()}"
        process = subprocess.Popen(
            [
                "uv",
                "run",
                "--frozen",
                "uvicorn",
                "src.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            cwd=INTELLIGENCE_ROOT,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            # Its own process group on POSIX, so teardown can signal the tree.
            start_new_session=sys.platform != "win32",
        )
        base_url = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if process.poll() is not None:
                output = process.stdout.read() if process.stdout is not None else ""
                raise RuntimeError(f"intelligence-service exited during startup: {output}")
            try:
                if httpx.get(f"{base_url}/health", timeout=0.5).status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.1)
        else:
            output = _stop_process_tree(process)
            raise RuntimeError(f"intelligence-service failed to become healthy: {output}")

        try:
            yield {
                "intelligence_base_url": base_url,
                "policy_admin_url": policy_admin_url,
                "policy_system_url": _role_url(
                    policy_admin_url, "policy_system_writer", SYSTEM_PASSWORD
                ),
                "policy_tenant_url": _role_url(
                    policy_admin_url, TENANT_ROLE, TENANT_PASSWORD
                ),
            }
        finally:
            _stop_process_tree(process)


def test_real_performance_http_projection_computes_and_persists_drift(
    drift_stack: dict[str, str],
) -> None:
    cross_tenant = httpx.get(
        f"{drift_stack['intelligence_base_url']}/internal/performance/agents/"
        f"{DRIFTED_AGENT_ID}",
        params={"tenant_id": OTHER_TENANT_ID, "task_class": TASK_CLASS, "limit": 8},
        headers={"authorization": "Bearer integration-token"},
        timeout=5,
    )
    assert cross_tenant.status_code == 403
    assert cross_tenant.json()["detail"]["error_code"] == "SERVICE_TENANT_MISMATCH"

    candidates = httpx.get(
        f"{drift_stack['intelligence_base_url']}/internal/performance/drift-candidates",
        params={"minimum_observations": 8},
        headers={"authorization": "Bearer integration-token"},
        timeout=5,
    )
    assert candidates.status_code == 200
    assert candidates.json()["candidates"] == [
        {
            "tenant_id": TENANT_ID,
            "agent_id": DRIFTED_AGENT_ID,
            "task_class": TASK_CLASS,
        },
        {
            "tenant_id": TENANT_ID,
            "agent_id": STABLE_AGENT_ID,
            "task_class": TASK_CLASS,
        },
    ]

    system_engine = sa.create_engine(drift_stack["policy_system_url"])
    tenant_engine = sa.create_engine(drift_stack["policy_tenant_url"])
    repository = SqlAlchemyDriftRepository(
        sessionmaker(tenant_engine, class_=Session, expire_on_commit=False),
        sessionmaker(system_engine, class_=Session, expire_on_commit=False),
    )
    policy_store = PolicyStoreService(
        SqlAlchemyPolicyStoreRepository(
            sessionmaker(tenant_engine, class_=Session, expire_on_commit=False),
            sessionmaker(system_engine, class_=Session, expire_on_commit=False),
        )
    )
    with tenant_engine.begin() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant_id, true)"),
            {"tenant_id": TENANT_UUID},
        )
        connection.execute(
            sa.text(
                "INSERT INTO policies(id,scope,scope_id,kind,version,body,status,source) "
                "VALUES ('pol_038f4d6e-2b4a-7a3e-8c1a-1234567890ff','tenant',CAST(:tenant AS uuid),"
                "'routing_weights',1,CAST(:body AS jsonb),'active','human')"
            ),
            {"tenant": TENANT_UUID, "body": '{"similarity_weight": 0.8}'},
        )

    async def compute() -> tuple[ComputeAgentDriftResponse, ComputeAgentDriftResponse]:
        client = HttpxIntelligencePerformanceClient(
            drift_stack["intelligence_base_url"],
            timeout_seconds=5,
            service_token="integration-token",
        )
        detector = DriftDetector(
            client,
            repository,
            policy_store,
            window_size=4,
            failure_threshold=0.2,
            outcome_client=_UNEXERCISED_OUTCOME_CLIENT,
        )
        try:
            drifted = await detector.compute_agent_drift(
                ComputeAgentDriftRequest(
                    tenant_id=TENANT_ID,
                    agent_id=DRIFTED_AGENT_ID,
                    task_class=TASK_CLASS,
                ),
                "Bearer integration-token",
            )
            stable = await detector.compute_agent_drift(
                ComputeAgentDriftRequest(
                    tenant_id=TENANT_ID,
                    agent_id=STABLE_AGENT_ID,
                    task_class=TASK_CLASS,
                ),
                "Bearer integration-token",
            )
            return drifted, stable
        finally:
            await client.close()

    drifted, stable = asyncio.run(compute())
    assert drifted.score == 1.0
    assert drifted.baseline == 0.0
    assert drifted.action_taken == "weight_decay"
    assert stable.score == 0.0
    assert stable.action_taken == "none"
    active_policy = asyncio.run(
        policy_store.get_active_policy(
            GetActivePolicyRequest(tenant_id=TENANT_ID, kind="routing_weights"),
            "Bearer integration-token",
        )
    )
    assert json.loads(active_policy.body_json or "{}")["similarity_weight"] == 0.0

    async def list_scores(tenant_id: str) -> tuple[str, ...]:
        client = HttpxIntelligencePerformanceClient(
            drift_stack["intelligence_base_url"],
            timeout_seconds=5,
            service_token="integration-token",
        )
        detector = DriftDetector(
            client,
            repository,
            policy_store,
            window_size=4,
            failure_threshold=0.2,
            outcome_client=_UNEXERCISED_OUTCOME_CLIENT,
        )
        try:
            response = await detector.list_agent_drift(
                ListAgentDriftRequest(tenant_id=tenant_id, agent_id=DRIFTED_AGENT_ID),
                "Bearer integration-token",
            )
            return tuple(score.drift_score_id for score in response.scores)
        finally:
            await client.close()

    cross_tenant_scores = asyncio.run(list_scores(OTHER_TENANT_ID))
    same_tenant_scores = asyncio.run(list_scores(TENANT_ID))
    tenant_engine.dispose()
    # Another tenant sees nothing, and the owner sees its own score. Both come
    # from drift_read alone, not from an app-level ownership check.
    #
    # `same_tenant_scores` asserted `()` until 0006, which was accurate and
    # was the defect: the policy admitted only model and provider rows, so a
    # tenant reading back the agent drift written for it got an empty list --
    # indistinguishable from "this agent has never drifted".
    assert cross_tenant_scores == ()
    assert len(same_tenant_scores) == 1

    admin = sa.create_engine(drift_stack["policy_admin_url"])
    with admin.connect() as connection:
        rows = connection.execute(
            sa.text(
                "SELECT subject_type,subject_ref,task_class,score,baseline,\"window\",action_taken "
                "FROM drift_scores ORDER BY subject_ref"
            )
        ).mappings().all()
    admin.dispose()
    system_engine.dispose()
    assert len(rows) == 2
    assert {row["action_taken"] for row in rows} == {"weight_decay", "none"}
    drifted_row = next(row for row in rows if row["subject_ref"] == DRIFTED_AGENT_ID)
    assert drifted_row["subject_type"] == "agent"
    assert drifted_row["task_class"] == TASK_CLASS
    assert float(drifted_row["score"]) == 1.0
    assert drifted_row["window"]["formula"] == (
        "max(0,recent_failure_rate-baseline_failure_rate)"
    )


def test_model_and_provider_drift_computes_and_persists_real_rows(
    drift_stack: dict[str, str],
) -> None:
    """Covers the real gap agent drift never exercised: model_outcomes has
    no tenant_id at all (platform-wide, not tenant-owned), and drift_read's
    real policy (0001_create_policy_tables.py) permits SELECT of
    subject_type IN ('model','provider') unconditionally -- unlike agent
    rows, which the test above proves are default-deny for every tenant.
    The HTTP boundary to cost-ledger-service is faked (no real NestJS
    service in this stack); everything from there in -- the detector's
    scoring math, the real Postgres write, and the real RLS-gated read --
    is real, using the same drift_stack Postgres container and roles the
    agent-drift test above already provisions."""
    outcome_client = _FakeOutcomeClient(
        {
            ("bedrock/claude-sonnet-5", "tokens"): _outcome_window(
                baseline=("success", "success", "success", "success"),
                recent=("failure", "failure", "failure", "failure"),
            ),
            ("openai/gpt-5", "tokens"): _outcome_window(
                baseline=("success", "success", "success", "failure"),
                recent=("success", "success", "success", "failure"),
            ),
            ("bedrock", None): _outcome_window(
                baseline=("success", "success", "success", "success"),
                recent=("failure", "failure", "failure", "failure"),
            ),
        }
    )
    system_engine = sa.create_engine(drift_stack["policy_system_url"])
    tenant_engine = sa.create_engine(drift_stack["policy_tenant_url"])
    repository = SqlAlchemyDriftRepository(
        sessionmaker(tenant_engine, class_=Session, expire_on_commit=False),
        sessionmaker(system_engine, class_=Session, expire_on_commit=False),
    )
    policy_store = PolicyStoreService(
        SqlAlchemyPolicyStoreRepository(
            sessionmaker(tenant_engine, class_=Session, expire_on_commit=False),
            sessionmaker(system_engine, class_=Session, expire_on_commit=False),
        )
    )

    async def run() -> tuple[str, str, str, tuple[str, ...], tuple[str, ...]]:
        client = HttpxIntelligencePerformanceClient(
            drift_stack["intelligence_base_url"],
            timeout_seconds=5,
            service_token="integration-token",
        )
        detector = DriftDetector(
            client,
            repository,
            policy_store,
            window_size=4,
            failure_threshold=0.2,
            outcome_client=outcome_client,
        )
        try:
            drifted_model = await detector.compute_model_drift(
                ComputeModelDriftRequest(provider="bedrock/claude-sonnet-5", resource="tokens"),
                "Bearer integration-token",
            )
            stable_model = await detector.compute_model_drift(
                ComputeModelDriftRequest(provider="openai/gpt-5", resource="tokens"),
                "Bearer integration-token",
            )
            drifted_provider = await detector.compute_provider_drift(
                ComputeProviderDriftRequest(provider="bedrock"),
                "Bearer integration-token",
            )
            model_scores = await detector.list_model_drift(
                ListModelDriftRequest(provider="bedrock/claude-sonnet-5"),
                "Bearer integration-token",
            )
            provider_scores = await detector.list_provider_drift(
                ListProviderDriftRequest(provider="bedrock"),
                "Bearer integration-token",
            )
            return (
                drifted_model.action_taken,
                stable_model.action_taken,
                drifted_provider.action_taken,
                tuple(score.drift_score_id for score in model_scores.scores),
                tuple(score.drift_score_id for score in provider_scores.scores),
            )
        finally:
            await client.close()

    (
        drifted_model_action,
        stable_model_action,
        drifted_provider_action,
        model_score_ids,
        provider_score_ids,
    ) = asyncio.run(run())
    tenant_engine.dispose()

    # Real, unmodified RLS: model/provider rows are readable back through
    # the exact same tenant-role session agent rows are default-deny under.
    assert drifted_model_action == "flagged"
    assert stable_model_action == "none"
    assert drifted_provider_action == "flagged"
    assert len(model_score_ids) == 1
    assert len(provider_score_ids) == 1

    with pytest.raises(InsufficientPerformanceDataError):
        asyncio.run(
            DriftDetector(
                HttpxIntelligencePerformanceClient(
                    drift_stack["intelligence_base_url"],
                    timeout_seconds=5,
                    service_token="integration-token",
                ),
                repository,
                policy_store,
                window_size=4,
                failure_threshold=0.2,
                outcome_client=outcome_client,
            ).compute_model_drift(
                ComputeModelDriftRequest(provider="unknown/model", resource="tokens"),
                "Bearer integration-token",
            )
        )

    admin = sa.create_engine(drift_stack["policy_admin_url"])
    with admin.connect() as connection:
        rows = connection.execute(
            sa.text(
                "SELECT subject_type,subject_ref,task_class,\"window\" "
                "FROM drift_scores WHERE subject_type IN ('model','provider') "
                "ORDER BY subject_ref"
            )
        ).mappings().all()
    admin.dispose()
    system_engine.dispose()
    assert len(rows) == 3
    assert {row["subject_type"] for row in rows} == {"model", "provider"}
    assert all(row["task_class"] is None for row in rows)
    model_row = next(row for row in rows if row["subject_ref"] == "bedrock/claude-sonnet-5")
    assert model_row["window"]["resource"] == "tokens"
    provider_row = next(row for row in rows if row["subject_type"] == "provider")
    assert "resource" not in provider_row["window"]

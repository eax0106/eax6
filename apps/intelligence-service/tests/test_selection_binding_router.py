"""Real-Postgres coverage for HEAL-6 PR B's HTTP router over SelectionBindingEngine."""

from collections.abc import AsyncGenerator, Generator, Sequence
from pathlib import Path

import pytest
from alembic.config import Config as AlembicConfig
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.config import get_settings
from src.db.session import get_db_session
from src.main import app
from src.selection_binding import EmbeddingResult
from src.selection_binding.router import get_embedding_client, get_instructions_client

SERVICE_ROOT = Path(__file__).parent.parent
PGVECTOR_IMAGE = "pgvector/pgvector:pg16"

TEST_MODEL_ID = "test-embedding-v1"

TENANT_A = "ten_018f47a5-7b2c-7d10-8f11-123456789abc"
WORKSPACE_A = "ws_018f47a5-7b2c-7d10-8f11-123456789abc"
RUN_ID = "run_018f47a5-7b2c-7d10-8f11-123456789abc"
AGENT_A = "agt_018f47a5-7b2c-7d10-8f11-123456789ab1"


def raw_id(prefixed_id: str) -> str:
    return prefixed_id.split("_", maxsplit=1)[1]


class FakeEmbeddingClient:
    def __init__(self, vector: Sequence[float]) -> None:
        self.vector = vector

    async def embed(self, *, tenant_id: str, text: str) -> EmbeddingResult:
        return EmbeddingResult(vector=self.vector, model_id=TEST_MODEL_ID)


class FakeInstructionsClient:
    async def draft_instructions(self, **kwargs: object) -> str:
        return "Handle text.generation work from supplied context and check the result."


def vector(first: float) -> list[float]:
    return [first, *([0.0] * 511)]


@pytest.fixture(scope="module")
def postgres_url() -> Generator[str, None, None]:
    with PostgresContainer(
        image=PGVECTOR_IMAGE,
        dbname="intelligence_db",
        username="intelligence_service",
        password="testpass",
    ) as postgres:
        sync_url = postgres.get_connection_url()
        alembic_config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        alembic_config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        alembic_config.set_main_option("sqlalchemy.url", sync_url)
        command.upgrade(alembic_config, "head")
        yield sync_url


async def seed_agent_with_preferred_binding(session: AsyncSession) -> None:
    tenant_uuid = raw_id(TENANT_A)
    await session.execute(
        text(
            """
INSERT INTO agents (id, tenant_id, workspace_id, name, tier, status)
VALUES (:agent_id, CAST(:tenant_id AS uuid), CAST(:workspace_id AS uuid),
        'Agent A', 'STANDARD', 'active')
"""
        ),
        {"agent_id": AGENT_A, "tenant_id": tenant_uuid, "workspace_id": raw_id(WORKSPACE_A)},
    )
    await session.execute(
        text(
            """
INSERT INTO agent_versions (id, agent_id, tenant_id, version_number, published_at)
VALUES (:id, :agent_id, CAST(:tenant_id AS uuid), 1, now())
"""
        ),
        {"id": f"agtv-{AGENT_A}-1", "agent_id": AGENT_A, "tenant_id": tenant_uuid},
    )
    await session.commit()


def request_body(*, preferred_agent_id: str | None = None) -> dict[str, object]:
    requirement: dict[str, object] = {"capabilities": ["text.generation"]}
    if preferred_agent_id is not None:
        requirement["preferred_agent_id"] = preferred_agent_id
    return {
        "tenant_id": TENANT_A,
        "run_id": RUN_ID,
        "node_key": "node.one",
        "node_requirements_json": f'{{"node.one": {_json(requirement)}}}',
        "workspace_id": WORKSPACE_A,
        "node_type": "LLMTask",
        "task_category": "analysis",
    }


def _json(value: dict[str, object]) -> str:
    import json

    return json.dumps(value)


def seed(postgres_url: str) -> None:
    """Runs seeding on its own fresh event loop/connection -- kept fully
    separate from TestClient's own loop (see `client` fixture docstring)."""
    import asyncio

    async_url = make_url(postgres_url).set(drivername="postgresql+asyncpg")

    async def run() -> None:
        engine = create_async_engine(async_url)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            await seed_agent_with_preferred_binding(session)
        await engine.dispose()

    asyncio.run(run())


@pytest.fixture
def client(postgres_url: str, monkeypatch: pytest.MonkeyPatch) -> Generator[TestClient, None, None]:
    # TestClient runs the app's async routes on its own event loop (via a
    # thread-backed portal) -- reusing a connection created on the test
    # function's own asyncio loop crashes with "attached to a different
    # loop". Each override call opens its own fresh session against the
    # same real Postgres instance instead, matching what get_db_session
    # does in production.
    async_url = make_url(postgres_url).set(drivername="postgresql+asyncpg")
    monkeypatch.setenv("AUTH0_M2M_TOKEN_URL", "http://127.0.0.1:9/oauth/token")
    monkeypatch.setenv("AUTH0_M2M_AUDIENCE", "alter-engine")
    monkeypatch.setenv("AUTH0_M2M_CLIENT_ID", "test-client")
    monkeypatch.setenv("AUTH0_M2M_CLIENT_SECRET", "test-secret")
    get_settings.cache_clear()

    async def override_session() -> AsyncGenerator[AsyncSession, None]:
        engine = create_async_engine(async_url)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            yield session
        await engine.dispose()

    app.dependency_overrides[get_db_session] = override_session
    with TestClient(app, headers={"authorization": "Bearer integration-token"}) as test_client:
        yield test_client
    app.dependency_overrides.clear()
    get_settings.cache_clear()


class TestBindAgentModelToolRoute:
    def test_preferred_agent_path_succeeds_with_no_embedding_client(
        self, postgres_url: str, client: TestClient
    ) -> None:
        seed(postgres_url)

        response = client.post(
            "/selection-binding/bind-agent-model-tool",
            json=request_body(preferred_agent_id=AGENT_A),
        )

        assert response.status_code == 200
        assert response.json()["agent_id"] == AGENT_A

    def test_ranked_match_path_fails_closed_when_model_gateway_is_unreachable(
        self, client: TestClient
    ) -> None:
        # No Model Gateway is running in this test environment -- the real
        # GrpcEmbeddingClient's Embed RPC genuinely fails (connection
        # refused against the default localhost:50051 target), exercising
        # the real fail-closed path rather than a hardcoded stub error.
        response = client.post(
            "/selection-binding/bind-agent-model-tool",
            json=request_body(),
        )

        assert response.status_code == 503
        assert "Embed RPC call to Model Gateway failed" in response.json()["detail"]

    def test_ranked_match_path_with_no_eligible_agent_auto_creates_and_binds(
        self, client: TestClient
    ) -> None:
        """No agent matches "text.generation" in this fixture's seeded data,
        so the real router wiring (AgentAutoCreationEngine injected into
        SelectionBindingEngine, see selection_binding/router.py) creates one
        and returns it bound, rather than a bare no-match."""
        app.dependency_overrides[get_embedding_client] = lambda: FakeEmbeddingClient(vector(1.0))
        app.dependency_overrides[get_instructions_client] = FakeInstructionsClient
        try:
            response = client.post(
                "/selection-binding/bind-agent-model-tool",
                json=request_body(),
            )
        finally:
            del app.dependency_overrides[get_embedding_client]
            del app.dependency_overrides[get_instructions_client]

        assert response.status_code == 200
        body = response.json()
        assert body["model_alias"] == "STANDARD"
        assert body["tool_names"] == []
        assert body["agent_version"] == 1

    def test_invalid_node_requirements_json_returns_422(self, client: TestClient) -> None:
        body = request_body()
        body["node_requirements_json"] = "not json"

        response = client.post("/selection-binding/bind-agent-model-tool", json=body)

        assert response.status_code == 422

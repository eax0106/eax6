"""Real-Postgres coverage for capability registry persistence and HTTP routes."""

from collections.abc import AsyncGenerator, Generator
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.capability_registry.canonical_tools import CANONICAL_TOOL_SIDE_EFFECTS
from src.capability_registry.models import RegisterCapability
from src.capability_registry.repository import CapabilityRegistryRepository
from src.capability_registry.router import router
from src.db.session import get_db_session

SERVICE_ROOT = Path(__file__).parent.parent
PGVECTOR_IMAGE = "pgvector/pgvector:pg16"
TENANT_A = "ten_aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa"
TENANT_B = "ten_bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb"
PLATFORM = "ten_00000000-0000-7000-8000-000000000001"
WORKSPACE = "ws_cccccccc-0000-4000-8000-cccccccccccc"


def body(capability_id: str, **overrides: object) -> dict[str, object]:
    return {
        "capability_id": capability_id,
        "kind": "tool",
        "scope": "tenant",
        "supported_capabilities": ["text.generate"],
        "provenance": {"source": "test"},
    } | overrides


@pytest.fixture(scope="module")
def postgres_url() -> Generator[str, None, None]:
    with PostgresContainer(
        image=PGVECTOR_IMAGE,
        dbname="intelligence_db",
        username="intelligence_service",
        password="testpass",
    ) as postgres:
        url = postgres.get_connection_url()
        config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        config.set_main_option("sqlalchemy.url", url)
        command.upgrade(config, "head")
        yield url


@pytest.fixture
def client(postgres_url: str) -> Generator[TestClient, None, None]:
    app = FastAPI()
    app.include_router(router)
    async_url = make_url(postgres_url).set(drivername="postgresql+asyncpg")

    async def override_session() -> AsyncGenerator[AsyncSession, None]:
        engine = create_async_engine(async_url)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            yield session
        await engine.dispose()

    app.dependency_overrides[get_db_session] = override_session
    with TestClient(app) as test_client:
        yield test_client


def test_routes_enforce_tenant_workspace_version_lifecycle_and_bounded_search(
    client: TestClient,
) -> None:
    created = client.post(f"/internal/capability-registry/{TENANT_A}/records", json=body("alpha"))
    assert created.status_code == 200
    duplicate = client.post(f"/internal/capability-registry/{TENANT_A}/records", json=body("alpha"))
    assert duplicate.status_code == 422
    assert "use supersede" in duplicate.json()["detail"]
    assert client.post(
        f"/internal/capability-registry/{TENANT_A}/records",
        json=body("workspace", scope="workspace", workspace_id=WORKSPACE),
    ).status_code == 200
    assert client.post(
        f"/internal/capability-registry/{PLATFORM}/records",
        json=body("global", scope="global"),
    ).status_code == 200

    # Scoped to this test's capability: migration 0008's global tool records
    # are visible to every tenant too.
    scope = {"capabilities": ["text.generate"]}
    hidden = client.post(f"/internal/capability-registry/{TENANT_B}/search", json=scope).json()
    assert [row["capability_id"] for row in hidden] == ["global"]
    unfiltered = client.post(f"/internal/capability-registry/{TENANT_A}/search", json=scope).json()
    assert [row["capability_id"] for row in unfiltered] == ["alpha", "global", "workspace"]
    workspace = client.post(
        f"/internal/capability-registry/{TENANT_A}/search",
        json={**scope, "workspace_id": WORKSPACE},
    ).json()
    assert [row["capability_id"] for row in workspace] == ["alpha", "global", "workspace"]
    assert client.post(
        f"/internal/capability-registry/{TENANT_A}/search", json={**scope, "limit": 2}
    ).json() == unfiltered[:2]

    replacement = client.post(
        f"/internal/capability-registry/{TENANT_A}/records/alpha/supersede", json=body("alpha")
    )
    assert replacement.status_code == 200
    assert replacement.json()["version"] == 2
    history = client.post(
        f"/internal/capability-registry/{TENANT_A}/search", json={"include_inactive": True}
    ).json()
    alpha_history = [
        (row["version"], row["status"])
        for row in history
        if row["capability_id"] == "alpha"
    ]
    assert alpha_history == [
        (2, "active"),
        (1, "superseded"),
    ]
    assert client.post(
        f"/internal/capability-registry/{TENANT_A}/records/alpha/2/deactivate"
    ).status_code == 204


@pytest.mark.asyncio
async def test_supersede_rolls_back_when_replacement_insert_fails(postgres_url: str) -> None:
    engine = create_async_engine(make_url(postgres_url).set(drivername="postgresql+asyncpg"))
    factory = async_sessionmaker(engine, expire_on_commit=False)
    request = RegisterCapability.model_validate(body("atomic"))
    async with factory() as session:
        repository = CapabilityRegistryRepository(session)
        await repository.register(TENANT_A, request)

        invalid_replacement = RegisterCapability.model_construct(
            **(request.model_dump() | {"scope": "workspace", "workspace_id": None})
        )
        with pytest.raises(Exception):
            await repository.supersede(TENANT_A, "atomic", invalid_replacement)
    async with factory() as session:
        record = await CapabilityRegistryRepository(session).get(TENANT_A, "atomic", 1)
        assert record.status == "active"
    await engine.dispose()


def test_rls_hides_private_registry_records(postgres_url: str) -> None:
    tenant_a = TENANT_A.removeprefix("ten_")
    tenant_b = TENANT_B.removeprefix("ten_")
    setup = sa.create_engine(postgres_url, isolation_level="AUTOCOMMIT")
    with setup.connect() as connection:
        connection.execute(sa.text("DROP ROLE IF EXISTS capability_registry_reader"))
        connection.execute(sa.text("CREATE ROLE capability_registry_reader"))
        connection.execute(
            sa.text("GRANT SELECT ON capability_registry_versions TO capability_registry_reader")
        )
    engine = sa.create_engine(postgres_url)
    with engine.connect() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, false)"),
            {"tenant": tenant_a},
        )
        connection.execute(
            sa.text(
                "INSERT INTO capability_registry_versions "
                "(capability_id, version, owner_tenant_id, scope, kind, supported_capabilities, "
                "constraints, availability, provenance, metadata, status) "
                "VALUES ('rls-private', 1, CAST(:tenant AS uuid), 'tenant', 'tool', "
                "'[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'active')"
            ),
            {"tenant": tenant_a},
        )
        connection.commit()
        connection.execute(sa.text("SET ROLE capability_registry_reader"))
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, false)"),
            {"tenant": tenant_b},
        )
        count_sql = sa.text(
            "SELECT count(*) FROM capability_registry_versions WHERE capability_id = 'rls-private'"
        )
        assert connection.execute(count_sql).scalar() == 0
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, false)"),
            {"tenant": tenant_a},
        )
        assert connection.execute(count_sql).scalar() == 1
        connection.execute(sa.text("RESET ROLE"))
        connection.rollback()


def test_side_effects_default_to_true_and_an_explicit_false_round_trips(
    client: TestClient,
) -> None:
    base = f"/internal/capability-registry/{TENANT_A}"
    probe = {"supported_capabilities": ["effects.probe"]}
    unlabelled = client.post(f"{base}/records", json=body("effects-unlabelled", **probe))
    reads = client.post(
        f"{base}/records", json=body("effects-reads", side_effects=False, **probe)
    )
    assert unlabelled.status_code == reads.status_code == 200
    assert unlabelled.json()["side_effects"] is True
    assert reads.json()["side_effects"] is False

    assert client.get(f"{base}/records/effects-reads/1").json()["side_effects"] is False
    found = {
        row["capability_id"]: row["side_effects"]
        for row in client.post(f"{base}/search", json={"capabilities": ["effects.probe"]}).json()
    }
    assert found == {"effects-reads": False, "effects-unlabelled": True}

    # A new version states its own label; it does not inherit the old one.
    replaced = client.post(
        f"{base}/records/effects-reads/supersede", json=body("effects-reads", **probe)
    )
    assert replaced.json()["side_effects"] is True
    assert client.get(f"{base}/records/effects-reads/2").json()["side_effects"] is True


def test_migration_0008_registers_the_canonical_tools_for_every_tenant(client: TestClient) -> None:
    labels = {
        row["capability_id"]: (row["scope"], row["kind"], row["side_effects"])
        for row in client.post(f"/internal/capability-registry/{TENANT_B}/search", json={}).json()
        if row["capability_id"].startswith("tool.")
    }
    assert labels == {
        f"tool.{name}": ("global", "tool", side_effects)
        for name, side_effects in CANONICAL_TOOL_SIDE_EFFECTS.items()
    }


def test_migrations_0007_and_0008_upgrade_and_roll_back() -> None:
    tenant = TENANT_A.removeprefix("ten_")
    with PostgresContainer(
        image=PGVECTOR_IMAGE,
        dbname="intelligence_db",
        username="intelligence_service",
        password="testpass",
    ) as postgres:
        url = postgres.get_connection_url()
        config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        config.set_main_option("sqlalchemy.url", url)
        command.upgrade(config, "0006")

        engine = sa.create_engine(url)
        with engine.begin() as connection:
            connection.execute(
                sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
                {"tenant": tenant},
            )
            connection.execute(
                sa.text(
                    "INSERT INTO capability_registry_versions "
                    "(capability_id, version, owner_tenant_id, scope, kind, "
                    "supported_capabilities, constraints, availability, provenance, status) "
                    "VALUES ('before-0007', 1, CAST(:tenant AS uuid), 'tenant', 'tool', "
                    "'[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'active')"
                ),
                {"tenant": tenant},
            )

        command.upgrade(config, "head")
        with engine.begin() as connection:
            connection.execute(
                sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
                {"tenant": tenant},
            )
            assert connection.execute(
                sa.text(
                    "SELECT side_effects FROM capability_registry_versions "
                    "WHERE capability_id = 'before-0007'"
                )
            ).scalar_one() is True

        with engine.begin() as connection:
            connection.execute(
                sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
                {"tenant": "00000000-0000-7000-8000-000000000001"},
            )
            seeded = sa.text(
                "SELECT count(*) FROM capability_registry_versions "
                "WHERE provenance ->> 'source' = 'canonical-tool-catalog'"
            )
            assert connection.execute(seeded).scalar_one() == len(CANONICAL_TOOL_SIDE_EFFECTS)
        command.downgrade(config, "0007")
        with engine.begin() as connection:
            connection.execute(
                sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
                {"tenant": "00000000-0000-7000-8000-000000000001"},
            )
            assert connection.execute(seeded).scalar_one() == 0
        command.downgrade(config, "0006")
        columns = sa.inspect(engine).get_columns("capability_registry_versions")
        assert "side_effects" not in {column["name"] for column in columns}
        engine.dispose()

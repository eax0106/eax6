"""Real PostgreSQL: the registry stores exactly the reviewed templates, every
tenant can read them, and no tenant can write or own one."""

from collections.abc import AsyncGenerator, Generator
from hashlib import sha256
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
from src.capability_registry.router import router
from src.db.session import get_db_session

SERVICE_ROOT = Path(__file__).parent.parent
TEMPLATE_DIR = SERVICE_ROOT / "src" / "capability_registry" / "templates" / "v1"
PGVECTOR_IMAGE = "pgvector/pgvector:pg16"
PLATFORM = "00000000-0000-7000-8000-000000000001"
TENANT = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa"
APP_ROLE = "templates_app"


def _alembic(url: str) -> AlembicConfig:
    config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
    config.set_main_option("sqlalchemy.url", url)
    return config


@pytest.fixture(scope="module")
def database() -> Generator[tuple[str, str], None, None]:
    with PostgresContainer(
        image=PGVECTOR_IMAGE,
        dbname="intelligence_db",
        username="intelligence_service",
        password="testpass",
    ) as postgres:
        url = postgres.get_connection_url()
        command.upgrade(_alembic(url), "head")
        engine = sa.create_engine(url)
        with engine.begin() as connection:
            # An ordinary role, so row security applies as it does in service.
            connection.execute(sa.text(f"CREATE ROLE {APP_ROLE} LOGIN PASSWORD 'apppass'"))
            connection.execute(
                sa.text(
                    f"GRANT SELECT, INSERT, UPDATE ON capability_registry_templates TO {APP_ROLE}"
                )
            )
        engine.dispose()
        app_url = make_url(url).set(username=APP_ROLE, password="apppass")
        yield url, app_url.render_as_string(hide_password=False)


def _client(url: str) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    async_url = make_url(url).set(drivername="postgresql+asyncpg")

    async def override_session() -> AsyncGenerator[AsyncSession, None]:
        engine = create_async_engine(async_url)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as session:
            yield session
        await engine.dispose()

    app.dependency_overrides[get_db_session] = override_session
    return TestClient(app)


def test_seeded_rows_are_exactly_the_reviewed_files(database: tuple[str, str]) -> None:
    owner_url, _ = database
    engine = sa.create_engine(owner_url)
    with engine.connect() as connection:
        rows = connection.execute(
            sa.text(
                "SELECT template_id, version, status, owner_tenant_id::text, content_sha256, "
                "provenance->>'source' FROM capability_registry_templates ORDER BY template_id"
            )
        ).all()
    engine.dispose()
    files = {path.name: sha256(path.read_bytes()).hexdigest() for path in TEMPLATE_DIR.glob("*.json")}
    assert len(rows) == 8
    assert {row[4] for row in rows} == set(files.values())
    assert all(row[1] == 1 and row[2] == "active" for row in rows)
    assert all(row[3] == PLATFORM and row[5] == "alter-authored" for row in rows)


def test_routes_list_and_read_templates_for_any_caller(database: tuple[str, str]) -> None:
    _, app_url = database
    with _client(app_url) as client:
        listed = client.get("/internal/capability-registry/templates")
        assert listed.status_code == 200
        summaries = listed.json()
        assert [item["template_id"] for item in summaries] == sorted(
            item["template_id"] for item in summaries
        )
        assert len(summaries) == 8
        assert "skeleton" not in summaries[0]
        detail = client.get("/internal/capability-registry/templates/whatsapp-faq-responder")
        assert detail.status_code == 200
        body = detail.json()
        assert body["version"] == 1
        assert body["skeleton"]["entry_point"] == "plan_search"
        assert len(body["test_cases"]) == 2
        assert client.get("/internal/capability-registry/templates/not-a-template").status_code == 404


def test_a_tenant_cannot_store_or_own_a_template(database: tuple[str, str]) -> None:
    _, app_url = database
    engine = sa.create_engine(app_url)
    insert = sa.text(
        "INSERT INTO capability_registry_templates "
        "(template_id, version, owner_tenant_id, status, title, summary, definition, "
        "content_sha256, provenance) VALUES ('harvested', 1, CAST(:owner AS uuid), 'active', "
        "'t', 's', '{}', repeat('a', 64), '{}')"
    )
    with engine.connect() as connection:
        # A tenant writing a template it owns: refused by the platform-only CHECK.
        with pytest.raises(sa.exc.IntegrityError), connection.begin():
            connection.execute(
                sa.text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": TENANT}
            )
            connection.execute(insert, {"owner": TENANT})
        # A tenant writing a platform-owned row: refused by row security.
        with pytest.raises(sa.exc.ProgrammingError, match="row-level security"), connection.begin():
            connection.execute(
                sa.text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": TENANT}
            )
            connection.execute(insert, {"owner": PLATFORM})
        # Tenant context still reads every template.
        with connection.begin():
            connection.execute(
                sa.text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": TENANT}
            )
            count = connection.execute(
                sa.text("SELECT count(*) FROM capability_registry_templates")
            ).scalar_one()
        assert count == 8
    engine.dispose()


def test_downgrade_removes_the_table_and_upgrade_restores_the_set(database: tuple[str, str]) -> None:
    owner_url, _ = database
    config = _alembic(owner_url)
    command.downgrade(config, "0010")
    engine = sa.create_engine(owner_url)
    with engine.connect() as connection:
        assert connection.execute(
            sa.text("SELECT to_regclass('capability_registry_templates')")
        ).scalar_one() is None
    command.upgrade(config, "head")
    with engine.connect() as connection:
        assert connection.execute(
            sa.text("SELECT count(*) FROM capability_registry_templates")
        ).scalar_one() == 8
    engine.dispose()

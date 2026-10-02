# ruff: noqa: E501
from __future__ import annotations

import hashlib
from collections.abc import Generator
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.config import get_settings
from src.db.ids import PLATFORM_TENANT_ID
from src.deletion import router as deletion_router
from src.deletion.errors import DeletionHttpError, deletion_exception_handler
from src.deletion.provider import TABLES, IntelligenceDeletionProvider

SERVICE_ROOT = Path(__file__).parent.parent
PGVECTOR_IMAGE = "pgvector/pgvector:pg16"
TENANT_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1"
TENANT_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1"
WORKSPACE_A = "018f4d6e-2b4a-7a3e-8c1a-12345678a001"
WORKSPACE_B = "018f4d6e-2b4a-7a3e-8c1a-12345678b001"
MANIFEST = "del_018f4d6e-2b4a-7a3e-8c1a-123456789099"
ZERO_VECTOR = "[" + ",".join(["0"] * 512) + "]"


@pytest.fixture(scope="module")
def databases() -> Generator[tuple[sessionmaker[Session], sessionmaker[Session]], None, None]:
    with PostgresContainer(
        image=PGVECTOR_IMAGE,
        dbname="intelligence_db",
        username="intelligence_admin",
        password="testpass",
    ) as pg:
        admin_url = pg.get_connection_url()
        admin = sa.create_engine(admin_url)
        with admin.begin() as connection:
            connection.execute(
                sa.text("CREATE ROLE intelligence_service NOLOGIN NOSUPERUSER NOBYPASSRLS")
            )
        config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        config.set_main_option("sqlalchemy.url", admin_url)
        command.upgrade(config, "head")

        with admin.begin() as connection:
            # A role held to row security, like the service's own.
            connection.execute(sa.text("CREATE ROLE intel_erasure LOGIN PASSWORD 'erase'"))
            connection.execute(sa.text("GRANT USAGE ON SCHEMA public TO intel_erasure"))
            connection.execute(
                sa.text(
                    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO intel_erasure"
                )
            )
        app_url = make_url(admin_url).set(username="intel_erasure", password="erase")
        app = sa.create_engine(app_url)
        yield (
            sessionmaker(app, class_=Session, expire_on_commit=False),
            sessionmaker(admin, class_=Session, expire_on_commit=False),
        )
        app.dispose()
        admin.dispose()


def _seed(admin: sessionmaker[Session], tenant: str, workspace: str, suffix: str) -> None:
    with admin.begin() as session:
        params = {
            "t": tenant,
            "w": workspace,
            "a": f"agt_{tenant[:-2]}{suffix}",
            "v": f"agtv_{tenant[:-2]}{suffix}",
            "e": f"cemb_{tenant[:-2]}{suffix}",
            "p": f"perf_{tenant[:-2]}{suffix}",
            "vec": ZERO_VECTOR,
        }
        session.execute(
            sa.text(
                "INSERT INTO agents (id, tenant_id, workspace_id, name, tier, persona_description, status) "
                "VALUES (:a, :t, :w, 'Agent', 'FAST', 'p', 'active')"
            ),
            params,
        )
        session.execute(
            sa.text(
                "INSERT INTO agent_versions (id, agent_id, tenant_id, version_number, capabilities) "
                "VALUES (:v, :a, :t, 1, '[]')"
            ),
            params,
        )
        session.execute(
            sa.text(
                "INSERT INTO capability_embeddings (id, agent_id, tenant_id, capability_description, embedding) "
                "VALUES (:e, :a, :t, 'd', CAST(:vec AS vector))"
            ),
            params,
        )
        session.execute(
            sa.text(
                "INSERT INTO performance_records (id, agent_id, tenant_id, verdict) "
                "VALUES (:p, :a, :t, 'success')"
            ),
            params,
        )
        session.execute(
            sa.text(
                "INSERT INTO capability_registry_versions (capability_id, version, owner_tenant_id, scope, kind, "
                "supported_capabilities, constraints, availability, provenance, status) "
                "VALUES ('cap-x', 1, :t, 'tenant', 'agent', '[]', '{}', '{}', '{}', 'active')"
            ),
            params,
        )


def _counts(admin: sessionmaker[Session], tenant: str) -> dict[str, int]:
    column = {"capability_registry_versions": "owner_tenant_id"}
    with admin.begin() as session:
        return {
            table: int(
                session.scalar(
                    sa.text(
                        f"SELECT count(*) FROM {table} WHERE {column.get(table, 'tenant_id')}=:t"
                    ),
                    {"t": tenant},
                )
                or 0
            )
            for table in TABLES
        }


def test_erases_one_tenant_completely_and_leaves_the_other_and_the_platform_whole(
    databases: tuple[sessionmaker[Session], sessionmaker[Session]],
) -> None:
    app, admin = databases
    provider = IntelligenceDeletionProvider(app, admin)
    _seed(admin, TENANT_A, WORKSPACE_A, "01")
    _seed(admin, TENANT_B, WORKSPACE_B, "02")
    with admin.begin() as session:
        session.execute(
            sa.text(
                "INSERT INTO agents (id, tenant_id, name, tier, persona_description, status) "
                "VALUES ('agt_00000000-0000-7000-8000-0000000000ff', :p, 'Global', 'FAST', 'p', 'active')"
            ),
            {"p": PLATFORM_TENANT_ID},
        )

    located = provider.locate_subject_data(f"ten_{TENANT_A}")
    assert {item.table for item in located} == set(TABLES)
    assert all(item.rowCount == 1 for item in located)

    result = provider.delete_subject_data(f"ten_{TENANT_A}", MANIFEST)
    verified = provider.verify_deletion(f"ten_{TENANT_A}", MANIFEST)

    assert result.deletedRows == 5
    assert verified.deleted is True and verified.remaining == ()
    assert set(_counts(admin, TENANT_A).values()) == {0}
    assert set(_counts(admin, TENANT_B).values()) == {1}
    assert _counts(admin, PLATFORM_TENANT_ID)["agents"] == 1
    assert provider.delete_subject_data(f"ten_{TENANT_A}", MANIFEST).deletedRows == 0


TENANT_WS = "018f4d6e-2b4a-7a3e-8c1a-1234567890c1"
WORKSPACE_ERASED = "018f4d6e-2b4a-7a3e-8c1a-1234567890c2"
WORKSPACE_KEPT = "018f4d6e-2b4a-7a3e-8c1a-1234567890c3"


def test_erases_one_workspace_scoped_from_the_live_schema(
    databases: tuple[sessionmaker[Session], sessionmaker[Session]],
) -> None:
    """D2: one workspace's agents and workspace-scoped registry entries go."""
    app, admin = databases
    provider = IntelligenceDeletionProvider(app, admin)
    _seed(admin, TENANT_WS, WORKSPACE_ERASED, "11")
    with admin.begin() as session:
        session.execute(sa.text("DELETE FROM capability_registry_versions WHERE owner_tenant_id=:t"), {"t": TENANT_WS})
    _seed(admin, TENANT_WS, WORKSPACE_KEPT, "12")
    with admin.begin() as session:
        session.execute(
            sa.text(
                "INSERT INTO capability_registry_versions (capability_id, version, owner_tenant_id, scope, "
                "workspace_id, kind, supported_capabilities, constraints, availability, provenance, status) "
                "VALUES ('cap-ws', 1, :t, 'workspace', :w, 'agent', '[]', '{}', '{}', '{}', 'active')"
            ),
            {"t": TENANT_WS, "w": WORKSPACE_ERASED},
        )
    tenant, erased, kept = f"ten_{TENANT_WS}", f"ws_{WORKSPACE_ERASED}", f"ws_{WORKSPACE_KEPT}"

    located = {item.table: item.rowCount for item in provider.locate_workspace_data(tenant, erased)}
    assert located == {table: 1 for table in TABLES}

    assert provider.delete_workspace_data(tenant, erased, MANIFEST).deletedRows == 5
    assert provider.verify_workspace_deletion(tenant, erased, MANIFEST).deleted is True
    kept_rows = {item.table: item.rowCount for item in provider.locate_workspace_data(tenant, kept)}
    assert kept_rows == {**{table: 1 for table in TABLES}, "capability_registry_versions": 0}
    # The tenant-scoped registry entry (no workspace) is not workspace data.
    assert _counts(admin, TENANT_WS)["capability_registry_versions"] == 1
    with pytest.raises(ValueError):
        provider.locate_workspace_data(tenant, "ws_nope")
    provider.delete_subject_data(tenant, MANIFEST)


def test_lists_real_tenants_only(
    databases: tuple[sessionmaker[Session], sessionmaker[Session]],
) -> None:
    app, admin = databases
    _seed(admin, TENANT_B, WORKSPACE_B, "03") if _counts(admin, TENANT_B)["agents"] == 0 else None
    subjects = IntelligenceDeletionProvider(app, admin).list_subject_ids()
    assert f"ten_{TENANT_B}" in subjects
    assert f"ten_{PLATFORM_TENANT_ID}" not in subjects
    with pytest.raises(RuntimeError):
        IntelligenceDeletionProvider(app).list_subject_ids()


@pytest.mark.parametrize(
    "tenant",
    [
        "nope",
        "ten_not-a-uuid",
        f"ten_{PLATFORM_TENANT_ID}",
        "ten_018f4d6e-2b4a-4a3e-8c1a-1234567890a1",
    ],
)
def test_refuses_a_bad_tenant_and_the_platform_tenant(
    databases: tuple[sessionmaker[Session], sessionmaker[Session]], tenant: str
) -> None:
    provider = IntelligenceDeletionProvider(databases[0])
    with pytest.raises(ValueError):
        provider.locate_subject_data(tenant)
    with pytest.raises(ValueError):
        provider.delete_subject_data(tenant, MANIFEST)


def test_refuses_a_bad_manifest(
    databases: tuple[sessionmaker[Session], sessionmaker[Session]],
) -> None:
    with pytest.raises(ValueError):
        IntelligenceDeletionProvider(databases[0]).delete_subject_data(f"ten_{TENANT_A}", "nope")


class _FakeProvider:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def locate_subject_data(self, tenant_id: str) -> tuple[()]:
        self.calls.append(tenant_id)
        return ()

    def apply_retention_policy(self) -> object:
        raise RuntimeError("boom")


def _client(monkeypatch: pytest.MonkeyPatch, fake: _FakeProvider) -> TestClient:
    token = "shared-deletion-token"
    monkeypatch.setenv("DELETION_SERVICE_TOKEN_SHA256", hashlib.sha256(token.encode()).hexdigest())
    get_settings.cache_clear()
    app = FastAPI()
    app.include_router(deletion_router.router)
    app.add_exception_handler(DeletionHttpError, deletion_exception_handler)  # type: ignore[arg-type]
    app.dependency_overrides[deletion_router.get_provider] = lambda: fake
    return TestClient(app)


@pytest.mark.parametrize("header", [None, "", "Bearer wrong", "Basic abc"])
def test_every_route_refuses_without_the_deletion_token(
    monkeypatch: pytest.MonkeyPatch, header: str | None
) -> None:
    fake = _FakeProvider()
    client = _client(monkeypatch, fake)
    headers = {} if header is None else {"Authorization": header}
    assert (
        client.get(
            "/internal/deletion/locate", params={"tenantId": "ten_x"}, headers=headers
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/internal/deletion/delete", json={"tenantId": "t", "manifestId": "m"}, headers=headers
        ).status_code
        == 401
    )
    assert client.post("/internal/deletion/retention", headers=headers).status_code == 401
    assert client.get("/internal/deletion/subjects", headers=headers).status_code == 401
    assert fake.calls == []
    get_settings.cache_clear()


def test_an_unconfigured_service_refuses_even_an_empty_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeProvider()
    client = _client(monkeypatch, fake)
    monkeypatch.setenv("DELETION_SERVICE_TOKEN_SHA256", "")
    get_settings.cache_clear()
    assert client.get("/internal/deletion/locate", params={"tenantId": "ten_x"}).status_code == 401
    get_settings.cache_clear()


def test_the_shared_token_is_accepted_and_failures_carry_no_detail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeProvider()
    client = _client(monkeypatch, fake)
    auth = {"Authorization": "Bearer shared-deletion-token"}
    assert (
        client.get(
            "/internal/deletion/locate", params={"tenantId": "ten_x"}, headers=auth
        ).status_code
        == 200
    )
    failed = client.post("/internal/deletion/retention", headers=auth)
    assert failed.status_code == 500
    assert "boom" not in failed.text
    get_settings.cache_clear()

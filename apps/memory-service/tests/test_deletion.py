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
from src.deletion import router as deletion_router
from src.deletion.errors import DeletionHttpError, deletion_exception_handler
from src.deletion.provider import TABLES, MemoryDeletionProvider

SERVICE_ROOT = Path(__file__).parent.parent
TENANT_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1"
TENANT_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1"
MANIFEST = "del_018f4d6e-2b4a-7a3e-8c1a-123456789099"


@pytest.fixture(scope="module")
def databases() -> Generator[
    tuple[sessionmaker[Session], sessionmaker[Session], sessionmaker[Session]], None, None
]:
    with PostgresContainer(
        image="postgres:16-alpine", dbname="policy_db", username="policy_admin", password="testpass"
    ) as pg:
        admin_url = pg.get_connection_url()
        config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        config.set_main_option("sqlalchemy.url", admin_url)
        admin = sa.create_engine(admin_url, isolation_level="AUTOCOMMIT")
        with admin.connect() as conn:
            conn.execute(sa.text("CREATE ROLE policy_system_writer LOGIN PASSWORD 'sys'"))
            conn.execute(sa.text("CREATE ROLE mem_app LOGIN PASSWORD 'app'"))
        command.upgrade(config, "head")  # 0008 grants DELETE on drift_scores to the writer
        with admin.connect() as conn:
            conn.execute(sa.text("GRANT USAGE ON SCHEMA public TO mem_app, policy_system_writer"))
            conn.execute(
                sa.text(
                    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mem_app"
                )
            )
        app = sa.create_engine(make_url(admin_url).set(username="mem_app", password="app"))
        system = sa.create_engine(
            make_url(admin_url).set(username="policy_system_writer", password="sys")
        )
        yield (
            sessionmaker(app, class_=Session, expire_on_commit=False),
            sessionmaker(system, class_=Session, expire_on_commit=False),
            sessionmaker(admin, class_=Session, expire_on_commit=False),
        )
        app.dispose()
        system.dispose()
        admin.dispose()


def _seed(admin: sessionmaker[Session], tenant: str, n: str) -> None:
    with admin.begin() as s:
        p = {
            "t": tenant,
            "pol": f"pol_{tenant[:-2]}{n}",
            "pro": f"ppr_{tenant[:-2]}{n}",
            "d": f"drf_{tenant[:-2]}{n}",
            "m": f"mem_{tenant[:-2]}{n}",
            "n": int(n),
        }
        s.execute(
            sa.text(
                "INSERT INTO policies (id, scope, scope_id, kind, version, body, status, source) VALUES (:pol, 'tenant', :t, 'routing_weights', :n, '{}', 'active', 'human')"
            ),
            p,
        )
        s.execute(
            sa.text(
                "INSERT INTO policy_promotions (id, policy_id, action, actor) VALUES (:pro, :pol, 'promote', 'u')"
            ),
            p,
        )
        s.execute(
            sa.text(
                "INSERT INTO drift_scores (id, tenant_id, subject_type, subject_ref, score) VALUES (:d, :t, 'agent', 'agt_1', 0.5)"
            ),
            p,
        )
        s.execute(
            sa.text(
                "INSERT INTO memory_records (id, tenant_id, scope, content, provenance, status) VALUES (:m, :t, 'failure', '{\"note\": \"private\"}', '{}', 'candidate')"
            ),
            p,
        )


def _counts(admin: sessionmaker[Session], tenant: str) -> dict[str, int]:
    queries = {
        "drift_scores": "SELECT count(*) FROM drift_scores WHERE tenant_id=:t",
        "memory_records": "SELECT count(*) FROM memory_records WHERE tenant_id=:t",
        "policies": "SELECT count(*) FROM policies WHERE scope='tenant' AND scope_id=:t",
        "policy_promotions": "SELECT count(*) FROM policy_promotions WHERE policy_id IN (SELECT id FROM policies WHERE scope_id=:t)",
    }
    with admin.begin() as s:
        return {
            table: int(s.scalar(sa.text(q), {"t": tenant}) or 0) for table, q in queries.items()
        }


def test_erases_one_tenant_and_leaves_the_other_and_the_global_tier(
    databases: tuple[sessionmaker[Session], sessionmaker[Session], sessionmaker[Session]],
) -> None:
    app, system, admin = databases
    provider = MemoryDeletionProvider(app, system)
    _seed(admin, TENANT_A, "01")
    _seed(admin, TENANT_B, "02")
    global_before = _global_counts(admin)

    located = provider.locate_subject_data(f"ten_{TENANT_A}")
    assert {item.table for item in located} == set(TABLES)
    assert all(item.rowCount == 1 for item in located)

    result = provider.delete_subject_data(f"ten_{TENANT_A}", MANIFEST)
    verified = provider.verify_deletion(f"ten_{TENANT_A}", MANIFEST)

    assert result.deletedRows == 4
    assert verified.deleted is True and verified.remaining == ()
    assert set(_counts(admin, TENANT_A).values()) == {0}
    assert set(_counts(admin, TENANT_B).values()) == {1}
    assert _global_counts(admin) == global_before
    assert provider.delete_subject_data(f"ten_{TENANT_A}", MANIFEST).deletedRows == 0


def _global_counts(admin: sessionmaker[Session]) -> tuple[int, int]:
    with admin.begin() as s:
        return (
            int(s.scalar(sa.text("SELECT count(*) FROM policies WHERE scope='global'")) or 0),
            int(
                s.scalar(sa.text("SELECT count(*) FROM memory_records WHERE tenant_id IS NULL"))
                or 0
            ),
        )


def test_the_tenant_role_alone_cannot_remove_agent_drift_scores(
    databases: tuple[sessionmaker[Session], sessionmaker[Session], sessionmaker[Session]],
) -> None:
    app, _, admin = databases
    _seed(admin, TENANT_B, "09") if _counts(admin, TENANT_B)["drift_scores"] == 0 else None
    with app.begin() as s:
        s.execute(sa.text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": TENANT_B})
        removed = s.execute(
            sa.text("DELETE FROM drift_scores WHERE tenant_id=:t"), {"t": TENANT_B}
        ).rowcount
    assert removed == 0
    assert _counts(admin, TENANT_B)["drift_scores"] >= 1


def test_lists_tenants_the_system_role_can_see(
    databases: tuple[sessionmaker[Session], sessionmaker[Session], sessionmaker[Session]],
) -> None:
    app, system, admin = databases
    _seed(admin, TENANT_B, "07") if _counts(admin, TENANT_B)["drift_scores"] == 0 else None
    assert f"ten_{TENANT_B}" in MemoryDeletionProvider(app, system).list_subject_ids()


@pytest.mark.parametrize(
    "tenant", ["nope", "ten_not-a-uuid", "ten_018f4d6e-2b4a-4a3e-8c1a-1234567890a1"]
)
def test_refuses_a_bad_tenant_and_manifest(
    databases: tuple[sessionmaker[Session], sessionmaker[Session], sessionmaker[Session]],
    tenant: str,
) -> None:
    provider = MemoryDeletionProvider(databases[0], databases[1])
    with pytest.raises(ValueError):
        provider.delete_subject_data(tenant, MANIFEST)
    with pytest.raises(ValueError):
        provider.delete_subject_data(f"ten_{TENANT_A}", "nope")


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

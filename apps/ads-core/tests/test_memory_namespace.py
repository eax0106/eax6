"""Real-Postgres coverage for the memory_namespace writer -- the delivery
target memory-service's promote_memory already computes destination=
"ads_memory_namespace" for (policy_store/repository.py), but nothing had
ever written to until this endpoint existed."""

from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

import pytest
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.memory_namespace.repository import ScopeNotFoundError, SqlAlchemyMemoryNamespaceRepository
from src.memory_namespace.router import configure_memory_namespace_repository
from src.memory_namespace.router import router as memory_namespace_router

SERVICE_ROOT = Path(__file__).parent.parent
PGVECTOR_IMAGE = "pgvector/pgvector:pg16"

TENANT_A = "ten_018f47a5-7b2c-7d10-8f11-123456789abc"
TENANT_B = "ten_028f47a5-7b2c-7d10-8f11-123456789abc"
SCOPE_A = "scp_018f47a5-7b2c-7d10-8f11-123456789ab1"
SCOPE_B = "scp_018f47a5-7b2c-7d10-8f11-123456789ab2"
PROJECT_A = "018f47a5-7b2c-7d10-8f11-1234567890aa"


def _repository(sessions: sessionmaker[Session]) -> SqlAlchemyMemoryNamespaceRepository:
    # Fixed anonymous fixtures; separate native proof covers settings and gateway transport.
    return SqlAlchemyMemoryNamespaceRepository(
        sessions,
        access=lambda _tenant, _workspace: (True, 90),
        redact=lambda _tenant, content: content,
    )


def raw(prefixed: str) -> str:
    return prefixed.split("_", maxsplit=1)[1]


@pytest.fixture(scope="module")
def sessions() -> Generator[sessionmaker[Session], None, None]:
    with PostgresContainer(
        image=PGVECTOR_IMAGE, dbname="ads_db", username="ads_core", password="testpass"
    ) as postgres:
        sync_url = postgres.get_connection_url()
        alembic_config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        alembic_config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        alembic_config.set_main_option("sqlalchemy.url", sync_url)
        command.upgrade(alembic_config, "head")
        engine = create_engine(sync_url)
        with engine.begin() as connection:
            for scope_id in (SCOPE_A, SCOPE_B):
                connection.execute(
                    text(
                        "INSERT INTO scopes (id, tenant_id, workspace_id) "
                        "VALUES (:id, CAST(:tenant_id AS uuid), CAST(:workspace_id AS uuid))"
                    ),
                    {
                        "id": scope_id,
                        "tenant_id": raw(TENANT_A),
                        "workspace_id": "018f47a5-7b2c-7d10-8f11-123456789cde",
                    },
                )
        yield sessionmaker(bind=engine, class_=Session, expire_on_commit=False)
        engine.dispose()


class TestSqlAlchemyMemoryNamespaceRepository:
    def test_records_a_real_row_scoped_to_an_existing_scope(
        self, sessions: sessionmaker[Session]
    ) -> None:
        repository = _repository(sessions)

        record_id = repository.record(
            tenant_uuid=raw(TENANT_A),
            scope_id=SCOPE_A,
            project_ref=PROJECT_A,
            kind="project_fact",
            statement="Run completed with verdict 'completed_verified'; 0 node(s) failed.",
            confidence=0.9,
            provenance={"memory_id": "mem_018f47a5-7b2c-7d10-8f11-123456789fff"},
        )

        assert record_id.startswith("mns_")
        facts = repository.list_active_for_scopes(
            tenant_uuid=raw(TENANT_A),
            workspace_uuid="018f47a5-7b2c-7d10-8f11-123456789cde",
            scope_ids=(SCOPE_A,),
            limit=10,
        )
        assert len(facts) == 1
        assert facts[0].id == record_id
        assert facts[0].kind == "project_fact"
        assert facts[0].confidence == 0.9

    def test_rejects_an_unknown_scope_instead_of_an_orphan_row(
        self, sessions: sessionmaker[Session]
    ) -> None:
        repository = _repository(sessions)

        with pytest.raises(ScopeNotFoundError):
            repository.record(
                tenant_uuid=raw(TENANT_A),
                scope_id="scp_018f47a5-7b2c-7d10-8f11-99999999999a",
                project_ref=PROJECT_A,
                kind="project_fact",
                statement="orphan",
                confidence=None,
                provenance={},
            )

    def test_rejects_a_scope_belonging_to_a_different_tenant(
        self, sessions: sessionmaker[Session]
    ) -> None:
        repository = _repository(sessions)

        with pytest.raises(ScopeNotFoundError):
            repository.record(
                tenant_uuid=raw(TENANT_B),
                scope_id=SCOPE_A,
                project_ref=PROJECT_A,
                kind="project_fact",
                statement="cross-tenant",
                confidence=None,
                provenance={},
            )

    def test_list_active_for_scopes_excludes_a_different_scope(
        self, sessions: sessionmaker[Session]
    ) -> None:
        repository = _repository(sessions)

        facts = repository.list_active_for_scopes(
            tenant_uuid=raw(TENANT_A),
            workspace_uuid="018f47a5-7b2c-7d10-8f11-123456789cde",
            scope_ids=(SCOPE_B,),
            limit=10,
        )

        assert facts == ()

    def test_list_active_for_scopes_returns_empty_for_no_scope_ids(
        self, sessions: sessionmaker[Session]
    ) -> None:
        repository = _repository(sessions)

        facts = repository.list_active_for_scopes(
            tenant_uuid=raw(TENANT_A),
            workspace_uuid="018f47a5-7b2c-7d10-8f11-123456789cde",
            scope_ids=(),
            limit=10,
        )

        assert facts == ()


class TestMemoryNamespaceRoute:
    def test_records_via_http_and_returns_a_real_prefixed_id(
        self, sessions: sessionmaker[Session]
    ) -> None:
        app = FastAPI()
        app.include_router(memory_namespace_router)
        configure_memory_namespace_repository(_repository(sessions))
        try:
            response = TestClient(app).post(
                "/ads/memory-namespace/records",
                json={
                    "tenant_id": TENANT_A,
                    "scope_id": SCOPE_A,
                    "project_ref": PROJECT_A,
                    "kind": "project_fact",
                    "statement": "Run completed with verdict 'rescued'; 1 node(s) failed.",
                    "confidence": 0.7,
                    "provenance": {"memory_id": "mem_018f47a5-7b2c-7d10-8f11-1234567890ff"},
                },
            )
        finally:
            configure_memory_namespace_repository(None)

        assert response.status_code == 201
        assert response.json()["id"].startswith("mns_")

    def test_returns_404_for_an_unknown_scope(self, sessions: sessionmaker[Session]) -> None:
        app = FastAPI()
        app.include_router(memory_namespace_router)
        configure_memory_namespace_repository(_repository(sessions))
        try:
            response = TestClient(app).post(
                "/ads/memory-namespace/records",
                json={
                    "tenant_id": TENANT_A,
                    "scope_id": "scp_018f47a5-7b2c-7d10-8f11-88888888888a",
                    "kind": "project_fact",
                    "statement": "orphan",
                    "provenance": {},
                },
            )
        finally:
            configure_memory_namespace_repository(None)

        assert response.status_code == 404

    def test_rejects_an_unrecognised_kind(self, sessions: sessionmaker[Session]) -> None:
        app = FastAPI()
        app.include_router(memory_namespace_router)
        configure_memory_namespace_repository(_repository(sessions))
        try:
            response = TestClient(app).post(
                "/ads/memory-namespace/records",
                json={
                    "tenant_id": TENANT_A,
                    "scope_id": SCOPE_A,
                    "kind": "not_a_real_kind",
                    "statement": "x",
                    "provenance": {},
                },
            )
        finally:
            configure_memory_namespace_repository(None)

        assert response.status_code == 422

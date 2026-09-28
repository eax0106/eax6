from __future__ import annotations

import uuid
from collections.abc import Generator
from dataclasses import dataclass
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.db.ids import new_prefixed_id
from src.ingestion.repository import SqlAlchemyIngestionRepository
from src.ingestion.router import get_ingestion_repository, router

SERVICE_ROOT = Path(__file__).parent.parent
PGVECTOR_IMAGE = "pgvector/pgvector:pg16"
_ZERO_EMBEDDING = "[" + ",".join(["0"] * 1024) + "]"


@dataclass(frozen=True)
class DatabaseHarness:
    engine: sa.Engine
    sessions: sessionmaker[Session]


@pytest.fixture(scope="module")
def database() -> Generator[DatabaseHarness, None, None]:
    with PostgresContainer(
        image=PGVECTOR_IMAGE,
        dbname="ads_db",
        username="ads_core",
        password="testpass",
    ) as postgres:
        url = postgres.get_connection_url()
        alembic = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        alembic.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        alembic.set_main_option("sqlalchemy.url", url)
        command.upgrade(alembic, "head")
        engine = sa.create_engine(url)
        yield DatabaseHarness(
            engine=engine,
            sessions=sessionmaker(bind=engine, class_=Session, expire_on_commit=False),
        )
        engine.dispose()


@pytest.fixture()
def client(database: DatabaseHarness) -> Generator[TestClient, None, None]:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_ingestion_repository] = lambda: (
        SqlAlchemyIngestionRepository(database.sessions)
    )
    with TestClient(app) as test_client:
        yield test_client


def _tenant() -> tuple[str, str]:
    bare = str(uuid.uuid4())
    return f"ten_{bare}", bare


def _headers(tenant_id: str, workspace_id: str | None = None) -> dict[str, str]:
    headers = {"X-Alter-Tenant-Id": tenant_id}
    if workspace_id is not None:
        headers["X-Alter-Workspace-Id"] = workspace_id
    return headers


def _seed_source(
    database: DatabaseHarness,
    *,
    tenant_uuid: str,
    workspace_uuid: str,
    provider: str = "google_drive",
    sync_config: dict[str, object] | None = None,
) -> str:
    scope_id = new_prefixed_id("scp")
    source_id = new_prefixed_id("src")
    with database.engine.begin() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": tenant_uuid},
        )
        connection.execute(
            sa.text(
                "INSERT INTO scopes(id, tenant_id, workspace_id) "
                "VALUES (:id, :tenant, :workspace)"
            ),
            {"id": scope_id, "tenant": tenant_uuid, "workspace": workspace_uuid},
        )
        connection.execute(
            sa.text(
                "INSERT INTO sources(id, tenant_id, scope_id, kind, provider, "
                "sync_config, status) "
                "VALUES (:id, :tenant, :scope, 'connector', :provider, "
                "CAST(:sync_config AS jsonb), 'active')"
            ),
            {
                "id": source_id,
                "tenant": tenant_uuid,
                "scope": scope_id,
                "provider": provider,
                "sync_config": _json(sync_config or {}),
            },
        )
    return source_id


def _seed_document_with_chunks(
    database: DatabaseHarness,
    *,
    tenant_uuid: str,
    scope_id: str,
    source_id: str,
    chunk_count: int,
) -> str:
    document_id = new_prefixed_id("doc")
    with database.engine.begin() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": tenant_uuid},
        )
        connection.execute(
            sa.text(
                "INSERT INTO documents(id, tenant_id, scope_id, source_id, kind, "
                "current_version, status) "
                "VALUES (:id, :tenant, :scope, :source, 'file', 1, 'active')"
            ),
            {"id": document_id, "tenant": tenant_uuid, "scope": scope_id, "source": source_id},
        )
        connection.execute(
            sa.text(
                "INSERT INTO document_versions(document_id, version, content_ref, "
                "provenance) "
                "VALUES (:document, 1, :content_ref, CAST(:provenance AS jsonb))"
            ),
            {
                "document": document_id,
                "content_ref": f"tenants/{tenant_uuid}/documents/{document_id}/versions/1/content",
                "provenance": _json({}),
            },
        )
        for seq in range(chunk_count):
            connection.execute(
                sa.text(
                    "INSERT INTO chunks(id, tenant_id, scope_id, document_id, "
                    "document_version, seq, text_content, embedding, "
                    "embedding_provider, embedding_model, embedding_version) "
                    "VALUES (:id, :tenant, :scope, :document, 1, :seq, :text, "
                    "CAST(:embedding AS vector), 'stub', 'stub-model', 'v1')"
                ),
                {
                    "id": new_prefixed_id("chk"),
                    "tenant": tenant_uuid,
                    "scope": scope_id,
                    "document": document_id,
                    "seq": seq,
                    "text": f"chunk {seq}",
                    "embedding": _ZERO_EMBEDDING,
                },
            )
    return document_id


def _json(value: dict[str, object]) -> str:
    import json

    return json.dumps(value)


def test_list_sources_reports_real_document_and_chunk_counts(
    client: TestClient,
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _tenant()
    workspace_uuid = str(uuid.uuid4())
    source_id = _seed_source(
        database,
        tenant_uuid=tenant_uuid,
        workspace_uuid=workspace_uuid,
        sync_config={"name": "Q3 Policies"},
    )
    with database.engine.begin() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": tenant_uuid},
        )
        scope_id = connection.scalar(
            sa.text("SELECT scope_id FROM sources WHERE id = :id"), {"id": source_id}
        )
    _seed_document_with_chunks(
        database, tenant_uuid=tenant_uuid, scope_id=scope_id, source_id=source_id, chunk_count=3
    )
    _seed_document_with_chunks(
        database, tenant_uuid=tenant_uuid, scope_id=scope_id, source_id=source_id, chunk_count=2
    )

    response = client.get(
        "/ads/sources", headers=_headers(tenant_id, f"ws_{workspace_uuid}")
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["page"] == {"next_cursor": None, "has_more": False}
    assert len(body["data"]) == 1
    row = body["data"][0]
    assert row["id"] == source_id
    assert row["provider"] == "google_drive"
    assert row["sync_config"] == {"name": "Q3 Policies"}
    assert row["document_count"] == 2
    assert row["chunk_count"] == 5


def test_list_sources_is_workspace_scoped(client: TestClient, database: DatabaseHarness) -> None:
    tenant_id, tenant_uuid = _tenant()
    workspace_a = str(uuid.uuid4())
    workspace_b = str(uuid.uuid4())
    _seed_source(database, tenant_uuid=tenant_uuid, workspace_uuid=workspace_a)
    _seed_source(database, tenant_uuid=tenant_uuid, workspace_uuid=workspace_b)

    response = client.get("/ads/sources", headers=_headers(tenant_id, f"ws_{workspace_a}"))

    assert response.status_code == 200
    assert len(response.json()["data"]) == 1


def test_list_sources_paginates_newest_first(
    client: TestClient, database: DatabaseHarness
) -> None:
    tenant_id, tenant_uuid = _tenant()
    workspace_uuid = str(uuid.uuid4())
    first = _seed_source(database, tenant_uuid=tenant_uuid, workspace_uuid=workspace_uuid)
    second = _seed_source(database, tenant_uuid=tenant_uuid, workspace_uuid=workspace_uuid)

    page_one = client.get(
        "/ads/sources?limit=1", headers=_headers(tenant_id, f"ws_{workspace_uuid}")
    )
    assert page_one.status_code == 200
    body_one = page_one.json()
    assert [row["id"] for row in body_one["data"]] == [second]
    assert body_one["page"]["has_more"] is True
    cursor = body_one["page"]["next_cursor"]
    assert cursor == second

    page_two = client.get(
        f"/ads/sources?limit=1&cursor={cursor}",
        headers=_headers(tenant_id, f"ws_{workspace_uuid}"),
    )
    assert page_two.status_code == 200
    body_two = page_two.json()
    assert [row["id"] for row in body_two["data"]] == [first]
    assert body_two["page"] == {"next_cursor": None, "has_more": False}


def test_list_sources_rejects_bad_limit_and_cursor(
    client: TestClient, database: DatabaseHarness
) -> None:
    tenant_id, tenant_uuid = _tenant()
    workspace_uuid = str(uuid.uuid4())
    _seed_source(database, tenant_uuid=tenant_uuid, workspace_uuid=workspace_uuid)

    too_big = client.get(
        "/ads/sources?limit=201", headers=_headers(tenant_id, f"ws_{workspace_uuid}")
    )
    assert too_big.status_code == 400

    zero = client.get(
        "/ads/sources?limit=0", headers=_headers(tenant_id, f"ws_{workspace_uuid}")
    )
    assert zero.status_code == 400

    bad_cursor = client.get(
        "/ads/sources?cursor=not-a-real-source",
        headers=_headers(tenant_id, f"ws_{workspace_uuid}"),
    )
    assert bad_cursor.status_code == 400


def test_get_source_detail_returns_real_read(
    client: TestClient, database: DatabaseHarness
) -> None:
    tenant_id, tenant_uuid = _tenant()
    workspace_uuid = str(uuid.uuid4())
    source_id = _seed_source(
        database,
        tenant_uuid=tenant_uuid,
        workspace_uuid=workspace_uuid,
        provider="shopify",
        sync_config={"name": "Storefront"},
    )

    response = client.get(
        f"/ads/sources/{source_id}/detail", headers=_headers(tenant_id)
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == source_id
    assert body["workspace_id"] == workspace_uuid
    assert body["provider"] == "shopify"
    assert body["sync_config"] == {"name": "Storefront"}
    assert body["document_count"] == 0
    assert body["chunk_count"] == 0
    assert body["status"] == "active"


def test_get_source_detail_is_tenant_isolated_and_404s(
    client: TestClient, database: DatabaseHarness
) -> None:
    tenant_a, tenant_a_uuid = _tenant()
    tenant_b, _ = _tenant()
    workspace_uuid = str(uuid.uuid4())
    source_id = _seed_source(database, tenant_uuid=tenant_a_uuid, workspace_uuid=workspace_uuid)

    cross_tenant = client.get(
        f"/ads/sources/{source_id}/detail", headers=_headers(tenant_b)
    )
    assert cross_tenant.status_code == 404

    missing = client.get(
        f"/ads/sources/{new_prefixed_id('src')}/detail", headers=_headers(tenant_a)
    )
    assert missing.status_code == 404

    bad_id = client.get("/ads/sources/not-a-source/detail", headers=_headers(tenant_a))
    assert bad_id.status_code == 400


def test_get_source_workspace_route_is_unchanged_by_the_new_detail_route(
    client: TestClient, database: DatabaseHarness
) -> None:
    """Guards PR #67's resolver: GET /sources/{id} (no suffix) must keep
    returning the narrow {id, workspace_id} RBAC-resolution shape."""
    tenant_id, tenant_uuid = _tenant()
    workspace_uuid = str(uuid.uuid4())
    source_id = _seed_source(database, tenant_uuid=tenant_uuid, workspace_uuid=workspace_uuid)

    response = client.get(f"/ads/sources/{source_id}", headers=_headers(tenant_id))

    assert response.status_code == 200
    assert response.json() == {"id": source_id, "workspace_id": workspace_uuid}


def _scope_of(database: DatabaseHarness, tenant_uuid: str, source_id: str) -> str:
    with database.engine.begin() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": tenant_uuid},
        )
        return str(
            connection.scalar(
                sa.text("SELECT scope_id FROM sources WHERE id = :id"), {"id": source_id}
            )
        )


def test_list_documents_is_workspace_scoped_and_filters_by_source(
    client: TestClient, database: DatabaseHarness
) -> None:
    tenant_id, tenant_uuid = _tenant()
    workspace_a = str(uuid.uuid4())
    workspace_b = str(uuid.uuid4())
    source_one = _seed_source(database, tenant_uuid=tenant_uuid, workspace_uuid=workspace_a)
    source_two = _seed_source(database, tenant_uuid=tenant_uuid, workspace_uuid=workspace_a)
    other = _seed_source(database, tenant_uuid=tenant_uuid, workspace_uuid=workspace_b)
    for source in (source_one, source_one, source_two):
        _seed_document_with_chunks(
            database,
            tenant_uuid=tenant_uuid,
            scope_id=_scope_of(database, tenant_uuid, source),
            source_id=source,
            chunk_count=1,
        )
    _seed_document_with_chunks(
        database,
        tenant_uuid=tenant_uuid,
        scope_id=_scope_of(database, tenant_uuid, other),
        source_id=other,
        chunk_count=1,
    )

    everything = client.get("/ads/documents", headers=_headers(tenant_id, f"ws_{workspace_a}"))
    assert everything.status_code == 200, everything.text
    assert len(everything.json()["data"]) == 3
    assert {row["source_id"] for row in everything.json()["data"]} == {source_one, source_two}

    one_source = client.get(
        f"/ads/documents?source_id={source_one}", headers=_headers(tenant_id, f"ws_{workspace_a}")
    )
    assert one_source.status_code == 200
    assert [row["source_id"] for row in one_source.json()["data"]] == [source_one, source_one]


def test_list_documents_paginates_newest_first(
    client: TestClient, database: DatabaseHarness
) -> None:
    tenant_id, tenant_uuid = _tenant()
    workspace_uuid = str(uuid.uuid4())
    source = _seed_source(database, tenant_uuid=tenant_uuid, workspace_uuid=workspace_uuid)
    scope_id = _scope_of(database, tenant_uuid, source)
    for _ in range(3):
        _seed_document_with_chunks(
            database, tenant_uuid=tenant_uuid, scope_id=scope_id, source_id=source, chunk_count=1
        )

    first = client.get(
        "/ads/documents?limit=2", headers=_headers(tenant_id, f"ws_{workspace_uuid}")
    )
    assert first.status_code == 200
    body = first.json()
    assert len(body["data"]) == 2 and body["page"]["has_more"] is True
    second = client.get(
        f"/ads/documents?limit=2&cursor={body['page']['next_cursor']}",
        headers=_headers(tenant_id, f"ws_{workspace_uuid}"),
    )
    rest = second.json()
    assert len(rest["data"]) == 1 and rest["page"]["has_more"] is False
    ids = [row["id"] for row in body["data"] + rest["data"]]
    assert len(set(ids)) == 3

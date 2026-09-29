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
from src.ingestion.router import get_ingestion_repository, get_object_storage, router
from src.storage.object_storage import InMemoryObjectStorageProvider

SERVICE_ROOT = Path(__file__).parent.parent
PGVECTOR_IMAGE = "pgvector/pgvector:pg16"
_ZERO_EMBEDDING = "[" + ",".join(["0"] * 1024) + "]"


@dataclass(frozen=True)
class DatabaseHarness:
    engine: sa.Engine
    sessions: sessionmaker[Session]


class FailingObjectStorage(InMemoryObjectStorageProvider):
    def delete_object(self, *, key: str) -> None:
        raise RuntimeError("object store unavailable")


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
def storage() -> InMemoryObjectStorageProvider:
    return InMemoryObjectStorageProvider()


def _client(
    database: DatabaseHarness, storage: InMemoryObjectStorageProvider
) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_ingestion_repository] = lambda: (
        SqlAlchemyIngestionRepository(database.sessions)
    )
    app.dependency_overrides[get_object_storage] = lambda: storage
    return TestClient(app)


@pytest.fixture()
def client(
    database: DatabaseHarness, storage: InMemoryObjectStorageProvider
) -> Generator[TestClient, None, None]:
    with _client(database, storage) as test_client:
        yield test_client


@dataclass(frozen=True)
class Seeded:
    tenant_id: str
    tenant_uuid: str
    scope_id: str
    source_id: str


def _seed_source(database: DatabaseHarness) -> Seeded:
    tenant_uuid = str(uuid.uuid4())
    scope_id = new_prefixed_id("scp")
    source_id = new_prefixed_id("src")
    with _tenant_connection(database, tenant_uuid) as connection:
        connection.execute(
            sa.text("INSERT INTO scopes(id, tenant_id, workspace_id) VALUES (:id, :t, :w)"),
            {"id": scope_id, "t": tenant_uuid, "w": str(uuid.uuid4())},
        )
        connection.execute(
            sa.text(
                "INSERT INTO sources(id, tenant_id, scope_id, kind, status) "
                "VALUES (:id, :t, :scope, 'upload', 'active')"
            ),
            {"id": source_id, "t": tenant_uuid, "scope": scope_id},
        )
        connection.execute(
            sa.text(
                "INSERT INTO ingestion_jobs(id, tenant_id, source_id, stage) "
                "VALUES (:id, :t, :source, 'indexed')"
            ),
            {"id": new_prefixed_id("ing"), "t": tenant_uuid, "source": source_id},
        )
        connection.execute(
            sa.text(
                "INSERT INTO records(id, tenant_id, scope_id, source_id, entity_type, "
                "external_key, body, version) "
                "VALUES (:id, :t, :scope, :source, 'row', 'k1', CAST('{}' AS jsonb), 1)"
            ),
            {
                "id": new_prefixed_id("rec"),
                "t": tenant_uuid,
                "scope": scope_id,
                "source": source_id,
            },
        )
    return Seeded(f"ten_{tenant_uuid}", tenant_uuid, scope_id, source_id)


def _seed_document(
    database: DatabaseHarness,
    storage: InMemoryObjectStorageProvider,
    seeded: Seeded,
    *,
    content_prefix: str | None = None,
) -> str:
    """A document with two versions, two chunks per version, and raw and
    normalized objects per version actually present in the object store."""
    document_id = new_prefixed_id("doc")
    prefix = content_prefix or f"tenants/{seeded.tenant_uuid}/documents/{document_id}"
    with _tenant_connection(database, seeded.tenant_uuid) as connection:
        connection.execute(
            sa.text(
                "INSERT INTO documents(id, tenant_id, scope_id, source_id, kind, "
                "current_version, status) VALUES (:id, :t, :scope, :source, 'file', 2, 'active')"
            ),
            {
                "id": document_id,
                "t": seeded.tenant_uuid,
                "scope": seeded.scope_id,
                "source": seeded.source_id,
            },
        )
        for version in (1, 2):
            raw = f"{prefix}/versions/{version}/raw"
            normalized = f"{prefix}/versions/{version}/normalized"
            storage.put_object_bytes(key=raw, content=b"raw", content_type="text/plain")
            storage.put_object_bytes(key=normalized, content=b"norm", content_type="text/plain")
            connection.execute(
                sa.text(
                    "INSERT INTO document_versions(document_id, version, content_ref, "
                    "normalized_ref, provenance) "
                    "VALUES (:d, :v, :raw, :normalized, CAST('{}' AS jsonb))"
                ),
                {"d": document_id, "v": version, "raw": raw, "normalized": normalized},
            )
            for seq in range(2):
                connection.execute(
                    sa.text(
                        "INSERT INTO chunks(id, tenant_id, scope_id, document_id, "
                        "document_version, seq, text_content, embedding, "
                        "embedding_provider, embedding_model, embedding_version) "
                        "VALUES (:id, :t, :scope, :d, :v, :seq, 'text', "
                        "CAST(:embedding AS vector), 'stub', 'stub-model', 'v1')"
                    ),
                    {
                        "id": new_prefixed_id("chk"),
                        "t": seeded.tenant_uuid,
                        "scope": seeded.scope_id,
                        "d": document_id,
                        "v": version,
                        "seq": seq,
                        "embedding": _ZERO_EMBEDDING,
                    },
                )
    return document_id


class _tenant_connection:
    def __init__(self, database: DatabaseHarness, tenant_uuid: str) -> None:
        self._context = database.engine.begin()
        self._tenant_uuid = tenant_uuid

    def __enter__(self) -> sa.Connection:
        connection = self._context.__enter__()
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :t, true)"),
            {"t": self._tenant_uuid},
        )
        return connection

    def __exit__(self, *exc: object) -> None:
        self._context.__exit__(*exc)  # type: ignore[arg-type]


def _counts(database: DatabaseHarness, seeded: Seeded, document_id: str) -> dict[str, int]:
    with _tenant_connection(database, seeded.tenant_uuid) as connection:
        return {
            "documents": connection.scalar(
                sa.text("SELECT count(*) FROM documents WHERE id=:d"), {"d": document_id}
            ),
            "versions": connection.scalar(
                sa.text("SELECT count(*) FROM document_versions WHERE document_id=:d"),
                {"d": document_id},
            ),
            "chunks": connection.scalar(
                sa.text("SELECT count(*) FROM chunks WHERE document_id=:d"), {"d": document_id}
            ),
        }


def _source_counts(database: DatabaseHarness, seeded: Seeded) -> dict[str, int]:
    with _tenant_connection(database, seeded.tenant_uuid) as connection:
        return {
            table: connection.scalar(
                sa.text(f"SELECT count(*) FROM {table} WHERE {column}=:id"),
                {"id": value},
            )
            for table, column, value in (
                ("sources", "id", seeded.source_id),
                ("documents", "source_id", seeded.source_id),
                ("records", "source_id", seeded.source_id),
                ("ingestion_jobs", "source_id", seeded.source_id),
                ("scopes", "id", seeded.scope_id),
            )
        }


def _objects_for(storage: InMemoryObjectStorageProvider, document_id: str) -> list[str]:
    return [key for key in storage._objects if f"/documents/{document_id}/" in key]


def _headers(seeded: Seeded) -> dict[str, str]:
    return {"X-Alter-Tenant-Id": seeded.tenant_id}


def test_delete_document_erases_rows_and_stored_objects(
    client: TestClient, database: DatabaseHarness, storage: InMemoryObjectStorageProvider
) -> None:
    seeded = _seed_source(database)
    target = _seed_document(database, storage, seeded)
    kept = _seed_document(database, storage, seeded)
    assert _counts(database, seeded, target) == {"documents": 1, "versions": 2, "chunks": 4}
    assert len(_objects_for(storage, target)) == 4

    response = client.delete(f"/ads/documents/{target}", headers=_headers(seeded))

    assert response.status_code == 204
    assert _counts(database, seeded, target) == {"documents": 0, "versions": 0, "chunks": 0}
    assert _objects_for(storage, target) == []
    assert _counts(database, seeded, kept) == {"documents": 1, "versions": 2, "chunks": 4}
    assert len(_objects_for(storage, kept)) == 4
    assert client.delete(f"/ads/documents/{target}", headers=_headers(seeded)).status_code == 404


def test_delete_document_of_another_tenant_is_not_found_and_changes_nothing(
    client: TestClient, database: DatabaseHarness, storage: InMemoryObjectStorageProvider
) -> None:
    owner = _seed_source(database)
    other = _seed_source(database)
    document_id = _seed_document(database, storage, owner)

    response = client.delete(f"/ads/documents/{document_id}", headers=_headers(other))

    assert response.status_code == 404
    assert _counts(database, owner, document_id) == {"documents": 1, "versions": 2, "chunks": 4}
    assert len(_objects_for(storage, document_id)) == 4


def test_delete_document_keeps_rows_when_the_object_store_fails(
    database: DatabaseHarness,
) -> None:
    storage = FailingObjectStorage()
    seeded = _seed_source(database)
    document_id = _seed_document(database, storage, seeded)

    with _client(database, storage) as client, pytest.raises(RuntimeError):
        client.delete(f"/ads/documents/{document_id}", headers=_headers(seeded))

    assert _counts(database, seeded, document_id) == {"documents": 1, "versions": 2, "chunks": 4}


def test_delete_document_refuses_a_reference_outside_the_tenant(
    client: TestClient, database: DatabaseHarness, storage: InMemoryObjectStorageProvider
) -> None:
    seeded = _seed_source(database)
    foreign = f"tenants/{uuid.uuid4()}/documents/doc_x"
    document_id = _seed_document(database, storage, seeded, content_prefix=foreign)

    response = client.delete(f"/ads/documents/{document_id}", headers=_headers(seeded))

    assert response.status_code == 409
    assert _counts(database, seeded, document_id) == {"documents": 1, "versions": 2, "chunks": 4}
    assert len([key for key in storage._objects if key.startswith(foreign)]) == 4


def test_delete_source_erases_its_documents_records_and_jobs_but_keeps_the_scope(
    client: TestClient, database: DatabaseHarness, storage: InMemoryObjectStorageProvider
) -> None:
    seeded = _seed_source(database)
    documents = [_seed_document(database, storage, seeded) for _ in range(2)]
    neighbour = _seed_source(database)
    neighbour_document = _seed_document(database, storage, neighbour)
    assert _source_counts(database, seeded) == {
        "sources": 1,
        "documents": 2,
        "records": 1,
        "ingestion_jobs": 1,
        "scopes": 1,
    }

    response = client.delete(f"/ads/sources/{seeded.source_id}", headers=_headers(seeded))

    assert response.status_code == 204
    assert _source_counts(database, seeded) == {
        "sources": 0,
        "documents": 0,
        "records": 0,
        "ingestion_jobs": 0,
        "scopes": 1,
    }
    for document_id in documents:
        assert _counts(database, seeded, document_id) == {
            "documents": 0,
            "versions": 0,
            "chunks": 0,
        }
        assert _objects_for(storage, document_id) == []
    assert _counts(database, neighbour, neighbour_document)["documents"] == 1
    assert len(_objects_for(storage, neighbour_document)) == 4


def test_delete_source_of_another_tenant_is_not_found(
    client: TestClient, database: DatabaseHarness, storage: InMemoryObjectStorageProvider
) -> None:
    owner = _seed_source(database)
    other = _seed_source(database)
    _seed_document(database, storage, owner)

    response = client.delete(f"/ads/sources/{owner.source_id}", headers=_headers(other))

    assert response.status_code == 404
    assert _source_counts(database, owner)["documents"] == 1


def test_delete_rejects_malformed_ids(client: TestClient, database: DatabaseHarness) -> None:
    seeded = _seed_source(database)
    assert client.delete("/ads/documents/nope", headers=_headers(seeded)).status_code == 400
    assert client.delete("/ads/sources/nope", headers=_headers(seeded)).status_code == 400


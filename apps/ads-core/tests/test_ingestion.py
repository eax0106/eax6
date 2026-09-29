from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from time import monotonic, sleep
from typing import cast

import grpc
import pytest
import sqlalchemy as sa
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from alter.modelgw.v1 import modelgw_pb2, modelgw_pb2_grpc
from src.db.ids import new_prefixed_id
from src.ingestion.chunking import (
    Chunk,
    ChunkSplitter,
    ParagraphAwareChunkSplitter,
    UnsupportedContentTypeError,
)
from src.ingestion.embedding_client import (
    EmbeddingClient,
    EmbeddingDimensions,
    EmbeddingResult,
    GrpcEmbeddingClient,
)
from src.ingestion.models import IngestionPayload, ScanResult
from src.ingestion.normalization import ContentNormalizer, TextAwareNormalizer
from src.ingestion.pipeline import IngestionPipeline
from src.ingestion.repository import (
    IngestionRepository,
    SqlAlchemyIngestionRepository,
    StoredDocumentContent,
    StoredDocumentSummary,
    StoredIngestionJob,
    StoredReindex,
    StoredSource,
    StoredSourceDetail,
)
from src.ingestion.router import get_ingestion_pipeline, router
from src.ingestion.scanner import ContentScanner, DisclosedStubScanner
from src.ingestion.validation import PayloadValidator
from src.query.models import RetrievalRequest
from src.query.repository import SqlAlchemyRetrievalRepository
from src.storage.object_storage import InMemoryObjectStorageProvider, ObjectStorageProvider

SERVICE_ROOT = Path(__file__).parent.parent
PGVECTOR_IMAGE = "pgvector/pgvector:pg16"
RUNTIME_ROLE = "ads_ingestion_runtime"
RUNTIME_PASSWORD = "runtime-test-password"
KNOWN_BAD = b"EICAR-STANDARD-ANTIVIRUS-TEST-FILE"
ALLOWED_TYPES = frozenset(
    {"application/json", "text/plain", "application/pdf", "image/png", "image/jpeg"}
)


@dataclass(frozen=True)
class DatabaseHarness:
    admin_engine: sa.Engine
    runtime_engine: sa.Engine
    sessions: sessionmaker[Session]


@pytest.fixture(scope="module")
def database() -> Generator[DatabaseHarness, None, None]:
    with PostgresContainer(
        image=PGVECTOR_IMAGE,
        dbname="ads_db",
        username="ads_core",
        password="testpass",
    ) as pg:
        admin_url = pg.get_connection_url()
        alembic_cfg = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        alembic_cfg.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        alembic_cfg.set_main_option("sqlalchemy.url", admin_url)
        command.upgrade(alembic_cfg, "head")

        admin_engine = sa.create_engine(admin_url)
        with admin_engine.begin() as connection:
            connection.execute(
                sa.text(f"CREATE ROLE {RUNTIME_ROLE} LOGIN PASSWORD '{RUNTIME_PASSWORD}'")
            )
            connection.execute(sa.text(f"GRANT CONNECT ON DATABASE ads_db TO {RUNTIME_ROLE}"))
            connection.execute(sa.text(f"GRANT USAGE ON SCHEMA public TO {RUNTIME_ROLE}"))
            connection.execute(sa.text(f"GRANT SELECT ON sources TO {RUNTIME_ROLE}"))
            connection.execute(
                sa.text(
                    f"GRANT SELECT, INSERT, UPDATE ON ingestion_jobs TO {RUNTIME_ROLE}"
                )
            )
            connection.execute(
                sa.text(f"GRANT SELECT, INSERT, UPDATE ON documents TO {RUNTIME_ROLE}")
            )
            connection.execute(
                sa.text(f"GRANT SELECT, INSERT ON document_versions TO {RUNTIME_ROLE}")
            )
            connection.execute(
                sa.text(f"GRANT SELECT, INSERT ON chunks TO {RUNTIME_ROLE}")
            )
            connection.execute(sa.text(f"GRANT SELECT ON scopes TO {RUNTIME_ROLE}"))
            connection.execute(sa.text(f"GRANT SELECT ON memory_namespace TO {RUNTIME_ROLE}"))

        runtime_url = sa.engine.make_url(admin_url).set(
            username=RUNTIME_ROLE,
            password=RUNTIME_PASSWORD,
        )
        runtime_engine = sa.create_engine(runtime_url)
        sessions = sessionmaker(
            bind=runtime_engine,
            class_=Session,
            expire_on_commit=False,
        )
        yield DatabaseHarness(
            admin_engine=admin_engine,
            runtime_engine=runtime_engine,
            sessions=sessions,
        )
        runtime_engine.dispose()
        admin_engine.dispose()


def _new_tenant() -> tuple[str, str]:
    bare = str(uuid.uuid4())
    return f"ten_{bare}", bare


def _seed_source(database: DatabaseHarness, tenant_uuid: str) -> str:
    source_id = new_prefixed_id("src")
    scope_id = new_prefixed_id("scp")
    with database.admin_engine.begin() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant_id, true)"),
            {"tenant_id": tenant_uuid},
        )
        connection.execute(
            sa.text(
                "INSERT INTO scopes (id, tenant_id, workspace_id) VALUES (:id, :tenant, :workspace)"
            ),
            {
                "id": scope_id,
                "tenant": tenant_uuid,
                "workspace": str(uuid.uuid4()),
            },
        )
        connection.execute(
            sa.text(
                "INSERT INTO sources (id, tenant_id, scope_id, kind, status) "
                "VALUES (:id, :tenant, :scope, 'upload', 'active')"
            ),
            {"id": source_id, "tenant": tenant_uuid, "scope": scope_id},
        )
    return source_id


FAKE_MODEL_ID = "amazon.titan-embed-text-v2:0"


class FakeEmbeddingClient:
    """Deterministic in-process fake -- unit tests never dial real gRPC."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, EmbeddingDimensions]] = []

    def embed(
        self, *, tenant_id: str, text: str, dimensions: EmbeddingDimensions
    ) -> EmbeddingResult:
        self.calls.append((tenant_id, text, dimensions))
        seed = int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:8], 16)
        vector = tuple(((seed + index) % 1000) / 1000 for index in range(dimensions))
        return EmbeddingResult(vector=vector, model_id=FAKE_MODEL_ID)


class _FixedChunkSplitter:
    def __init__(self, chunks: tuple[Chunk, ...]) -> None:
        self._chunks = chunks

    def split(self, *, content: bytes, content_type: str) -> tuple[Chunk, ...]:
        del content, content_type
        return self._chunks


class _DelayedEmbeddingClient(FakeEmbeddingClient):
    def __init__(self, delay_seconds: float) -> None:
        super().__init__()
        self._delay_seconds = delay_seconds

    def embed(
        self, *, tenant_id: str, text: str, dimensions: EmbeddingDimensions
    ) -> EmbeddingResult:
        sleep(self._delay_seconds)
        return super().embed(tenant_id=tenant_id, text=text, dimensions=dimensions)


class _FailingOnChunkEmbeddingClient(FakeEmbeddingClient):
    def embed(
        self, *, tenant_id: str, text: str, dimensions: EmbeddingDimensions
    ) -> EmbeddingResult:
        if text == "chunk 2":
            raise RuntimeError("embedding unavailable for chunk 2")
        return super().embed(tenant_id=tenant_id, text=text, dimensions=dimensions)


class _EmbeddingServicer(modelgw_pb2_grpc.ModelgwServiceServicer):
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, int]] = []

    def Embed(  # noqa: N802 -- generated gRPC method name
        self,
        request: modelgw_pb2.EmbedRequest,
        context: grpc.ServicerContext,
    ) -> modelgw_pb2.EmbedResponse:
        del context
        self.calls.append((request.tenant_id, request.text, request.dimensions))
        return modelgw_pb2.EmbedResponse(
            embedding=[0.5 for _ in range(request.dimensions)],
            model_id=FAKE_MODEL_ID,
        )


def _pipeline(
    database: DatabaseHarness,
    *,
    max_content_bytes: int = 1024,
    repository: IngestionRepository | None = None,
    scanner: ContentScanner | None = None,
    normalizer: ContentNormalizer | None = None,
    chunk_splitter: ChunkSplitter | None = None,
    embedding_client: EmbeddingClient | None = None,
    object_storage: ObjectStorageProvider | None = None,
    embedding_pipeline_version: str = "v1",
) -> IngestionPipeline:
    return IngestionPipeline(
        repository=repository or SqlAlchemyIngestionRepository(database.sessions),
        chunk_splitter=chunk_splitter or ParagraphAwareChunkSplitter(),
        embedding_client=embedding_client or FakeEmbeddingClient(),
        validator=PayloadValidator(
            max_content_bytes=max_content_bytes,
            allowed_content_types=ALLOWED_TYPES,
        ),
        scanner=scanner or DisclosedStubScanner((KNOWN_BAD,)),
        normalizer=normalizer or TextAwareNormalizer(),
        object_storage=object_storage or InMemoryObjectStorageProvider(),
        max_content_bytes=max_content_bytes,
        embedding_pipeline_version=embedding_pipeline_version,
    )


class RecordingRepository:
    """Delegates to real Postgres and snapshots every committed transition."""

    def __init__(
        self,
        delegate: SqlAlchemyIngestionRepository,
        sessions: sessionmaker[Session],
    ) -> None:
        self._delegate = delegate
        self._sessions = sessions
        self.committed_stages: list[str] = []

    def create_source(
        self,
        *,
        tenant_uuid: str,
        workspace_id: str,
        connector: str,
        settings: dict[str, object],
    ) -> StoredSource:
        return self._delegate.create_source(
            tenant_uuid=tenant_uuid,
            workspace_id=workspace_id,
            connector=connector,
            settings=settings,
        )

    def reserve_upload(self, **kwargs: object) -> StoredIngestionJob:
        return self._delegate.reserve_upload(**kwargs)  # type: ignore[arg-type]

    def receive(self, **kwargs: object) -> StoredIngestionJob:
        job = self._delegate.receive(**kwargs)  # type: ignore[arg-type]
        self._record(str(kwargs["tenant_uuid"]), job.ingestion_job_id)
        return job

    def transition(self, **kwargs: object) -> StoredIngestionJob:
        job = self._delegate.transition(**kwargs)  # type: ignore[arg-type]
        self._record(str(kwargs["tenant_uuid"]), job.ingestion_job_id)
        return job

    def fail(self, **kwargs: object) -> StoredIngestionJob:
        job = self._delegate.fail(**kwargs)  # type: ignore[arg-type]
        self._record(str(kwargs["tenant_uuid"]), job.ingestion_job_id)
        return job

    def get(self, **kwargs: object) -> StoredIngestionJob:
        return self._delegate.get(**kwargs)  # type: ignore[arg-type]

    def complete_deduplication(self, **kwargs: object) -> StoredIngestionJob:
        job = self._delegate.complete_deduplication(**kwargs)  # type: ignore[arg-type]
        self._record(str(kwargs["tenant_uuid"]), job.ingestion_job_id)
        return job

    def mark_indexed_as_duplicate(self, **kwargs: object) -> StoredIngestionJob:
        job = self._delegate.mark_indexed_as_duplicate(**kwargs)  # type: ignore[arg-type]
        self._record(str(kwargs["tenant_uuid"]), job.ingestion_job_id)
        return job

    def create_chunks_and_index(self, **kwargs: object) -> StoredIngestionJob:
        job = self._delegate.create_chunks_and_index(**kwargs)  # type: ignore[arg-type]
        self._record(str(kwargs["tenant_uuid"]), job.ingestion_job_id)
        return job

    def get_source_workspace_id(self, **kwargs: object) -> str:
        return self._delegate.get_source_workspace_id(**kwargs)  # type: ignore[arg-type]

    def list_sources(self, **kwargs: object) -> tuple[list[StoredSourceDetail], bool]:
        return self._delegate.list_sources(**kwargs)  # type: ignore[arg-type]

    def get_source_detail(self, **kwargs: object) -> StoredSourceDetail:
        return self._delegate.get_source_detail(**kwargs)  # type: ignore[arg-type]

    def list_documents(self, **kwargs: object) -> tuple[list[StoredDocumentSummary], bool]:
        return self._delegate.list_documents(**kwargs)  # type: ignore[arg-type]

    def get_document_workspace_id(self, **kwargs: object) -> str:
        return self._delegate.get_document_workspace_id(**kwargs)  # type: ignore[arg-type]

    def get_ingestion_job_workspace_id(self, **kwargs: object) -> str:
        return self._delegate.get_ingestion_job_workspace_id(**kwargs)  # type: ignore[arg-type]

    def get_current_document_content(self, **kwargs: object) -> StoredDocumentContent:
        return self._delegate.get_current_document_content(**kwargs)  # type: ignore[arg-type]

    def activate_reindex(self, **kwargs: object) -> StoredReindex:
        return self._delegate.activate_reindex(**kwargs)  # type: ignore[arg-type]

    def _record(self, tenant_uuid: str, ingestion_job_id: str) -> None:
        with self._sessions.begin() as session:
            session.execute(
                sa.text("SELECT set_config('app.current_tenant_id', :tenant_id, true)"),
                {"tenant_id": tenant_uuid},
            )
            stage = session.scalar(
                sa.text("SELECT stage FROM ingestion_jobs WHERE id = :id"),
                {"id": ingestion_job_id},
            )
            assert stage is not None
            self.committed_stages.append(str(stage))


def test_upload_walks_all_seven_durable_stages(database: DatabaseHarness) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    recording = RecordingRepository(
        SqlAlchemyIngestionRepository(database.sessions),
        database.sessions,
    )
    pipeline = _pipeline(database, repository=recording)
    application = FastAPI()
    application.include_router(router)
    application.dependency_overrides[get_ingestion_pipeline] = lambda: pipeline
    content = b'{"project":"Alter"}'

    response = TestClient(application).post(
        "/ads/ingestion/uploads",
        content=content,
        headers={
            "Content-Type": "application/json",
            "X-Alter-Tenant-Id": tenant_id,
            "X-Alter-Source-Id": source_id,
        },
    )

    assert response.status_code == 202
    body = response.json()
    assert body["stage"] == "indexed"
    assert body["stats"]["content_hash"] == hashlib.sha256(content).hexdigest()
    assert body["stats"]["stage_history"] == [
        "received",
        "validated",
        "scanned",
        "normalized",
        "deduplicated",
        "chunked",
        "indexed",
    ]
    assert body["stats"]["deduplication"]["is_duplicate"] is False
    assert body["stats"]["indexing"] == {"chunk_count": 1, "reused_existing_chunks": False}
    assert recording.committed_stages == [
        "received",
        "validated",
        "scanned",
        "normalized",
        "deduplicated",
        "indexed",
    ]


@pytest.mark.parametrize(
    ("content", "content_type", "error_code"),
    [
        (b"123456789", "text/plain", "content_too_large"),
        (b"<xml />", "application/xml", "content_type_not_allowed"),
    ],
)
def test_validation_rejects_oversize_and_disallowed_mime(
    database: DatabaseHarness,
    content: bytes,
    content_type: str,
    error_code: str,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)

    result = _pipeline(database, max_content_bytes=8).ingest(
        IngestionPayload(tenant_id, source_id, content_type, content)
    )

    assert result.stage == "failed"
    assert result.error is not None
    assert result.error.code == error_code
    assert result.stats["stage_history"] == ["received", "failed"]


def test_scan_rejects_known_bad_signature(database: DatabaseHarness) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)

    result = _pipeline(database).ingest(
        IngestionPayload(tenant_id, source_id, "text/plain", b"prefix " + KNOWN_BAD)
    )

    assert result.stage == "failed"
    assert result.error is not None
    assert result.error.code == "known_bad_signature"
    assert result.stats["stage_history"] == ["received", "validated", "failed"]
    assert result.stats["scanned_by"] == "stub"
    assert KNOWN_BAD.decode() not in json.dumps(result.model_dump(mode="json"))


def test_malformed_declared_content_fails_validation(database: DatabaseHarness) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)

    result = _pipeline(database).ingest(
        IngestionPayload(tenant_id, source_id, "application/json", b"not-json")
    )

    assert result.stage == "failed"
    assert result.error is not None
    assert result.error.code == "malformed_content"
    assert result.stats["stage_history"] == ["received", "failed"]


class _FailingScanner:
    def scan(self, *, content: bytes, content_type: str) -> ScanResult:
        del content, content_type
        raise RuntimeError("sensitive scanner diagnostic")


def test_scanner_failure_fails_closed_without_leaking_diagnostic(
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)

    result = _pipeline(database, scanner=_FailingScanner()).ingest(
        IngestionPayload(tenant_id, source_id, "text/plain", b"ordinary content")
    )

    assert result.stage == "failed"
    assert result.error is not None
    assert result.error.code == "scanner_unavailable"
    assert result.stats["stage_history"] == ["received", "validated", "failed"]
    assert "sensitive scanner diagnostic" not in json.dumps(result.model_dump(mode="json"))


def test_stub_clean_result_discloses_its_limits(database: DatabaseHarness) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)

    result = _pipeline(database).ingest(
        IngestionPayload(tenant_id, source_id, "text/plain", b"ordinary clean fixture")
    )

    assert result.stage == "indexed"
    assert result.stats["scanned_by"] == "stub"
    assert result.stats["scan_limitations"] == [
        "signature_only",
        "no_antivirus_engine",
        "no_archive_expansion",
    ]


def test_same_tenant_source_and_hash_is_idempotent(database: DatabaseHarness) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    pipeline = _pipeline(database)
    payload = IngestionPayload(tenant_id, source_id, "application/json", b'{"same":true}')

    first = pipeline.ingest(payload)
    second = pipeline.ingest(payload)

    assert first.ingestion_job_id == second.ingestion_job_id
    with database.runtime_engine.begin() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant_id, true)"),
            {"tenant_id": tenant_uuid},
        )
        count = connection.scalar(
            sa.text(
                "SELECT count(*) FROM ingestion_jobs "
                "WHERE source_id = :source AND stats->>'content_hash' = :hash"
            ),
            {
                "source": source_id,
                "hash": hashlib.sha256(payload.content).hexdigest(),
            },
        )
    assert count == 1


def test_runtime_role_cannot_read_another_tenants_job(database: DatabaseHarness) -> None:
    tenant_a, tenant_a_uuid = _new_tenant()
    _, tenant_b_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_a_uuid)
    result = _pipeline(database).ingest(
        IngestionPayload(tenant_a, source_id, "text/plain", b"tenant private")
    )

    with database.runtime_engine.begin() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant_id, true)"),
            {"tenant_id": tenant_b_uuid},
        )
        hidden_count = connection.scalar(
            sa.text("SELECT count(*) FROM ingestion_jobs WHERE id = :id"),
            {"id": result.ingestion_job_id},
        )
    with database.runtime_engine.begin() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant_id, true)"),
            {"tenant_id": tenant_a_uuid},
        )
        visible_count = connection.scalar(
            sa.text("SELECT count(*) FROM ingestion_jobs WHERE id = :id"),
            {"id": result.ingestion_job_id},
        )

    assert hidden_count == 0
    assert visible_count == 1


def _dedup_stats(stats: dict[str, object]) -> dict[str, object]:
    return cast(dict[str, object], stats["deduplication"])


def _normalization_stats(stats: dict[str, object]) -> dict[str, object]:
    return cast(dict[str, object], stats["normalization"])


def _tenant_scoped(database: DatabaseHarness, tenant_uuid: str) -> sa.engine.Connection:
    connection = database.runtime_engine.connect()
    connection.execute(
        sa.text("SELECT set_config('app.current_tenant_id', :tenant_id, true)"),
        {"tenant_id": tenant_uuid},
    )
    return connection


def test_distinct_content_creates_a_real_document_and_version(
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)

    result = _pipeline(database).ingest(
        IngestionPayload(tenant_id, source_id, "text/plain", b"a brand new document")
    )

    assert result.stage == "indexed"
    document_id = _dedup_stats(result.stats)["document_id"]

    with _tenant_scoped(database, tenant_uuid) as connection:
        document = connection.execute(
            sa.text(
                "SELECT source_id, kind, current_version, permissions, status "
                "FROM documents WHERE id = :id"
            ),
            {"id": document_id},
        ).mappings().one()
        version = connection.execute(
            sa.text(
                "SELECT content_ref, normalized_ref, content_hash, provenance, ingestion_job_id "
                "FROM document_versions WHERE document_id = :id AND version = 1"
            ),
            {"id": document_id},
        ).mappings().one()

    assert document["source_id"] == source_id
    assert document["kind"] == "file"
    assert document["current_version"] == 1
    assert document["status"] == "active"
    assert dict(document["permissions"]) == {"visibility": "tenant", "shared_with": []}
    assert version["content_ref"] != version["normalized_ref"]
    assert version["content_hash"] == TextAwareNormalizer().normalize(
        content=b"a brand new document", content_type="text/plain"
    ).content_hash
    assert version["ingestion_job_id"] == result.ingestion_job_id
    provenance = dict(version["provenance"])
    assert provenance["raw_content_hash"] == hashlib.sha256(b"a brand new document").hexdigest()
    assert provenance["normalized_by"] == "text-nfc-lines-v1"


def test_json_canonicalization_dedups_differently_formatted_duplicates(
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    pipeline = _pipeline(database)

    first = pipeline.ingest(
        IngestionPayload(tenant_id, source_id, "application/json", b'{"a":1,"b":2}')
    )
    # Same object, different key order and whitespace -- different raw bytes,
    # so this is a genuinely new ingestion job (not caught by stage-1's raw
    # content_hash idempotency), but canonically identical JSON.
    second = pipeline.ingest(
        IngestionPayload(tenant_id, source_id, "application/json", b'{  "b": 2, "a": 1  }')
    )

    assert first.ingestion_job_id != second.ingestion_job_id
    assert _dedup_stats(first.stats)["is_duplicate"] is False
    assert _dedup_stats(second.stats)["is_duplicate"] is True
    assert (
        _dedup_stats(second.stats)["duplicate_of_document_id"]
        == _dedup_stats(first.stats)["document_id"]
    )
    with _tenant_scoped(database, tenant_uuid) as connection:
        document_count = connection.scalar(
            sa.text("SELECT count(*) FROM documents WHERE source_id = :source"),
            {"source": source_id},
        )
    assert document_count == 1


def test_text_normalization_dedups_trailing_whitespace_and_blank_line_variants(
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    pipeline = _pipeline(database)

    first = pipeline.ingest(
        IngestionPayload(tenant_id, source_id, "text/plain", b"line one\nline two")
    )
    second = pipeline.ingest(
        IngestionPayload(
            tenant_id, source_id, "text/plain", b"line one   \r\nline two\r\n\n\n"
        )
    )

    assert _dedup_stats(first.stats)["is_duplicate"] is False
    assert _dedup_stats(second.stats)["is_duplicate"] is True


def test_binary_content_normalization_is_an_honest_passthrough(
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    png_content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16

    result = _pipeline(database).ingest(
        IngestionPayload(tenant_id, source_id, "image/png", png_content)
    )

    # Normalization itself still runs and stays an honest passthrough --
    # the job fails one stage later, at chunking (see
    # test_binary_content_fails_instead_of_indexing_a_placeholder).
    assert result.stage == "failed"
    normalization = _normalization_stats(result.stats)
    assert normalization["normalized_by"] == "passthrough"
    assert normalization["limitations"] == ["no_text_extraction_for_binary_content"]
    assert normalization["normalized_content_hash"] == hashlib.sha256(png_content).hexdigest()


def test_binary_content_fails_instead_of_indexing_a_placeholder(
    database: DatabaseHarness,
) -> None:
    # ENGINE-FIX-P3-25 (Wave 4 item 1): pdf/png/jpeg have no real
    # text-extractor anywhere in this repo. Chunking them used to
    # manufacture one "[image/png content, N bytes]" placeholder chunk and
    # embed+index it as if it were real content -- the job reported
    # "indexed" with no error, but the document was never really
    # searchable. It must fail loudly instead.
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    embedding_client = FakeEmbeddingClient()
    png_content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16

    result = _pipeline(database, embedding_client=embedding_client).ingest(
        IngestionPayload(tenant_id, source_id, "image/png", png_content)
    )

    assert result.stage == "failed"
    assert result.error is not None
    assert result.error.code == "text_extraction_unavailable"
    assert result.stats["stage_history"] == [
        "received",
        "validated",
        "scanned",
        "normalized",
        "deduplicated",
        "failed",
    ]
    assert result.stats["chunking"] == {"content_type": "image/png"}
    # No placeholder text ever reached the embedding client -- nothing got
    # a fake vector.
    assert embedding_client.calls == []

    # The raw upload is still real and stored -- only chunk-and-index was
    # rejected, not the upload itself.
    document_id = _dedup_stats(result.stats)["document_id"]
    with _tenant_scoped(database, tenant_uuid) as connection:
        chunk_count = connection.scalar(
            sa.text("SELECT count(*) FROM chunks WHERE document_id = :document_id"),
            {"document_id": document_id},
        )
        document_count = connection.scalar(
            sa.text("SELECT count(*) FROM documents WHERE id = :document_id"),
            {"document_id": document_id},
        )
    assert chunk_count == 0
    assert document_count == 1


def test_reindex_of_a_binary_document_also_rejects_instead_of_placeholding(
    database: DatabaseHarness,
) -> None:
    # A retry/reindex call on a document whose original ingestion already
    # failed at chunking (raw content persisted, zero chunks) must hit the
    # same honest rejection -- not silently succeed with a placeholder on
    # the second attempt.
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    storage = InMemoryObjectStorageProvider()
    png_content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
    failed = _pipeline(database, object_storage=storage).ingest(
        IngestionPayload(tenant_id, source_id, "image/png", png_content)
    )
    document_id = str(_dedup_stats(failed.stats)["document_id"])
    pipeline = _pipeline(database, object_storage=storage)

    with pytest.raises(UnsupportedContentTypeError):
        pipeline.reindex(tenant_id=tenant_id, document_id=document_id)


def _indexing_stats(stats: dict[str, object]) -> dict[str, object]:
    return cast(dict[str, object], stats["indexing"])


def test_new_document_gets_real_chunks_with_real_embeddings(
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    embedding_client = FakeEmbeddingClient()
    content = b"first paragraph here.\n\nsecond paragraph here."

    result = _pipeline(database, embedding_client=embedding_client).ingest(
        IngestionPayload(tenant_id, source_id, "text/plain", content)
    )

    assert result.stage == "indexed"
    document_id = _dedup_stats(result.stats)["document_id"]
    indexing = _indexing_stats(result.stats)
    assert indexing["reused_existing_chunks"] is False
    assert indexing["chunk_count"] == 1  # both paragraphs fit in one window
    assert len(embedding_client.calls) == 1
    _, embedded_text, dimensions = embedding_client.calls[0]
    assert dimensions == 1024
    assert "first paragraph here." in embedded_text
    assert "second paragraph here." in embedded_text

    with _tenant_scoped(database, tenant_uuid) as connection:
        chunk = connection.execute(
            sa.text(
                "SELECT document_id, document_version, seq, text_content, "
                "embedding_provider, embedding_model, embedding_version "
                "FROM chunks WHERE document_id = :id"
            ),
            {"id": document_id},
        ).mappings().one()
        embedding_dim = connection.execute(
            sa.text(
                "SELECT atttypmod FROM pg_attribute "
                "JOIN pg_class ON attrelid = pg_class.oid "
                "WHERE relname = 'chunks' AND attname = 'embedding'"
            )
        ).scalar()

    assert chunk["document_id"] == document_id
    assert chunk["document_version"] == 1
    assert chunk["seq"] == 0
    assert chunk["embedding_provider"] == "aws-bedrock"
    assert chunk["embedding_model"] == FAKE_MODEL_ID
    assert chunk["embedding_version"] == "v1"
    assert embedding_dim == 1024


def test_ingestion_embeds_chunks_concurrently_without_losing_sequence(
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    chunks = tuple(Chunk(seq=index, text=f"chunk {index}") for index in range(5))
    delay_seconds = 0.2
    embedding_client = _DelayedEmbeddingClient(delay_seconds)
    pipeline = _pipeline(
        database,
        chunk_splitter=_FixedChunkSplitter(chunks),
        embedding_client=embedding_client,
    )

    started_at = monotonic()
    result = pipeline.ingest(
        IngestionPayload(tenant_id, source_id, "text/plain", b"five fixed chunks")
    )
    elapsed_seconds = monotonic() - started_at

    assert result.stage == "indexed"
    assert elapsed_seconds < 0.6, f"expected bounded concurrency, took {elapsed_seconds:.3f}s"
    assert {text for _, text, _ in embedding_client.calls} == {
        "chunk 0",
        "chunk 1",
        "chunk 2",
        "chunk 3",
        "chunk 4",
    }
    document_id = str(_dedup_stats(result.stats)["document_id"])
    with _tenant_scoped(database, tenant_uuid) as connection:
        stored = connection.execute(
            sa.text(
                "SELECT seq, text_content FROM chunks WHERE document_id = :document "
                "ORDER BY seq"
            ),
            {"document": document_id},
        ).mappings().all()
    assert [(row["seq"], row["text_content"]) for row in stored] == [
        (chunk.seq, chunk.text) for chunk in chunks
    ]


def test_ingestion_surfaces_one_chunk_embedding_failure_without_partial_indexing(
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    chunks = tuple(Chunk(seq=index, text=f"chunk {index}") for index in range(3))
    pipeline = _pipeline(
        database,
        chunk_splitter=_FixedChunkSplitter(chunks),
        embedding_client=_FailingOnChunkEmbeddingClient(),
    )

    with pytest.raises(RuntimeError, match="embedding unavailable for chunk 2"):
        pipeline.ingest(
            IngestionPayload(tenant_id, source_id, "text/plain", b"three fixed chunks")
        )

    with _tenant_scoped(database, tenant_uuid) as connection:
        chunk_count = connection.scalar(sa.text("SELECT count(*) FROM chunks"))
    assert chunk_count == 0


def test_duplicate_content_reuses_chunks_without_re_embedding(
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    embedding_client = FakeEmbeddingClient()
    pipeline = _pipeline(database, embedding_client=embedding_client)

    first = pipeline.ingest(
        IngestionPayload(tenant_id, source_id, "application/json", b'{"a":1,"b":2}')
    )
    calls_after_first = len(embedding_client.calls)
    second = pipeline.ingest(
        IngestionPayload(tenant_id, source_id, "application/json", b'{  "b": 2, "a": 1  }')
    )

    assert first.stage == "indexed"
    assert second.stage == "indexed"
    assert _indexing_stats(first.stats) == {"chunk_count": 1, "reused_existing_chunks": False}
    assert _indexing_stats(second.stats) == {"chunk_count": 0, "reused_existing_chunks": True}
    # The duplicate must never call the embedding provider again.
    assert len(embedding_client.calls) == calls_after_first

    with _tenant_scoped(database, tenant_uuid) as connection:
        chunk_count = connection.scalar(
            sa.text("SELECT count(*) FROM chunks WHERE document_id = :id"),
            {"id": _dedup_stats(first.stats)["document_id"]},
        )
    assert chunk_count == 1


def test_long_text_splits_into_multiple_chunks_without_cutting_a_paragraph(
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    paragraph_a = "alpha " * 200  # ~1200 chars, exceeds the 1000-char window alone
    paragraph_b = "beta " * 50
    content = f"{paragraph_a}\n\n{paragraph_b}".encode()

    result = _pipeline(
        database, max_content_bytes=len(content) + 10
    ).ingest(IngestionPayload(tenant_id, source_id, "text/plain", content))

    assert result.stage == "indexed"
    indexing = _indexing_stats(result.stats)
    assert cast(int, indexing["chunk_count"]) >= 2

    with _tenant_scoped(database, tenant_uuid) as connection:
        chunks = connection.execute(
            sa.text(
                "SELECT seq, text_content FROM chunks "
                "WHERE document_id = :id ORDER BY seq"
            ),
            {"id": _dedup_stats(result.stats)["document_id"]},
        ).mappings().all()

    assert [row["seq"] for row in chunks] == list(range(len(chunks)))
    # Neither paragraph was cut mid-string across chunk boundaries.
    assert any(paragraph_a.strip() in row["text_content"] for row in chunks)
    assert any(paragraph_b.strip() in row["text_content"] for row in chunks)


def test_adjacent_chunks_overlap_on_the_shared_boundary_paragraph(
    database: DatabaseHarness,
) -> None:
    # ENGINE-FIX-P3-26 (Wave 4 item 2): a real retrieval hit near a chunk
    # boundary needs shared context on both sides, or the idea that
    # straddled the boundary is only ever half-visible to a search. The
    # small boundary paragraph here fits under the overlap budget, so it
    # must appear whole in BOTH chunks, not just the one that "owns" it.
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    para1 = "first window filler word " * 30  # ~750 chars
    boundary = "BOUNDARY MARKER SENTENCE " * 2  # ~50 chars, fits the overlap budget
    para3 = "second window filler word " * 35  # ~910 chars, forces a new window
    content = f"{para1}\n\n{boundary}\n\n{para3}".encode()

    result = _pipeline(database, max_content_bytes=len(content) + 10).ingest(
        IngestionPayload(tenant_id, source_id, "text/plain", content)
    )

    assert result.stage == "indexed"
    assert cast(int, _indexing_stats(result.stats)["chunk_count"]) == 2

    with _tenant_scoped(database, tenant_uuid) as connection:
        chunks = (
            connection.execute(
                sa.text(
                    "SELECT seq, text_content FROM chunks WHERE document_id = :id ORDER BY seq"
                ),
                {"id": _dedup_stats(result.stats)["document_id"]},
            )
            .mappings()
            .all()
        )

    assert len(chunks) == 2
    boundary_text = boundary.strip()
    assert boundary_text in chunks[0]["text_content"]
    assert boundary_text in chunks[1]["text_content"]
    # The overlap is a prefix of the second chunk, not a random substring.
    assert chunks[1]["text_content"].startswith(boundary_text)
    # The big filler paragraphs were not duplicated across the boundary.
    assert para1.strip() not in chunks[1]["text_content"]
    assert para3.strip() not in chunks[0]["text_content"]


def test_reindex_reads_stored_content_and_atomically_activates_new_chunks(
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    storage = InMemoryObjectStorageProvider()
    content = b"stored paragraph for a real reindex"
    initial = _pipeline(
        database,
        object_storage=storage,
        embedding_pipeline_version="v0",
    ).ingest(IngestionPayload(tenant_id, source_id, "text/plain", content))
    document_id = str(_dedup_stats(initial.stats)["document_id"])

    with _tenant_scoped(database, tenant_uuid) as connection:
        refs = (
            connection.execute(
                sa.text(
                    "SELECT content_ref, normalized_ref FROM document_versions "
                    "WHERE document_id = :document AND version = 1"
                ),
                {"document": document_id},
            )
            .mappings()
            .one()
        )
    assert storage.get_object_bytes(key=refs["content_ref"], max_bytes=1024) == content
    assert storage.get_object_bytes(key=refs["normalized_ref"], max_bytes=1024) == content

    servicer = _EmbeddingServicer()
    grpc_server = grpc.server(ThreadPoolExecutor(max_workers=1))
    modelgw_pb2_grpc.add_ModelgwServiceServicer_to_server(  # type: ignore[no-untyped-call]
        servicer, grpc_server
    )
    port = grpc_server.add_insecure_port("127.0.0.1:0")
    grpc_server.start()
    embedding_client = GrpcEmbeddingClient(f"127.0.0.1:{port}")
    try:
        pipeline = _pipeline(
            database,
            object_storage=storage,
            embedding_client=embedding_client,
            embedding_pipeline_version="v1",
        )
        application = FastAPI()
        application.include_router(router)
        application.dependency_overrides[get_ingestion_pipeline] = lambda: pipeline

        response = TestClient(application).post(
            f"/ads/documents/{document_id}/actions/reindex",
            headers={"X-Alter-Tenant-Id": tenant_id},
        )
    finally:
        embedding_client.close()
        grpc_server.stop(0).wait()

    assert response.status_code == 200, response.text
    assert response.json() == {
        "document_id": document_id,
        "previous_document_version": 1,
        "document_version": 2,
        "embedding_version": "v1",
        "chunk_count": 1,
    }
    assert servicer.calls == [(tenant_id, content.decode(), 1024)]

    with _tenant_scoped(database, tenant_uuid) as connection:
        current_version = connection.scalar(
            sa.text("SELECT current_version FROM documents WHERE id = :document"),
            {"document": document_id},
        )
        generation_rows = connection.execute(
            sa.text(
                "SELECT document_version, embedding_version FROM chunks "
                "WHERE document_id = :document ORDER BY document_version"
            ),
            {"document": document_id},
        ).all()
        scope = connection.execute(
            sa.text(
                "SELECT s.id, s.workspace_id::text FROM scopes s "
                "JOIN documents d ON d.scope_id = s.id AND d.tenant_id = s.tenant_id "
                "WHERE d.id = :document"
            ),
            {"document": document_id},
        ).one()
    assert current_version == 2
    assert [(row[0], row[1]) for row in generation_rows] == [(1, "v0"), (2, "v1")]

    retrieved = SqlAlchemyRetrievalRepository(database.sessions).retrieve(
        RetrievalRequest(
            tenant_id=tenant_id,
            workspace_id=f"ws_{scope[1]}",
            requester="reindex-test",
            query="stored paragraph",
            scope_ids=(str(scope[0]),),
        ),
        tuple(0.5 for _ in range(1024)),
    )
    assert len(retrieved.hits) == 1
    assert retrieved.hits[0].document_id == document_id
    assert retrieved.hits[0].provenance["document"]["version"] == 2  # type: ignore[index]


def test_reindex_is_tenant_scoped_and_cross_tenant_request_is_hidden(
    database: DatabaseHarness,
) -> None:
    tenant_a, tenant_a_uuid = _new_tenant()
    tenant_b, _ = _new_tenant()
    source_id = _seed_source(database, tenant_a_uuid)
    storage = InMemoryObjectStorageProvider()
    pipeline = _pipeline(database, object_storage=storage)
    initial = pipeline.ingest(IngestionPayload(tenant_a, source_id, "text/plain", b"tenant A only"))
    document_id = str(_dedup_stats(initial.stats)["document_id"])
    application = FastAPI()
    application.include_router(router)
    application.dependency_overrides[get_ingestion_pipeline] = lambda: pipeline

    response = TestClient(application).post(
        f"/ads/documents/{document_id}/actions/reindex",
        headers={"X-Alter-Tenant-Id": tenant_b},
    )

    assert response.status_code == 404
    with _tenant_scoped(database, tenant_a_uuid) as connection:
        assert (
            connection.scalar(
                sa.text("SELECT current_version FROM documents WHERE id = :document"),
                {"document": document_id},
            )
            == 1
        )
        assert (
            connection.scalar(
                sa.text("SELECT count(*) FROM chunks WHERE document_id = :document"),
                {"document": document_id},
            )
            == 1
        )


class _FailingEmbeddingClient:
    def embed(
        self, *, tenant_id: str, text: str, dimensions: EmbeddingDimensions
    ) -> EmbeddingResult:
        del tenant_id, text, dimensions
        raise RuntimeError("embedding unavailable")


def test_reindex_failure_keeps_previous_chunk_generation_active(
    database: DatabaseHarness,
) -> None:
    tenant_id, tenant_uuid = _new_tenant()
    source_id = _seed_source(database, tenant_uuid)
    storage = InMemoryObjectStorageProvider()
    initial = _pipeline(database, object_storage=storage).ingest(
        IngestionPayload(tenant_id, source_id, "text/plain", b"durable old generation")
    )
    document_id = str(_dedup_stats(initial.stats)["document_id"])
    failing = _pipeline(
        database,
        object_storage=storage,
        embedding_client=_FailingEmbeddingClient(),
        embedding_pipeline_version="v2",
    )

    with pytest.raises(RuntimeError, match="embedding unavailable"):
        failing.reindex(tenant_id=tenant_id, document_id=document_id)

    with _tenant_scoped(database, tenant_uuid) as connection:
        assert (
            connection.scalar(
                sa.text("SELECT current_version FROM documents WHERE id = :document"),
                {"document": document_id},
            )
            == 1
        )
        assert (
            connection.scalar(
                sa.text("SELECT count(*) FROM document_versions WHERE document_id = :document"),
                {"document": document_id},
            )
            == 1
        )
        assert (
            connection.scalar(
                sa.text("SELECT count(*) FROM chunks WHERE document_id = :document"),
                {"document": document_id},
            )
            == 1
        )

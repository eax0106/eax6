from __future__ import annotations

import uuid
from collections.abc import Generator
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
from src.ingestion.embedding_client import EmbeddingDimensions, EmbeddingResult
from src.memory_namespace.repository import SqlAlchemyMemoryNamespaceRepository
from src.query.models import RetrievalRequest
from src.query.repository import ScopeViolationError, SqlAlchemyRetrievalRepository
from src.query.router import get_retrieval_service
from src.query.router import router as query_router
from src.query.service import RetrievalBackpressureError, RetrievalService

SERVICE_ROOT = Path(__file__).parent.parent
PGVECTOR_IMAGE = "pgvector/pgvector:pg16"
RUNTIME_ROLE = "ads_query_runtime"
RUNTIME_PASSWORD = "query-test-password"


class FakeEmbeddings:
    def embed(
        self, *, tenant_id: str, text: str, dimensions: EmbeddingDimensions
    ) -> EmbeddingResult:
        del tenant_id, text
        return EmbeddingResult(vector=(1.0,) + (0.0,) * (dimensions - 1), model_id="test")


@pytest.fixture(scope="module")
def retrieval_service() -> Generator[tuple[RetrievalService, sa.Engine], None, None]:
    with PostgresContainer(
        image=PGVECTOR_IMAGE, dbname="ads_db", username="ads_core", password="testpass"
    ) as pg:
        url = pg.get_connection_url()
        config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        config.set_main_option("sqlalchemy.url", url)
        command.upgrade(config, "head")
        admin = sa.create_engine(url)
        with admin.begin() as connection:
            connection.execute(
                sa.text(f"CREATE ROLE {RUNTIME_ROLE} LOGIN PASSWORD '{RUNTIME_PASSWORD}'")
            )
            for table in (
                "scopes",
                "sources",
                "documents",
                "document_versions",
                "chunks",
                "retrieval_audit",
                "memory_namespace",
            ):
                connection.execute(sa.text(f"GRANT SELECT, INSERT ON {table} TO {RUNTIME_ROLE}"))
            connection.execute(sa.text(f"GRANT USAGE ON SCHEMA public TO {RUNTIME_ROLE}"))
        runtime_url = sa.engine.make_url(url).set(username=RUNTIME_ROLE, password=RUNTIME_PASSWORD)
        runtime = sa.create_engine(runtime_url)
        service = RetrievalService(
            repository=SqlAlchemyRetrievalRepository(
                sessionmaker(bind=runtime, class_=Session),
                # Fixed anonymous corpus; separate native proof covers settings and redaction.
                SqlAlchemyMemoryNamespaceRepository(
                    sessionmaker(bind=runtime, class_=Session),
                    access=lambda _tenant, _workspace: (True, 90),
                    redact=lambda _tenant, content: content,
                ),
            ),
            embeddings=FakeEmbeddings(),
            max_concurrency=1,
        )
        yield service, admin
        runtime.dispose()
        admin.dispose()


def _seed(admin: sa.Engine) -> tuple[str, str, str, str, str, str]:
    tenant = str(uuid.uuid4())
    workspace = str(uuid.uuid4())
    other_workspace = str(uuid.uuid4())
    scope = new_prefixed_id("scp")
    other_scope = new_prefixed_id("scp")
    source = new_prefixed_id("src")
    document = new_prefixed_id("doc")
    other_document = new_prefixed_id("doc")
    with admin.begin() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"), {"tenant": tenant}
        )
        connection.execute(
            sa.text(
                "INSERT INTO scopes(id,tenant_id,workspace_id) VALUES (:id,:tenant,:workspace)"
            ),
            {"id": scope, "tenant": tenant, "workspace": workspace},
        )
        connection.execute(
            sa.text(
                "INSERT INTO scopes(id,tenant_id,workspace_id) VALUES (:id,:tenant,:workspace)"
            ),
            {"id": other_scope, "tenant": tenant, "workspace": other_workspace},
        )
        connection.execute(
            sa.text(
                "INSERT INTO sources(id,tenant_id,scope_id,kind) VALUES (:id,:tenant,:scope,'upload')"  # noqa: E501
            ),
            {"id": source, "tenant": tenant, "scope": scope},
        )
        for doc, doc_scope in ((document, scope), (other_document, other_scope)):
            connection.execute(
                sa.text(
                    "INSERT INTO documents(id,tenant_id,scope_id,source_id,kind,current_version,status) VALUES (:id,:tenant,:scope,:source,'file',1,'active')"  # noqa: E501
                ),
                {"id": doc, "tenant": tenant, "scope": doc_scope, "source": source},
            )
            connection.execute(
                sa.text(
                    "INSERT INTO document_versions(document_id,version,content_ref,provenance) VALUES (:id,1,'ref',:provenance)"  # noqa: E501
                ),
                {"id": doc, "provenance": '{"origin":"test"}'},
            )
        for text_value, metadata, doc, doc_scope in (
            ("refund policy allows returns", '{"department":"support"}', document, scope),
            ("refund hidden workspace", '{"department":"finance"}', other_document, other_scope),
        ):
            connection.execute(
                sa.text(
                    "INSERT INTO chunks(id,tenant_id,scope_id,document_id,document_version,seq,text_content,metadata,embedding,embedding_provider,embedding_model,embedding_version) VALUES (:id,:tenant,:scope,:document,1,0,:text,CAST(:metadata AS jsonb),CAST(:embedding AS vector),'test','test','v1')"  # noqa: E501
                ),
                {
                    "id": new_prefixed_id("chk"),
                    "tenant": tenant,
                    "scope": doc_scope,
                    "document": doc,
                    "text": text_value,
                    "metadata": metadata,
                    "embedding": "[1," + ",".join(["0"] * 1023) + "]",
                },
            )
    return f"ten_{tenant}", f"ws_{workspace}", scope, document, source, f"ws_{other_workspace}"


def _seed_empty_tenant(admin: sa.Engine) -> tuple[str, str, str]:
    tenant = str(uuid.uuid4())
    workspace = str(uuid.uuid4())
    scope = new_prefixed_id("scp")
    with admin.begin() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": tenant},
        )
        connection.execute(
            sa.text(
                "INSERT INTO scopes(id,tenant_id,workspace_id) VALUES (:id,:tenant,:workspace)"
            ),
            {"id": scope, "tenant": tenant, "workspace": workspace},
        )
    return f"ten_{tenant}", f"ws_{workspace}", scope


def test_hybrid_query_filters_metadata_scopes_and_audits(
    retrieval_service: tuple[RetrievalService, sa.Engine],
) -> None:
    service, admin = retrieval_service
    tenant, workspace, scope, document, source, other_workspace = _seed(admin)
    response = service.retrieve(
        RetrievalRequest(
            tenant_id=tenant,
            workspace_id=workspace,
            requester="svc_engine",
            query="refund policy",
            scope_ids=(scope,),
            source_ids=(source,),
            rerank=True,
            metadata_filter={"department": "support"},
        )
    )
    assert [hit.document_id for hit in response.hits] == [document]
    provenance = response.hits[0].provenance
    assert provenance["ingestion"] == {"origin": "test"}
    document_provenance = provenance["document"]
    source_provenance = provenance["source"]
    adsq_provenance = provenance["adsq"]
    assert isinstance(document_provenance, dict)
    assert isinstance(source_provenance, dict)
    assert isinstance(adsq_provenance, dict)
    assert document_provenance["id"] == document
    assert source_provenance["id"] == response.hits[0].source_id
    assert adsq_provenance["ranking_version"] == "know9-v1"
    assert response.audited_at is not None
    with admin.connect() as connection:
        audit = (
            connection.execute(
                sa.text(
                    "SELECT scope_inputs, filters, candidate_ids, result_doc_ids, "
                    "ranking_summary, outcome FROM retrieval_audit"
                )
            )
            .mappings()
            .one()
        )
    assert audit["scope_inputs"]["scope_ids"] == [scope]
    assert audit["scope_inputs"]["source_ids"] == [source]
    assert audit["filters"] == {"department": "support"}
    assert audit["candidate_ids"]["chunk_ids"] == [response.hits[0].chunk_id]
    assert audit["result_doc_ids"]["document_ids"] == [document]
    assert audit["ranking_summary"]["result_count"] == 1
    assert audit["outcome"] == "succeeded"
    with pytest.raises(ScopeViolationError):
        service.retrieve(
            RetrievalRequest(
                tenant_id=tenant,
                workspace_id=other_workspace,
                requester="svc_engine",
                query="refund",
                scope_ids=(scope,),
            )
        )
    with admin.connect() as connection:
        assert connection.scalar(sa.text("SELECT count(*) FROM retrieval_audit")) == 2
        assert (
            connection.scalar(
                sa.text("SELECT outcome FROM retrieval_audit ORDER BY created_at DESC LIMIT 1")
            )
            == "rejected"
        )


def test_retrieval_includes_real_memory_namespace_facts_scoped_to_the_request(
    retrieval_service: tuple[RetrievalService, sa.Engine],
) -> None:
    service, admin = retrieval_service
    tenant, workspace, scope, _document, source, _other_workspace = _seed(admin)
    fact_id = new_prefixed_id("mns")
    other_scope_fact_id = new_prefixed_id("mns")
    tenant_uuid = tenant.removeprefix("ten_")
    workspace_uuid = workspace.removeprefix("ws_")
    with admin.begin() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": tenant_uuid},
        )
        connection.execute(
            sa.text(
                "INSERT INTO memory_namespace "
                "(id, tenant_id, scope_id, kind, statement, confidence, provenance, status) "
                "VALUES (:id, :tenant, :scope, 'project_fact', :statement, 0.8, "
                "CAST(:provenance AS jsonb), 'active')"
            ),
            {
                "id": fact_id,
                "tenant": tenant_uuid,
                "scope": scope,
                "statement": "Run completed with verdict 'completed_verified'.",
                "provenance": '{"memory_id":"mem_test"}',
            },
        )
        # A different, real, tenant-visible scope -- must not leak into a
        # request that only asked for `scope`.
        other_scope = new_prefixed_id("scp")
        connection.execute(
            sa.text(
                "INSERT INTO scopes(id,tenant_id,workspace_id) VALUES (:id,:tenant,:workspace)"
            ),
            {"id": other_scope, "tenant": tenant_uuid, "workspace": workspace_uuid},
        )
        connection.execute(
            sa.text(
                "INSERT INTO memory_namespace "
                "(id, tenant_id, scope_id, kind, statement, provenance, status) "
                "VALUES (:id, :tenant, :scope, 'project_fact', 'other scope fact', "
                "'{}'::jsonb, 'active')"
            ),
            {"id": other_scope_fact_id, "tenant": tenant_uuid, "scope": other_scope},
        )

    response = service.retrieve(
        RetrievalRequest(
            tenant_id=tenant,
            workspace_id=workspace,
            requester="svc_engine",
            query="refund policy",
            scope_ids=(scope,),
            source_ids=(source,),
        )
    )

    assert [fact.id for fact in response.memory_facts] == [fact_id]
    assert response.memory_facts[0].statement == "Run completed with verdict 'completed_verified'."
    assert response.memory_facts[0].confidence == 0.8


def test_query_route_returns_real_seeded_provenance_and_confidence(
    retrieval_service: tuple[RetrievalService, sa.Engine],
) -> None:
    service, admin = retrieval_service
    tenant, workspace, scope, document, source, _ = _seed(admin)
    application = FastAPI()
    application.include_router(query_router)
    application.dependency_overrides[get_retrieval_service] = lambda: service
    client = TestClient(application)

    response = client.post(
        "/ads/query",
        headers={
            "X-Alter-Tenant-Id": tenant,
            "X-Alter-Workspace-Id": workspace,
            "X-Alter-Requester": "usr_retrieval_test",
        },
        json={
            "tenant_id": tenant,
            "workspace_id": workspace,
            "requester": "usr_retrieval_test",
            "query": "refund policy",
            "rerank": True,
            "scope_ids": [scope],
            "source_ids": [source],
            "metadata_filter": {"department": "support"},
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert [hit["document_id"] for hit in body["hits"]] == [document]
    assert isinstance(body["hits"][0]["confidence"], float)
    assert body["hits"][0]["provenance"]["ingestion"] == {"origin": "test"}
    assert body["audited_at"] is not None


def test_retrieval_backpressure_is_audited(
    retrieval_service: tuple[RetrievalService, sa.Engine],
) -> None:
    service, admin = retrieval_service
    tenant, workspace, scope, _, _, _ = _seed(admin)
    service._slots.acquire()  # Exercise a full gate without timing-sensitive worker threads.
    try:
        with pytest.raises(RetrievalBackpressureError):
            service.retrieve(
                RetrievalRequest(
                    tenant_id=tenant,
                    workspace_id=workspace,
                    requester="svc_engine",
                    query="refund",
                    scope_ids=(scope,),
                )
            )
    finally:
        service._slots.release()
    with admin.connect() as connection:
        assert (
            connection.scalar(
                sa.text("SELECT outcome FROM retrieval_audit ORDER BY created_at DESC LIMIT 1")
            )
            == "backpressured"
        )


def test_redteam_cross_tenant_scope_is_rejected_without_leaking_hits(
    retrieval_service: tuple[RetrievalService, sa.Engine],
) -> None:
    service, admin = retrieval_service
    _, _, foreign_scope, foreign_document, _, _ = _seed(admin)
    tenant, workspace, own_scope = _seed_empty_tenant(admin)

    with pytest.raises(ScopeViolationError):
        service.retrieve(
            RetrievalRequest(
                tenant_id=tenant,
                workspace_id=workspace,
                requester="svc_engine",
                query="refund policy",
                scope_ids=(foreign_scope,),
            )
        )

    assert service.provenance(tenant_id=tenant, document_id=foreign_document) is None
    with admin.connect() as connection:
        audit = (
            connection.execute(
                sa.text(
                    "SELECT outcome, result_doc_ids FROM retrieval_audit "
                    "ORDER BY created_at DESC LIMIT 1"
                )
            )
            .mappings()
            .one()
        )
    assert audit["outcome"] == "rejected"
    assert audit["result_doc_ids"] == {"document_ids": []}
    assert own_scope.startswith("scp_")

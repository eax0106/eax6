from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import time
from pathlib import Path

import grpc
import pytest
import sqlalchemy as sa
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from alter.memory.v1 import memory_pb2, memory_pb2_grpc
from src.config import get_settings
from src.db.ids import new_prefixed_id
from src.ingestion.embedding_client import GrpcEmbeddingClient
from src.m2m_auth import Auth0M2mTokenProvider
from src.memory_namespace.client import GrpcWorkspaceMemoryClient, MemoryUnavailableError
from src.memory_namespace.repository import SqlAlchemyMemoryNamespaceRepository
from src.memory_namespace.router import configure_memory_namespace_repository
from src.query.models import RetrievalRequest
from src.query.repository import ScopeViolationError, SqlAlchemyRetrievalRepository
from src.query.service import RetrievalService

ROOT = Path(__file__).resolve().parents[3]
ADS = ROOT / "apps/ads-core"
MEMORY = ROOT / "apps/memory-service"
AUTHORIZATION = "Bearer integration-token"


def _port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def test_ads_uses_actual_memory_settings_redaction_and_scheduled_retention(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    digest = hashlib.sha256(b"integration-token").hexdigest()
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN_SHA256", digest)
    tenant, other_tenant = new_prefixed_id("ten"), new_prefixed_id("ten")
    workspace, other_workspace = new_prefixed_id("ws"), new_prefixed_id("ws")
    actor = new_prefixed_id("usr")
    scopes = tuple(new_prefixed_id("scp") for _ in range(3))
    with (
        PostgresContainer(image="pgvector/pgvector:pg16", dbname="ads_db") as ads_pg,
        PostgresContainer(image="postgres:16-alpine", dbname="policy_db") as policy_pg,
    ):
        admin = sa.create_engine(ads_pg.get_connection_url())
        policy_admin = sa.create_engine(policy_pg.get_connection_url())
        config = Config(str(ADS / "alembic.ini"))
        config.set_main_option("script_location", str(ADS / "alembic"))
        config.set_main_option("sqlalchemy.url", ads_pg.get_connection_url())
        command.upgrade(config, "head")
        with policy_admin.begin() as connection:
            for role in ("memory_service", "policy_system_writer"):
                connection.execute(
                    sa.text(
                        f"CREATE ROLE {role} LOGIN NOBYPASSRLS NOSUPERUSER "
                        "PASSWORD 'native-test-pass'"
                    )
                )
            connection.execute(
                sa.text("GRANT USAGE ON SCHEMA public TO memory_service,policy_system_writer")
            )
            connection.execute(
                sa.text(
                    "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                    "GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO memory_service"
                )
            )
        policy_url = make_url(policy_pg.get_connection_url())
        environment = {
            **os.environ,
            "INTERNAL_SERVICE_TOKEN_SHA256": digest,
            "MEMORY_NATIVE_ADMIN_URL": policy_pg.get_connection_url(),
            "POLICY_DB_URL_SYNC": policy_url.set(
                username="memory_service", password="native-test-pass"
            ).render_as_string(hide_password=False),
            "POLICY_DB_SYSTEM_URL_SYNC": policy_url.set(
                username="policy_system_writer", password="native-test-pass"
            ).render_as_string(hide_password=False),
            "MEMORY_GRPC_BIND_ADDRESS": f"127.0.0.1:{_port()}",
        }
        with (tmp_path / "migration.log").open("w") as log:
            migrated = subprocess.run(
                [
                    "uv",
                    "run",
                    "--frozen",
                    "--project",
                    str(MEMORY),
                    "python",
                    "-c",
                    "import os; from alembic.config import Config; from alembic import command; "
                    "c=Config('alembic.ini'); c.set_main_option('script_location','alembic'); "
                    "c.set_main_option('sqlalchemy.url',os.environ['MEMORY_NATIVE_ADMIN_URL']); "
                    "command.upgrade(c,'head')",
                ],
                cwd=MEMORY,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=60,
            )
        assert migrated.returncode == 0, "Memory settings migration failed; inspect private log"
        with admin.begin() as connection:
            connection.execute(
                sa.text(
                    "CREATE ROLE ads_memory_runtime LOGIN NOBYPASSRLS NOSUPERUSER "
                    "PASSWORD 'native-test-pass'"
                )
            )
            connection.execute(sa.text("GRANT USAGE ON SCHEMA public TO ads_memory_runtime"))
            connection.execute(
                sa.text(
                    "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public "
                    "TO ads_memory_runtime"
                )
            )
            for scope, ten, ws in (
                (scopes[0], tenant, workspace),
                (scopes[1], tenant, other_workspace),
                (scopes[2], other_tenant, workspace),
            ):
                connection.execute(
                    sa.text(
                        "INSERT INTO scopes(id,tenant_id,workspace_id) "
                        "VALUES(:id,:tenant,:workspace)"
                    ),
                    {"id": scope, "tenant": ten[4:], "workspace": ws[3:]},
                )
            source, document = new_prefixed_id("src"), new_prefixed_id("doc")
            params = {
                "tenant": tenant[4:],
                "scope": scopes[0],
                "source": source,
                "document": document,
                "chunk": new_prefixed_id("chk"),
                "embedding": "[1," + ",".join(["0"] * 1023) + "]",
            }
            connection.execute(
                sa.text(
                    "INSERT INTO sources(id,tenant_id,scope_id,kind) "
                    "VALUES(:source,:tenant,:scope,'upload')"
                ),
                params,
            )
            connection.execute(
                sa.text(
                    "INSERT INTO documents(id,tenant_id,scope_id,source_id,kind,"
                    "current_version,status) "
                    "VALUES(:document,:tenant,:scope,:source,'file',1,'active')"
                ),
                params,
            )
            connection.execute(
                sa.text(
                    "INSERT INTO document_versions(document_id,version,content_ref,provenance) "
                    "VALUES(:document,1,'native-ref','{}'::jsonb)"
                ),
                params,
            )
            connection.execute(
                sa.text(
                    "INSERT INTO chunks(id,tenant_id,scope_id,document_id,document_version,seq,"
                    "text_content,metadata,embedding,embedding_provider,embedding_model,"
                    "embedding_version) VALUES(:chunk,:tenant,:scope,:document,1,0,"
                    "'Current knowledge document','{}'::jsonb,CAST(:embedding AS vector),"
                    "'native','native','v1')"
                ),
                params,
            )
        runtime = sa.create_engine(
            make_url(ads_pg.get_connection_url()).set(
                username="ads_memory_runtime", password="native-test-pass"
            )
        )
        sessions = sessionmaker(runtime, class_=Session, expire_on_commit=False)
        channel = grpc.insecure_channel(environment["MEMORY_GRPC_BIND_ADDRESS"])
        memory_client = GrpcWorkspaceMemoryClient(
            environment["MEMORY_GRPC_BIND_ADDRESS"], AUTHORIZATION
        )
        embeddings = None
        gateway = None
        with (tmp_path / "services.log").open("w") as log:
            memory = subprocess.Popen(
                [
                    "uv",
                    "run",
                    "--frozen",
                    "--project",
                    str(MEMORY),
                    "python",
                    "-m",
                    "src.grpc_server",
                ],
                cwd=MEMORY,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            try:
                grpc.channel_ready_future(channel).result(timeout=30)
                stub = memory_pb2_grpc.MemoryServiceStub(channel)  # type: ignore[no-untyped-call]
                metadata = (("authorization", AUTHORIZATION),)
                with pytest.raises(grpc.RpcError) as denied:
                    stub.MemoryAccess(
                        memory_pb2.MemoryAccessRequest(
                            tenant_id=tenant, workspace_id=workspace, kind="workspace"
                        ),
                        timeout=5,
                    )
                assert denied.value.code() == grpc.StatusCode.UNAUTHENTICATED
                assert memory_client.access(tenant, workspace) == (True, 90)
                settings = {
                    "conversationMemoryEnabled": False,
                    "workflowMemoryEnabled": False,
                    "workspaceMemoryEnabled": True,
                    "retentionDays": 7,
                }

                def update(enabled: bool, etag: str) -> str:
                    result = stub.UpdateMemorySettings(
                        memory_pb2.UpdateMemorySettingsRequest(
                            tenant_id=tenant,
                            workspace_id=workspace,
                            actor_id=actor,
                            settings_json=json.dumps(
                                {**settings, "workspaceMemoryEnabled": enabled}
                            ),
                            if_match=etag,
                        ),
                        metadata=metadata,
                        timeout=5,
                    )
                    return str(json.loads(result.settings_json)["etag"])

                etag = update(True, '"memory-0"')
                gateway_report = tmp_path / "gateway-report.json"
                gateway = subprocess.Popen(
                    [
                        "node",
                        "node_modules/vitest/vitest.mjs",
                        "run",
                        "apps/model-gateway/src/gateway/memory-redaction-native.integration.spec.ts",
                        "--maxWorkers=1",
                        "--reporter=json",
                        f"--outputFile={gateway_report}",
                    ],
                    cwd=ROOT,
                    env={**os.environ, "MEMORY_REDACTION_NATIVE_DIR": str(tmp_path)},
                    stdout=log,
                    stderr=subprocess.STDOUT,
                )
                for _ in range(1200):
                    if (tmp_path / "ready.json").exists():
                        break
                    assert gateway.poll() is None, "Native gateway exited before readiness"
                    time.sleep(0.025)
                assert (tmp_path / "ready.json").exists(), "Native gateway readiness timed out"
                ready = json.loads((tmp_path / "ready.json").read_text())
                embeddings = GrpcEmbeddingClient(
                    ready["address"],
                    access_token_provider=(
                        Auth0M2mTokenProvider(
                            token_url=ready["tokenUrl"],
                            audience="alter-engine",
                            client_id="memory-fixture",
                            client_secret="memory-fixture-secret",
                        )
                    ),
                )
                repository = SqlAlchemyMemoryNamespaceRepository(
                    sessions, access=memory_client.access, redact=embeddings.redact
                )

                def record(
                    ten: str, scope: str, statement: str = "Contact person@example.invalid"
                ) -> str:
                    return repository.record(
                        tenant_uuid=ten[4:],
                        scope_id=scope,
                        project_ref=None,
                        kind="project_fact",
                        statement=statement,
                        confidence=None,
                        provenance={"contact": "person@example.invalid"},
                    )

                current = record(tenant, scopes[0])
                assert current.startswith("mns_")
                expired = record(tenant, scopes[0], "Older lesson")
                other = record(tenant, scopes[1], "Other workspace lesson")
                foreign = record(other_tenant, scopes[2], "Other tenant lesson")
                with admin.begin() as connection:
                    connection.execute(
                        sa.text(
                            "UPDATE memory_namespace SET created_at=now()-interval '8 days' "
                            "WHERE id IN :ids"
                        ).bindparams(sa.bindparam("ids", expanding=True)),
                        {"ids": [expired, other, foreign]},
                    )
                    stored = connection.execute(
                        sa.text("SELECT statement,provenance FROM memory_namespace WHERE id=:id"),
                        {"id": current},
                    ).one()
                    assert "person@example.invalid" not in json.dumps(tuple(stored))
                    assert "<EMAIL_ADDRESS>" in stored.statement
                with sessions.begin() as session:
                    assert session.execute(
                        sa.text(
                            "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user"
                        )
                    ).one() == (False, False)
                    assert session.scalar(sa.text("SELECT count(*) FROM memory_namespace")) == 0
                fresh_other = record(tenant, scopes[1], "Current other workspace lesson")
                query_repository = SqlAlchemyRetrievalRepository(sessions, repository)
                query = RetrievalService(repository=query_repository, embeddings=embeddings)
                request = RetrievalRequest(
                    tenant_id=tenant,
                    workspace_id=workspace,
                    scope_ids=(scopes[0],),
                    requester="svc_engine",
                    query="Current knowledge",
                    rerank=False,
                )
                result = query.retrieve(request)
                assert [fact.id for fact in result.memory_facts] == [current]
                assert result.hits[0].document_id == document
                assert (
                    repository.list_active_for_scopes(
                        tenant_uuid=tenant[4:],
                        workspace_uuid=workspace[3:],
                        scope_ids=(scopes[1], scopes[2]),
                        limit=10,
                    )
                    == ()
                )
                with pytest.raises(ScopeViolationError):
                    query.retrieve(request.model_copy(update={"scope_ids": (scopes[1],)}))
                etag = update(False, etag)
                assert record(tenant, scopes[0]) == ""
                disabled = query.retrieve(request)
                assert disabled.memory_facts == () and disabled.hits[0].document_id == document
                etag = update(True, etag)
                for key, value in {
                    "ADS_DB_URL_SYNC": runtime.url.render_as_string(hide_password=False),
                    "ADS_DELETION_DB_URL_SYNC": ads_pg.get_connection_url(),
                    "DELETION_SERVICE_TOKEN_SHA256": digest,
                    "MEMORY_SERVICE_ADDRESS": environment["MEMORY_GRPC_BIND_ADDRESS"],
                    "MEMORY_SERVICE_AUTHORIZATION": AUTHORIZATION,
                    "MODEL_GATEWAY_GRPC_TARGET": ready["address"],
                    "AUTH0_M2M_TOKEN_URL": ready["tokenUrl"],
                    "AUTH0_M2M_AUDIENCE": "alter-engine",
                    "AUTH0_M2M_CLIENT_ID": "memory-fixture",
                    "AUTH0_M2M_CLIENT_SECRET": "memory-fixture-secret",
                }.items():
                    monkeypatch.setenv(key, value)
                get_settings.cache_clear()
                from src.main import app

                with TestClient(app) as http:
                    query_headers = {
                        "authorization": AUTHORIZATION,
                        "x-alter-tenant-id": tenant,
                        "x-alter-workspace-id": workspace,
                        "x-alter-requester": "svc_engine",
                    }
                    body = {
                        "tenant_id": tenant,
                        "scope_id": scopes[0],
                        "kind": "preference",
                        "statement": "Contact person@example.invalid",
                        "provenance": {},
                    }
                    assert http.post("/ads/memory-namespace/records", json=body).status_code == 401
                    response = http.post(
                        "/ads/memory-namespace/records",
                        json=body,
                        headers={"authorization": AUTHORIZATION},
                    )
                    assert response.status_code == 201 and not response.json()["skipped"]
                    delivered = http.post(
                        "/ads/query", json=request.model_dump(mode="json"), headers=query_headers
                    )
                    assert delivered.status_code == 200
                    assert len(delivered.json()["memory_facts"]) == 2
                    etag = update(False, etag)
                    skipped = http.post(
                        "/ads/memory-namespace/records",
                        json=body,
                        headers={"authorization": AUTHORIZATION},
                    )
                    assert skipped.status_code == 201 and skipped.json()["skipped"]
                    hidden = http.post(
                        "/ads/query", json=request.model_dump(mode="json"), headers=query_headers
                    )
                    assert hidden.status_code == 200 and hidden.json()["memory_facts"] == []
                    assert hidden.json()["hits"][0]["document_id"] == document
                    etag = update(True, etag)
                    with pytest.raises(MemoryUnavailableError):
                        record(tenant, scopes[0], "redaction-unavailable")
                    update(False, etag)
                    swept = http.post(
                        "/internal/deletion/retention", headers={"authorization": AUTHORIZATION}
                    )
                    assert swept.status_code == 200 and swept.json()["deletedRows"] == 1
                with admin.begin() as connection:
                    remaining = set(connection.scalars(sa.text("SELECT id FROM memory_namespace")))
                    assert (
                        expired not in remaining
                        and {current, other, foreign, fresh_other} <= remaining
                    )
                    assert connection.scalar(sa.text("SELECT count(*) FROM documents")) == 1
                unconfigured = SqlAlchemyMemoryNamespaceRepository(sessions)
                assert (
                    unconfigured.list_active_for_scopes(
                        tenant_uuid=tenant[4:],
                        workspace_uuid=workspace[3:],
                        scope_ids=(scopes[0],),
                        limit=10,
                    )
                    == ()
                )
                with pytest.raises(MemoryUnavailableError):
                    unconfigured.record(
                        tenant_uuid=tenant[4:],
                        scope_id=scopes[0],
                        project_ref=None,
                        kind="preference",
                        statement="Do not store",
                        confidence=None,
                        provenance={},
                    )
                (tmp_path / "expected.json").write_text(
                    json.dumps({"minimumCalls": 8, "tokenRequests": 2})
                )
                (tmp_path / "stop").touch()
                assert gateway.wait(timeout=30) == 0, (
                    "Native gateway proof failed; inspect private log"
                )
                report = json.loads(gateway_report.read_text())
                assert (
                    report["success"]
                    and report["numPassedTests"] == 1
                    and report["numPendingTests"] == 0
                )
            finally:
                configure_memory_namespace_repository(None)
                get_settings.cache_clear()
                if gateway is not None and gateway.poll() is None:
                    gateway.terminate()
                    gateway.wait(timeout=10)
                memory.terminate()
                memory.wait(timeout=10)
                channel.close()
                memory_client.close()
                if embeddings is not None:
                    embeddings.close()
                runtime.dispose()
                admin.dispose()
                policy_admin.dispose()

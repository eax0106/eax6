from __future__ import annotations

from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config
from pydantic import ValidationError
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.memory_learning.ids import new_prefixed_uuid7
from src.memory_settings.repository import (
    MemorySettingsPreconditionError,
    MemorySettingsRepository,
    WorkspaceMemoryValues,
)

SettingsDB = tuple[MemorySettingsRepository, sessionmaker[Session], sessionmaker[Session], Config]

ROOT = Path(__file__).parent.parent
TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
OTHER = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ba"
ACTOR = "usr_018f4d6e-2b4a-7a3e-8c1a-1234567890ac"


@pytest.fixture(scope="module")
def settings_db() -> Generator[
    tuple[MemorySettingsRepository, sessionmaker[Session], sessionmaker[Session], Config],
    None,
    None,
]:
    with PostgresContainer(image="postgres:16-alpine", dbname="policy_db") as pg:
        url = pg.get_connection_url()
        admin_engine = sa.create_engine(url)
        password = new_prefixed_uuid7("test")
        system_password = new_prefixed_uuid7("test")
        with admin_engine.begin() as conn:
            conn.execute(
                sa.text(
                    "CREATE ROLE policy_system_writer LOGIN NOBYPASSRLS NOSUPERUSER "
                    f"PASSWORD '{system_password}'"
                )
            )
            conn.execute(
                sa.text(
                    "CREATE ROLE memory_service LOGIN NOBYPASSRLS NOSUPERUSER "
                    f"PASSWORD '{password}'"
                )
            )
            conn.execute(
                sa.text("GRANT USAGE ON SCHEMA public TO memory_service,policy_system_writer")
            )
            conn.execute(
                sa.text(
                    "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                    "GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO memory_service"
                )
            )
        cfg = Config(str(ROOT / "alembic.ini"))
        cfg.set_main_option("script_location", str(ROOT / "alembic"))
        cfg.set_main_option("sqlalchemy.url", url)
        command.upgrade(cfg, "head")
        app_engine = sa.create_engine(
            make_url(url).set(username="memory_service", password=password)
        )
        system_engine = sa.create_engine(
            make_url(url).set(username="policy_system_writer", password=system_password)
        )
        app = sessionmaker(app_engine, class_=Session, expire_on_commit=False)
        admin = sessionmaker(admin_engine, class_=Session, expire_on_commit=False)
        yield MemorySettingsRepository(app), admin, sessionmaker(system_engine), cfg
        app_engine.dispose()
        system_engine.dispose()
        admin_engine.dispose()


def test_settings_defaults_are_independent_and_runtime_role_obeys_rls(
    settings_db: SettingsDB,
) -> None:
    repo, admin, _, _ = settings_db
    workspace = new_prefixed_uuid7("ws")
    expected = {
        "conversationMemoryEnabled": True,
        "workflowMemoryEnabled": True,
        "workspaceMemoryEnabled": True,
        "retentionDays": 90,
        "etag": '"memory-0"',
    }
    assert repo.get(TENANT, workspace).model_dump() == expected
    after = repo.update(
        TENANT,
        workspace,
        ACTOR,
        WorkspaceMemoryValues(conversationMemoryEnabled=False),
        '"memory-0"',
    )
    assert after.etag == '"memory-1"' and not after.conversationMemoryEnabled
    assert repo.get(OTHER, workspace).model_dump() == expected
    assert repo.get(TENANT, new_prefixed_uuid7("ws")).model_dump() == expected
    with repo.sessions.begin() as session:
        assert session.execute(
            sa.text("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
        ).one() == (False, False)
        assert (
            session.execute(sa.text("SELECT workspace_id FROM workspace_memory_settings")).all()
            == []
        )
        scope = repo.scope(session, OTHER, workspace)
        assert (
            session.execute(
                sa.text(
                    "SELECT workspace_id FROM workspace_memory_settings "
                    "WHERE workspace_id=:workspace"
                ),
                scope,
            ).all()
            == []
        )
    with admin.begin() as session:
        row = session.execute(
            sa.text(
                "SELECT actor_ref,before_value,after_value FROM memory_settings_audit "
                "WHERE workspace_id=:ws"
            ),
            {"ws": workspace[3:]},
        ).one()
        assert row.actor_ref == ACTOR
        assert row.before_value == expected
        assert row.after_value == after.model_dump()


@pytest.mark.parametrize("days", [6, 366, 7.5, True, "90"])
def test_settings_reject_invalid_retention(days: object) -> None:
    with pytest.raises(ValidationError):
        WorkspaceMemoryValues.model_validate({"retentionDays": days})


def test_settings_reject_sensitive_data_and_non_boolean_switches() -> None:
    for value in [{"allowSensitiveData": True}, {"conversationMemoryEnabled": "false"}]:
        with pytest.raises(ValidationError):
            WorkspaceMemoryValues.model_validate(value)
    assert WorkspaceMemoryValues(retentionDays=7).retentionDays == 7
    assert WorkspaceMemoryValues(retentionDays=365).retentionDays == 365


def test_settings_if_match_and_concurrent_first_write(settings_db: SettingsDB) -> None:
    repo, _, _, _ = settings_db
    ws = new_prefixed_uuid7("ws")
    values = WorkspaceMemoryValues(workflowMemoryEnabled=False, workspaceMemoryEnabled=False)
    with pytest.raises(MemorySettingsPreconditionError) as missing:
        repo.update(TENANT, ws, ACTOR, values, "")
    assert missing.value.status == 428

    def write() -> str:
        try:
            return repo.update(TENANT, ws, ACTOR, values, '"memory-0"').etag
        except MemorySettingsPreconditionError as error:
            assert error.status == 412
            return "stale"

    with ThreadPoolExecutor(max_workers=2) as workers:
        assert sorted(workers.map(lambda _: write(), range(2))) == ['"memory-1"', "stale"]
    assert repo.access(TENANT, ws, "chat") == (True, 90)
    assert repo.access(TENANT, ws, "workflow") == (False, 90)
    assert repo.access(TENANT, ws, "workspace") == (False, 90)


def test_settings_audit_failure_rolls_back_the_update(settings_db: SettingsDB) -> None:
    repo, admin, _, _ = settings_db
    ws = new_prefixed_uuid7("ws")
    rejected = new_prefixed_uuid7("usr")
    before = repo.get(TENANT, ws)
    with admin.begin() as session:
        session.execute(
            sa.text(
                "ALTER TABLE memory_settings_audit ADD CONSTRAINT native_audit_reject "
                f"CHECK(actor_ref <> '{rejected}')"
            )
        )
    try:
        with pytest.raises(sa.exc.IntegrityError):
            repo.update(TENANT, ws, rejected, WorkspaceMemoryValues(retentionDays=7), before.etag)
        assert repo.get(TENANT, ws) == before
        with admin.begin() as session:
            assert (
                session.scalar(
                    sa.text("SELECT count(*) FROM memory_settings_audit WHERE workspace_id=:ws"),
                    {"ws": ws[3:]},
                )
                == 0
            )
    finally:
        with admin.begin() as session:
            session.execute(
                sa.text("ALTER TABLE memory_settings_audit DROP CONSTRAINT native_audit_reject")
            )


def test_settings_migration_rolls_back_and_reapplies(settings_db: SettingsDB) -> None:
    repo, admin, _, cfg = settings_db
    command.downgrade(cfg, "0008")
    with admin.begin() as session:
        assert session.scalar(sa.text("SELECT to_regclass('workspace_memory_settings')")) is None
        assert (
            session.scalar(
                sa.text(
                    "SELECT count(*) FROM information_schema.columns "
                    "WHERE table_name='memory_records' AND column_name='workspace_id'"
                )
            )
            == 0
        )
    command.upgrade(cfg, "head")
    assert repo.get(TENANT, new_prefixed_uuid7("ws")).retentionDays == 90


def test_native_retention_and_erasure_use_scoped_rows_and_metadata_only_enumeration(
    settings_db: SettingsDB,
) -> None:
    import json

    from src.deletion.provider import MemoryDeletionProvider
    from src.policy_store.anonymization import (
        anonymize_global_content,
        anonymized_global_provenance,
    )

    repo, admin, system, _ = settings_db
    ws7, ws30 = new_prefixed_uuid7("ws"), new_prefixed_uuid7("ws")
    orphan_tenant = new_prefixed_uuid7("ten")
    repo.update(TENANT, ws7, ACTOR, WorkspaceMemoryValues(retentionDays=7), '"memory-0"')
    repo.update(TENANT, ws30, ACTOR, WorkspaceMemoryValues(retentionDays=30), '"memory-0"')
    cases = [
        (TENANT, ws7, 8, True),
        (TENANT, ws7, 6, False),
        (TENANT, ws30, 8, False),
        (TENANT, ws30, 31, True),
        (OTHER, ws7, 91, True),
        (OTHER, ws7, 85, False),
        (orphan_tenant, None, 93, True),
    ]
    records: dict[str, bool] = {}
    with admin.begin() as session:
        for tenant, ws, days, expired in cases:
            memory_id = new_prefixed_uuid7("mem")
            records[memory_id] = expired
            session.execute(
                sa.text(
                    "INSERT INTO memory_records(id,tenant_id,workspace_id,memory_kind,scope,"
                    "content,provenance,status,created_at) "
                    "VALUES(:id,:tenant,:workspace,'workflow',"
                    "'project','{}','{}','candidate',now()-make_interval(days=>:days))"
                ),
                {
                    "id": memory_id,
                    "tenant": tenant[4:],
                    "workspace": ws[3:] if ws else None,
                    "days": days,
                },
            )
        global_id = new_prefixed_uuid7("mem")
        session.execute(
            sa.text(
                "INSERT INTO memory_records(id,scope,content,provenance,status,created_at) "
                "VALUES(:id,'global',CAST(:content AS jsonb),CAST(:provenance AS jsonb),"
                "'promoted',now()-interval '400 days')"
            ),
            {
                "id": global_id,
                "content": json.dumps(anonymize_global_content({})),
                "provenance": json.dumps(anonymized_global_provenance(new_prefixed_uuid7("evr"))),
            },
        )
        assert (
            session.scalar(
                sa.text(
                    "SELECT relforcerowsecurity FROM pg_class WHERE oid='memory_records'::regclass"
                )
            )
            is True
        )
    with system.begin() as session:
        assert (
            session.execute(
                sa.text("SELECT tenant_id FROM memory_records WHERE tenant_id IS NOT NULL")
            ).all()
            == []
        )
        assert session.execute(
            sa.text("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
        ).one() == (False, False)
    provider = MemoryDeletionProvider(repo.sessions, system)
    assert {TENANT, OTHER, orphan_tenant} <= set(provider.list_subject_ids())
    result = provider.apply_retention_policy()
    assert result.deletedRows == sum(records.values())
    with admin.begin() as session:
        remaining = set(session.scalars(sa.text("SELECT id FROM memory_records")).all())
        assert remaining == {id_ for id_, expired in records.items() if not expired} | {global_id}
    assert provider.apply_retention_policy().deletedRows == 0
    manifest = new_prefixed_uuid7("del")
    assert any(row.rowCount for row in provider.locate_subject_data(TENANT))
    provider.delete_subject_data(TENANT, manifest)
    assert provider.verify_deletion(TENANT, manifest).deleted
    assert repo.get(TENANT, ws7).etag == '"memory-0"'
    with admin.begin() as session:
        assert (
            session.scalar(
                sa.text("SELECT count(*) FROM memory_records WHERE id=:id"), {"id": global_id}
            )
            == 1
        )
        assert (
            session.scalar(
                sa.text("SELECT count(*) FROM memory_records WHERE tenant_id=:tenant"),
                {"tenant": OTHER[4:]},
            )
            == 1
        )


@pytest.mark.asyncio
async def test_settings_use_real_authenticated_grpc_and_return_precondition_statuses(
    settings_db: SettingsDB,
) -> None:
    import json

    import grpc
    from test_memory_repository_integration import SeededRunClient

    from alter.memory.v1 import memory_pb2, memory_pb2_grpc
    from src.memory_grpc_service import MemoryGrpcService
    from src.memory_learning.extraction import MemoryLearningKernel
    from src.memory_learning.repository import SqlAlchemyMemoryCandidateRepository
    from src.policy_store.repository import SqlAlchemyPolicyStoreRepository
    from src.policy_store.service import PolicyStoreService
    from src.service_auth import ServiceAuthInterceptor

    repo, _, system, _ = settings_db
    service = MemoryGrpcService(
        MemoryLearningKernel(SeededRunClient(), SqlAlchemyMemoryCandidateRepository(repo.sessions)),
        PolicyStoreService(SqlAlchemyPolicyStoreRepository(repo.sessions, system)),
        repo,
    )
    server = grpc.aio.server(interceptors=[ServiceAuthInterceptor()])
    memory_pb2_grpc.add_MemoryServiceServicer_to_server(service, server)  # type: ignore[no-untyped-call]
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    try:
        async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
            stub = memory_pb2_grpc.MemoryServiceStub(channel)  # type: ignore[no-untyped-call]
            ws = new_prefixed_uuid7("ws")
            scope = memory_pb2.GetMemorySettingsRequest(tenant_id=TENANT, workspace_id=ws)
            with pytest.raises(grpc.aio.AioRpcError) as anonymous:
                await stub.GetMemorySettings(scope)
            assert anonymous.value.code() == grpc.StatusCode.UNAUTHENTICATED
            metadata = (("authorization", "Bearer integration-token"),)
            before = json.loads(
                (await stub.GetMemorySettings(scope, metadata=metadata)).settings_json
            )
            assert before["etag"] == '"memory-0"'
            values = WorkspaceMemoryValues(conversationMemoryEnabled=False, retentionDays=7)
            request = memory_pb2.UpdateMemorySettingsRequest(
                tenant_id=TENANT,
                workspace_id=ws,
                actor_id=ACTOR,
                settings_json=values.model_dump_json(),
            )
            with pytest.raises(grpc.aio.AioRpcError) as missing:
                await stub.UpdateMemorySettings(request, metadata=metadata)
            assert missing.value.code() == grpc.StatusCode.FAILED_PRECONDITION
            request.if_match = before["etag"]
            after = json.loads(
                (await stub.UpdateMemorySettings(request, metadata=metadata)).settings_json
            )
            assert after == {**values.model_dump(), "etag": '"memory-1"'}
            with pytest.raises(grpc.aio.AioRpcError) as stale:
                await stub.UpdateMemorySettings(request, metadata=metadata)
            assert stale.value.code() == grpc.StatusCode.ABORTED
            for kind, allowed in [("chat", False), ("workflow", True), ("workspace", True)]:
                response = await stub.MemoryAccess(
                    memory_pb2.MemoryAccessRequest(tenant_id=TENANT, workspace_id=ws, kind=kind),
                    metadata=metadata,
                )
                assert response.allowed is allowed and response.retention_days == 7
            foreign = json.loads(
                (
                    await stub.GetMemorySettings(
                        memory_pb2.GetMemorySettingsRequest(tenant_id=OTHER, workspace_id=ws),
                        metadata=metadata,
                    )
                ).settings_json
            )
            assert foreign == before
            request.if_match = after["etag"]
            request.settings_json = '{"allowSensitiveData":true}'
            with pytest.raises(grpc.aio.AioRpcError) as invalid:
                await stub.UpdateMemorySettings(request, metadata=metadata)
            assert invalid.value.code() == grpc.StatusCode.INVALID_ARGUMENT
            assert (
                json.loads((await stub.GetMemorySettings(scope, metadata=metadata)).settings_json)
                == after
            )
    finally:
        await server.stop(0)


@pytest.mark.asyncio
async def test_memory_recall_uses_authenticated_gateway_redaction_and_actual_scoped_storage(
    settings_db: SettingsDB,
    tmp_path: Path,
) -> None:
    import asyncio
    import json
    import os
    import subprocess

    import grpc
    from test_memory_repository_integration import RUN, SeededRunClient

    from alter.memory.v1 import memory_pb2, memory_pb2_grpc
    from alter.modelgw.v1 import modelgw_pb2, modelgw_pb2_grpc
    from src.m2m_auth import Auth0M2mTokenProvider
    from src.memory_grpc_service import MemoryGrpcService
    from src.memory_learning.extraction import MemoryLearningKernel
    from src.memory_learning.models import ProposeWritebackRequest, RunLearningSummary
    from src.memory_learning.repository import SqlAlchemyMemoryCandidateRepository
    from src.memory_settings.redaction import GrpcMemoryRedactor
    from src.policy_store.repository import SqlAlchemyPolicyStoreRepository
    from src.policy_store.service import PolicyStoreService
    from src.service_auth import ServiceAuthInterceptor

    root = ROOT.parent.parent
    report = tmp_path / "gateway-report.json"
    with (tmp_path / "gateway.log").open("w") as log:
        gateway = subprocess.Popen(
            [
                "node",
                "node_modules/vitest/vitest.mjs",
                "run",
                "apps/model-gateway/src/gateway/memory-redaction-native.integration.spec.ts",
                "--maxWorkers=1",
                "--reporter=json",
                f"--outputFile={report}",
            ],
            cwd=root,
            env={**os.environ, "MEMORY_REDACTION_NATIVE_DIR": str(tmp_path)},
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        redactor = None
        server = None
        try:
            for _ in range(1200):
                if (tmp_path / "ready.json").exists():
                    break
                assert gateway.poll() is None, "Native gateway exited before readiness"
                await asyncio.sleep(0.025)
            assert (tmp_path / "ready.json").exists(), "Native gateway readiness timed out"
            ready = json.loads((tmp_path / "ready.json").read_text())
            provider = Auth0M2mTokenProvider(
                token_url=ready["tokenUrl"],
                audience="alter-engine",
                client_id="memory-fixture",
                client_secret="memory-fixture-secret",
            )
            redactor = GrpcMemoryRedactor(ready["address"], provider)
            async with grpc.aio.insecure_channel(ready["address"]) as channel:
                anonymous = modelgw_pb2_grpc.ModelgwServiceStub(channel)  # type: ignore[no-untyped-call]
                with pytest.raises(grpc.aio.AioRpcError) as denied:
                    await anonymous.Redact(modelgw_pb2.RedactRequest(tenant_id=TENANT, content="x"))
                assert denied.value.code() == grpc.StatusCode.UNAUTHENTICATED

            class RunClient(SeededRunClient):
                async def load_summary(self, *, tenant_id: str, run_id: str) -> RunLearningSummary:
                    row = await super().load_summary(tenant_id=tenant_id, run_id=run_id)
                    return row.model_copy(
                        update={
                            "nodes": tuple(
                                node.model_copy(update={"node_key": "person@example.invalid"})
                                for node in row.nodes
                            ),
                            "recovery_actions": tuple(
                                action.model_copy(update={"strategy": "person@example.invalid"})
                                for action in row.recovery_actions
                            ),
                        }
                    )

            repo, admin, system, _ = settings_db
            kernel = MemoryLearningKernel(
                RunClient(), SqlAlchemyMemoryCandidateRepository(repo.sessions), redactor.redact
            )
            service = MemoryGrpcService(
                kernel,
                PolicyStoreService(SqlAlchemyPolicyStoreRepository(repo.sessions, system)),
                repo,
                redactor.redact,
            )
            server = grpc.aio.server(interceptors=[ServiceAuthInterceptor()])
            memory_pb2_grpc.add_MemoryServiceServicer_to_server(service, server)  # type: ignore[no-untyped-call]
            port = server.add_insecure_port("127.0.0.1:0")
            await server.start()
            ws = "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ac"
            wf, conversation = new_prefixed_uuid7("wf"), new_prefixed_uuid7("cnv")
            metadata = (("authorization", "Bearer integration-token"),)
            values = repo.update(
                TENANT, ws, ACTOR, WorkspaceMemoryValues(retentionDays=7), repo.get(TENANT, ws).etag
            )
            with admin.begin() as session:
                now = session.scalar(sa.text("SELECT now()"))
            from datetime import timedelta

            messages = [
                {
                    "id": new_prefixed_uuid7("msg"),
                    "conversationId": conversation,
                    "role": "user",
                    "kind": "text",
                    "content": "Email person@example.invalid",
                    "createdAt": (now - timedelta(days=days)).isoformat(),
                }
                for days in (0, 8)
            ]
            chat = memory_pb2.RecallChatRequest(
                tenant_id=TENANT,
                workspace_id=ws,
                conversation_id=conversation,
                messages_json=json.dumps(messages),
            )
            workflow = memory_pb2.RecallWorkflowRequest(
                tenant_id=TENANT,
                workspace_id=ws,
                workflow_id=wf,
            )
            writeback = ProposeWritebackRequest(
                tenant_id=TENANT,
                workspace_id=ws,
                run_id=RUN,
                verified_output_artifact_id=new_prefixed_uuid7("art"),
                namespace=f"workflow:{wf}",
            )
            async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
                stub = memory_pb2_grpc.MemoryServiceStub(channel)  # type: ignore[no-untyped-call]
                with pytest.raises(grpc.aio.AioRpcError) as denied_chat:
                    await stub.RecallChat(chat)
                assert denied_chat.value.code() == grpc.StatusCode.UNAUTHENTICATED
                recalled = json.loads((await stub.RecallChat(chat, metadata=metadata)).memory_json)
                assert len(recalled) == 1 and recalled[0]["id"] == messages[0]["id"]
                assert recalled[0]["content"] == "Email <EMAIL_ADDRESS>"
                stored = await kernel.propose_writeback(writeback, "Bearer integration-token")
                assert stored.memory_id and not stored.skipped
                assert "person@example.invalid" not in stored.candidate_json
                lessons = json.loads(
                    (await stub.RecallWorkflow(workflow, metadata=metadata)).memory_json
                )
                assert [row["id"] for row in lessons] == [stored.memory_id]
                for tenant, workspace in [(OTHER, ws), (TENANT, new_prefixed_uuid7("ws"))]:
                    foreign = memory_pb2.RecallWorkflowRequest(
                        tenant_id=tenant, workspace_id=workspace, workflow_id=wf
                    )
                    assert (
                        await stub.RecallWorkflow(foreign, metadata=metadata)
                    ).memory_json == "[]"
                with admin.begin() as session:
                    rows = (
                        session.execute(
                            sa.text(
                                "SELECT content,provenance,workspace_id::text,memory_kind "
                                "FROM memory_records "
                                "WHERE tenant_id=:tenant AND workspace_id=:ws"
                            ),
                            {"tenant": TENANT[4:], "ws": ws[3:]},
                        )
                        .mappings()
                        .all()
                    )
                    assert {row["memory_kind"] for row in rows} == {"chat", "workflow"}
                    assert "person@example.invalid" not in json.dumps([dict(row) for row in rows])
                values = repo.update(
                    TENANT,
                    ws,
                    ACTOR,
                    WorkspaceMemoryValues(
                        conversationMemoryEnabled=False,
                        workspaceMemoryEnabled=False,
                        retentionDays=7,
                    ),
                    values.etag,
                )
                assert (await stub.RecallChat(chat, metadata=metadata)).memory_json == "[]"
                assert json.loads(
                    (await stub.RecallWorkflow(workflow, metadata=metadata)).memory_json
                )
                values = repo.update(
                    TENANT,
                    ws,
                    ACTOR,
                    WorkspaceMemoryValues(
                        workflowMemoryEnabled=False, workspaceMemoryEnabled=False, retentionDays=7
                    ),
                    values.etag,
                )
                assert (await stub.RecallWorkflow(workflow, metadata=metadata)).memory_json == "[]"
                skipped = await kernel.propose_writeback(writeback, "Bearer integration-token")
                assert skipped.skipped and not skipped.memory_id
                assert json.loads((await stub.RecallChat(chat, metadata=metadata)).memory_json)
                values = repo.update(
                    TENANT, ws, ACTOR, WorkspaceMemoryValues(retentionDays=7), values.etag
                )
                with admin.begin() as session:
                    session.execute(
                        sa.text(
                            "UPDATE memory_records SET created_at=now()-interval '8 days' "
                            "WHERE id=:id"
                        ),
                        {"id": stored.memory_id},
                    )
                assert (await stub.RecallWorkflow(workflow, metadata=metadata)).memory_json == "[]"
                failed_conversation = new_prefixed_uuid7("cnv")
                failed = {
                    **messages[0],
                    "conversationId": failed_conversation,
                    "content": "redaction-unavailable",
                }
                with pytest.raises(grpc.aio.AioRpcError) as unavailable:
                    await stub.RecallChat(
                        memory_pb2.RecallChatRequest(
                            tenant_id=TENANT,
                            workspace_id=ws,
                            conversation_id=failed_conversation,
                            messages_json=json.dumps([failed]),
                        ),
                        metadata=metadata,
                    )
                assert unavailable.value.code() == grpc.StatusCode.UNAVAILABLE
                with admin.begin() as session:
                    assert (
                        session.scalar(
                            sa.text("SELECT count(*) FROM memory_records WHERE context_id=:id"),
                            {"id": failed_conversation},
                        )
                        == 0
                    )
            (tmp_path / "expected.json").write_text(json.dumps({"minimumCalls": 6}))
        finally:
            if server is not None:
                await server.stop(0)
            if redactor is not None:
                await redactor.close()
            if not (tmp_path / "expected.json").exists():
                (tmp_path / "expected.json").write_text(json.dumps({"minimumCalls": 0}))
            (tmp_path / "stop").write_text("finished")
            await asyncio.to_thread(gateway.wait, timeout=30)
        assert gateway.returncode == 0, "Native Model Gateway proof failed; inspect private report"
        result = json.loads(report.read_text())
        assert (
            result["success"] and result["numPassedTests"] == 1 and result["numPendingTests"] == 0
        )
        observed = json.loads((tmp_path / "observed.json").read_text())
        assert observed["tokenRequests"] == 1
        assert len(observed["calls"]) >= 6
        assert all(row["tenantId"] == TENANT for row in observed["calls"])


@pytest.mark.asyncio
async def test_public_memory_settings_use_actual_grpc_and_workspace_rbac(
    settings_db: SettingsDB,
    tmp_path: Path,
) -> None:
    import asyncio
    import json
    import os
    import subprocess

    import grpc
    from test_memory_learning import fixture_redact
    from test_memory_repository_integration import SeededRunClient

    from alter.memory.v1 import memory_pb2_grpc
    from src.memory_grpc_service import MemoryGrpcService
    from src.memory_learning.extraction import MemoryLearningKernel
    from src.memory_learning.repository import SqlAlchemyMemoryCandidateRepository
    from src.policy_store.repository import SqlAlchemyPolicyStoreRepository
    from src.policy_store.service import PolicyStoreService
    from src.service_auth import ServiceAuthInterceptor

    repo, admin, system, _ = settings_db
    ws, other_ws = new_prefixed_uuid7("ws"), new_prefixed_uuid7("ws")
    service = MemoryGrpcService(
        MemoryLearningKernel(SeededRunClient(), SqlAlchemyMemoryCandidateRepository(repo.sessions)),
        PolicyStoreService(SqlAlchemyPolicyStoreRepository(repo.sessions, system)),
        repo,
        fixture_redact,
    )
    server = grpc.aio.server(interceptors=[ServiceAuthInterceptor()])
    memory_pb2_grpc.add_MemoryServiceServicer_to_server(service, server)  # type: ignore[no-untyped-call]
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    config = tmp_path / "settings-native.json"
    config.write_text(
        json.dumps(
            {
                "address": f"127.0.0.1:{port}",
                "tenant": TENANT,
                "otherTenant": OTHER,
                "workspace": ws,
                "otherWorkspace": other_ws,
                "user": ACTOR,
            }
        )
    )
    config.chmod(0o600)
    with admin.begin() as session:
        session.execute(sa.text(
            "INSERT INTO memory_records(id,tenant_id,workspace_id,memory_kind,scope,"
            "content,provenance,status) VALUES(:id,:tenant,:ws,'workflow','project',"
            "CAST(:content AS jsonb),CAST(:provenance AS jsonb),'candidate')"
        ), {"id": new_prefixed_uuid7("mem"), "tenant": TENANT[4:], "ws": ws[3:],
            "content": json.dumps({"lesson": "Earlier run lesson"}),
            "provenance": json.dumps({"namespace": f"workflow:wf_{ws[3:]}"})})
    report = tmp_path / "public-report.json"
    database_url = admin.kw["bind"].url.set(drivername="postgresql").render_as_string(
        hide_password=False
    )
    try:
        with (tmp_path / "public.log").open("w") as log:
            result = await asyncio.to_thread(
                subprocess.run,
                [
                    "node",
                    "node_modules/vitest/vitest.mjs",
                    "run",
                    "--config",
                    "apps/platform-api/vitest.config.ts",
                    "apps/platform-api/src/memory-settings/memory-settings-native.integration.spec.ts",
                    "--maxWorkers=1",
                    "--reporter=json",
                    f"--outputFile={report}",
                ],
                cwd=ROOT.parent.parent,
                env={
                    **os.environ,
                    "MEMORY_SETTINGS_NATIVE_CONFIG": str(config),
                    "DATABASE_URL": database_url,
                    "MARKETPLACE_DATABASE_URL": database_url,
                    "AUTH0_DOMAIN": "auth.test",
                    "API_AUDIENCE": "alter-engine",
                    "SIGNING_KEY_PROVIDER": "mock",
                },
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=120,
            )
        assert result.returncode == 0, "Public memory settings failed; inspect private report"
        data = json.loads(report.read_text())
        assert data["success"] and data["numPassedTests"] == 1 and data["numPendingTests"] == 0
        stored = repo.get(TENANT, ws)
        assert stored.etag == '"memory-2"' and stored.retentionDays == 7
        with admin.begin() as session:
            assert (
                session.scalar(
                    sa.text("SELECT count(*) FROM memory_settings_audit WHERE workspace_id=:ws"),
                    {"ws": ws[3:]},
                )
                == 2
            )
    finally:
        await server.stop(0)

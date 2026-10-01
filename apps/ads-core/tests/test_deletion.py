from __future__ import annotations

import json
from collections.abc import Generator
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config as AlembicConfig
from sqlalchemy.orm import Session, sessionmaker
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.deletion.provider import AdsDeletionProvider

SERVICE_ROOT = Path(__file__).parent.parent
PGVECTOR_IMAGE = "pgvector/pgvector:pg16"
TENANT_A = "018f4d6e-2b4a-7a3e-8c1a-1234567890a1"
TENANT_B = "018f4d6e-2b4a-7a3e-8c1a-1234567890b1"
TENANT_PARTIAL = "018f4d6e-2b4a-7a3e-8c1a-1234567890c1"
TENANT_RETENTION = "018f4d6e-2b4a-7a3e-8c1a-1234567890d1"
TENANT_SOURCE_RETENTION = "018f4d6e-2b4a-7a3e-8c1a-1234567890e1"
MANIFEST = "del_018f4d6e-2b4a-7a3e-8c1a-123456789099"


class MemoryObjects:
    def __init__(self) -> None:
        self.references: set[str] = set()

    def delete_object(self, reference: str) -> None:
        self.references.discard(reference)

    def object_exists(self, reference: str) -> bool:
        return reference in self.references


@pytest.fixture(scope="module")
def deletion_database() -> Generator[
    tuple[sessionmaker[Session], sessionmaker[Session]], None, None
]:
    with PostgresContainer(
        image=PGVECTOR_IMAGE,
        dbname="ads_db",
        username="ads_admin",
        password="testpass",
    ) as pg:
        url = pg.get_connection_url()
        config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        config.set_main_option("sqlalchemy.url", url)
        command.upgrade(config, "head")

        admin = sa.create_engine(url)
        with admin.begin() as connection:
            connection.execute(sa.text("CREATE ROLE ads_deletion_test NOLOGIN"))
            connection.execute(sa.text("GRANT USAGE ON SCHEMA public TO ads_deletion_test"))
            connection.execute(
                sa.text(
                    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public "
                    "TO ads_deletion_test"
                )
            )

        tenant_engine = sa.create_engine(url)

        @sa.event.listens_for(tenant_engine, "connect")
        def assume_tenant_role(dbapi_connection: object, connection_record: object) -> None:
            del connection_record
            cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
            cursor.execute("SET ROLE ads_deletion_test")
            cursor.close()

        yield (
            sessionmaker(tenant_engine, class_=Session, expire_on_commit=False),
            sessionmaker(admin, class_=Session, expire_on_commit=False),
        )
        tenant_engine.dispose()
        admin.dispose()


def _seed_all(
    sessions: sessionmaker[Session], tenant: str, suffix: str, workspace: str | None = None
) -> str:
    scope = f"scp_{suffix}"
    source = f"src_{suffix}"
    document = f"doc_{suffix}"
    job = f"job_{suffix}"
    reference = f"s3://ads-private/{tenant}/{document}/content"
    vector = "[" + ",".join("0" for _ in range(1024)) + "]"
    with sessions.begin() as session:
        session.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": tenant},
        )
        session.execute(
            sa.text("INSERT INTO scopes(id,tenant_id,workspace_id) VALUES (:id,:t,:w)"),
            {"id": scope, "t": tenant, "w": workspace or tenant},
        )
        session.execute(
            sa.text("INSERT INTO sources(id,tenant_id,scope_id,kind) VALUES (:id,:t,:s,'upload')"),
            {"id": source, "t": tenant, "s": scope},
        )
        session.execute(
            sa.text(
                "INSERT INTO ingestion_jobs(id,tenant_id,source_id,stage,completed_at) "
                "VALUES (:id,:t,:s,'indexed',now())"
            ),
            {"id": job, "t": tenant, "s": source},
        )
        session.execute(
            sa.text(
                "INSERT INTO documents(id,tenant_id,scope_id,source_id,kind,current_version) "
                "VALUES (:id,:t,:scope,:source,'file',1)"
            ),
            {"id": document, "t": tenant, "scope": scope, "source": source},
        )
        session.execute(
            sa.text(
                "INSERT INTO document_versions"
                "(document_id,version,content_ref,provenance,ingestion_job_id) "
                "VALUES (:document,1,:reference,'{}'::jsonb,:job)"
            ),
            {"document": document, "reference": reference, "job": job},
        )
        session.execute(
            sa.text(
                "INSERT INTO chunks"
                "(id,tenant_id,scope_id,document_id,document_version,seq,text_content,embedding,"
                "embedding_provider,embedding_model,embedding_version) "
                "VALUES (:id,:t,:scope,:document,1,0,'content',CAST(:vector AS vector),"
                "'mock','mock','v1')"
            ),
            {
                "id": f"chk_{suffix}",
                "t": tenant,
                "scope": scope,
                "document": document,
                "vector": vector,
            },
        )
        session.execute(
            sa.text(
                "INSERT INTO records"
                "(id,tenant_id,scope_id,source_id,entity_type,external_key,body,version) "
                "VALUES (:id,:t,:scope,:source,'fixture',:key,'{}'::jsonb,1)"
            ),
            {"id": f"rec_{suffix}", "t": tenant, "scope": scope, "source": source, "key": suffix},
        )
        session.execute(
            sa.text(
                "INSERT INTO memory_namespace"
                "(id,tenant_id,scope_id,kind,statement,provenance) "
                "VALUES (:id,:t,:scope,'project_fact','fixture','{}'::jsonb)"
            ),
            {"id": f"mem_{suffix}", "t": tenant, "scope": scope},
        )
        session.execute(
            sa.text(
                "INSERT INTO retrieval_audit(id,tenant_id,scope_id,requester) "
                "VALUES (:id,:t,:scope,'fixture')"
            ),
            {"id": f"ret_{suffix}", "t": tenant, "scope": scope},
        )
    return reference


def test_hard_delete_all_nine_tables_objects_and_tenant_isolation(
    deletion_database: tuple[sessionmaker[Session], sessionmaker[Session]],
) -> None:
    tenant_sessions, system_sessions = deletion_database
    objects = MemoryObjects()
    ref_a = _seed_all(tenant_sessions, TENANT_A, "delete-a")
    ref_b = _seed_all(tenant_sessions, TENANT_B, "keep-b")
    objects.references.update({ref_a, ref_b})
    provider = AdsDeletionProvider(tenant_sessions, objects, system_sessions)

    locations = provider.locate_subject_data(f"ten_{TENANT_A}")
    assert {item.table for item in locations} == {
        "scopes",
        "sources",
        "documents",
        "document_versions",
        "chunks",
        "records",
        "memory_namespace",
        "ingestion_jobs",
        "retrieval_audit",
    }
    assert all(item.rowCount == 1 for item in locations)
    assert ref_a in {ref for item in locations for ref in item.objectReferences}

    result = provider.delete_subject_data(f"ten_{TENANT_A}", MANIFEST)
    assert result.deletedRows == 9
    assert result.deletedObjects == 1
    assert provider.verify_deletion(f"ten_{TENANT_A}", MANIFEST).deleted is True
    assert objects.object_exists(ref_a) is False
    assert objects.object_exists(ref_b) is True
    assert all(item.rowCount == 1 for item in provider.locate_subject_data(f"ten_{TENANT_B}"))


TENANT_WORKSPACES = "018f4d6e-2b4a-7a3e-8c1a-1234567890f1"
WORKSPACE_ERASED = "018f4d6e-2b4a-7a3e-8c1a-1234567890f2"
WORKSPACE_KEPT = "018f4d6e-2b4a-7a3e-8c1a-1234567890f3"


def test_workspace_erasure_scoped_from_the_live_schema(
    deletion_database: tuple[sessionmaker[Session], sessionmaker[Session]],
) -> None:
    """D2: one workspace's rows and objects go; the tenant's other workspace stays."""
    tenant_sessions, system_sessions = deletion_database
    objects = MemoryObjects()
    ref_erased = _seed_all(tenant_sessions, TENANT_WORKSPACES, "ws-erase", WORKSPACE_ERASED)
    ref_kept = _seed_all(tenant_sessions, TENANT_WORKSPACES, "ws-keep", WORKSPACE_KEPT)
    objects.references.update({ref_erased, ref_kept})
    provider = AdsDeletionProvider(tenant_sessions, objects, system_sessions)
    tenant, erased, kept = (
        f"ten_{TENANT_WORKSPACES}",
        f"ws_{WORKSPACE_ERASED}",
        f"ws_{WORKSPACE_KEPT}",
    )

    located = provider.locate_workspace_data(tenant, erased)
    assert len(located) == 9
    assert all(item.rowCount == 1 for item in located)
    assert {ref for item in located for ref in item.objectReferences} == {ref_erased}

    result = provider.delete_workspace_data(tenant, erased, MANIFEST)
    assert result.deletedRows == 9
    assert result.deletedObjects == 1
    assert provider.verify_workspace_deletion(tenant, erased, MANIFEST).deleted is True
    assert objects.object_exists(ref_erased) is False
    assert objects.object_exists(ref_kept) is True
    assert all(item.rowCount == 1 for item in provider.locate_workspace_data(tenant, kept))
    assert all(item.rowCount == 1 for item in provider.locate_subject_data(tenant))
    with pytest.raises(ValueError):
        provider.locate_workspace_data(tenant, "ws_nope")
    provider.delete_subject_data(tenant, MANIFEST)


def test_verify_fails_closed_when_rows_survive(
    deletion_database: tuple[sessionmaker[Session], sessionmaker[Session]],
) -> None:
    tenant_sessions, system_sessions = deletion_database
    _seed_all(tenant_sessions, TENANT_PARTIAL, "partial")
    provider = AdsDeletionProvider(tenant_sessions, MemoryObjects(), system_sessions)

    verification = provider.verify_deletion(f"ten_{TENANT_PARTIAL}", MANIFEST)
    assert verification.deleted is False
    assert verification.remaining


def test_retention_sweeps_only_expired_rows(
    deletion_database: tuple[sessionmaker[Session], sessionmaker[Session]],
) -> None:
    tenant_sessions, system_sessions = deletion_database
    _seed_all(tenant_sessions, TENANT_RETENTION, "retention")
    with tenant_sessions.begin() as session:
        session.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": TENANT_RETENTION},
        )
        session.execute(
            sa.text(
                "UPDATE retrieval_audit SET created_at=now()-interval '14 months' "
                "WHERE id='ret_retention'"
            )
        )
        session.execute(
            sa.text(
                "UPDATE ingestion_jobs SET completed_at=now()-interval '91 days' "
                "WHERE id='job_retention'"
            )
        )

    provider = AdsDeletionProvider(tenant_sessions, MemoryObjects(), system_sessions)
    sweep = provider.apply_retention_policy()
    assert sweep.deletedRows == 2
    locations = provider.locate_subject_data(f"ten_{TENANT_RETENTION}")
    counts = {item.table: item.rowCount for item in locations}
    assert counts["retrieval_audit"] == 0
    assert counts["ingestion_jobs"] == 0
    assert counts["documents"] == 1


def test_source_retention_config_changes_actual_deletion_behaviour(
    deletion_database: tuple[sessionmaker[Session], sessionmaker[Session]],
) -> None:
    """Retention config is enforced, not merely stored: the same aged document
    survives under a long window and is purged (rows + object) once the source's
    `retention_days` is shortened past its age.
    """

    tenant_sessions, system_sessions = deletion_database
    objects = MemoryObjects()
    reference = _seed_all(tenant_sessions, TENANT_SOURCE_RETENTION, "srcret")
    objects.references.add(reference)
    with tenant_sessions.begin() as session:
        session.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": TENANT_SOURCE_RETENTION},
        )
        session.execute(
            sa.text(
                "UPDATE documents SET updated_at=now()-interval '100 days' WHERE id='doc_srcret'"
            )
        )
    provider = AdsDeletionProvider(tenant_sessions, objects, system_sessions)

    def set_retention_days(value: int) -> None:
        with tenant_sessions.begin() as session:
            session.execute(
                sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
                {"tenant": TENANT_SOURCE_RETENTION},
            )
            session.execute(
                sa.text(
                    "UPDATE sources SET permissions=CAST(:permissions AS jsonb) "
                    "WHERE id='src_srcret'"
                ),
                {
                    "permissions": json.dumps(
                        {"visibility": "tenant", "shared_with": [], "retention_days": value}
                    )
                },
            )

    def counts() -> dict[str, int]:
        locations = provider.locate_subject_data(f"ten_{TENANT_SOURCE_RETENTION}")
        return {item.table: item.rowCount for item in locations}

    set_retention_days(365)
    long_window = provider.apply_retention_policy()
    assert long_window.deletedObjects == 0
    assert counts()["documents"] == 1
    assert objects.object_exists(reference) is True

    set_retention_days(90)
    short_window = provider.apply_retention_policy()
    assert short_window.deletedRows == 3  # chunk + document_version + document
    assert short_window.deletedObjects == 1
    after = counts()
    assert after["documents"] == 0
    assert after["document_versions"] == 0
    assert after["chunks"] == 0
    assert after["sources"] == 1  # the source itself is never swept
    assert objects.object_exists(reference) is False


def test_internal_subject_enumeration_uses_only_system_connection(
    deletion_database: tuple[sessionmaker[Session], sessionmaker[Session]],
    capsys: pytest.CaptureFixture[str],
) -> None:
    tenant_sessions, system_sessions = deletion_database
    provider = AdsDeletionProvider(tenant_sessions, MemoryObjects(), system_sessions)
    subjects = provider.list_subject_ids()
    assert f"ten_{TENANT_B}" in subjects
    assert f"ten_{TENANT_PARTIAL}" in subjects
    assert f"ten_{TENANT_RETENTION}" in subjects
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == ""

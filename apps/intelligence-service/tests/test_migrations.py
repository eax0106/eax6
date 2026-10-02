"""
Intelligence DB migration tests.

Static tests: inspect migration source for required SQL constructs.
Integration tests: spin real Postgres+pgvector via testcontainers,
  run alembic upgrade head, verify schema, tenant isolation, immutability,
  vector dimension enforcement.
"""

import re
from collections.abc import Generator
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config as AlembicConfig
from testcontainers.community.postgres import PostgresContainer

from alembic import command

# ── paths ─────────────────────────────────────────────────────────────────────
SERVICE_ROOT = Path(__file__).parent.parent
VERSIONS_DIR = SERVICE_ROOT / "alembic" / "versions"
MIGRATION_FILE = VERSIONS_DIR / "0001_create_intelligence_tables.py"

TABLES = ["agents", "agent_versions", "capability_embeddings", "performance_records"]
PGVECTOR_IMAGE = "pgvector/pgvector:pg16"


# ── static tests ───────────────────────────────────────────────────────────────
class TestMigrationFileStructure:
    def test_migration_file_exists(self) -> None:
        assert MIGRATION_FILE.exists(), f"Missing migration: {MIGRATION_FILE}"

    def test_expected_migrations_in_versions(self) -> None:
        py_files = sorted(f.name for f in VERSIONS_DIR.glob("*.py") if f.name != "__init__.py")
        assert py_files == [
            "0001_create_intelligence_tables.py",
            "0002_create_drift_reader.py",
            "0003_create_capability_registry.py",
            "0004_split_agent_version_config.py",
            "0005_global_agents.py",
            "0006_agent_auto_creation_key.py",
            "0007_capability_side_effects.py",
            "0008_register_canonical_tools.py",
            "0009_agent_owner_tenant.py",
        ]

    def test_all_tables_defined(self) -> None:
        sql = MIGRATION_FILE.read_text()
        for table in TABLES:
            assert f"CREATE TABLE {table}" in sql, f"Missing CREATE TABLE {table}"

    def test_rls_enable_force_on_all_tables(self) -> None:
        sql = MIGRATION_FILE.read_text()
        for table in TABLES:
            assert f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY" in sql
            assert f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY" in sql

    def test_tenant_context_policy_on_all_tables(self) -> None:
        sql = MIGRATION_FILE.read_text()
        for table in TABLES:
            assert f"CREATE POLICY {table}_tenant_context_isolation ON {table}" in sql
        assert "NULLIF(current_setting('app.current_tenant_id', true), '')::uuid" in sql
        assert "WITH CHECK" in sql

    def test_reject_tenant_id_change_defined_once_used_four_times(self) -> None:
        sql = MIGRATION_FILE.read_text()
        defs = re.findall(r"CREATE OR REPLACE FUNCTION reject_tenant_id_change", sql)
        assert len(defs) == 1, f"Expected 1 definition, got {len(defs)}"
        uses = re.findall(r"EXECUTE FUNCTION reject_tenant_id_change\(\)", sql)
        assert len(uses) == 4, f"Expected 4 uses (one per table), got {len(uses)}"

    def test_no_cross_database_references(self) -> None:
        sql = MIGRATION_FILE.read_text()
        for forbidden in ["orchestration_db", "audit_db", "platform_db", "policy_db"]:
            assert forbidden not in sql, f"Cross-DB reference found: {forbidden}"

    def test_capability_embeddings_vector_512(self) -> None:
        sql = MIGRATION_FILE.read_text()
        assert "vector(512)" in sql

    def test_pgvector_extension_created(self) -> None:
        sql = MIGRATION_FILE.read_text()
        assert "CREATE EXTENSION IF NOT EXISTS vector" in sql

    def test_performance_records_no_fk_on_run_id(self) -> None:
        sql = MIGRATION_FILE.read_text()
        # run_id must NOT have a FK (it's a cross-DB external ref)
        assert "run_id" in sql
        lines = sql.splitlines()
        fk_lines = [ln for ln in lines if "FOREIGN KEY" in ln and "run_id" in ln]
        assert len(fk_lines) == 0, f"run_id has unexpected FK: {fk_lines}"

    def test_hnsw_index_on_embeddings(self) -> None:
        sql = MIGRATION_FILE.read_text()
        assert "USING hnsw" in sql
        assert "vector_cosine_ops" in sql

    def test_downgrade_drops_all_tables(self) -> None:
        sql = MIGRATION_FILE.read_text()
        for table in TABLES:
            assert f"DROP TABLE IF EXISTS {table}" in sql

    def test_init_script_creates_intelligence_db(self) -> None:
        init_script = (
            SERVICE_ROOT.parent.parent
            / "infrastructure"
            / "local"
            / "engine-db-init.sh"
        )
        content = init_script.read_text()
        assert "CREATE ROLE intelligence_service LOGIN PASSWORD" in content
        assert "CREATE DATABASE intelligence_db OWNER intelligence_service" in content
        assert "REVOKE CONNECT, TEMPORARY ON DATABASE intelligence_db FROM PUBLIC" in content
        grant = "GRANT CONNECT, TEMPORARY ON DATABASE intelligence_db TO intelligence_service"
        assert grant in content


# ── integration tests (testcontainers) ────────────────────────────────────────
@pytest.fixture(scope="module")
def pg_url() -> Generator[str, None, None]:
    """Start pgvector/pgvector:pg16 container, run migrations, yield sync URL."""
    with PostgresContainer(
        image=PGVECTOR_IMAGE,
        dbname="intelligence_db",
        username="intelligence_service",
        password="testpass",
    ) as pg:
        sync_url = pg.get_connection_url()

        alembic_cfg = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        alembic_cfg.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        alembic_cfg.set_main_option("sqlalchemy.url", sync_url)

        command.upgrade(alembic_cfg, "head")

        yield sync_url


@pytest.fixture
def conn(pg_url: str) -> Generator[sa.engine.Connection, None, None]:
    engine = sa.create_engine(pg_url)
    with engine.connect() as c:
        yield c
        c.rollback()


def _set_tenant(conn: sa.engine.Connection, tenant_id: str) -> None:
    conn.execute(sa.text(f"SET app.current_tenant_id = '{tenant_id}'"))


class TestSchemaAfterMigration:
    def test_all_tables_exist(self, conn: sa.engine.Connection) -> None:
        for table in TABLES:
            result = conn.execute(
                sa.text(
                    "SELECT 1 FROM information_schema.tables "
                    "WHERE table_schema='public' AND table_name=:t"
                ),
                {"t": table},
            )
            assert result.scalar() == 1, f"Table missing: {table}"

    def test_vector_extension_installed(self, conn: sa.engine.Connection) -> None:
        result = conn.execute(
            sa.text("SELECT 1 FROM pg_extension WHERE extname='vector'")
        )
        assert result.scalar() == 1

    def test_capability_embeddings_column_is_512_dim(
        self, conn: sa.engine.Connection
    ) -> None:
        result = conn.execute(
            sa.text(
                "SELECT atttypmod FROM pg_attribute "
                "JOIN pg_class ON attrelid = pg_class.oid "
                "WHERE relname = 'capability_embeddings' AND attname = 'embedding'"
            )
        )
        # pgvector stores dimensions in atttypmod
        typmod = result.scalar()
        assert typmod == 512, f"Expected 512-dim embedding, got typmod={typmod}"

    def test_rls_enabled_on_all_tables(self, conn: sa.engine.Connection) -> None:
        result = conn.execute(
            sa.text(
                "SELECT relname FROM pg_class "
                "WHERE relrowsecurity = true AND relforcerowsecurity = true "
                "AND relname = ANY(:tables)"
            ),
            {"tables": TABLES},
        )
        enabled = {row[0] for row in result}
        assert enabled == set(TABLES), f"RLS not ENABLED+FORCED on: {set(TABLES) - enabled}"


class TestTenantIsolation:
    def test_agent_only_visible_to_owning_tenant(
        self, pg_url: str
    ) -> None:
        # testcontainers creates the primary user as a superuser, and PostgreSQL
        # superusers bypass RLS even with FORCE ROW LEVEL SECURITY. To actually
        # exercise the policy, we create a non-superuser role and SET ROLE to it.
        # DDL (CREATE ROLE / GRANT) must be committed before switching roles, so
        # we use a separate autocommit connection for setup.
        tenant_a = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa"
        tenant_b = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb"
        ws = "cccccccc-0000-4000-8000-cccccccccccc"

        setup_engine = sa.create_engine(pg_url, isolation_level="AUTOCOMMIT")
        with setup_engine.connect() as setup:
            setup.execute(
                sa.text("DROP ROLE IF EXISTS rls_test_reader")
            )
            setup.execute(sa.text("CREATE ROLE rls_test_reader"))
            setup.execute(
                sa.text("GRANT SELECT, INSERT ON agents TO rls_test_reader")
            )

        engine = sa.create_engine(pg_url)
        with engine.connect() as c:
            # Insert as superuser (bypasses RLS — intentional for test setup)
            _set_tenant(c, tenant_a)
            c.execute(
                sa.text(
                    "INSERT INTO agents (id, tenant_id, workspace_id, name, tier) "
                    "VALUES ('agt_rls-a', :t, :ws, 'Agent A', 'STANDARD')"
                ),
                {"t": tenant_a, "ws": ws},
            )
            c.commit()

            # Switch to non-superuser role — RLS now applies
            c.execute(sa.text("SET ROLE rls_test_reader"))

            # tenant_b context: row is invisible
            _set_tenant(c, tenant_b)
            count = c.execute(
                sa.text("SELECT count(*) FROM agents WHERE id = 'agt_rls-a'")
            ).scalar()
            assert count == 0, "RLS must hide tenant_a row from tenant_b context"

            # tenant_a context: row is visible
            _set_tenant(c, tenant_a)
            count = c.execute(
                sa.text("SELECT count(*) FROM agents WHERE id = 'agt_rls-a'")
            ).scalar()
            assert count == 1, "RLS must show tenant_a row in tenant_a context"

            c.execute(sa.text("RESET ROLE"))
            c.rollback()


class TestTenantIdImmutability:
    def test_agent_tenant_id_is_immutable(self, conn: sa.engine.Connection) -> None:
        tenant = "dddddddd-0000-4000-8000-dddddddddddd"
        ws = "eeeeeeee-0000-4000-8000-eeeeeeeeeeee"
        other = "ffffffff-0000-4000-8000-ffffffffffff"

        _set_tenant(conn, tenant)
        conn.execute(
            sa.text(
                "INSERT INTO agents (id, tenant_id, workspace_id, name, tier) "
                "VALUES ('agt_immut', :t, :ws, 'Immut', 'FAST')"
            ),
            {"t": tenant, "ws": ws},
        )

        with pytest.raises(Exception, match="tenant_id is immutable"):
            conn.execute(
                sa.text(
                    "UPDATE agents SET tenant_id = :other WHERE id = 'agt_immut'"
                ),
                {"other": other},
            )

    def test_performance_record_tenant_id_is_immutable(
        self, conn: sa.engine.Connection
    ) -> None:
        tenant = "11111111-0000-4000-8000-111111111111"
        other = "22222222-0000-4000-8000-222222222222"
        ws = "33333333-0000-4000-8000-333333333333"

        _set_tenant(conn, tenant)
        conn.execute(
            sa.text(
                "INSERT INTO agents (id, tenant_id, workspace_id, name, tier) "
                "VALUES ('agt_perf-parent', :t, :ws, 'Parent', 'FAST')"
            ),
            {"t": tenant, "ws": ws},
        )
        conn.execute(
            sa.text(
                "INSERT INTO performance_records "
                "(id, agent_id, tenant_id, verdict) "
                "VALUES ('perf_immut', 'agt_perf-parent', :t, 'success')"
            ),
            {"t": tenant},
        )

        with pytest.raises(Exception, match="tenant_id is immutable"):
            conn.execute(
                sa.text(
                    "UPDATE performance_records SET tenant_id = :other "
                    "WHERE id = 'perf_immut'"
                ),
                {"other": other},
            )


class TestVectorDimension:
    def test_wrong_dimension_embedding_rejected(
        self, conn: sa.engine.Connection
    ) -> None:
        tenant = "44444444-0000-4000-8000-444444444444"
        ws = "55555555-0000-4000-8000-555555555555"

        _set_tenant(conn, tenant)
        conn.execute(
            sa.text(
                "INSERT INTO agents (id, tenant_id, workspace_id, name, tier) "
                "VALUES ('agt_vec-parent', :t, :ws, 'VecParent', 'STANDARD')"
            ),
            {"t": tenant, "ws": ws},
        )

        wrong_dim = "[" + ",".join(["0.1"] * 256) + "]"  # 256-dim, not 512
        with pytest.raises(Exception):
            conn.execute(
                sa.text(
                    "INSERT INTO capability_embeddings "
                    "(id, agent_id, tenant_id, capability_description, embedding) "
                    f"VALUES ('cemb_wrong', 'agt_vec-parent', :t, 'desc', '{wrong_dim}'::vector)"
                ),
                {"t": tenant},
            )

    def test_correct_dimension_embedding_accepted(
        self, conn: sa.engine.Connection
    ) -> None:
        tenant = "66666666-0000-4000-8000-666666666666"
        ws = "77777777-0000-4000-8000-777777777777"

        _set_tenant(conn, tenant)
        conn.execute(
            sa.text(
                "INSERT INTO agents (id, tenant_id, workspace_id, name, tier) "
                "VALUES ('agt_vec-ok', :t, :ws, 'VecOk', 'STANDARD')"
            ),
            {"t": tenant, "ws": ws},
        )

        correct_dim = "[" + ",".join(["0.1"] * 512) + "]"
        conn.execute(
            sa.text(
                "INSERT INTO capability_embeddings "
                "(id, agent_id, tenant_id, capability_description, embedding) "
                f"VALUES ('cemb_ok', 'agt_vec-ok', :t, 'Can do X', '{correct_dim}'::vector)"
            ),
            {"t": tenant},
        )

        count = conn.execute(
            sa.text("SELECT count(*) FROM capability_embeddings WHERE id = 'cemb_ok'")
        ).scalar()
        assert count == 1


class TestDowngrade:
    def test_downgrade_removes_all_tables(self, pg_url: str) -> None:
        alembic_cfg = AlembicConfig(
            str(SERVICE_ROOT / "alembic.ini")
        )
        alembic_cfg.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        alembic_cfg.set_main_option("sqlalchemy.url", pg_url)

        command.downgrade(alembic_cfg, "base")

        engine = sa.create_engine(pg_url)
        with engine.connect() as c:
            for table in TABLES:
                result = c.execute(
                    sa.text(
                        "SELECT 1 FROM information_schema.tables "
                        "WHERE table_schema='public' AND table_name=:t"
                    ),
                    {"t": table},
                )
                assert result.scalar() is None, f"Table still exists after downgrade: {table}"

"""Native local migration proof; never starts the MVP stack or changes its volumes."""

import importlib.util
import secrets
from pathlib import Path

import pytest
import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from testcontainers.postgres import PostgresContainer

from alembic import command

ROOT = Path(__file__).resolve().parents[2]
SERVICE = ROOT / "apps/intelligence-service"
spec = importlib.util.spec_from_file_location(
    "local_migrate", Path(__file__).with_name("mvp-intelligence-migrate.py")
)
assert spec and spec.loader
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


def test_rejects_nonlocal_or_unrestricted_connections() -> None:
    for url in (
        "postgresql://intelligence_service@remote/intelligence_db",
        "postgresql://engine_admin@localhost/intelligence_db",
        "postgresql://intelligence_service@localhost/postgres",
        "postgresql://intelligence_service@localhost/intelligence_db?host=remote",
        "mysql://intelligence_service@localhost/intelligence_db",
    ):
        with pytest.raises(local.LocalMigrationError, match="local intelligence_service"):
            local.migrate(url, "", SERVICE)


def test_restricted_migration_and_repeat_preserve_ownership_and_rls() -> None:
    password = secrets.token_hex(24)
    pg = PostgresContainer(
        "pgvector/pgvector:pg16", username="engine_admin", password=password, dbname="postgres"
    )
    pg.with_volume_mapping(str(ROOT), "/repo", mode="ro")
    for name in ("AUDIT_DB_PASSWORD", "AUDIT_RETENTION_DB_PASSWORD"):
        pg.with_env(name, password)
    with pg:
        result = pg.exec(["sh", "/repo/infrastructure/local/engine-db-init.sh"])
        assert result.exit_code == 0, "existing local initializer failed"
        url = sa.engine.make_url(pg.get_connection_url()).set(
            username="intelligence_service", password=password, database="intelligence_db"
        )
        cfg = Config(str(SERVICE / "alembic.ini"))
        cfg.set_main_option("script_location", str(SERVICE / "alembic"))
        cfg.set_main_option("sqlalchemy.url", url.render_as_string(hide_password=False))
        # Original startup behavior must reproduce the exact real boot failure.
        with pytest.raises(sa.exc.ProgrammingError) as failed:
            command.upgrade(cfg, "head")
        assert failed.value.orig.pgcode == "42501"
        assert 'must be able to SET ROLE "intelligence_drift_reader"' in (
            failed.value.orig.diag.message_primary
        )
        print("OLD LOCAL MIGRATION FAILED: restricted revision0009 ownership transfer")
        local.migrate(url.render_as_string(hide_password=False), password, SERVICE)
        engine = sa.create_engine(url)
        try:
            with engine.begin() as conn:
                assert MigrationContext.configure(conn).get_current_heads() == (
                    ScriptDirectory.from_config(cfg).get_current_head(),
                )
                assert tuple(
                    conn.execute(
                        sa.text(
                            "SELECT rolsuper, rolbypassrls, "
                            "pg_has_role(current_user, 'intelligence_drift_reader', 'MEMBER') "
                            "FROM pg_roles WHERE rolname=current_user"
                        )
                    ).one()
                ) == (False, False, False)
                tables = list(
                    conn.execute(
                        sa.text(
                            "SELECT relname, pg_get_userbyid(relowner), relrowsecurity, "
                            "relforcerowsecurity FROM pg_class JOIN pg_namespace "
                            "ON relnamespace=pg_namespace.oid "
                            "WHERE nspname='public' AND relkind='r'"
                        )
                    )
                )
                assert tables
                for name, owner, rls, forced in tables:
                    assert owner == "intelligence_service", name
                    if name != "alembic_version":
                        assert rls and forced, name
                assert conn.execute(
                    sa.text(
                        "SELECT pg_get_userbyid(proowner) FROM pg_proc "
                        "WHERE oid='agent_owner_tenant(text)'::regprocedure"
                    )
                ).scalar_one() == ("intelligence_drift_reader")
                assert conn.execute(
                    sa.text(
                        "SELECT has_function_privilege(current_user, "
                        "'agent_owner_tenant(text)', 'EXECUTE')"
                    )
                ).scalar_one()
                assert (
                    conn.execute(
                        sa.text(
                            "SELECT count(*) FROM pg_proc, LATERAL aclexplode(proacl) acl "
                            "WHERE oid='agent_owner_tenant(text)'::regprocedure "
                            "AND acl.grantee=0 AND acl.privilege_type='EXECUTE'"
                        )
                    ).scalar_one()
                    == 0
                )
                with pytest.raises(sa.exc.ProgrammingError), conn.begin_nested():
                    conn.execute(sa.text("SET ROLE intelligence_drift_reader"))
                tenant_a = "aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa"
                tenant_b = "bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb"
                conn.execute(
                    sa.text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": tenant_a}
                )
                conn.execute(
                    sa.text(
                        "INSERT INTO agents(id,tenant_id,workspace_id,name,tier) "
                        "VALUES('agt_local-proof', :t, :t, 'Local proof', 'STANDARD')"
                    ),
                    {"t": tenant_a},
                )
                assert conn.execute(sa.text("SELECT count(*) FROM agents")).scalar_one() == 1
                assert (
                    conn.execute(
                        sa.text("SELECT agent_owner_tenant('agt_local-proof')::text")
                    ).scalar_one()
                    == tenant_a
                )
                seeds = conn.execute(
                    sa.text("SELECT count(*) FROM capability_registry_templates")
                ).scalar_one()
                assert (
                    seeds
                    == len(list((SERVICE / "src/capability_registry/templates/v1").glob("*.json")))
                    > 0
                )
                conn.execute(
                    sa.text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": tenant_b}
                )
                assert conn.execute(sa.text("SELECT count(*) FROM agents")).scalar_one() == 0
                with pytest.raises(sa.exc.ProgrammingError), conn.begin_nested():
                    conn.execute(
                        sa.text(
                            "INSERT INTO agents(id,tenant_id,workspace_id,name,tier) "
                            "VALUES('agt_foreign', :t, :t, 'Foreign', 'STANDARD')"
                        ),
                        {"t": tenant_a},
                    )
                conn.execute(sa.text("SELECT set_config('app.current_tenant_id', '', true)"))
                assert conn.execute(sa.text("SELECT count(*) FROM agents")).scalar_one() == 0
            # Already-upgraded stacks do not need admin credentials or replay old migrations.
            local.migrate(url.render_as_string(hide_password=False), "", SERVICE)
            with engine.connect() as conn:
                assert (
                    conn.execute(
                        sa.text("SELECT count(*) FROM capability_registry_templates")
                    ).scalar_one()
                    == seeds
                )
                conn.execute(
                    sa.text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": tenant_a}
                )
                assert conn.execute(sa.text("SELECT count(*) FROM agents")).scalar_one() == 1
        finally:
            engine.dispose()

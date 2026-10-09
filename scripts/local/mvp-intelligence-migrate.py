"""Local-only bootstrap: use the existing administrator for revision0009 only."""

import os
import sys
from pathlib import Path

import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory

from alembic import command


class LocalMigrationError(ValueError):
    """Safe diagnostic: never contains a credential or connection string."""


def migrate(runtime_url: str, admin_password: str, service_root: Path) -> None:
    url = sa.engine.make_url(runtime_url)
    if (
        url.drivername not in {"postgresql", "postgresql+psycopg2"}
        or url.host not in {"localhost", "127.0.0.1"}
        or url.username != "intelligence_service"
        or url.database != "intelligence_db"
        or url.query
    ):
        raise LocalMigrationError("local intelligence_service database required")

    def config(connection_url: sa.engine.URL) -> Config:
        cfg = Config(str(service_root / "alembic.ini"))
        cfg.set_main_option("script_location", str(service_root / "alembic"))
        cfg.set_main_option("prepend_sys_path", str(service_root))
        cfg.set_main_option(
            "sqlalchemy.url",
            connection_url.render_as_string(hide_password=False).replace("%", "%%"),
        )
        return cfg

    normal = config(url)
    script = ScriptDirectory.from_config(normal)
    head = script.get_current_head()  # Refuses multiple migration branches.
    if script.get_revision("0009").down_revision != "0008":
        raise LocalMigrationError("revision0009 predecessor changed; review required")
    before = {revision.revision for revision in script.walk_revisions(head="0008")}
    known = {revision.revision for revision in script.walk_revisions()}
    engine = sa.create_engine(url)
    try:
        with engine.connect() as conn:
            role = conn.execute(
                sa.text(
                    "SELECT current_user, rolsuper, rolbypassrls "
                    "FROM pg_roles WHERE rolname=current_user"
                )
            ).one()
            if tuple(role) != ("intelligence_service", False, False):
                raise LocalMigrationError("restricted runtime role required")
            revisions = MigrationContext.configure(conn).get_current_heads()
        if len(revisions) > 1 or (revisions and revisions[0] not in known):
            raise LocalMigrationError("unknown or divergent local migration revision")
        if not revisions or revisions[0] in before:
            if not admin_password:
                raise LocalMigrationError("ENGINE_DB_ADMIN_PASSWORD required for revision0009")
            # Application tables remain owned by their normal restricted role.
            command.upgrade(normal, "0008")
            owner = config(url.set(username="engine_admin", password=admin_password))
            command.upgrade(owner, "0009")
        command.upgrade(normal, "head")
        with engine.connect() as conn:
            if MigrationContext.configure(conn).get_current_heads() != (head,):
                raise LocalMigrationError("local migrations did not reach current head")
    finally:
        engine.dispose()
    print("LOCAL INTELLIGENCE MIGRATIONS VERIFIED")


if __name__ == "__main__":
    try:
        if os.environ.get("ALTER_ENV") != "local":
            raise LocalMigrationError("ALTER_ENV=local required")
        migrate(
            os.environ["INTELLIGENCE_DB_URL_SYNC"],
            os.environ.get("ENGINE_DB_ADMIN_PASSWORD", ""),
            Path(__file__).resolve().parents[2] / "apps/intelligence-service",
        )
    except Exception as error:
        # Driver diagnostics omit SQL parameters and connection credentials.
        diag = getattr(getattr(error, "orig", None), "diag", None)
        detail = (
            str(error)
            if isinstance(error, LocalMigrationError)
            else getattr(diag, "message_primary", type(error).__name__)
        )
        print(f"intelligence-service: local migration failed: {detail}", file=sys.stderr)
        sys.exit(1)

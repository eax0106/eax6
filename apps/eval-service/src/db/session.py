"""Global golden-set sessions use the existing forced-RLS service context."""

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import Session, sessionmaker


def global_eval_sessions(url: str) -> tuple[Engine, sessionmaker[Session]]:
    engine = create_engine(url, pool_pre_ping=True)

    @event.listens_for(engine, "checkout")
    def set_context(dbapi_connection: object, _record: object, _proxy: object) -> None:
        cursor = dbapi_connection.cursor()  # type: ignore[attr-defined]
        try:
            cursor.execute("SET ROLE eval_service")
            cursor.execute("SET app.eval_internal = 'on'")
        finally:
            cursor.close()

    return engine, sessionmaker(bind=engine, expire_on_commit=False, class_=Session)

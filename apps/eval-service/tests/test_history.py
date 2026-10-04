from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
import sqlalchemy as sa
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.db.models import EvalRun, GoldenSet
from src.db.session import global_eval_sessions
from src.history.repository import HistoryRepository
from src.history.router import history_repository
from src.main import app

TOKEN = "history-service-test-credential"


@pytest.fixture(scope="module")
def sessions() -> Generator[sessionmaker[Session], None, None]:
    with PostgresContainer("postgres:16-alpine", dbname="eval_db") as postgres:
        url = postgres.get_connection_url()
        config = Config(str(Path(__file__).parent.parent / "alembic.ini"))
        config.set_main_option("script_location", str(Path(__file__).parent.parent / "alembic"))
        config.set_main_option("sqlalchemy.url", url)
        command.upgrade(config, "head")
        admin = sa.create_engine(url)
        with admin.begin() as tx:
            tx.execute(sa.text("CREATE ROLE eval_service NOLOGIN NOBYPASSRLS NOSUPERUSER"))
            tx.execute(sa.text("GRANT eval_service TO CURRENT_USER"))
            tx.execute(sa.text("GRANT USAGE ON SCHEMA public TO eval_service"))
            tx.execute(
                sa.text(
                    "GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public "
                    "TO eval_service"
                )
            )
        engine, factory = global_eval_sessions(url)
        with factory.begin() as session:
            golden = GoldenSet(
                id=uuid4(), name="history-native", domain="verification", version=2, status="active"
            )
            session.add(golden)
            session.flush()
            at = datetime(2026, 10, 5, tzinfo=UTC)
            for i, (status, rate) in enumerate(
                [("completed", 0.9), ("failed", 0.0), ("running", None)]
            ):
                session.add(
                    EvalRun(
                        id=uuid4(),
                        golden_set_id=golden.id,
                        golden_set_version=1,
                        subject="native",
                        trigger="manual",
                        status=status,
                        pass_rate=rate,
                        created_at=at + timedelta(seconds=i),
                    )
                )
            # A separate set proves filtering is applied before pagination.
            other = GoldenSet(
                id=uuid4(), name="history-other", domain="planner", version=1, status="active"
            )
            session.add(other)
            session.flush()
            session.add(
                EvalRun(
                    id=uuid4(),
                    golden_set_id=other.id,
                    golden_set_version=1,
                    subject="other",
                    trigger="scheduled",
                    status="pending",
                )
            )
        try:
            yield factory
        finally:
            engine.dispose()
            admin.dispose()


@pytest.fixture()
def client(
    sessions: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch
) -> Generator[TestClient, None, None]:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN_SHA256", hashlib.sha256(TOKEN.encode()).hexdigest())
    app.dependency_overrides[history_repository] = lambda: HistoryRepository(sessions)
    try:
        with TestClient(app) as browser:
            yield browser
    finally:
        app.dependency_overrides.clear()


def test_service_guard_and_database_context_fail_closed(
    client: TestClient, sessions: sessionmaker[Session]
) -> None:
    assert client.get("/health").status_code == 200
    for headers in [{}, {"Authorization": "Bearer unrelated"}]:
        assert client.get("/internal/evaluation-history", headers=headers).status_code == 401
    with sessions() as session:
        row = session.execute(
            sa.text("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")
        ).one()
        assert tuple(row) == (False, False)
        session.execute(sa.text("SET LOCAL app.eval_internal='off'"))
        assert session.execute(sa.select(EvalRun)).all() == []
    # A returned connection must receive its context on checkout again.
    with sessions() as session:
        assert len(session.execute(sa.select(EvalRun)).all()) == 4


def test_http_lists_original_versions_scores_and_stable_pages(client: TestClient) -> None:
    headers = {"Authorization": "Bearer " + TOKEN}
    first = client.get(
        "/internal/evaluation-history",
        params={"golden_set": "history-native", "limit": 2},
        headers=headers,
    )
    assert first.status_code == 200
    body = first.json()
    assert [row["status"] for row in body["data"]] == ["running", "failed"]
    assert [row["passRate"] for row in body["data"]] == [None, 0.0]
    assert all(row["goldenSetVersion"] == 1 for row in body["data"])
    second = client.get(
        "/internal/evaluation-history",
        params={"golden_set": "history-native", "limit": 2, "cursor": body["nextCursor"]},
        headers=headers,
    ).json()
    assert len(second["data"]) == 1
    assert second["data"][0]["passRate"] == 0.9
    assert second["nextCursor"] is None
    assert not {row["id"] for row in body["data"]} & {row["id"] for row in second["data"]}
    empty = client.get(
        "/internal/evaluation-history", params={"golden_set": "missing"}, headers=headers
    ).json()
    assert empty == {"data": [], "nextCursor": None}


@pytest.mark.parametrize(
    "query",
    [
        {"limit": 0},
        {"limit": 101},
        {"limit": "bad"},
        {"golden_set": ""},
        {"cursor": "bad"},
        {"cursor": base64.urlsafe_b64encode(json.dumps([1, 2]).encode()).decode()},
        {"cursor": "a" * 257},
    ],
)
def test_http_refuses_invalid_inputs(client: TestClient, query: dict[str, object]) -> None:
    response = client.get(
        "/internal/evaluation-history", params=query, headers={"Authorization": "Bearer " + TOKEN}
    )
    assert response.status_code in (400, 422)


def test_storage_failure_is_visible_and_contains_no_database_details(
    client: TestClient, sessions: sessionmaker[Session]
) -> None:
    class UnavailableHistory(HistoryRepository):
        def list_runs(
            self, limit: int, cursor: str | None, golden_set: str | None
        ) -> dict[str, object]:
            raise RuntimeError("Database credentials and topology must remain private")

    app.dependency_overrides[history_repository] = lambda: UnavailableHistory(sessions)
    response = client.get(
        "/internal/evaluation-history", headers={"Authorization": "Bearer " + TOKEN}
    )
    assert response.status_code == 503
    assert response.json() == {"detail": "Evaluation history is temporarily unavailable"}

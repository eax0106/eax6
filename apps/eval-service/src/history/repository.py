from __future__ import annotations

import base64
import json
from datetime import datetime
from uuid import UUID

from sqlalchemy import select, tuple_
from sqlalchemy.orm import Session, sessionmaker

from src.db.models import EvalRun, GoldenSet


def decode_cursor(value: str | None) -> tuple[datetime, UUID] | None:
    if value is None:
        return None
    try:
        if len(value) > 256:
            raise ValueError("Cursor too long")
        raw = json.loads(base64.b64decode(value, altchars=b"-_", validate=True))
        if (
            not isinstance(raw, list)
            or len(raw) != 2
            or not all(isinstance(item, str) for item in raw)
        ):
            raise ValueError("Invalid cursor")
        timestamp = datetime.fromisoformat(raw[0])
        if timestamp.tzinfo is None:
            raise ValueError("Cursor requires a time zone")
        return timestamp, UUID(raw[1])
    except (ValueError, TypeError, KeyError, UnicodeDecodeError) as error:
        raise ValueError("Invalid history cursor") from error


def encode_cursor(timestamp: datetime, run_id: UUID) -> str:
    raw = json.dumps([timestamp.isoformat(), str(run_id)]).encode()
    return base64.urlsafe_b64encode(raw).decode()


class HistoryRepository:
    def __init__(self, sessions: sessionmaker[Session]) -> None:
        self.sessions = sessions

    def list_runs(
        self, limit: int, cursor: str | None, golden_set: str | None
    ) -> dict[str, object]:
        boundary = decode_cursor(cursor)
        statement = select(EvalRun, GoldenSet).join(GoldenSet)
        if golden_set is not None:
            statement = statement.where(GoldenSet.name == golden_set)
        if boundary is not None:
            statement = statement.where(tuple_(EvalRun.created_at, EvalRun.id) < boundary)
        statement = statement.order_by(EvalRun.created_at.desc(), EvalRun.id.desc()).limit(
            limit + 1
        )
        with self.sessions() as session:
            rows = list(session.execute(statement).all())
            visible = rows[:limit]
            data = [
                {
                    "id": str(run.id),
                    "goldenSetName": golden.name,
                    "goldenSetDomain": golden.domain,
                    "goldenSetVersion": run.golden_set_version,
                    "subject": run.subject,
                    "trigger": run.trigger,
                    "status": run.status,
                    "passRate": float(run.pass_rate) if run.pass_rate is not None else None,
                    "startedAt": run.started_at,
                    "completedAt": run.completed_at,
                    "createdAt": run.created_at,
                }
                for run, golden in visible
            ]
            next_cursor = (
                encode_cursor(visible[-1][0].created_at, visible[-1][0].id)
                if len(rows) > limit
                else None
            )
            return {"data": data, "nextCursor": next_cursor}

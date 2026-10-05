import os
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import Engine

from src.config import DEFAULT_EVAL_DB_URL_SYNC
from src.db.session import global_eval_sessions
from src.history.repository import HistoryRepository

router = APIRouter(prefix="/internal/evaluation-history")


@lru_cache(maxsize=1)
def history_storage() -> tuple[Engine, HistoryRepository]:
    engine, sessions = global_eval_sessions(
        os.environ.get("EVAL_DB_URL_SYNC", DEFAULT_EVAL_DB_URL_SYNC)
    )
    return engine, HistoryRepository(sessions)


def history_repository() -> HistoryRepository:
    return history_storage()[1]


@router.get("")
def list_runs(
    repository: Annotated[HistoryRepository, Depends(history_repository)],
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    cursor: Annotated[str | None, Query(max_length=256)] = None,
    golden_set: Annotated[str | None, Query(min_length=1, max_length=128)] = None,
) -> dict[str, object]:
    try:
        return repository.list_runs(limit, cursor, golden_set)
    except ValueError as error:
        raise HTTPException(400, "Invalid history cursor") from error
    except Exception as error:
        raise HTTPException(503, "Evaluation history is temporarily unavailable") from error

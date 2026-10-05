from __future__ import annotations

import secrets
import time
import uuid

from fastapi import Request
from fastapi.responses import JSONResponse

from .models import ProblemDetails


class DeletionHttpError(Exception):
    def __init__(self, problem: ProblemDetails) -> None:
        super().__init__(problem.detail)
        self.problem = problem


def deletion_problem(*, status: int, instance: str) -> DeletionHttpError:
    error_code = {
        400: "DELETION_VALIDATION_FAILED",
        401: "DELETION_AUTHENTICATION_FAILED",
    }.get(status, "DELETION_INTERNAL_ERROR")
    title = {400: "Bad Request", 401: "Unauthorized"}.get(status, "Internal Server Error")
    detail = {
        400: "Deletion request validation failed",
        401: "Internal service authentication failed",
    }.get(status, "Deletion request could not be completed")
    return DeletionHttpError(
        ProblemDetails(
            type=f"https://alter.dev/problems/{error_code.lower().replace('_', '-')}",
            title=title,
            status=status,
            detail=detail,
            instance=instance,
            error_code=error_code,
            trace_id=_prefixed_uuid7("trc"),
            request_id=_prefixed_uuid7("req"),
            retryable=status >= 500,
            documentation_key="deletion.internal",
        )
    )


async def deletion_exception_handler(request: Request, error: DeletionHttpError) -> JSONResponse:
    del request
    return JSONResponse(
        status_code=error.problem.status,
        content=error.problem.model_dump(mode="json"),
        media_type="application/problem+json",
    )


def _prefixed_uuid7(prefix: str) -> str:
    timestamp_ms = time.time_ns() // 1_000_000
    raw = bytearray(secrets.token_bytes(16))
    raw[0:6] = timestamp_ms.to_bytes(6, byteorder="big")
    raw[6] = (raw[6] & 0x0F) | 0x70
    raw[8] = (raw[8] & 0x3F) | 0x80
    return f"{prefix}_{uuid.UUID(bytes=bytes(raw))}"

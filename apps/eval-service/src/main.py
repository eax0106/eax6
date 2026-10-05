import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .benchmarks.router import benchmark_storage
from .benchmarks.router import router as benchmark_router
from .deletion.errors import DeletionHttpError, deletion_exception_handler
from .deletion.router import deletion_storage
from .deletion.router import router as deletion_router
from .history.router import history_storage
from .history.router import router as history_router
from .service_auth import assert_configured_at_startup, fastapi_dependency

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # A missing credential is a boot failure, never a per-request surprise.
    assert_configured_at_startup()
    if os.environ.get("EVAL_BENCHMARK_RECOVERY", "on") == "on":
        # No run of a new process is executing yet; close what a restart cut
        # off. The database being briefly unreachable must not stop the boot.
        try:
            benchmark_storage()[1].close_interrupted_runs()
        except Exception:
            logger.exception("closing interrupted benchmark runs failed")
    yield
    for storage in (history_storage, benchmark_storage, deletion_storage):
        if storage.cache_info().currsize:
            storage()[0].dispose()
            storage.cache_clear()


# Application-level dependency: every current AND future router inherits it
# (same pattern as memory-service/ads-core -- per-router dependencies are how
# a new router silently ships unauthenticated).
app = FastAPI(
    lifespan=lifespan,
    # Erasure routes check the deletion credential audit-service holds.
    dependencies=[fastapi_dependency(frozenset({"/health"}), ("/internal/deletion/",))],
)

app.include_router(history_router)
app.include_router(benchmark_router)
app.include_router(deletion_router)
app.add_exception_handler(DeletionHttpError, deletion_exception_handler)  # type: ignore[arg-type]


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "eval-service"}

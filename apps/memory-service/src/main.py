from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .deletion.errors import DeletionHttpError, deletion_exception_handler
from .deletion.router import deletion_lifespan
from .deletion.router import router as deletion_router
from .drift.router import drift_lifespan
from .drift.router import router as drift_router
from .memory_learning.router import memory_learning_lifespan
from .memory_learning.router import router as memory_learning_router
from .policy_store.router import policy_store_lifespan
from .policy_store.router import router as policy_store_router
from .service_auth import assert_configured_at_startup, fastapi_dependency


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # A missing credential is a boot failure, never a per-request surprise.
    assert_configured_at_startup()
    async with memory_learning_lifespan(app):
        async with policy_store_lifespan(app):
            async with drift_lifespan(app):
                async with deletion_lifespan(app):
                    yield


# Application-level dependency: every current AND future router inherits it.
# Per-router dependencies are what let ads-core ship three unauthenticated
# routers alongside one authenticated one.
# The internal deletion routes carry audit-service's deletion token, which they check.
app = FastAPI(
    lifespan=lifespan,
    dependencies=[
        fastapi_dependency(frozenset({"/health"}), ("/internal/deletion/",)),
    ],
)

app.include_router(memory_learning_router)
app.include_router(policy_store_router)
app.include_router(drift_router)
app.include_router(deletion_router)
app.add_exception_handler(DeletionHttpError, deletion_exception_handler)  # type: ignore[arg-type]


# Probes run before a credential is available to the balancer; keep /health
# open and keep it free of any tenant or system detail.
@app.get("/health", dependencies=[])
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "memory-service"}

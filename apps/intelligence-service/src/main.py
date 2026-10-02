from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .architecture_synthesizer.router import router as architecture_synthesizer_router
from .capability_registry.router import router as capability_registry_router
from .capability_resolver.grpc_server import start_capability_server
from .config import get_settings
from .deletion.errors import DeletionHttpError, deletion_exception_handler
from .deletion.router import deletion_lifespan
from .deletion.router import router as deletion_router
from .performance.router import performance_lifespan
from .performance.router import router as performance_router
from .planner.router import planner_lifespan
from .planner.router import router as planner_router
from .problem_understanding.router import problem_understanding_lifespan
from .problem_understanding.router import router as problem_understanding_router
from .selection_binding.router import router as selection_binding_router
from .selection_binding.router import selection_binding_lifespan
from .service_auth import assert_configured_at_startup


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # A missing credential is a boot failure, never a per-request surprise.
    assert_configured_at_startup()
    capability_server = await start_capability_server(
        get_settings().capability_grpc_bind_address
    )
    try:
        async with performance_lifespan(app):
            async with planner_lifespan(app):
                async with problem_understanding_lifespan(app):
                    async with selection_binding_lifespan(app):
                        async with deletion_lifespan(app):
                            yield
    finally:
        await capability_server.stop(0)


# NOTE: intelligence-service's HTTP app is its public API (planner,
# problem-understanding, selection-binding, capability-registry,
# architecture-synthesizer) and is reached by the platform/frontend without a
# service credential, so it is intentionally NOT behind the internal
# service-to-service token. Internal performance routes validate the shared
# service credential, as the capability resolver gRPC surface already does.
app = FastAPI(
    lifespan=lifespan,
)

app.include_router(planner_router)
app.include_router(problem_understanding_router)
app.include_router(selection_binding_router)
app.include_router(performance_router)
app.include_router(capability_registry_router)
app.include_router(architecture_synthesizer_router)
app.include_router(deletion_router)
app.add_exception_handler(DeletionHttpError, deletion_exception_handler)  # type: ignore[arg-type]


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "intelligence-service"}

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from starlette.concurrency import run_in_threadpool

from src.db.ids import validate_prefixed_id

from .client import MemoryUnavailableError
from .models import RecordMemoryNamespaceRequest, RecordMemoryNamespaceResponse
from .repository import ScopeNotFoundError, SqlAlchemyMemoryNamespaceRepository

router = APIRouter(prefix="/ads/memory-namespace", tags=["ads-memory-namespace"])

_default_repository: SqlAlchemyMemoryNamespaceRepository | None = None


def configure_memory_namespace_repository(
    repository: SqlAlchemyMemoryNamespaceRepository | None,
) -> None:
    global _default_repository
    _default_repository = repository


def get_memory_namespace_repository() -> SqlAlchemyMemoryNamespaceRepository:
    if _default_repository is None:
        raise RuntimeError("Memory namespace repository is not initialized")
    return _default_repository


RepositoryDep = Annotated[
    SqlAlchemyMemoryNamespaceRepository, Depends(get_memory_namespace_repository)
]


@router.post(
    "/records",
    response_model=RecordMemoryNamespaceResponse,
    status_code=status.HTTP_201_CREATED,
)
async def record_memory_namespace(
    request: RecordMemoryNamespaceRequest,
    repository: RepositoryDep,
) -> RecordMemoryNamespaceResponse:
    validate_prefixed_id("ten", request.tenant_id)
    tenant_uuid = request.tenant_id.removeprefix("ten_")
    try:
        record_id = await run_in_threadpool(
            repository.record,
            tenant_uuid=tenant_uuid,
            scope_id=request.scope_id,
            project_ref=request.project_ref,
            kind=request.kind,
            statement=request.statement,
            confidence=request.confidence,
            provenance=request.provenance,
        )
    except ScopeNotFoundError as error:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
    except MemoryUnavailableError as error:
        raise HTTPException(status_code=503, detail="Workspace memory unavailable") from error
    return RecordMemoryNamespaceResponse(id=record_id, skipped=not record_id)

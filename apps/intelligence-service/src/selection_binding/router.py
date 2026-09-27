"""FastAPI router for the real internal selection-binding path.

Route:
  POST /selection-binding/bind-agent-model-tool

The engine needs a per-request AsyncSession (unlike verification's singleton
kernel), so it is constructed per-request from injected dependencies rather
than cached at app startup.

The embedding_client is a real GrpcEmbeddingClient (Model Gateway's Embed
RPC), opened once at app startup and reused across requests -- same
lifespan-managed-singleton pattern planner/router.py's GrpcAdsClient uses,
not a per-request channel. See selection_binding_lifespan below and
embedding_client.py's own module doc for what closed this gap.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent_auto_creation.engine import (
    AgentAutoCreationEngine,
    PersonaCreationValidationError,
)
from src.agent_auto_creation.instructions_client import (
    AgentInstructionsClient,
    AgentInstructionsError,
    AgentInstructionsUnavailableError,
    ModelGatewayAgentInstructionsClient,
)
from src.capability_registry.repository import CapabilityRegistryRepository
from src.capability_resolver.models import NodeType
from src.db.session import get_db_session
from src.m2m_auth import lazy_auth0_m2m_token_provider_from_settings
from src.selection_binding.architecture_binder import ArchitectureBinder
from src.selection_binding.embedding_client import (
    EmbeddingClient,
    EmbeddingTransportUnavailableError,
    GrpcEmbeddingClient,
)
from src.selection_binding.engine import (
    BindingValidationError,
    EmbeddingResultError,
    SelectionBindingEngine,
)
from src.selection_binding.models import (
    ArchitectureBindingOutcome,
    BindAgentModelToolRequest,
    BindingContext,
    BindingOutcome,
    BindingRequest,
    NodeKey,
    NonEmptyString,
    RunId,
    TenantId,
    WorkspaceId,
)
from src.selection_binding.policy_client import HttpRoutingPolicyClient, RoutingPolicyClient

_default_embedding_client: EmbeddingClient | None = None
_default_policy_client: HttpRoutingPolicyClient | None = None
_default_instructions_client: ModelGatewayAgentInstructionsClient | None = None


@asynccontextmanager
async def selection_binding_lifespan(app: FastAPI) -> AsyncIterator[None]:
    del app
    global _default_embedding_client, _default_policy_client, _default_instructions_client

    from ..config import get_settings

    settings = get_settings()
    token_provider = lazy_auth0_m2m_token_provider_from_settings(settings)
    client = GrpcEmbeddingClient(
        settings.model_gateway_grpc_target,
        timeout_seconds=settings.model_gateway_grpc_timeout_seconds,
        access_token_provider=token_provider,
    )
    instructions_client = ModelGatewayAgentInstructionsClient(
        settings.model_gateway_grpc_target,
        timeout_seconds=settings.model_gateway_grpc_timeout_seconds,
        access_token_provider=token_provider,
    )
    # Real shared internal-service credential (memory-service's
    # verify_service_token validates its SHA-256 hash) -- the hardcoded
    # "Bearer intelligence-service" this replaced would never match any
    # real INTERNAL_SERVICE_TOKEN_SHA256, so every real routing_weights
    # policy lookup silently 401'd and fell back to the hardcoded default,
    # unnoticed because tests call PolicyStoreService directly and never
    # exercise this HTTP client's real auth header.
    policy_client = HttpRoutingPolicyClient(
        settings.memory_service_base_url,
        f"Bearer {settings.internal_service_token}",
    )
    _default_embedding_client = client
    _default_policy_client = policy_client
    _default_instructions_client = instructions_client
    try:
        yield
    finally:
        await client.close()
        _default_embedding_client = None
        await instructions_client.close()
        _default_instructions_client = None
        await policy_client.close()
        _default_policy_client = None


def get_embedding_client() -> EmbeddingClient:
    if _default_embedding_client is None:
        raise RuntimeError(
            "EmbeddingClient not initialised -- call selection_binding_lifespan first"
        )
    return _default_embedding_client


def get_policy_client() -> RoutingPolicyClient:
    if _default_policy_client is None:
        raise RuntimeError(
            "RoutingPolicyClient not initialised -- call selection_binding_lifespan first"
        )
    return _default_policy_client


def get_instructions_client() -> AgentInstructionsClient:
    if _default_instructions_client is None:
        raise RuntimeError(
            "AgentInstructionsClient not initialised -- call selection_binding_lifespan first"
        )
    return _default_instructions_client


SessionDep = Annotated[AsyncSession, Depends(get_db_session)]
EmbeddingClientDep = Annotated[EmbeddingClient, Depends(get_embedding_client)]
PolicyClientDep = Annotated[RoutingPolicyClient, Depends(get_policy_client)]
InstructionsClientDep = Annotated[AgentInstructionsClient, Depends(get_instructions_client)]

router = APIRouter(prefix="/selection-binding", tags=["selection-binding"])


class BindAgentModelToolHttpRequest(BaseModel):
    """Locked proto fields plus the trusted context BindingContext needs.

    Callers (orchestration-service) already know workspace_id/node_type from
    their own compiled-DAG/run state -- this is an internal service call,
    not an untrusted public endpoint, so carrying that context alongside
    the proto-locked fields is consistent with BindingContext's own
    docstring ("Trusted internal context absent from the locked protobuf
    request").
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    tenant_id: TenantId
    run_id: RunId
    node_key: NodeKey
    node_requirements_json: NonEmptyString
    workspace_id: WorkspaceId
    node_type: NodeType
    task_category: NonEmptyString | None = None


@router.post("/bind-agent-model-tool", response_model_exclude_none=True)
async def bind_agent_model_tool(
    request: BindAgentModelToolHttpRequest,
    session: SessionDep,
    embedding_client: EmbeddingClientDep,
    policy_client: PolicyClientDep,
    instructions_client: InstructionsClientDep,
) -> BindingOutcome:
    from ..config import get_settings

    persona_creation_engine = AgentAutoCreationEngine(
        session,
        embedding_client,
        instructions_client=instructions_client,
        maximum_tier=get_settings().agent_auto_creation_max_tier,
    )
    engine = SelectionBindingEngine(
        session,
        embedding_client,
        policy_client=policy_client,
        persona_creation_engine=persona_creation_engine,
    )
    bind_request = BindAgentModelToolRequest(
        tenant_id=request.tenant_id,
        run_id=request.run_id,
        node_key=request.node_key,
        node_requirements_json=request.node_requirements_json,
    )
    context = BindingContext(
        workspace_id=request.workspace_id,
        node_type=request.node_type,
        task_category=request.task_category,
    )
    try:
        outcome = await engine.bind(bind_request, context)
    except BindingValidationError as exc:
        await session.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except PersonaCreationValidationError as exc:
        await session.rollback()
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except EmbeddingResultError as exc:
        await session.rollback()
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except EmbeddingTransportUnavailableError as exc:
        await session.rollback()
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except AgentInstructionsUnavailableError as exc:
        await session.rollback()
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except AgentInstructionsError as exc:
        await session.rollback()
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception:
        await session.rollback()
        raise
    await session.commit()
    return outcome


@router.post("/bind-architecture", response_model=ArchitectureBindingOutcome)
async def bind_architecture(
    request: BindingRequest, session: SessionDep
) -> ArchitectureBindingOutcome:
    try:
        return await ArchitectureBinder(CapabilityRegistryRepository(session)).bind(request)
    except Exception:
        await session.rollback()
        raise

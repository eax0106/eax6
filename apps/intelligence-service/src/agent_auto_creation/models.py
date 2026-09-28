"""PLAN-8 persona-creation inputs and outcome type."""

from pydantic import BaseModel, ConfigDict

from src.agent_contracts.types import (
    NoAgentMatch,
    NonEmptyString,
    TenantId,
    Uint32,
    WorkspaceId,
)
from src.capability_resolver.models import AgentId


class _StrictFrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class CreatePersonaRequest(_StrictFrozenModel):
    tenant_id: TenantId
    workspace_id: WorkspaceId
    capability_profile_json: NonEmptyString


class CreatePersonaResponse(_StrictFrozenModel):
    agent_id: AgentId
    agent_version: Uint32
    persona_json: NonEmptyString


PersonaCreationOutcome = CreatePersonaResponse | NoAgentMatch

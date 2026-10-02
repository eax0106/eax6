"""Typed homes for PLAN-7 binding inputs, outputs, and no-match signals."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from src.agent_contracts.types import NoAgentMatch as NoAgentMatch

# Re-exported: these moved to src.agent_contracts (task C7) and are still
# imported from here across the service.
from src.agent_contracts.types import NodeKey as NodeKey
from src.agent_contracts.types import NoMatchReason as NoMatchReason
from src.agent_contracts.types import NonEmptyString as NonEmptyString
from src.agent_contracts.types import RunId as RunId
from src.agent_contracts.types import TenantId as TenantId
from src.agent_contracts.types import Uint32 as Uint32
from src.agent_contracts.types import WorkspaceId as WorkspaceId
from src.architecture_synthesizer.models import ArchitectureSpec
from src.capability_registry.models import CapabilityKind
from src.capability_resolver.models import AgentId, ModelAlias, NodeType


class _StrictFrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class BindAgentModelToolRequest(_StrictFrozenModel):
    tenant_id: TenantId
    run_id: RunId
    node_key: NodeKey
    node_requirements_json: NonEmptyString


class BindAgentModelToolResponse(_StrictFrozenModel):
    agent_id: AgentId
    agent_version: Uint32
    model_alias: ModelAlias
    tool_names: list[NonEmptyString]
    # The bound agent version's instructions (agent_versions.persona_description).
    # LLMTask sends them as the model's system message, which is what makes
    # binding a different agent change how a node behaves. Empty when the
    # version has none.
    instructions: str = ""


BindingOutcome = BindAgentModelToolResponse | NoAgentMatch


class BindingContext(_StrictFrozenModel):
    """Trusted internal context absent from the locked protobuf request."""

    workspace_id: WorkspaceId
    node_type: NodeType
    task_category: NonEmptyString | None = None


class BindingPolicy(_StrictFrozenModel):
    allowed_kinds: list[CapabilityKind] | None = None
    maximum_cost_amount: float | None = Field(default=None, ge=0)
    reliability_weight: float = Field(default=0.4, ge=0, le=1)
    latency_weight: float = Field(default=0.3, ge=0, le=1)
    cost_weight: float = Field(default=0.3, ge=0, le=1)

    @model_validator(mode="after")
    def has_scoring_weight(self) -> "BindingPolicy":
        if self.reliability_weight + self.latency_weight + self.cost_weight <= 0:
            raise ValueError("at least one binding score weight must be positive")
        return self


class BindingRequest(_StrictFrozenModel):
    tenant_id: TenantId
    workspace_id: WorkspaceId
    architecture: ArchitectureSpec
    policy: BindingPolicy = Field(default_factory=BindingPolicy)


class BoundCapability(_StrictFrozenModel):
    record_id: NonEmptyString
    version: int = Field(gt=0)
    kind: CapabilityKind
    source_node_key: NodeKey
    rationale: NonEmptyString
    score: float = Field(ge=0, le=1)
    factors: dict[NonEmptyString, float] = Field(min_length=1)
    required_connector: (
        Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9._-]{0,63}$")] | None
    ) = None


class BindingDecision(_StrictFrozenModel):
    status: Literal["ready"] = "ready"
    bindings: list[BoundCapability]


class BindingBlocked(_StrictFrozenModel):
    status: Literal["blocked"] = "blocked"
    source_node_key: NodeKey
    reason: NonEmptyString


ArchitectureBindingOutcome = BindingDecision | BindingBlocked

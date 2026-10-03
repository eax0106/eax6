from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from src.capability_resolver.models import ModelAlias

CapabilityKind = Literal["agent", "model", "tool", "connector", "execution"]
CapabilityScope = Literal["global", "tenant", "workspace"]
CapabilityStatus = Literal["active", "deprecated", "superseded"]
NonEmpty = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=256)]
CapabilityId = Annotated[
    str,
    StringConstraints(pattern=r"^[a-z][a-z0-9._:-]{0,127}$", strict=True),
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class CapabilityConstraints(StrictModel):
    regions: list[NonEmpty] = Field(default_factory=list, max_length=32)
    data_residency: list[NonEmpty] = Field(default_factory=list, max_length=32)
    required_permissions: list[NonEmpty] = Field(default_factory=list, max_length=64)
    maximum_input_bytes: int | None = Field(default=None, gt=0)


class CapabilityAvailability(StrictModel):
    available: bool = True
    latency_ms_p50: int | None = Field(default=None, ge=0)
    reliability: float | None = Field(default=None, ge=0, le=1)
    cost_unit: NonEmpty | None = None
    cost_amount: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def cost_has_unit(self) -> CapabilityAvailability:
        if (self.cost_unit is None) != (self.cost_amount is None):
            raise ValueError("cost_unit and cost_amount must be supplied together")
        return self


class RegisterCapability(StrictModel):
    capability_id: CapabilityId
    kind: CapabilityKind
    scope: CapabilityScope
    workspace_id: str | None = None
    supported_capabilities: list[NonEmpty] = Field(min_length=1, max_length=128)
    # Whether using this capability sends or changes anything outside Alter.
    # Only an explicit false excuses a tool from approval; unlabelled means true.
    side_effects: bool = True
    constraints: CapabilityConstraints = Field(default_factory=CapabilityConstraints)
    availability: CapabilityAvailability = Field(default_factory=CapabilityAvailability)
    provenance: dict[NonEmpty, NonEmpty] = Field(min_length=1, max_length=16)
    metadata: dict[NonEmpty, str | int | float | bool] = Field(default_factory=dict, max_length=32)

    @model_validator(mode="after")
    def scope_has_correct_workspace(self) -> RegisterCapability:
        if self.scope == "workspace" and self.workspace_id is None:
            raise ValueError("workspace scope requires workspace_id")
        if self.scope != "workspace" and self.workspace_id is not None:
            raise ValueError("only workspace scope may include workspace_id")
        return self


class CapabilityRecord(RegisterCapability):
    version: int = Field(gt=0)
    status: CapabilityStatus
    owner_tenant_id: str


class CapabilitySearch(StrictModel):
    capabilities: list[NonEmpty] = Field(default_factory=list, max_length=32)
    kind: CapabilityKind | None = None
    model_alias: ModelAlias | None = None
    workspace_id: str | None = None
    include_inactive: bool = False
    limit: int = Field(default=50, ge=1, le=100)
    offset: int = Field(default=0, ge=0)

"""Types shared by the L4 components that choose or create an agent -- Selection
& Binding and the Agent Factory (task C7, design log §22 item 9). They live in
neither: the Factory has callers in two layers and must not reach through
Selection to get its own vocabulary."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

_UUID_V7_BODY = (
    r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)

TenantId = Annotated[
    str,
    StringConstraints(pattern=rf"(?i)^ten_{_UUID_V7_BODY}$", strict=True),
]
WorkspaceId = Annotated[
    str,
    StringConstraints(pattern=rf"(?i)^ws_{_UUID_V7_BODY}$", strict=True),
]
RunId = Annotated[
    str,
    StringConstraints(pattern=rf"(?i)^run_{_UUID_V7_BODY}$", strict=True),
]
NodeKey = Annotated[
    str,
    StringConstraints(
        pattern=r"(?i)^[a-z][a-z0-9._-]{0,127}$",
        strict=True,
    ),
]
NonEmptyString = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, strict=True),
]
Uint32 = Annotated[int, Field(strict=True, ge=0, le=4_294_967_295)]



class _StrictFrozenModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


NoMatchReason = Literal[
    "agent_not_required",
    "preferred_agent_unavailable",
    # Nobody in this workspace has the capability at all. Auto-creation, when
    # configured, turns this into a created agent rather than a no-match --
    # so it is returned only when creation is unavailable or declined it.
    "no_eligible_agent",
    # Somebody has the capability, but not at a tier this requirement accepts;
    # or nobody has it and minting one at the requested tier is above the
    # configured ceiling. Both are the same answer to the caller: no agent of
    # yours is allowed a model this expensive. Splitting this out of
    # no_eligible_agent is what stops auto-creation trying to fix a tier gap
    # by creating an agent that fails the same filter.
    "no_agent_at_required_tier",
]


class NoAgentMatch(_StrictFrozenModel):
    """Normal PLAN-7 result consumed by PLAN-8; never an exception."""

    node_key: NodeKey
    reason: NoMatchReason

"""Advice from pinned registry facts, using the architecture binder's score."""

import json
from typing import Any, cast

from src.capability_registry.canonical_tools import tool_capability
from src.capability_registry.models import CapabilityRecord, CapabilitySearch
from src.capability_registry.repository import CapabilityRegistryError, CapabilityRegistryRepository
from src.capability_resolver.models import ModelAlias

from .architecture_binder import score_capability
from .models import (
    OverrideCandidate,
    OverrideCritiqueRequest,
    OverrideCritiqueResponse,
    OverrideWarning,
)


def visible(record: CapabilityRecord, request: OverrideCritiqueRequest) -> bool:
    return (
        record.scope == "global"
        or record.owner_tenant_id.removeprefix("ten_") == request.tenant_id.removeprefix("ten_")
    ) and (
        record.workspace_id is None
        or record.workspace_id.removeprefix("ws_") == request.workspace_id.removeprefix("ws_")
    )


async def critique_override(
    registry: CapabilityRegistryRepository, request: OverrideCritiqueRequest
) -> OverrideCritiqueResponse:
    warnings: list[OverrideWarning] = []

    def warn(code: str, message: str) -> None:
        warnings.append(OverrideWarning(code=code, message=message))

    original: CapabilityRecord | None = None
    if request.original_binding:
        try:
            fetched = await registry.get(
                request.tenant_id,
                request.original_binding.record_id,
                request.original_binding.version,
            )
            if visible(fetched, request):
                original = fetched
        except CapabilityRegistryError:
            pass
    if original is None:
        warn(
            "facts_unavailable",
            "Original provider facts are unavailable; its recorded binding remains visible.",
        )

    choice = request.choice
    query = CapabilitySearch(
        kind=choice.kind,
        workspace_id=request.workspace_id,
        limit=100,
        model_alias=cast(ModelAlias, choice.value) if choice.kind == "model" else None,
        capabilities=[] if choice.kind == "model" else [cast(str, tool_capability(choice.value))],
    )
    candidates = [
        record
        for record in await registry.search(request.tenant_id, query)
        if visible(record, request)
        and record.status == "active"
        and record.availability.available
        and record.kind == choice.kind
        and (
            record.metadata.get("model_alias") == choice.value
            if choice.kind == "model"
            else tool_capability(choice.value) in record.supported_capabilities
        )
    ]
    selected = min(
        candidates,
        key=lambda record: (
            -score_capability(record, request.policy)[0] if request.policy else 0,
            record.capability_id,
            record.version,
        ),
        default=None,
    )

    tiers = ("FAST", "STANDARD", "ADVANCED", "CEILING")
    if (
        choice.kind == "model"
        and request.required_model_alias
        and tiers.index(choice.value) < tiers.index(request.required_model_alias)
    ):
        warn(
            "model_tier",
            f"Chosen alias {choice.value} is below required tier {request.required_model_alias}.",
        )
    candidate: OverrideCandidate | None = None
    if selected is None:
        warn(
            "facts_unavailable",
            "Chosen provider has no active scoped registry facts; "
            "score and latency cannot be compared.",
        )
    else:
        missing = sorted(set(request.required_capabilities) - set(selected.supported_capabilities))
        if missing:
            warn(
                "required_capability",
                "Chosen provider lacks required capabilities: " + ", ".join(missing),
            )
        if (
            choice.kind == "tool"
            and selected.side_effects
            and (original is None or not original.side_effects)
        ):
            warn("outside_action", "Chosen tool adds an outside action.")
        additional = sorted(
            set(selected.constraints.required_permissions)
            - set(original.constraints.required_permissions if original else [])
        )
        if additional:
            warn(
                "account_scope",
                "Chosen provider requires additional account permissions: " + ", ".join(additional),
            )
        previous_latency = original.availability.latency_ms_p50 if original else None
        next_latency = selected.availability.latency_ms_p50
        if (
            previous_latency is not None
            and next_latency is not None
            and next_latency > previous_latency
            and next_latency >= previous_latency * request.latency_multiplier
        ):
            warn(
                "latency", f"Expected latency grows from {previous_latency}ms to {next_latency}ms."
            )
        if previous_latency is None or next_latency is None:
            warn("facts_unavailable", "Expected latency is not recorded for both providers.")
        output_contract: dict[str, Any] | None = None
        encoded = selected.metadata.get("output_contract")
        if isinstance(encoded, str) and len(encoded) <= 65536:
            try:
                parsed = json.loads(encoded)
                json.dumps(parsed, allow_nan=False)
                if isinstance(parsed, dict):
                    output_contract = parsed
            except (ValueError, TypeError):
                pass
        score, factors = (
            score_capability(selected, request.policy) if request.policy else (None, None)
        )
        if request.policy is None:
            warn(
                "facts_unavailable",
                "Original scoring weights are unavailable; no comparison score is invented.",
            )
        candidate = OverrideCandidate(
            record_id=selected.capability_id,
            version=selected.version,
            kind=selected.kind,
            source_node_key=request.node_key,
            rationale="manual choice evaluated with original binding policy weights"
            if request.policy
            else "manual provider facts; original scoring weights unavailable",
            score=score,
            factors=factors,
            output_contract=output_contract,
        )
    return OverrideCritiqueResponse(
        original_binding=request.original_binding, candidate=candidate, warnings=warnings
    )

"""Registry- and ArchitectureSpec-driven concrete capability binding."""

import re

from src.architecture_synthesizer.registry_client import within_allowed
from src.capability_registry.models import CapabilityRecord, CapabilitySearch
from src.capability_registry.repository import CapabilityRegistryRepository

from .models import (
    ArchitectureBindingOutcome,
    BindingBlocked,
    BindingDecision,
    BindingRequest,
    BoundCapability,
)


class ArchitectureBinder:
    def __init__(self, registry: CapabilityRegistryRepository) -> None:
        self._registry = registry

    async def bind(self, request: BindingRequest) -> ArchitectureBindingOutcome:
        bindings: list[BoundCapability] = []
        architecture = request.architecture
        approval_policy = (
            architecture.constraints.human_approval_required
            or architecture.constraints.external_action_approval_required
            or architecture.constraints.customer_visible
        )
        approved_before = {
            boundary.before_node_key
            for boundary in architecture.boundaries
            if boundary.kind == "human_approval" and boundary.before_node_key is not None
        }
        for node in sorted(architecture.nodes, key=lambda value: value.source_node_key):
            role = node.capability_role
            if role is None:
                continue
            candidates: list[CapabilityRecord] = []
            for kind in role.eligible_kinds:
                candidates.extend(
                    await self._registry.search(
                        request.tenant_id,
                        CapabilitySearch(
                            capabilities=role.required_capabilities,
                            kind=kind,
                            workspace_id=request.workspace_id,
                            limit=100,
                        ),
                    )
                )
            eligible = [candidate for candidate in candidates if _eligible(candidate, request)]
            # Synthesis left out the approval gate before this action because
            # every record it saw was free of side effects. A record registered
            # since then may not be, and binding it would run an unapproved
            # external action, so only side-effect-free records stay eligible.
            if (
                approval_policy
                and node.execution_kind == "deterministic"
                and node.source_node_key not in approved_before
            ):
                eligible = [candidate for candidate in eligible if not candidate.side_effects]
            if not eligible:
                return BindingBlocked(
                    source_node_key=node.source_node_key,
                    reason="Capability Registry has no active policy-eligible candidate",
                )
            selected = sorted(eligible, key=lambda candidate: _rank(candidate, request))[0]
            connector = selected.metadata.get("required_connector")
            if (connector is not None and (
                not isinstance(connector, str)
                or re.fullmatch(r"[a-z][a-z0-9._-]{0,63}", connector) is None
            )) or (selected.kind == "connector" and connector is None):
                return BindingBlocked(
                    source_node_key=node.source_node_key,
                    reason="Registered connector requirement is missing or invalid",
                )
            score, factors = _score(selected, request)
            bindings.append(
                BoundCapability(
                    record_id=selected.capability_id,
                    version=selected.version,
                    kind=selected.kind,
                    source_node_key=node.source_node_key,
                    rationale="registry capability fit with deterministic policy score",
                    score=score,
                    factors=factors,
                    required_connector=connector,
                )
            )
        return BindingDecision(bindings=bindings)


def _eligible(candidate: CapabilityRecord, request: BindingRequest) -> bool:
    policy = request.policy
    constraints = request.architecture.constraints
    if not candidate.availability.available:
        return False
    if policy.allowed_kinds is not None and candidate.kind not in policy.allowed_kinds:
        return False
    if policy.maximum_cost_amount is not None:
        amount = candidate.availability.cost_amount
        if amount is None or amount > policy.maximum_cost_amount:
            return False
    if candidate.constraints.required_permissions and not set(
        candidate.constraints.required_permissions
    ).issubset(constraints.allowed_permissions):
        return False
    # Same rule synthesis applied. Binding kept its own copy, which still treated
    # a residency-restricted record as unusable by a tenant that sets no
    # residency, so an architecture synthesis called ready was then blocked here.
    if not within_allowed(candidate.constraints.regions, constraints.allowed_regions):
        return False
    return within_allowed(candidate.constraints.data_residency, constraints.allowed_data_residency)


def _score(candidate: CapabilityRecord, request: BindingRequest) -> tuple[float, dict[str, float]]:
    reliability = candidate.availability.reliability
    reliability_score = 0.5 if reliability is None else reliability
    latency = candidate.availability.latency_ms_p50
    latency_score = 0.5 if latency is None else 1 / (1 + latency / 1000)
    cost = candidate.availability.cost_amount
    cost_score = 0.5 if cost is None else 1 / (1 + cost)
    weights = request.policy
    total_weight = weights.reliability_weight + weights.latency_weight + weights.cost_weight
    score = (
        weights.reliability_weight * reliability_score
        + weights.latency_weight * latency_score
        + weights.cost_weight * cost_score
    ) / total_weight
    return score, {"reliability": reliability_score, "latency": latency_score, "cost": cost_score}


def _rank(candidate: CapabilityRecord, request: BindingRequest) -> tuple[float, str, int]:
    score, _ = _score(candidate, request)
    return (-score, candidate.capability_id, candidate.version)

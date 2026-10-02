import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.architecture_synthesizer.models import (
    ArchitectureBoundary,
    ArchitectureNode,
    ArchitectureSpec,
    EligibleCapabilityRole,
    ExecutionWave,
    SynthesisConstraints,
)
from src.capability_registry.models import CapabilityRecord
from src.selection_binding.architecture_binder import ArchitectureBinder
from src.selection_binding.models import (
    BindingBlocked,
    BindingDecision,
    BindingPolicy,
    BindingRequest,
)
from src.selection_binding.router import router

TENANT = "ten_aaaaaaaa-0000-7000-8000-aaaaaaaaaaaa"
WORKSPACE = "ws_bbbbbbbb-0000-7000-8000-bbbbbbbbbbbb"


class Registry:
    def __init__(self, records: list[CapabilityRecord]) -> None:
        self.records = records

    async def search(self, *args: object, **kwargs: object) -> list[CapabilityRecord]:
        return self.records


def record(
    identifier: str, *, reliability: float = 0.8, available: bool = True
) -> CapabilityRecord:
    return CapabilityRecord.model_validate(
        {
            "capability_id": identifier,
            "version": 2,
            "owner_tenant_id": "aaaaaaaa-0000-7000-8000-aaaaaaaaaaaa",
            "kind": "model",
            "scope": "workspace",
            "workspace_id": WORKSPACE,
            "supported_capabilities": ["text.generation"],
            "availability": {
                "available": available, "reliability": reliability, "latency_ms_p50": 100,
                "cost_unit": "request", "cost_amount": 0.1,
            },
            "provenance": {"source": "test"},
            "status": "active",
        }
    )


def request(policy: BindingPolicy | None = None) -> BindingRequest:
    return BindingRequest(
        tenant_id=TENANT,
        workspace_id=WORKSPACE,
        architecture=ArchitectureSpec(
            source_task_skeleton_version="1",
            topology="single",
            constraints=SynthesisConstraints(),
            nodes=[
                ArchitectureNode(
                    source_node_key="node", role="direct", execution_kind="llm", depends_on=[],
                    capability_role=EligibleCapabilityRole(
                        source_node_key="node", required_capabilities=["text.generation"],
                        eligible_kinds=["model"],
                    ),
                )
            ],
            execution_waves=[ExecutionWave(order=0, node_keys=["node"])],
            rationale=["test"],
            confidence=1,
        ),
        policy=policy or BindingPolicy(),
    )


@pytest.mark.asyncio
async def test_binding_is_policy_filtered_and_version_pinned() -> None:
    records = [record("low", reliability=0.6), record("high", reliability=0.9)]
    binder = ArchitectureBinder(Registry(records))  # type: ignore[arg-type]
    outcome = await binder.bind(request())
    assert outcome.status == "ready"
    assert outcome.bindings[0].record_id == "high"
    assert outcome.bindings[0].version == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("allowed_data_residency", "binds"),
    [([], True), (["eu"], True), (["us"], False)],
)
async def test_binding_applies_the_same_residency_rule_as_synthesis(
    allowed_data_residency: list[str], binds: bool
) -> None:
    # Found live through prepare-compiler-input: synthesis called an EU-only
    # record usable by a tenant with no residency constraint, and binding then
    # blocked the same architecture with its own stricter copy of the check.
    eu_only = CapabilityRecord.model_validate(
        record("eu-only").model_dump() | {"constraints": {"data_residency": ["eu"]}}
    )
    value = request()
    constrained = value.model_copy(
        update={
            "architecture": value.architecture.model_copy(
                update={
                    "constraints": SynthesisConstraints(
                        allowed_data_residency=allowed_data_residency
                    )
                }
            )
        }
    )

    outcome = await ArchitectureBinder(Registry([eu_only])).bind(constrained)  # type: ignore[arg-type]

    assert (outcome.status == "ready") is binds


def _tool_request(
    *, approval_gate: bool, constraints: SynthesisConstraints | None = None
) -> BindingRequest:
    boundaries = [
        ArchitectureBoundary(kind="verification", before_node_key="lookup", reason="x"),
    ]
    if approval_gate:
        boundaries.append(
            ArchitectureBoundary(kind="human_approval", before_node_key="lookup", reason="x")
        )
    value = request()
    architecture = value.architecture.model_copy(
        update={
            "topology": "deterministic",
            "constraints": constraints or SynthesisConstraints(human_approval_required=True),
            "nodes": [
                ArchitectureNode(
                    source_node_key="lookup", role="deterministic",
                    execution_kind="deterministic", source_node_type="tool", depends_on=[],
                    capability_role=EligibleCapabilityRole(
                        source_node_key="lookup", required_capabilities=["text.generation"],
                        eligible_kinds=["model"],
                    ),
                )
            ],
            "execution_waves": [ExecutionWave(order=0, node_keys=["lookup"])],
            "boundaries": boundaries,
        }
    )
    return value.model_copy(update={"architecture": architecture})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("approval_gate", "bound"),
    # Without the gate only the side-effect-free record may run; the more
    # reliable record that acts would be an unapproved external action.
    [(False, "reads"), (True, "acts")],
)
async def test_an_action_synthesized_without_approval_never_binds_a_record_with_side_effects(
    approval_gate: bool, bound: str
) -> None:
    reads = CapabilityRecord.model_validate(
        record("reads", reliability=0.6).model_dump() | {"side_effects": False}
    )
    acts = record("acts", reliability=0.9)
    binder = ArchitectureBinder(Registry([reads, acts]))  # type: ignore[arg-type]

    outcome = await binder.bind(_tool_request(approval_gate=approval_gate))

    assert isinstance(outcome, BindingDecision)
    assert outcome.bindings[0].record_id == bound


@pytest.mark.asyncio
async def test_external_action_approval_keeps_side_effect_records_off_ungated_actions() -> None:
    reads = CapabilityRecord.model_validate(
        record("reads", reliability=0.6).model_dump() | {"side_effects": False}
    )
    binder = ArchitectureBinder(Registry([reads, record("acts", reliability=0.9)]))  # type: ignore[arg-type]
    outcome = await binder.bind(
        _tool_request(
            approval_gate=False,
            constraints=SynthesisConstraints(external_action_approval_required=True),
        )
    )
    assert isinstance(outcome, BindingDecision)
    assert outcome.bindings[0].record_id == "reads"


@pytest.mark.asyncio
async def test_an_ungated_action_with_only_side_effect_records_blocks() -> None:
    binder = ArchitectureBinder(Registry([record("acts")]))  # type: ignore[arg-type]
    outcome = await binder.bind(_tool_request(approval_gate=False))
    assert isinstance(outcome, BindingBlocked)


@pytest.mark.asyncio
async def test_no_policy_eligible_candidate_blocks() -> None:
    binder = ArchitectureBinder(Registry([record("inactive", available=False)]))  # type: ignore[arg-type]
    outcome = await binder.bind(request(BindingPolicy(allowed_kinds=["tool"])))
    assert isinstance(outcome, BindingBlocked)


def test_zero_score_weights_are_rejected_at_route_boundary() -> None:
    app = FastAPI()
    app.include_router(router)
    payload = request().model_dump(mode="json")
    payload["policy"] = {"reliability_weight": 0, "latency_weight": 0, "cost_weight": 0}
    response = TestClient(app).post("/selection-binding/bind-architecture", json=payload)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_binding_preserves_registered_connection_requirement() -> None:
    registered = CapabilityRecord.model_validate(
        record("connected-model").model_dump() | {"metadata": {"required_connector": "github"}}
    )
    outcome = await ArchitectureBinder(Registry([registered])).bind(request())  # type: ignore[arg-type]
    assert isinstance(outcome, BindingDecision)
    assert outcome.bindings[0].required_connector == "github"


@pytest.mark.asyncio
@pytest.mark.parametrize("declaration", ["Github", "", "../github", 1, True])
async def test_invalid_registered_connection_requirement_blocks(declaration: object) -> None:
    registered = CapabilityRecord.model_validate(
        record("invalid-requirement").model_dump()
        | {"metadata": {"required_connector": declaration}}
    )
    outcome = await ArchitectureBinder(Registry([registered])).bind(request())  # type: ignore[arg-type]
    assert isinstance(outcome, BindingBlocked)
    assert outcome.reason == "Registered connector requirement is missing or invalid"


@pytest.mark.asyncio
async def test_connector_record_without_declared_connection_blocks() -> None:
    registered = CapabilityRecord.model_validate(
        record("undeclared").model_dump() | {"kind": "connector"}
    )
    outcome = await ArchitectureBinder(Registry([registered])).bind(request())  # type: ignore[arg-type]
    assert isinstance(outcome, BindingBlocked)

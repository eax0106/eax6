"""D20 rule cases against the real route; registry storage is the controlled edge."""

from collections.abc import AsyncGenerator
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.capability_registry.models import CapabilityRecord, CapabilitySearch
from src.db.session import get_db_session
from src.selection_binding.router import router

TENANT = "ten_aaaaaaaa-0000-7000-8000-aaaaaaaaaaaa"
WORKSPACE = "ws_cccccccc-0000-7000-8000-cccccccccccc"


def record(identifier: str, **changes: object) -> CapabilityRecord:
    return CapabilityRecord.model_validate(
        {
            "capability_id": identifier,
            "version": 1,
            "kind": "model",
            "scope": "workspace",
            "workspace_id": WORKSPACE,
            "owner_tenant_id": TENANT.removeprefix("ten_"),
            "supported_capabilities": ["text.generation"],
            "side_effects": False,
            "availability": {
                "available": True,
                "latency_ms_p50": 100,
                "reliability": 0.9,
                "cost_unit": "call",
                "cost_amount": 1.0,
            },
            "provenance": {"source": "rule-fixture"},
            "metadata": {"model_alias": "STANDARD"},
            "status": "active",
            **changes,
        }
    )


class Registry:
    def __init__(self, original: CapabilityRecord, candidate: CapabilityRecord) -> None:
        self.original = original
        self.candidate = candidate

    async def get(self, tenant: str, identifier: str, version: int) -> CapabilityRecord:
        assert tenant == TENANT and identifier == self.original.capability_id and version == 1
        return self.original

    async def search(self, tenant: str, query: CapabilitySearch) -> list[CapabilityRecord]:
        assert tenant == TENANT and query.workspace_id == WORKSPACE
        return [self.candidate]


def payload(kind: str = "model", value: str = "FAST") -> dict[str, object]:
    return {
        "tenant_id": TENANT,
        "workspace_id": WORKSPACE,
        "node_key": "work",
        "choice": {"kind": kind, "value": value},
        "original_binding": {
            "record_id": "original",
            "version": 1,
            "kind": kind,
            "source_node_key": "work",
            "rationale": "Original ranked capability fit",
            "score": 0.88,
            "factors": {"reliability": 0.9, "latency": 0.91, "cost": 0.5},
            "required_connector": None,
            "model_alias": None,
            "required_model_alias": None,
        },
        "required_capabilities": ["text.generation"],
        "required_model_alias": "ADVANCED",
        "policy": {"reliability_weight": 0.4, "latency_weight": 0.3, "cost_weight": 0.3},
        "latency_multiplier": 2.0,
    }


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    application = FastAPI()
    application.include_router(router)

    async def session() -> AsyncGenerator[object, None]:
        yield object()

    application.dependency_overrides[get_db_session] = session
    return application


def call(
    app: FastAPI,
    monkeypatch: pytest.MonkeyPatch,
    original: CapabilityRecord,
    candidate: CapabilityRecord,
    request: dict[str, object] | None = None,
) -> dict[str, Any]:
    monkeypatch.setattr(
        "src.selection_binding.router.CapabilityRegistryRepository",
        lambda _: Registry(original, candidate),
    )
    with TestClient(app) as client:
        response = client.post("/selection-binding/critique-override", json=request or payload())
    assert response.status_code == 200, response.text
    return cast(dict[str, Any], response.json())


def test_retains_original_reason_and_factors_and_scores_the_actual_candidate(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    result = call(
        app,
        monkeypatch,
        record("original"),
        record(
            "candidate",
            metadata={"model_alias": "FAST"},
            availability={
                "available": True,
                "reliability": 0.7,
                "latency_ms_p50": 200,
                "cost_unit": "call",
                "cost_amount": 2.0,
            },
        ),
    )
    assert result["original_binding"] == payload()["original_binding"]
    selected = result["candidate"]
    assert isinstance(selected, dict)
    assert selected["score"] < 0.88
    assert selected["factors"]["cost"] < 0.5
    assert {"model_tier", "latency"}.issubset({warning["code"] for warning in result["warnings"]})


def test_warns_on_required_capability_outside_action_and_additional_permissions(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = payload("tool", "email.send")
    request["required_capabilities"] = ["tool.search.web"]
    request["required_model_alias"] = None
    result = call(
        app,
        monkeypatch,
        record("original", kind="tool", supported_capabilities=["tool.search.web"], metadata={}),
        record(
            "tool.email.send",
            kind="tool",
            supported_capabilities=["tool.email.send"],
            side_effects=True,
            constraints={"required_permissions": ["mail.send"]},
            metadata={},
        ),
        request,
    )
    codes = {warning["code"] for warning in result["warnings"]}
    assert {"required_capability", "outside_action", "account_scope"}.issubset(codes)


def test_excludes_another_workspace_candidate_without_inventing_a_score(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    result = call(
        app,
        monkeypatch,
        record("original"),
        record(
            "candidate",
            metadata={"model_alias": "FAST"},
            workspace_id="ws_dddddddd-0000-7000-8000-dddddddddddd",
        ),
    )
    assert result["candidate"] is None
    assert "facts_unavailable" in {warning["code"] for warning in result["warnings"]}


def test_uses_configured_latency_threshold_and_keeps_provider_contract_facts(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = payload()
    request["latency_multiplier"] = 3.0
    candidate = record(
        "candidate",
        metadata={
            "model_alias": "FAST",
            "output_contract": '{"type":"object","properties":{"summary":{"type":"string"}},'
            '"required":["summary"]}',
        },
        availability={"available": True, "latency_ms_p50": 299},
    )
    result = call(app, monkeypatch, record("original"), candidate, request)
    assert "latency" not in {warning["code"] for warning in result["warnings"]}
    selected = result["candidate"]
    assert isinstance(selected, dict)
    assert selected["output_contract"]["properties"]["summary"]["type"] == "string"

import json
from types import SimpleNamespace
from typing import Any

import pytest

from src.agent_auto_creation.instructions_client import (
    AgentInstructionsError,
    ModelGatewayAgentInstructionsClient,
)
from src.capability_resolver import NodeRequirement, ToolRequirement


class RecordingStub:
    def __init__(self, content: str) -> None:
        self.content = content
        self.requests: list[tuple[Any, dict[str, object]]] = []

    async def Invoke(self, request: object, **kwargs: object) -> SimpleNamespace:
        self.requests.append((request, kwargs))
        return SimpleNamespace(output_json=json.dumps({"message": {"content": self.content}}))


def client_with_stub(stub: RecordingStub) -> Any:
    client: Any = object.__new__(ModelGatewayAgentInstructionsClient)
    client._stub = stub
    client._timeout_seconds = 7.0
    client._access_token_provider = None
    return client


async def test_drafts_instructions_from_the_capability_profile() -> None:
    stub = RecordingStub(
        json.dumps(
            {
                "instructions": (
                    "Handle document.synthesis work. Use search.web only when current "
                    "information is needed, verify the result, and report uncertainty."
                )
            }
        )
    )
    client = client_with_stub(stub)
    requirement = NodeRequirement(
        capabilities=["document.synthesis"],
        tools=[ToolRequirement(name="search.web", permissions=["web:read"])],
    )

    result = await client.draft_instructions(
        tenant_id="ten_018f47a5-7b2c-7d10-8f11-123456789abc",
        run_id="run_018f47a5-7b2c-7d10-8f11-123456789abc",
        node_key="node.one",
        requirement=requirement,
    )

    assert result.startswith("Handle document.synthesis work.")
    request, kwargs = stub.requests[0]
    assert request.model_alias == "STANDARD"
    assert request.node_execution_id.startswith("agent_instructions_node.one_run_")
    assert kwargs == {"timeout": 7.0}
    payload = json.loads(request.input_json)
    assert payload["temperature"] == 0.1
    assert payload["messages"][0]["alter_authored"] is True
    assert json.loads(payload["messages"][1]["content"]) == (
        requirement.model_dump(exclude_none=True)
    )


async def test_accepts_a_fenced_json_object() -> None:
    client = client_with_stub(RecordingStub('```json\n{"instructions":"Check the work."}\n```'))

    result = await client.draft_instructions(
        tenant_id="ten_a",
        run_id="run_a",
        node_key="node.one",
        requirement=NodeRequirement(capabilities=["analysis.reasoning"]),
    )

    assert result == "Check the work."


@pytest.mark.parametrize(
    "content",
    [
        "not json",
        "{}",
        '{"instructions":""}',
        '{"instructions":"ok","extra":true}',
    ],
)
async def test_rejects_an_unusable_model_answer(content: str) -> None:
    client = client_with_stub(RecordingStub(content))

    with pytest.raises(AgentInstructionsError, match="invalid agent instructions"):
        await client.draft_instructions(
            tenant_id="ten_a",
            run_id="run_a",
            node_key="node.one",
            requirement=NodeRequirement(capabilities=["analysis.reasoning"]),
        )

import json
from types import SimpleNamespace
from typing import Any

import pytest

from src.agent_auto_creation.instructions_client import (
    _SYSTEM_PROMPT,
    AgentInstructionsError,
    ModelGatewayAgentInstructionsClient,
    _alter_authored_system_message,
)
from src.capability_resolver import NodeRequirement, ToolRequirement


def test_rejects_an_interpolated_alter_authored_system_prompt() -> None:
    with pytest.raises(ValueError, match="registered module-level constant"):
        _alter_authored_system_message(f"{_SYSTEM_PROMPT}\ncapability=tenant text")


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


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        # A bulleted draft with raw line breaks inside the JSON string: valid
        # to every reader of the instructions, rejected by strict json.loads.
        (
            '{"instructions":"You handle analysis.reasoning work.\n- Check the result.\n'
            '- Report uncertainty."}',
            "You handle analysis.reasoning work.\n- Check the result.\n- Report uncertainty.",
        ),
        # A sentence of preamble before the object.
        (
            'Here are the instructions:\n{"instructions":"Check the work."}',
            "Check the work.",
        ),
        # A fence that is not the first thing in the answer.
        (
            'Sure.\n```json\n{"instructions":"Check the work."}\n```',
            "Check the work.",
        ),
    ],
)
async def test_accepts_the_shapes_models_wrap_a_valid_answer_in(
    content: str, expected: str
) -> None:
    client = client_with_stub(RecordingStub(content))

    result = await client.draft_instructions(
        tenant_id="ten_a",
        run_id="run_a",
        node_key="node.one",
        requirement=NodeRequirement(capabilities=["analysis.reasoning"]),
    )

    assert result == expected


async def test_leaves_room_for_the_longest_instructions_it_accepts() -> None:
    stub = RecordingStub('{"instructions":"Check the work."}')
    client = client_with_stub(stub)

    await client.draft_instructions(
        tenant_id="ten_a",
        run_id="run_a",
        node_key="node.one",
        requirement=NodeRequirement(capabilities=["analysis.reasoning"]),
    )

    request, _ = stub.requests[0]
    # 4,000 characters is about 1,000 tokens; 700 cut long drafts off
    # mid-string, which then failed to parse.
    assert json.loads(request.input_json)["max_tokens"] >= 1_100

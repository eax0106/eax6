"""Tests for the Model Gateway prompt boundary."""

import json
from types import SimpleNamespace
from typing import Any

import pytest

from src.capability_registry.canonical_tools import CANONICAL_TOOL_SIDE_EFFECTS
from src.planner.manager_worker import ManagerWorkerPlan, build_manager_worker_skeleton
from src.planner.model_gateway_llm_client import (
    _SKELETON_SYSTEM_PROMPT,
    _TOOL_REFERENCE,
    ModelGatewayLlmClient,
    _alter_authored_system_message,
    _executable_problems,
    _linked_to_referenced_nodes,
)
from src.planner.task_skeleton import TaskNode, TaskSkeleton


def test_rejects_an_interpolated_alter_authored_system_prompt() -> None:
    with pytest.raises(ValueError, match="registered module-level constant"):
        _alter_authored_system_message(f"{_SKELETON_SYSTEM_PROMPT}\ntenant={_RUN}")


class _RecordingStub:
    def __init__(self) -> None:
        self.request: Any | None = None

    async def Invoke(self, request: object, **_kwargs: object) -> object:
        self.request = request
        skeleton = TaskSkeleton(
            version="1",
            nodes=[
                TaskNode(
                    key="plan",
                    type="llm",
                    config={"model_alias": "STANDARD", "prompt": "Plan it."},
                    depends_on=[],
                )
            ],
            entry_point="plan",
        )
        return SimpleNamespace(output_json=json.dumps({"message": {"content": skeleton.to_json()}}))


async def test_generate_skeleton_sends_canonical_problem_spec_json() -> None:
    stub = _RecordingStub()
    client: Any = object.__new__(ModelGatewayLlmClient)
    client._stub = stub
    client._timeout_seconds = 30
    client._access_token_provider = None
    problem_spec_json = json.dumps(
        {
            "objective": "summarize customer feedback",
            "current_situation": None,
            "actors": [],
            "systems_involved": [],
            "constraints": [],
            "required_data": [],
            "risk": "unknown",
            "missing_information": [],
            "success_criteria": [],
            "context_references": [],
        },
        separators=(",", ":"),
    )

    await client.generate_skeleton(
        tenant_id="ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
        run_id="run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
        strategy="iterative",
        problem_spec_json=problem_spec_json,
    )

    assert stub.request is not None
    payload = json.loads(stub.request.input_json)
    assert payload["messages"][1] == {"role": "user", "content": problem_spec_json}


class _AnsweringStub:
    def __init__(self, content: str) -> None:
        self.content = content
        self.request: Any | None = None

    async def Invoke(self, request: object, **_kwargs: object) -> object:
        self.request = request
        return SimpleNamespace(output_json=json.dumps({"message": {"content": self.content}}))


def _client(stub: object) -> Any:
    client: Any = object.__new__(ModelGatewayLlmClient)
    client._stub = stub
    client._timeout_seconds = 30
    client._access_token_provider = None
    return client


async def test_classify_workflow_strategy_sends_objective_and_returns_model_choice() -> None:
    stub = _AnsweringStub(
        json.dumps({"strategy": "manager_worker", "reason": "Independent workstreams."})
    )

    strategy, reason = await _client(stub).classify_workflow_strategy(
        tenant_id="ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
        run_id="run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
        objective="Localize the app into four languages",
    )

    assert (strategy, reason) == ("manager_worker", "Independent workstreams.")
    assert stub.request is not None
    assert stub.request.model_alias == "STANDARD"
    assert stub.request.run_id == "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
    payload = json.loads(stub.request.input_json)
    assert payload["temperature"] == 0
    assert payload["messages"][0]["alter_authored"] is True
    assert "alter_authored" not in payload["messages"][1]
    assert payload["messages"][1] == {
        "role": "user",
        "content": "Localize the app into four languages",
    }


async def test_classify_workflow_strategy_rejects_a_strategy_workflow_mode_cannot_use() -> None:
    # plan_then_execute is project-mode only; a model answering it for a
    # workflow objective is wrong, not a fifth option, so the kernel must
    # get an error and fall back rather than pass it through.
    stub = _AnsweringStub(json.dumps({"strategy": "plan_then_execute", "reason": "x"}))

    with pytest.raises(ValueError, match="unknown workflow strategy"):
        await _client(stub).classify_workflow_strategy(
            tenant_id="ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
            run_id="",
            objective="Fix a typo",
        )


async def test_classify_workflow_strategy_raises_on_non_json_answer() -> None:
    stub = _AnsweringStub("I think iterative is best.")

    with pytest.raises(json.JSONDecodeError):
        await _client(stub).classify_workflow_strategy(
            tenant_id="ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
            run_id="",
            objective="Fix a typo",
        )


# ---------------------------------------------------------------------------
# revise_skeleton
# ---------------------------------------------------------------------------

_TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
_RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"


def _llm(key: str, depends_on: list[str], prompt: str = "Do the step.") -> dict[str, object]:
    return {
        "key": key,
        "type": "llm",
        "config": {"model_alias": "STANDARD", "prompt": prompt},
        "depends_on": depends_on,
    }


_FAILED_SKELETON = TaskSkeleton.model_validate(
    {
        "version": "1",
        "nodes": [_llm("fetch", []), _llm("summarize", ["fetch"], "Summarize it.")],
        "entry_point": "fetch",
    }
)
_FAILURE_CONTEXT = json.dumps(
    {
        "node_execution_id": "nex_1",
        "node_key": "summarize",
        "failure_class": "logic_output_failure",
        "root_cause": {"explanation": "prompt never says which fields to return"},
    }
)


async def _revise(answer: object) -> tuple[TaskSkeleton, str]:
    stub = _AnsweringStub(json.dumps(answer))
    result: tuple[TaskSkeleton, str] = await _client(stub).revise_skeleton(
        tenant_id=_TENANT,
        run_id=_RUN,
        current_skeleton=_FAILED_SKELETON,
        failure_context_json=_FAILURE_CONTEXT,
    )
    return result


async def test_revise_skeleton_sends_plan_failure_and_failed_node_on_advanced() -> None:
    revised = {
        "version": "1",
        "nodes": [
            _llm("fetch", []),
            _llm("summarize", ["fetch"], 'Summarize it as {"summary": string}.'),
        ],
        "entry_point": "fetch",
    }
    stub = _AnsweringStub(json.dumps({"skeleton": revised, "reason": "Named the output."}))

    skeleton, reason = await _client(stub).revise_skeleton(
        tenant_id=_TENANT,
        run_id=_RUN,
        current_skeleton=_FAILED_SKELETON,
        failure_context_json=_FAILURE_CONTEXT,
    )

    assert skeleton == TaskSkeleton.model_validate(revised)
    assert reason == "Named the output."
    assert stub.request is not None
    assert stub.request.model_alias == "ADVANCED"
    sent = json.loads(json.loads(stub.request.input_json)["messages"][1]["content"])
    assert sent["current_skeleton"] == _FAILED_SKELETON.model_dump()
    assert sent["failed_node_key"] == "summarize"
    assert sent["failure"]["failure_class"] == "logic_output_failure"


async def test_revise_skeleton_accepts_raw_newlines_inside_prompt_strings() -> None:
    # Seen live on Bedrock: a long prompt string with a literal newline in it,
    # which strict JSON parsing rejects as an invalid control character.
    revised = _FAILED_SKELETON.model_dump()
    revised["nodes"][1]["config"]["prompt"] = "PLACEHOLDER"
    # The replacement holds a real newline character, unescaped, inside the
    # JSON string value.
    raw = json.dumps({"skeleton": revised, "reason": "Split lines."}).replace(
        "PLACEHOLDER", "Summarize it.\nReturn a summary field."
    )
    stub = _AnsweringStub(raw)

    skeleton, _ = await _client(stub).revise_skeleton(
        tenant_id=_TENANT,
        run_id=_RUN,
        current_skeleton=_FAILED_SKELETON,
        failure_context_json=_FAILURE_CONTEXT,
    )

    assert skeleton.nodes[1].config["prompt"] == "Summarize it.\nReturn a summary field."


async def test_revise_skeleton_refuses_to_return_the_plan_that_failed() -> None:
    # This is what the stub did, and Phase 2's replan recompiled the same
    # plan and failed the same way.
    with pytest.raises(ValueError, match="identical"):
        await _revise({"skeleton": _FAILED_SKELETON.model_dump(), "reason": "No change."})


@pytest.mark.parametrize(
    ("nodes", "entry_point", "problem"),
    [
        ([_llm("a", []), _llm("b", ["missing"])], "a", "depends on unknown node 'missing'"),
        ([_llm("a", ["b"]), _llm("b", ["a"])], "a", "has dependencies"),
        ([_llm("a", []), _llm("b", ["c"]), _llm("c", ["b"])], "a", "dependency cycle"),
        (
            [_llm("a", []), {"key": "b", "type": "llm", "config": {}, "depends_on": ["a"]}],
            "a",
            "llm node 'b' has no valid model_alias",
        ),
        (
            [_llm("a", []), {"key": "t", "type": "tool", "config": {}, "depends_on": ["a"]}],
            "a",
            "tool node 't' has no tool_name",
        ),
        ([_llm("a", []), _llm("a", [])], "a", "duplicate node keys"),
    ],
)
async def test_revise_skeleton_rejects_a_plan_that_cannot_compile_or_run(
    nodes: list[dict[str, object]], entry_point: str, problem: str
) -> None:
    answer = {"skeleton": {"version": "1", "nodes": nodes, "entry_point": entry_point}}

    with pytest.raises(ValueError, match="not executable") as error:
        await _revise(answer)

    assert problem in str(error.value)


# ---------------------------------------------------------------------------
# generate_skeleton: canonical tool names
# ---------------------------------------------------------------------------


def _tool(key: str, depends_on: list[str], tool_name: str) -> dict[str, object]:
    return {
        "key": key,
        "type": "tool",
        "config": {"tool_name": tool_name, "arguments": {"query": "x"}},
        "depends_on": depends_on,
    }


def _skeleton_json(nodes: list[dict[str, object]], entry_point: str = "a") -> str:
    return json.dumps({"version": "1", "nodes": nodes, "entry_point": entry_point})


class _SequenceStub:
    def __init__(self, *contents: str) -> None:
        self.contents = list(contents)
        self.requests: list[Any] = []

    async def Invoke(self, request: object, **_kwargs: object) -> object:
        self.requests.append(request)
        return SimpleNamespace(
            output_json=json.dumps({"message": {"content": self.contents.pop(0)}})
        )


async def _generate(stub: _SequenceStub) -> TaskSkeleton:
    skeleton: TaskSkeleton = await _client(stub).generate_skeleton(
        tenant_id=_TENANT, run_id=_RUN, strategy="iterative", problem_spec_json='{"objective":"x"}'
    )
    return skeleton


def test_every_canonical_tool_is_offered_to_the_planner() -> None:
    for name in CANONICAL_TOOL_SIDE_EFFECTS:
        assert f'"{name}"' in _TOOL_REFERENCE
    assert _TOOL_REFERENCE in _SKELETON_SYSTEM_PROMPT


def test_a_tool_name_outside_the_canonical_list_cannot_run() -> None:
    skeleton = TaskSkeleton.from_json(
        _skeleton_json([_llm("a", []), _tool("b", ["a"], "youtube_upload")])
    )

    assert _executable_problems(skeleton) == [
        "tool node 'b' names 'youtube_upload', which is not a tool; "
        "use one of the listed tools or an llm node"
    ]


def _email(key: str, depends_on: list[str], arguments: dict[str, object]) -> dict[str, object]:
    return {
        "key": key,
        "type": "tool",
        "config": {"tool_name": "email.send", "arguments": arguments},
        "depends_on": depends_on,
    }


def test_a_tool_argument_can_reference_a_step_it_depends_on() -> None:
    skeleton = TaskSkeleton.from_json(
        _skeleton_json(
            [
                _llm("a", []),
                _email(
                    "b",
                    ["a"],
                    {
                        "to": "ops@example.com",
                        "subject": {"$from": "a", "path": "subject"},
                        "body": {"$from": "a"},
                    },
                ),
            ]
        )
    )

    assert _executable_problems(skeleton) == []


def test_a_tool_argument_cannot_reference_what_the_tool_does_not_receive() -> None:
    skeleton = TaskSkeleton.from_json(
        _skeleton_json(
            [
                _llm("a", []),
                _llm("b", ["a"]),
                {
                    "key": "route",
                    "type": "branch",
                    "config": {"conditions": {"c": "true"}},
                    "depends_on": ["b"],
                },
                _email(
                    "c",
                    ["b", "route"],
                    {
                        "to": {"$from": "a", "path": "to"},
                        "subject": {"$from": "route"},
                        "body": [{"$from": "b", "path": "body", "default": "x"}],
                    },
                ),
            ]
        )
    )

    assert _executable_problems(skeleton) == [
        "tool node 'c' arguments.to references 'a', which is not in its depends_on",
        "tool node 'c' arguments.subject references branch 'route', which has no output to pass on",
        "tool node 'c' arguments.body.0 is not a reference of the form "
        '{"$from": "<node key>", "path": "<field>.<field>"}',
    ]


def test_a_referenced_step_becomes_a_dependency() -> None:
    # The reference says the value comes from "a", so depending on "a" is the
    # only reading of the plan; adding the edge beats spending a model call.
    skeleton = _linked_to_referenced_nodes(
        TaskSkeleton.from_json(
            _skeleton_json(
                [
                    _llm("a", []),
                    _llm("b", ["a"]),
                    _email(
                        "c",
                        ["b"],
                        {
                            "to": "ops@example.com",
                            "subject": {"$from": "b", "path": "subject"},
                            "body": {"$from": "a"},
                        },
                    ),
                ]
            )
        )
    )

    assert [node.depends_on for node in skeleton.nodes] == [[], ["a"], ["b", "a"]]
    assert _executable_problems(skeleton) == []


def test_a_reference_that_cannot_become_a_dependency_is_left_to_fail() -> None:
    skeleton = _linked_to_referenced_nodes(
        TaskSkeleton.from_json(
            _skeleton_json(
                [
                    _llm("a", []),
                    {
                        "key": "route",
                        "type": "branch",
                        "config": {"conditions": {"b": "true"}},
                        "depends_on": ["a"],
                    },
                    _email("b", ["route"], {"to": {"$from": "route"}}),
                    _email("c", ["a"], {"to": {"$from": "missing"}}),
                    _email("d", ["a"], {"to": {"$from": "e"}}),
                    _llm("e", ["d"]),
                ]
            )
        )
    )

    # A branch has no output, an unknown key names no step, and depending on
    # "e" would close a cycle, so none of these three edges is added.
    assert [node.depends_on for node in skeleton.nodes] == [
        [],
        ["a"],
        ["route"],
        ["a"],
        ["a"],
        ["d"],
    ]
    assert _executable_problems(skeleton) != []


def test_the_entry_point_never_gains_a_dependency() -> None:
    skeleton = _linked_to_referenced_nodes(
        TaskSkeleton.from_json(
            _skeleton_json(
                [_email("a", [], {"to": {"$from": "b"}}), _llm("b", ["a"])],
            )
        )
    )

    assert skeleton.nodes[0].depends_on == []


async def test_generate_skeleton_does_not_spend_a_repair_turn_on_a_missing_edge() -> None:
    stub = _SequenceStub(
        _skeleton_json(
            [_llm("a", []), _email("b", [], {"to": {"$from": "a", "path": "to"}})],
        )
    )

    skeleton = await _generate(stub)

    assert len(stub.requests) == 1
    assert skeleton.nodes[1].depends_on == ["a"]


def test_the_planner_is_told_how_to_reference_an_earlier_step() -> None:
    assert '{"$from": "<key of that step>", "path": "<field>.<field>"}' in _SKELETON_SYSTEM_PROMPT
    assert '"browser_session_id": {"$from"' in _TOOL_REFERENCE


async def test_generate_skeleton_returns_an_executable_plan_in_one_call() -> None:
    plan = _skeleton_json([_llm("a", []), _tool("b", ["a"], "search.web")])
    stub = _SequenceStub(plan)

    skeleton = await _generate(stub)

    assert [node.config.get("tool_name") for node in skeleton.nodes] == [None, "search.web"]
    assert len(stub.requests) == 1


async def test_generate_skeleton_repairs_an_invented_tool_name_once() -> None:
    invented = _skeleton_json([_llm("a", []), _tool("b", ["a"], "youtube_upload")])
    repaired = _skeleton_json([_llm("a", []), _llm("b", ["a"])])
    stub = _SequenceStub(invented, repaired)

    skeleton = await _generate(stub)

    assert [node.type for node in skeleton.nodes] == ["llm", "llm"]
    repair = stub.requests[1]
    assert repair.node_execution_id == f"planner_skeleton_repair_{_RUN}"
    messages = json.loads(repair.input_json)["messages"]
    assert [message["role"] for message in messages] == ["system", "user", "assistant", "user"]
    assert messages[2]["content"] == invented
    assert "'youtube_upload', which is not a tool" in messages[3]["content"]
    # Only the constant system prompt is exempt from gateway redaction; the
    # model's own plan and the repair request are redacted like user text.
    assert [message.get("alter_authored") for message in messages] == [True, None, None, None]


async def test_generate_skeleton_repairs_an_answer_that_is_not_json() -> None:
    stub = _SequenceStub("Here is the plan:", _skeleton_json([_llm("a", [])]))

    skeleton = await _generate(stub)

    assert skeleton.entry_point == "a"
    assert (
        "not a valid skeleton" in json.loads(stub.requests[1].input_json)["messages"][3]["content"]
    )


async def test_generate_skeleton_fails_rather_than_return_a_plan_that_cannot_run() -> None:
    invented = _skeleton_json([_llm("a", []), _tool("b", ["a"], "slack_post")])
    stub = _SequenceStub(invented, invented)

    with pytest.raises(ValueError, match="'slack_post', which is not a tool"):
        await _generate(stub)
    assert len(stub.requests) == 2


# ---------------------------------------------------------------------------
# generate_manager_worker_plan
# ---------------------------------------------------------------------------


def _worker(key: str, **overrides: object) -> dict[str, object]:
    return {
        "key": key,
        "objective": f"Own the {key} workstream.",
        "model_alias": "STANDARD",
        "prompt": f"Do {key}.",
        **overrides,
    }


async def _plan(answer: object, model_alias: str = "CEILING") -> tuple[ManagerWorkerPlan, Any]:
    stub = _AnsweringStub(json.dumps(answer))
    plan = await _client(stub).generate_manager_worker_plan(
        tenant_id=_TENANT,
        run_id=_RUN,
        objective="Localize the product into three languages",
        kb_context='{"objective":"Localize the product into three languages"}',
        model_alias=model_alias,
    )
    return plan, stub.request


async def test_manager_worker_plan_builds_executable_llm_nodes() -> None:
    plan, request = await _plan(
        {
            "manager": {"model_alias": "ADVANCED", "prompt": "Write the shared brief."},
            "workers": [_worker("japanese"), _worker("german")],
        }
    )

    assert request.model_alias == "CEILING"
    assert json.loads(request.input_json)["messages"][1]["content"] == (
        '{"objective":"Localize the product into three languages"}'
    )
    skeleton = build_manager_worker_skeleton(plan)
    # Every llm node carries what LlmTaskHandler requires -- the stub's plan
    # compiled but no node in it could run.
    assert _executable_problems(skeleton) == []
    by_key = {node.key: node for node in skeleton.nodes}
    assert by_key["node_manager"].config == {
        "model_alias": "ADVANCED",
        "prompt": "Write the shared brief.",
    }
    assert by_key["node_worker_german"].depends_on == ["node_manager"]
    assert by_key["node_join"].depends_on == ["node_worker_japanese", "node_worker_german"]


async def test_manager_worker_plan_namespaces_each_worker_output_for_the_merge() -> None:
    # Merge shallow-merges worker outputs; two workers answering the same
    # field would silently drop one of them.
    plan, _ = await _plan(
        {
            "manager": {"prompt": "Brief."},
            "workers": [_worker("japanese"), _worker("german")],
        }
    )

    prompts = {worker.key: str(worker.config["prompt"]) for worker in plan.workers}
    assert prompts["japanese"].endswith('only top-level key is "japanese", holding your result.')
    assert prompts["german"].startswith("Do german.")
    assert plan.manager_config["model_alias"] == "STANDARD"


@pytest.mark.parametrize(
    ("answer", "message"),
    [
        ({"manager": {"prompt": "b"}, "workers": [_worker("only")]}, "2 to 8 workers"),
        ({"manager": {"prompt": "b"}, "workers": [_worker(f"w{i}") for i in range(9)]}, "2 to 8"),
        ({"workers": [_worker("a"), _worker("b")]}, "manager must be an object"),
        ({"manager": {"prompt": " "}, "workers": [_worker("a"), _worker("b")]}, "no prompt"),
        (
            {"manager": {"prompt": "b"}, "workers": [_worker("a"), _worker("Bad Key")]},
            "not snake_case",
        ),
        ({"manager": {"prompt": "b"}, "workers": [_worker("a"), _worker("a")]}, "duplicate"),
        (
            {"manager": {"prompt": "b"}, "workers": [_worker("a"), _worker("b", model_alias="X")]},
            "unknown model_alias",
        ),
    ],
)
async def test_manager_worker_plan_rejects_plans_that_cannot_run(
    answer: dict[str, object], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        await _plan(answer)


def test_planning_and_replanning_advertise_deterministic_arithmetic() -> None:
    from src.planner.model_gateway_llm_client import _REPLAN_SYSTEM_PROMPT

    for prompt in (_SKELETON_SYSTEM_PROMPT, _REPLAN_SYSTEM_PROMPT):
        assert "record_aggregation" in prompt
        assert "decimal_sum" in prompt
        assert "decimal_places" in prompt


@pytest.mark.parametrize("config", [
    {"record_aggregation": {"records_field": "items", "decimal_places": -1}},
    {"record_aggregation": {"records_field": "items", "group_field": None}},
    {"decimal_sum": {"fields": [], "output_field": "total"}},
    {"decimal_sum": {"fields": ["a"], "output_field": "total", "decimal_places": True}},
])
def test_planner_rejects_invalid_arithmetic(config: dict[str, object]) -> None:
    skeleton = TaskSkeleton(nodes=[TaskNode(key="compute", type="join", config=config)],
                            entry_point="compute")
    assert any("arithmetic" in problem for problem in _executable_problems(skeleton))

"""Real Model Gateway-backed LlmClient.

Every LlmClient operation is real here:

- generate_skeleton: ProblemSpec -> TaskSkeleton for direct/iterative work.
- classify_workflow_strategy: chooses a workflow objective's strategy.
- revise_skeleton: rewrites a skeleton around a failed node, for Recovery's
  replan strategy.
- generate_manager_worker_plan: splits an objective into a manager brief and
  independent parallel workers.

Model output is untrusted. Revised skeletons and manager/worker plans are
checked for what the compiler and node handlers will later require (see
_executable_problems and _manager_worker_plan), so a plan that cannot run
fails here with its reason rather than at compile or execution time.

Same real gRPC-call pattern as verification-service's GrpcModelGatewayClient
(apps/verification-service/src/verification/model_gateway_client.py):
plain messages[] Invoke call against alter.modelgw.v1.ModelgwService, no
vendor SDK here -- the real Model Gateway adapter is the only thing that
ever names a concrete model.
"""

from __future__ import annotations

import json
import re

import grpc

from alter.modelgw.v1 import modelgw_pb2, modelgw_pb2_grpc

from ..capability_registry.canonical_tools import CANONICAL_TOOL_SIDE_EFFECTS
from ..m2m_auth import AccessTokenProvider
from .llm_client import StubLlmClient
from .manager_worker import ManagerWorkerPlan, WorkerTaskSpec
from .task_skeleton import TaskNode, TaskSkeleton

# CEILING is reserved (per llm_client.py) for the manager_worker path's
# "hardest decomposition"; the default single-shot skeleton call uses
# STANDARD.
_MODEL_ALIAS_SKELETON = "STANDARD"

# The Tool Gateway dispatches exactly the canonical tools
# (capability_registry/canonical_tools.py), and these are the fields its input
# parsers require. A test fails if a canonical tool is missing here.
_TOOL_REFERENCE = """\
- "search.web": {"query": "<search query>", "maxResults": <optional positive integer>}
- "database.select", "database.insert", "database.update", "database.delete": \
{"databaseId": "<id of the tenant database>", "statement": "<one SQL statement>", \
"parameters": [<optional statement parameters>]}
- "browser.session.create": {"session_id": "<correlation id>"}, and its output is \
{"sessionId": "<browser session id>", "expiresAt": "..."}
- "browser.navigate": {"session_id": "...", "browser_session_id": {"$from": "<key of the \
browser.session.create step>", "path": "sessionId"}, "url": "<url>"}
- "browser.click": {"session_id": "...", "browser_session_id": "...", "selector": \
"<CSS selector>"}
- "browser.extract": {"session_id": "...", "browser_session_id": "...", "selector": \
"<optional CSS selector>"}
- "browser.session.close": {"session_id": "...", "browser_session_id": "..."}
- "email.send": {"to": "<one email address>", "subject": "<subject>", "body": "<body \
text>", "html": <optional boolean>}
- "knowledge.search": {"query": "<what to look for>", "topK": <optional integer 1 to 10>}, \
reads only this workspace's own documents, and its output is {"results": [{"documentId": \
"...", "title": "...", "text": "<passage>", "score": <number>}]}
- "whatsapp.send": {"to": "<one international phone number, digits only>", "text": "<message \
text>"}, sends from the workspace's connected WhatsApp account, and its output is \
{"messageId": "..."}"""

_SKELETON_SHAPE = (
    """{
  "version": "1",
  "nodes": [
    {
      "key": "<unique_snake_case_id, must start with a letter>",
      "type": "<llm|tool|branch|join>",
      "config": { ... },
      "depends_on": ["<key of node this depends on>", ...],
      "success_criteria": ["<exact success criterion assigned to this node>", ...]
    }
  ],
  "entry_point": "<key of the first node, must have depends_on: []>"
}

Rules for config, by node type:
- "llm": config must have "model_alias" (one of FAST, STANDARD, ADVANCED, CEILING -- use \
STANDARD unless the step clearly needs more reasoning) and "prompt" (a specific, self-\
contained instruction for that step). The model executing this step will be told to \
respond with JSON only, so the prompt should describe what fields the JSON output needs.
- "tool": config must have "tool_name" and "arguments". "tool_name" must be exactly one \
of the tools listed below -- these are the only tools that exist, and a step naming any \
other tool cannot run. "arguments" is an object with that tool's fields, each a literal \
value or a reference to an earlier step (see "Using another step's output" below). \
Never put passwords, API keys, tokens or other secrets in arguments.
- "branch" and "join": config can be an empty object {}.

Tools (tool_name: arguments):
"""
    + _TOOL_REFERENCE
    + """

Anything the plan cannot already know -- a fact from the web, a page's contents, rows \
in a database -- is fetched by the matching tool step. A plan that needs current \
information and calls no tool is wrong: "search.web" is how the web is read, and \
the browser tools are for a specific page you were given.

Never invent a tool: a tool_name that is not in that list is not a tool. When the \
objective needs an action none of these tools performs -- posting to a chat app, \
uploading a video, creating a ticket, sending an SMS, adding a calendar event -- \
do not add a tool node for it at all. Use an "llm" node that prepares exactly what a \
person needs to complete that action themselves.

Using another step's output. An argument whose value an earlier step produces is written \
as {"$from": "<key of that step>", "path": "<field>.<field>"} instead of a literal: it \
stands for the value at that path in that step's JSON output (a number in the path picks \
an array item; leave out "path" for the whole output). List that step in this node's \
depends_on. A "branch" step has no output to reference. A reference is the whole argument \
value and cannot be embedded inside a longer string, so when an argument combines several \
values, add an "llm" step that outputs the finished value and reference that.

An "llm" step only reasons over its prompt and the outputs of the steps it depends on. \
It cannot search the web, open pages, read or change a database, or send anything, so a \
step that needs current information from outside or acts outside must be a tool step."""
)

_SKELETON_SYSTEM_PROMPT = f"""You are a task planner. Decompose the validated ProblemSpec JSON
into a task skeleton: a small DAG of steps needed to accomplish it.

Respond with a single JSON object only, no other text, no markdown code fences. The object \
must have this exact shape:
{_SKELETON_SHAPE}

Keep the plan small and concrete -- 2 to 6 nodes. Every node's dependencies must reference \
real node keys in the same skeleton. Exactly one node must have depends_on: [] and must \
match entry_point: the first step starts the work itself and never waits on another \
step. For every string in the input ProblemSpec's success_criteria, assign that \
exact unchanged string to one or more node success_criteria lists. Do not omit, rewrite, invent, \
or copy every criterion onto every node."""

# Replanning happens after something already failed on a plan good enough to
# compile, so it needs more judgement than drafting one.
_MODEL_ALIAS_REPLAN = "ADVANCED"

_REPLAN_SYSTEM_PROMPT = f"""You are a task planner repairing a plan after one of its steps \
failed. The user message is a JSON object with "current_skeleton" (the plan that ran), \
"failed_node_key" (the step that failed, when known) and "failure" (what the recovery \
system observed: failure class and root-cause estimate).

Produce a revised skeleton that removes the cause of the failure. Change what the failure \
points at -- for example rewrite the failed step's prompt or arguments, split it into \
smaller steps, add a step that gathers or checks what it was missing, or replace an \
approach that cannot work. Keep steps that did not contribute to the failure unchanged, \
with the same keys. Do not return the plan unchanged.

Respond with a single JSON object only, no other text, no markdown code fences:
{{"skeleton": <the revised skeleton>, "reason": "<one sentence: what changed and why>"}}

The revised skeleton must have this exact shape:
{_SKELETON_SHAPE}

Every node's dependencies must reference real node keys in the same skeleton. Exactly one \
node must have depends_on: [] and must match entry_point."""

# kernel.py passes CEILING for this call: deciding how to split an objective
# is the hardest decomposition the Planner does.
_MANAGER_WORKER_SYSTEM_PROMPT = """You are a task planner splitting one large objective into \
independent workstreams that run in parallel. The user message is a validated ProblemSpec \
JSON.

Plan one manager step and 2 to 8 worker steps:
- The manager runs first. Its prompt produces a shared brief that every worker receives: \
how the objective is divided, conventions and constraints all workers must follow, and \
what each worker's result must contain.
- Each worker owns exactly one workstream. Workers run at the same time and cannot see \
each other's results, so no worker may depend on another worker's output.

Respond with a single JSON object only, no other text, no markdown code fences:
{
  "manager": {"model_alias": "<FAST|STANDARD|ADVANCED|CEILING>", "prompt": "<instruction>"},
  "workers": [
    {
      "key": "<unique_snake_case_id, must start with a letter>",
      "objective": "<one sentence: the workstream this worker owns>",
      "model_alias": "<FAST|STANDARD|ADVANCED|CEILING>",
      "prompt": "<specific, self-contained instruction for this worker>"
    }
  ]
}

Use STANDARD unless a step clearly needs more reasoning. Every step's model will be told \
to respond with JSON only, so each prompt should describe the JSON fields its output needs."""

_MODEL_ALIASES = frozenset({"FAST", "STANDARD", "ADVANCED", "CEILING"})
# Same pattern the compiler enforces (compiler/dag-builder.ts).
_NODE_KEY_RE = re.compile(r"^[a-z][a-z0-9._-]{0,127}$", re.IGNORECASE)
_WORKER_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
_MIN_WORKERS = 2
_MAX_WORKERS = 8

_MODEL_ALIAS_STRATEGY = "STANDARD"

# Written from the strategy definitions in strategies.py. It deliberately
# carries no example objectives: the planner golden set is the measure of
# this prompt, so wording copied from it would score the copy, not the model.
_STRATEGY_SYSTEM_PROMPT = """You decide how a workflow objective should be executed. \
Judge the work the objective actually requires, not how the request is worded: length, \
politeness, list formatting and particular verbs are not evidence either way.

Choose exactly one strategy:

- "direct": the whole objective is a single step. One action or one answer completes it, \
and there is no intermediate result that has to be checked before the work is done.

- "iterative": one line of work with several steps. Later steps depend on what earlier \
steps produce, or a result has to be checked before continuing -- for example finding a \
cause before acting on it, making a change and then confirming nothing broke, or \
repeating an adjustment until a goal is met. A list of steps that happen in order on the \
same piece of work is iterative, however many steps it names.

- "manager_worker": several substantial workstreams that are independent of each other \
and can run in parallel under one coordinator -- such as the same large job carried out \
separately for different teams, sites, markets or languages, or distinct large \
deliverables that do not wait on one another. The workstreams do not need to be listed \
individually; a count or a phrase covering many of them is enough when each one is a \
substantial job on its own.

If unsure between "direct" and "iterative", choose "iterative". Choose "manager_worker" \
only when the parallel, independent workstreams are clear.

Respond with a single JSON object only, no other text, no markdown code fences:
{"strategy": "<direct|iterative|manager_worker>", "reason": "<one sentence>"}"""

WORKFLOW_STRATEGIES = frozenset({"direct", "iterative", "manager_worker"})
_ALTER_AUTHORED_SYSTEM_PROMPTS = frozenset(
    {
        _SKELETON_SYSTEM_PROMPT,
        _REPLAN_SYSTEM_PROMPT,
        _MANAGER_WORKER_SYSTEM_PROMPT,
        _STRATEGY_SYSTEM_PROMPT,
    }
)


def _alter_authored_system_message(content: str) -> dict[str, object]:
    if content not in _ALTER_AUTHORED_SYSTEM_PROMPTS:
        raise ValueError("alter_authored system prompt must be a registered module-level constant")
    return {"role": "system", "content": content, "alter_authored": True}


def strategy_payload(objective: str) -> dict[str, object]:
    return {
        "messages": [
            _alter_authored_system_message(_STRATEGY_SYSTEM_PROMPT),
            {"role": "user", "content": objective},
        ],
        "temperature": 0,
        "max_tokens": 200,
    }


class ModelGatewayLlmClient(StubLlmClient):
    """Every planner model call, through the Model Gateway."""

    def __init__(
        self,
        target: str,
        *,
        timeout_seconds: float = 30,
        channel: grpc.aio.Channel | None = None,
        access_token_provider: AccessTokenProvider | None = None,
    ) -> None:
        self._channel = channel or grpc.aio.insecure_channel(target)
        self._owns_channel = channel is None
        self._stub = modelgw_pb2_grpc.ModelgwServiceStub(  # type: ignore[no-untyped-call]
            self._channel
        )
        self._timeout_seconds = timeout_seconds
        self._access_token_provider = access_token_provider

    async def close(self) -> None:
        if self._owns_channel:
            await self._channel.close()

    async def generate_skeleton(
        self,
        *,
        tenant_id: str,
        run_id: str,
        strategy: str,
        problem_spec_json: str,
    ) -> TaskSkeleton:
        content = await self._invoke(
            tenant_id=tenant_id,
            run_id=run_id,
            node_execution_id=f"planner_skeleton_{run_id}",
            model_alias=_MODEL_ALIAS_SKELETON,
            payload=_payload(_SKELETON_SYSTEM_PROMPT, problem_spec_json, temperature=0.2),
        )
        skeleton, problems = _parsed_skeleton(content)
        if skeleton is not None and not problems:
            return skeleton
        # One repair turn: the model sees its own plan and exactly what stops
        # it running (most often a tool name that does not exist) and fixes it.
        content = await self._invoke(
            tenant_id=tenant_id,
            run_id=run_id,
            node_execution_id=f"planner_skeleton_repair_{run_id}",
            model_alias=_MODEL_ALIAS_SKELETON,
            payload=_repair_payload(problem_spec_json, content, problems),
        )
        repaired, problems = _parsed_skeleton(content)
        if repaired is None or problems:
            raise ValueError(f"skeleton is not executable: {'; '.join(problems)}")
        return repaired

    async def revise_skeleton(
        self,
        *,
        tenant_id: str,
        run_id: str,
        current_skeleton: TaskSkeleton,
        failure_context_json: str,
    ) -> tuple[TaskSkeleton, str]:
        failure = json.loads(failure_context_json)
        failed_node_key = failure.get("node_key") if isinstance(failure, dict) else None
        request = {
            "current_skeleton": current_skeleton.model_dump(),
            "failed_node_key": failed_node_key,
            "failure": failure,
        }
        content = await self._invoke(
            tenant_id=tenant_id,
            run_id=run_id,
            node_execution_id=f"planner_replan_{run_id}",
            model_alias=_MODEL_ALIAS_REPLAN,
            payload=_payload(_REPLAN_SYSTEM_PROMPT, json.dumps(request), temperature=0.2),
        )
        # strict=False: models put raw newlines inside long prompt strings.
        answer = json.loads(content, strict=False)
        revised = _entry_point_fixed(
            _linked_to_referenced_nodes(TaskSkeleton.model_validate(answer["skeleton"]))
        )
        problems = _executable_problems(revised)
        if problems:
            raise ValueError(f"revised skeleton is not executable: {'; '.join(problems)}")
        if revised == current_skeleton:
            # Recompiling the plan that just failed would only fail again.
            raise ValueError("revised skeleton is identical to the skeleton that failed")
        reason = str(answer.get("reason") or "").strip()
        return revised, reason or "Plan revised after a node failure."

    async def generate_manager_worker_plan(
        self,
        *,
        tenant_id: str,
        run_id: str,
        objective: str,
        kb_context: str,
        model_alias: str,
    ) -> ManagerWorkerPlan:
        content = await self._invoke(
            tenant_id=tenant_id,
            run_id=run_id,
            node_execution_id=f"planner_manager_worker_{run_id}",
            model_alias=model_alias,
            payload=_payload(_MANAGER_WORKER_SYSTEM_PROMPT, kb_context, temperature=0.2),
        )
        return _manager_worker_plan(json.loads(content, strict=False))

    async def classify_workflow_strategy(
        self,
        *,
        tenant_id: str,
        run_id: str,
        objective: str,
    ) -> tuple[str, str]:
        content = await self._invoke(
            tenant_id=tenant_id,
            run_id=run_id,
            node_execution_id=f"planner_select_strategy_{run_id}",
            model_alias=_MODEL_ALIAS_STRATEGY,
            payload=json.dumps(strategy_payload(objective), separators=(",", ":")),
        )
        answer = json.loads(content)
        strategy = answer["strategy"]
        if strategy not in WORKFLOW_STRATEGIES:
            raise ValueError(f"model chose unknown workflow strategy {strategy!r}")
        return strategy, str(answer.get("reason") or "Chosen by model classification.")

    async def _invoke(
        self,
        *,
        tenant_id: str,
        run_id: str,
        node_execution_id: str,
        model_alias: str,
        payload: str,
    ) -> str:
        kwargs: dict[str, object] = {"timeout": self._timeout_seconds}
        if self._access_token_provider is not None:
            kwargs["metadata"] = self._access_token_provider.metadata()
        response = await self._stub.Invoke(
            modelgw_pb2.InvokeRequest(
                tenant_id=tenant_id,
                run_id=run_id,
                node_execution_id=node_execution_id,
                model_alias=model_alias,
                input_json=payload,
            ),
            **kwargs,
        )
        envelope = json.loads(response.output_json)
        return str(envelope["message"]["content"])


def _payload(system_prompt: str, user_content: str, *, temperature: float) -> str:
    return json.dumps(
        {
            "messages": [
                _alter_authored_system_message(system_prompt),
                {"role": "user", "content": user_content},
            ],
            "temperature": temperature,
        },
        separators=(",", ":"),
    )


def _parsed_skeleton(content: str) -> tuple[TaskSkeleton | None, list[str]]:
    """The model's skeleton and what stops it running; a skeleton that does not
    parse is one more problem for the repair turn rather than an exception."""
    try:
        skeleton = TaskSkeleton.model_validate(json.loads(content, strict=False))
    except ValueError as error:
        return None, [f"the answer is not a valid skeleton ({error})"]
    skeleton = _entry_point_fixed(_linked_to_referenced_nodes(skeleton))
    return skeleton, _executable_problems(skeleton)


def _repair_payload(problem_spec_json: str, plan: str, problems: list[str]) -> str:
    return json.dumps(
        {
            "messages": [
                _alter_authored_system_message(_SKELETON_SYSTEM_PROMPT),
                {"role": "user", "content": problem_spec_json},
                {"role": "assistant", "content": plan},
                {
                    "role": "user",
                    "content": "That plan cannot run: "
                    + "; ".join(problems)
                    + ". Return the corrected plan in the same JSON shape. A step naming a "
                    "tool that does not exist cannot be renamed to another tool that does "
                    'not exist either: replace it with an "llm" step whose prompt prepares '
                    "exactly what a person needs to do that action themselves.",
                },
            ],
            "temperature": 0.2,
        },
        separators=(",", ":"),
    )


def _llm_step_config(step: object, label: str) -> dict[str, object]:
    if not isinstance(step, dict):
        raise ValueError(f"{label} must be an object")
    alias = step.get("model_alias", "STANDARD")
    prompt = step.get("prompt")
    if alias not in _MODEL_ALIASES:
        raise ValueError(f"{label} has unknown model_alias {alias!r}")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError(f"{label} has no prompt")
    return {"model_alias": alias, "prompt": prompt}


def _manager_worker_plan(answer: object) -> ManagerWorkerPlan:
    """Validate a model's manager/worker answer into an executable plan.

    Every step becomes an LLMTask node, so each needs what LlmTaskHandler
    requires: a valid model_alias and a non-empty prompt.
    """
    if not isinstance(answer, dict):
        raise ValueError("manager_worker plan must be a JSON object")
    raw_workers = answer.get("workers")
    if not isinstance(raw_workers, list) or not _MIN_WORKERS <= len(raw_workers) <= _MAX_WORKERS:
        raise ValueError(f"manager_worker plan needs {_MIN_WORKERS} to {_MAX_WORKERS} workers")

    manager_config = _llm_step_config(answer.get("manager"), "manager")
    workers: list[WorkerTaskSpec] = []
    for index, raw in enumerate(raw_workers):
        label = f"worker {index}"
        config = _llm_step_config(raw, label)
        key = raw.get("key")
        objective = raw.get("objective")
        if not isinstance(key, str) or not _WORKER_KEY_RE.match(key):
            raise ValueError(f"{label} key {key!r} is not snake_case")
        if not isinstance(objective, str) or not objective.strip():
            raise ValueError(f"{label} has no objective")
        # Workers meet at a Merge node, which shallow-merges their outputs, so
        # two workers both answering {"summary": ...} would silently lose one.
        # Nesting each worker's result under its own key keeps every result.
        config["prompt"] = (
            f"{config['prompt']}\n\nRespond with a JSON object whose only top-level key is "
            f'"{key}", holding your result.'
        )
        workers.append(WorkerTaskSpec(key=key, objective=objective, config=config))

    keys = [worker.key for worker in workers]
    if len(set(keys)) != len(keys):
        raise ValueError("manager_worker plan has duplicate worker keys")
    return ManagerWorkerPlan(manager_config=manager_config, workers=workers)


def _executable_problems(skeleton: TaskSkeleton) -> list[str]:
    """What would stop this skeleton compiling or its nodes running.

    Mirrors compileTaskSkeletonToDag in
    apps/orchestration-service/src/compiler/dag-builder.ts and the LLMTask and
    ToolCall handlers' config requirements. Gate conditions are left to the
    compiler, which reports them precisely.
    """
    problems: list[str] = []
    nodes = {node.key: node for node in skeleton.nodes}
    if not skeleton.nodes:
        problems.append("no nodes")
    if len(nodes) != len(skeleton.nodes):
        problems.append("duplicate node keys")
    for node in skeleton.nodes:
        if not _NODE_KEY_RE.match(node.key):
            problems.append(f"node key {node.key!r} is invalid")
        if node.type not in {"llm", "tool", "branch", "join"}:
            problems.append(f"node {node.key!r} has unknown type {node.type!r}")
        problems.extend(
            f"node {node.key!r} depends on unknown node {dependency!r}"
            for dependency in node.depends_on
            if dependency not in nodes
        )
        if node.type == "llm":
            if node.config.get("model_alias") not in _MODEL_ALIASES:
                problems.append(f"llm node {node.key!r} has no valid model_alias")
            prompt = node.config.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip():
                problems.append(f"llm node {node.key!r} has no prompt")
        if node.type == "tool":
            tool_name = node.config.get("tool_name")
            if not isinstance(tool_name, str):
                problems.append(f"tool node {node.key!r} has no tool_name")
            elif tool_name not in CANONICAL_TOOL_SIDE_EFFECTS:
                problems.append(
                    f"tool node {node.key!r} names {tool_name!r}, which is not a tool; "
                    "use one of the listed tools or an llm node"
                )
            arguments = node.config.get("arguments")
            if not isinstance(arguments, dict):
                problems.append(f"tool node {node.key!r} has no arguments object")
            else:
                problems.extend(_reference_problems(node, arguments, "arguments", nodes))

    entry = nodes.get(skeleton.entry_point)
    if entry is None:
        problems.append(f"entry_point {skeleton.entry_point!r} is not a node")
    elif entry.depends_on:
        problems.append(f"entry_point {skeleton.entry_point!r} has dependencies")

    # Peel off nodes whose dependencies are all satisfied; anything left is a cycle.
    remaining = {key: {d for d in node.depends_on if d in nodes} for key, node in nodes.items()}
    while ready := [key for key, deps in remaining.items() if not deps]:
        for key in ready:
            del remaining[key]
        for deps in remaining.values():
            deps.difference_update(ready)
    if remaining:
        problems.append(f"dependency cycle among {sorted(remaining)}")
    return problems


def _linked_to_referenced_nodes(skeleton: TaskSkeleton) -> TaskSkeleton:
    """The skeleton with every referenced step added to the referring node's
    depends_on.

    A tool node that reads an earlier step's output through {"$from": ...} must
    depend on that step, or the compiler never wires the value through. Models
    write the reference and forget the edge often enough that rejecting the plan
    wastes a model call to fix something that follows from the reference itself.
    The edge is only added when it cannot change what the plan means: the
    referenced node exists, is not a branch (a branch decides whether a node
    runs and has no output), and does not itself depend on this node, which
    would make a cycle.
    """
    nodes = {node.key: node for node in skeleton.nodes}
    repaired: list[TaskNode] = []
    for node in skeleton.nodes:
        added = [
            source
            for source in sorted(_referenced_keys(node.config.get("arguments")))
            if source not in node.depends_on
            and (source_node := nodes.get(source)) is not None
            and source_node.type != "branch"
            and node.key != skeleton.entry_point
            and not _depends_on_transitively(nodes, source, node.key)
        ]
        repaired.append(
            node.model_copy(update={"depends_on": [*node.depends_on, *added]}) if added else node
        )
    return skeleton.model_copy(update={"nodes": repaired})


def _entry_point_fixed(skeleton: TaskSkeleton) -> TaskSkeleton:
    """The skeleton with entry_point naming the step that actually starts it.

    The shape rules say exactly one node has no dependencies and entry_point
    names it. Models sometimes name a later step instead, which is a label
    error rather than a different plan: the graph already says which step runs
    first. Only repaired when the plan leaves no doubt -- exactly one node has
    no dependencies.
    """
    roots = [node.key for node in skeleton.nodes if not node.depends_on]
    if len(roots) != 1 or skeleton.entry_point == roots[0]:
        return skeleton
    return skeleton.model_copy(update={"entry_point": roots[0]})


def _referenced_keys(value: object) -> set[str]:
    """Every node key an argument value references, at any depth."""

    if isinstance(value, list):
        return {key for item in value for key in _referenced_keys(item)}
    if not isinstance(value, dict):
        return set()
    source = value.get("$from")
    if isinstance(source, str) and source:
        return {source}
    return {key for item in value.values() for key in _referenced_keys(item)}


def _depends_on_transitively(nodes: dict[str, TaskNode], start: str, target: str) -> bool:
    seen: set[str] = set()
    pending = [start]
    while pending:
        key = pending.pop()
        if key == target:
            return True
        if key in seen:
            continue
        seen.add(key)
        node = nodes.get(key)
        if node is not None:
            pending.extend(node.depends_on)
    return False


def _reference_problems(
    node: TaskNode, value: object, field: str, nodes: dict[str, TaskNode]
) -> list[str]:
    """Argument references ToolCallHandler could not resolve.

    ToolCallHandler resolves {"$from": key, "path": ...} against the outputs
    of the node's own inputs, which the compiler wires from its depends_on --
    except a branch, whose edge only decides whether the node runs.
    """
    if isinstance(value, list):
        return [
            problem
            for index, item in enumerate(value)
            for problem in _reference_problems(node, item, f"{field}.{index}", nodes)
        ]
    if not isinstance(value, dict):
        return []
    if "$from" not in value:
        return [
            problem
            for key, item in value.items()
            for problem in _reference_problems(node, item, f"{field}.{key}", nodes)
        ]

    source, path = value["$from"], value.get("path")
    if (
        not isinstance(source, str)
        or not source
        or (path is not None and (not isinstance(path, str) or not path))
        or set(value) - {"$from", "path"}
    ):
        return [
            f"tool node {node.key!r} {field} is not a reference of the form "
            '{"$from": "<node key>", "path": "<field>.<field>"}'
        ]
    if source not in node.depends_on:
        return [
            f"tool node {node.key!r} {field} references {source!r}, which is not in its depends_on"
        ]
    if (source_node := nodes.get(source)) is not None and source_node.type == "branch":
        return [
            f"tool node {node.key!r} {field} references branch {source!r}, "
            "which has no output to pass on"
        ]
    return []

"""Golden set for model-drafted auto-created agent instructions.

The set is fixed around three product rules rather than model phrasing:

1. Every required capability identifier remains explicit in the instructions.
2. Every allowed tool is named, and no other canonical tool is granted.
3. The instructions require verification or explicit uncertainty.

The live run needs a real Model Gateway and is opt-in through
AGENT_INSTRUCTIONS_LIVE_MODEL_GATEWAY. It reports every case rather than
asserting a quality threshold because model output varies between runs.
"""

import json
import os
import uuid
from dataclasses import dataclass

import pytest

from src.agent_auto_creation.instructions_client import (
    ModelGatewayAgentInstructionsClient,
)
from src.capability_registry.canonical_tools import CANONICAL_TOOL_SIDE_EFFECTS
from src.capability_resolver import NodeRequirement, ToolRequirement
from src.config import get_settings
from src.m2m_auth import lazy_auth0_m2m_token_provider_from_settings

pytestmark = pytest.mark.skipif(
    not os.environ.get("AGENT_INSTRUCTIONS_LIVE_MODEL_GATEWAY"),
    reason=("needs a live Model Gateway (set AGENT_INSTRUCTIONS_LIVE_MODEL_GATEWAY)"),
)


@dataclass(frozen=True)
class InstructionCase:
    key: str
    requirement: NodeRequirement


INSTRUCTION_CASES: tuple[InstructionCase, ...] = (
    InstructionCase(
        "reason-from-context",
        NodeRequirement(capabilities=["analysis.reasoning"]),
    ),
    InstructionCase(
        "synthesise-documents",
        NodeRequirement(capabilities=["document.synthesis", "analysis.reasoning"]),
    ),
    InstructionCase(
        "research-the-web",
        NodeRequirement(
            capabilities=["research.current_events"],
            tools=[ToolRequirement(name="search.web", permissions=["web:read"])],
        ),
    ),
    InstructionCase(
        "read-database",
        NodeRequirement(
            capabilities=["analytics.query"],
            tools=[ToolRequirement(name="database.select", permissions=["database:read"])],
        ),
    ),
    InstructionCase(
        "compose-email",
        NodeRequirement(
            capabilities=["communications.email_drafting"],
            tools=[ToolRequirement(name="email.send", permissions=["email:send"])],
        ),
    ),
    InstructionCase(
        "inspect-browser-page",
        NodeRequirement(
            capabilities=["web.page_analysis"],
            tools=[ToolRequirement(name="browser.extract", permissions=["browser:read"])],
        ),
    ),
)

_CHECK_LANGUAGE = ("check", "validat", "verif", "uncertain", "confidence")


def _fresh_prefixed_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4()}"


async def test_agent_instruction_golden_set() -> None:
    settings = get_settings()
    client = ModelGatewayAgentInstructionsClient(
        settings.model_gateway_grpc_target,
        timeout_seconds=120,
        access_token_provider=lazy_auth0_m2m_token_provider_from_settings(settings),
    )
    results: list[dict[str, object]] = []
    try:
        for case in INSTRUCTION_CASES:
            try:
                instructions = await client.draft_instructions(
                    tenant_id=_fresh_prefixed_id("ten"),
                    run_id=_fresh_prefixed_id("run"),
                    node_key=case.key,
                    requirement=case.requirement,
                )
            except Exception as error:  # noqa: BLE001 -- recorded per case
                results.append({"case": case.key, "error": str(error), "passed": False})
                continue

            expected_tools = {tool.name for tool in case.requirement.tools or []}
            mentioned_tools = {tool for tool in CANONICAL_TOOL_SIDE_EFFECTS if tool in instructions}
            missing_capabilities = [
                capability
                for capability in case.requirement.capabilities
                if capability not in instructions
            ]
            missing_tools = sorted(expected_tools - mentioned_tools)
            extra_tools = sorted(mentioned_tools - expected_tools)
            has_check = any(word in instructions.lower() for word in _CHECK_LANGUAGE)
            results.append(
                {
                    "case": case.key,
                    "missing_capabilities": missing_capabilities,
                    "missing_tools": missing_tools,
                    "extra_tools": extra_tools,
                    "has_check_or_uncertainty": has_check,
                    "passed": not missing_capabilities
                    and not missing_tools
                    and not extra_tools
                    and has_check,
                }
            )
    finally:
        await client.close()

    summary = {
        "passed": sum(1 for result in results if result["passed"]),
        "total": len(results),
        "cases": results,
    }
    print(json.dumps(summary, indent=2))  # noqa: T201 -- the score is the output
    assert len(results) == len(INSTRUCTION_CASES)

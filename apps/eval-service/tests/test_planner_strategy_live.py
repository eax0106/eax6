"""Planner golden set v2 strategy cases, live, against Phase 4.1's 0.90 floor.

Task 4.1's done gate is the planner golden set scoring at least 0.90 on this
repository's own stack. This is that measurement as a check: the real
eval-service PlannerClient, a running intelligence-service, and whatever
Model Gateway that service is pointed at, so a pass is evidence about the path
a run takes rather than about a stub.

A strategy answer carrying "(keyword fallback" means the model call failed and
the keyword heuristic answered instead. The heuristic alone scores 17/36 --
a plausible number that reads as a weak model rather than as an outage -- so
any fallback fails this check on its own, before the score is looked at.

Runs only when PLANNER_STRATEGY_LIVE_BASE_URL names a running
intelligence-service. INTERNAL_SERVICE_TOKEN is sent as the service
credential when set.
"""

import os

import pytest

from src.db.planner_golden_set_v2 import PLANNER_CASES_V2
from src.execution.planner_client import PlannerClient

pytestmark = pytest.mark.skipif(
    not os.environ.get("PLANNER_STRATEGY_LIVE_BASE_URL"),
    reason="needs a running intelligence-service (set PLANNER_STRATEGY_LIVE_BASE_URL)",
)

FLOOR = 0.90
TENANT_ID = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
RUN_ID = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
FALLBACK_MARKER = "(keyword fallback"

STRATEGY_CASES = [
    case for case in PLANNER_CASES_V2 if case.input_json.get("operation") == "select_strategy"
]


def test_strategy_cases_clear_the_phase_4_floor_without_fallback() -> None:
    client = PlannerClient(
        os.environ["PLANNER_STRATEGY_LIVE_BASE_URL"],
        timeout_seconds=120.0,
        service_token=os.environ.get("INTERNAL_SERVICE_TOKEN", ""),
    )
    misses: list[str] = []
    fallbacks: list[str] = []
    for case in STRATEGY_CASES:
        result = client.select_strategy(
            tenant_id=TENANT_ID,
            run_id=RUN_ID,
            objective=str(case.input_json["objective"]),
            mode=str(case.input_json["mode"]),
        )
        tag = case.tags[-1]
        if FALLBACK_MARKER in result.reason:
            fallbacks.append(tag)
        if result.strategy != case.expected_json["strategy"]:
            misses.append(
                f"{tag}: expected {case.expected_json['strategy']}, got {result.strategy}"
            )

    passed = len(STRATEGY_CASES) - len(misses)
    score = passed / len(STRATEGY_CASES)
    print(
        f"planner strategy v2 live: {passed}/{len(STRATEGY_CASES)} ({score:.3f}), "
        f"fallbacks={len(fallbacks)}"
    )
    for miss in misses:
        print(f"  miss {miss}")

    assert not fallbacks, f"model classification fell back to keywords for: {fallbacks}"
    assert score >= FLOOR, f"{passed}/{len(STRATEGY_CASES)} is below the {FLOOR} floor"

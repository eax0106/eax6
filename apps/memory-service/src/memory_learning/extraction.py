from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable

from pydantic import ValidationError

from src.memory_settings.redaction import MemoryRedactionUnavailableError

from .ids import new_prefixed_uuid7, raw_uuid7
from .models import (
    MemoryScope,
    ProposeWritebackRequest,
    ProposeWritebackResponse,
    RunLearningSummary,
    StrictModel,
)
from .orchestration_client import OrchestrationRunClient
from .repository import MemoryCandidateRepository


class MemoryLearningValidationError(ValueError):
    pass


class RedactedCandidate(StrictModel):
    content: dict[str, object]
    namespace: str
    source_summary: str


class MemoryLearningKernel:
    def __init__(
        self,
        orchestration: OrchestrationRunClient,
        repository: MemoryCandidateRepository,
        redact: Callable[[str, str], Awaitable[str]] | None = None,
    ) -> None:
        self._orchestration = orchestration
        self._repository = repository
        self._redact = redact

    async def propose_writeback(
        self,
        request: ProposeWritebackRequest,
        authorization: str,
    ) -> ProposeWritebackResponse:
        if (
            not authorization.startswith("Bearer ")
            or not authorization.removeprefix("Bearer ").strip()
        ):
            raise MemoryLearningValidationError("valid bearer authorization is required")

        summary = await self._orchestration.load_summary(
            tenant_id=request.tenant_id,
            run_id=request.run_id,
        )
        if summary.tenant_id != request.tenant_id:
            raise MemoryLearningValidationError(
                "authenticated orchestration tenant does not match request tenant_id"
            )
        if summary.run_id != request.run_id:
            raise MemoryLearningValidationError(
                "orchestration summary run_id does not match request"
            )
        if summary.workspace_id != request.workspace_id:
            raise MemoryLearningValidationError("run does not belong to requested workspace")

        if not await asyncio.to_thread(
            self._repository.workflow_enabled, request.tenant_id, request.workspace_id
        ):
            return ProposeWritebackResponse(memory_id="", candidate_json="{}", skipped=True)

        scope = _scope_for(summary)
        content = _candidate_content(request, summary)
        source_summary = _source_summary(summary)
        if self._redact is None:
            raise MemoryRedactionUnavailableError("Memory redaction unavailable")
        redacted_json = await self._redact(
            request.tenant_id,
            RedactedCandidate(
                content=content, namespace=request.namespace, source_summary=source_summary
            ).model_dump_json(),
        )
        try:
            redacted = RedactedCandidate.model_validate_json(redacted_json)
        except ValidationError as error:
            raise MemoryRedactionUnavailableError("Memory redaction unavailable") from error
        stored = await asyncio.to_thread(
            self._repository.propose,
            memory_id=new_prefixed_uuid7("mem"),
            tenant_uuid=raw_uuid7(request.tenant_id, "ten"),
            run_id=request.run_id,
            scope=scope,
            content=redacted.content,
            provenance={
                "run_id": request.run_id,
                "workspace_id": request.workspace_id,
                "verified_output_artifact_id": request.verified_output_artifact_id,
                "namespace": redacted.namespace,
                "source_summary": redacted.source_summary,
            },
        )
        return ProposeWritebackResponse(
            memory_id=stored.memory_id,
            skipped=stored.skipped,
            candidate_json=json.dumps(
                stored.content,
                sort_keys=True,
                separators=(",", ":"),
            ),
        )


def _scope_for(summary: RunLearningSummary) -> MemoryScope:
    if any(action.failure_class == "safety_violation" for action in summary.recovery_actions):
        return "safety_pattern"
    # Global scope is deliberately reserved for KNOW-15's anonymized promotion path.
    if summary.verdict in {"completed_verified", "rescued"}:
        return "project"
    return "failure"


def _candidate_content(
    request: ProposeWritebackRequest,
    summary: RunLearningSummary,
) -> dict[str, object]:
    failed_nodes = [
        {
            "node_execution_id": node.node_execution_id,
            "node_key": node.node_key,
            "node_type": node.node_type,
            "status": node.status,
            "attempt": node.attempt,
            "error_code": node.error_code,
        }
        for node in summary.nodes
        if node.status in {"failed", "blocked_pending_recovery"}
    ]
    nodes = [
        {
            "node_execution_id": node.node_execution_id,
            "node_key": node.node_key,
            "node_type": node.node_type,
            "status": node.status,
            "attempt": node.attempt,
            "input_ref": node.input_ref,
            "output_ref": node.output_ref,
        }
        for node in summary.nodes
    ]
    recovery_actions = [
        {
            "node_execution_id": action.node_execution_id,
            "failure_class": action.failure_class,
            "strategy": action.strategy,
            "outcome": action.outcome,
        }
        for action in summary.recovery_actions
    ]
    return {
        "namespace": request.namespace,
        "final_verdict": summary.verdict,
        "gates": {
            "passed": summary.gates_passed,
            "failed": summary.gates_failed,
        },
        "recovery_count": summary.recovery_count,
        "nodes": nodes,
        "failed_nodes": failed_nodes,
        "recovery_actions": recovery_actions,
    }


def _source_summary(summary: RunLearningSummary) -> str:
    failed = sum(node.status in {"failed", "blocked_pending_recovery"} for node in summary.nodes)
    strategies = sorted({action.strategy for action in summary.recovery_actions})
    strategy_text = ",".join(strategies) if strategies else "none"
    return (
        f"verdict={summary.verdict}; failed_nodes={failed}; "
        f"recovery_count={summary.recovery_count}; strategies={strategy_text}"
    )

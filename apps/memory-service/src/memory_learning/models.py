from __future__ import annotations

import re
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_UUID_V7_BODY = r"[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"

_TENANT_ID_RE = re.compile(rf"^ten_{_UUID_V7_BODY}$", re.IGNORECASE)
_WORKSPACE_ID_RE = re.compile(rf"^ws_{_UUID_V7_BODY}$", re.IGNORECASE)
_RUN_ID_RE = re.compile(rf"^run_{_UUID_V7_BODY}$", re.IGNORECASE)
_ARTIFACT_ID_RE = re.compile(rf"^art_{_UUID_V7_BODY}$", re.IGNORECASE)
_MEMORY_ID_RE = re.compile(rf"^mem_{_UUID_V7_BODY}$", re.IGNORECASE)

RunVerdict = Literal[
    "completed_verified",
    "rescued",
    "escalated",
    "failed",
    "abandoned",
    "degraded",
]
MemoryScope = Literal["failure", "project", "safety_pattern"]


def _validate_pattern(pattern: re.Pattern[str], value: str, field: str) -> str:
    if not pattern.fullmatch(value):
        raise ValueError(f"{field} must match {pattern.pattern}")
    return value


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ProposeWritebackRequest(StrictModel):
    """HTTP mirror of alter.memory.v1.ProposeWritebackRequest."""

    tenant_id: str
    workspace_id: str
    run_id: str
    verified_output_artifact_id: str
    namespace: str = Field(min_length=1)

    @field_validator("tenant_id")
    @classmethod
    def _tenant_id(cls, value: str) -> str:
        return _validate_pattern(_TENANT_ID_RE, value, "tenant_id")

    @field_validator("workspace_id")
    @classmethod
    def _workspace_id(cls, value: str) -> str:
        return _validate_pattern(_WORKSPACE_ID_RE, value, "workspace_id")

    @field_validator("run_id")
    @classmethod
    def _run_id(cls, value: str) -> str:
        return _validate_pattern(_RUN_ID_RE, value, "run_id")

    @field_validator("verified_output_artifact_id")
    @classmethod
    def _artifact_id(cls, value: str) -> str:
        return _validate_pattern(_ARTIFACT_ID_RE, value, "verified_output_artifact_id")

    @field_validator("namespace")
    @classmethod
    def _namespace(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("namespace must not be blank")
        return value


class ProposeWritebackResponse(StrictModel):
    """HTTP mirror of alter.memory.v1.ProposeWritebackResponse."""

    memory_id: str
    candidate_json: str
    skipped: bool = False

    @model_validator(mode="after")
    def identity(self) -> Self:
        if self.skipped:
            if self.memory_id or self.candidate_json != "{}":
                raise ValueError("Skipped memory cannot return stored content")
        else:
            _validate_pattern(_MEMORY_ID_RE, self.memory_id, "memory_id")
        return self


class RunNodeSummary(StrictModel):
    node_execution_id: str
    node_key: str
    node_type: str
    status: str
    attempt: int = Field(ge=1)
    input_ref: str | None
    output_ref: str | None
    error_code: str | None


class RunRecoverySummary(StrictModel):
    node_execution_id: str | None
    failure_class: str
    strategy: str
    outcome: str | None


class RunLearningSummary(StrictModel):
    tenant_id: str
    run_id: str
    workspace_id: str
    verdict: RunVerdict
    gates_passed: int = Field(ge=0)
    gates_failed: int = Field(ge=0)
    recovery_count: int = Field(ge=0)
    nodes: tuple[RunNodeSummary, ...]
    recovery_actions: tuple[RunRecoverySummary, ...]

    @field_validator("tenant_id")
    @classmethod
    def _tenant_id(cls, value: str) -> str:
        return _validate_pattern(_TENANT_ID_RE, value, "tenant_id")

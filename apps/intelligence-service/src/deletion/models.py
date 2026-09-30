from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class SubjectDataLocation(StrictModel):
    store: str
    table: str
    rowCount: int
    objectReferences: tuple[str, ...] = ()


class DeletionResult(StrictModel):
    store: str
    manifestId: str
    deletedRows: int
    deletedObjects: int


class VerificationResult(StrictModel):
    store: str
    manifestId: str
    deleted: bool
    remaining: tuple[SubjectDataLocation, ...]


class RetentionSweepResult(StrictModel):
    store: str
    deletedRows: int
    deletedObjects: int
    sweptAt: str


class ReplayResult(StrictModel):
    store: str
    ledgerEntriesReplayed: int
    deletedRows: int
    deletedObjects: int


class DeleteRequest(StrictModel):
    tenantId: str
    manifestId: str


class VerifyRequest(DeleteRequest):
    pass


class ProblemDetails(StrictModel):
    type: str
    title: str = Field(min_length=1)
    status: int = Field(ge=100, le=599)
    detail: str = Field(min_length=1)
    instance: str = Field(pattern=r"^/")
    error_code: str = Field(pattern=r"^[A-Z][A-Z0-9_]*$")
    trace_id: str = Field(pattern=r"^trc_[0-9a-f-]{36}$")
    request_id: str = Field(pattern=r"^req_[0-9a-f-]{36}$")
    retryable: bool
    field_errors: tuple[object, ...] = ()
    documentation_key: str = Field(pattern=r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$")

"""Alter-authored starter workflow templates (design log §19, decision D18).

Each template is a TaskSkeleton the Graph Compiler compiles as it stands, plus
what a workspace needs before it can run (requirements) and the cases it must
pass in Simulate (test_cases). They live in capability_registry_templates,
owned by the platform tenant only; no tenant's workflow is ever stored as one.

Two placeholders stand in for what only the instantiating workspace knows, and
the engine replaces them when it instantiates a template:
  "$alter:credential:<integration>"  a ToolCall credential_ref for a
      platform-wide or run-scoped integration (email-send, web-search,
      knowledge-search, whatsapp-send);
  "$alter:connection:<connector>"    the id of the workspace's connected
      connection of that connector type (a database.* databaseId).
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

TemplateId = Annotated[str, StringConstraints(pattern=r"^[a-z][a-z0-9-]{2,63}$", strict=True)]
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=600)]
Criterion = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=400)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class TemplateRequirement(StrictModel):
    kind: Literal["connection", "documents", "whatsapp_account", "trigger", "setting"]
    connector_type: str | None = None
    purpose: Text


class TemplateTestCase(StrictModel):
    name: Text
    input: dict[str, Any]
    success_criteria: list[Criterion] = Field(min_length=1, max_length=20)


class TemplateDefinition(StrictModel):
    template_id: TemplateId
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    summary: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=400)]
    requirements: list[TemplateRequirement] = Field(max_length=10)
    skeleton: dict[str, Any]
    test_cases: list[TemplateTestCase] = Field(min_length=2, max_length=10)


class TemplateSummary(StrictModel):
    template_id: TemplateId
    version: int = Field(gt=0)
    title: str
    summary: str
    requirements: list[TemplateRequirement]


class TemplateRecord(TemplateSummary):
    skeleton: dict[str, Any]
    test_cases: list[TemplateTestCase]
    content_sha256: str


class TemplateNotFoundError(LookupError):
    pass


_COLUMNS = "template_id, version, title, summary, definition, content_sha256"


class TemplateRepository:
    """Reads the active version of each template; templates are global, so no
    tenant context narrows what is visible."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def list_active(self) -> list[TemplateSummary]:
        result = await self._session.execute(
            text(
                f"SELECT {_COLUMNS} FROM capability_registry_templates "
                "WHERE status = 'active' ORDER BY template_id LIMIT 100"
            )
        )
        return [
            TemplateSummary(**_record(row).model_dump(include=set(TemplateSummary.model_fields)))
            for row in result.mappings()
        ]

    async def get_active(self, template_id: str) -> TemplateRecord:
        result = await self._session.execute(
            text(
                f"SELECT {_COLUMNS} FROM capability_registry_templates "
                "WHERE status = 'active' AND template_id = :template_id"
            ),
            {"template_id": template_id},
        )
        row = result.mappings().first()
        if row is None:
            raise TemplateNotFoundError("template not found")
        return _record(row)


def _record(row: RowMapping) -> TemplateRecord:
    definition = TemplateDefinition.model_validate(row["definition"])
    return TemplateRecord(
        template_id=row["template_id"],
        version=row["version"],
        title=row["title"],
        summary=row["summary"],
        requirements=definition.requirements,
        skeleton=definition.skeleton,
        test_cases=definition.test_cases,
        content_sha256=row["content_sha256"],
    )

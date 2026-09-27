"""Real-Postgres coverage for PLAN-8 agent auto-creation."""

import asyncio
import json
import uuid
from collections.abc import AsyncGenerator, Generator, Sequence
from pathlib import Path

import pytest
from alembic.config import Config as AlembicConfig
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.agent_auto_creation import (
    AgentAutoCreationEngine,
    AgentInstructionsClient,
    CreatePersonaRequest,
    CreatePersonaResponse,
    PersonaCreationValidationError,
)
from src.capability_resolver import NodeRequirement, NodeRequirements, ToolRequirement
from src.db.ids import new_prefixed_id
from src.selection_binding import (
    BindAgentModelToolRequest,
    BindAgentModelToolResponse,
    BindingContext,
    EmbeddingResult,
    EmbeddingResultError,
    NoAgentMatch,
    SelectionBindingEngine,
)

SERVICE_ROOT = Path(__file__).parent.parent
PGVECTOR_IMAGE = "pgvector/pgvector:pg16"

# Model id the FakeEmbeddingClient reports; stored embedding_metadata carries
# it so the provenance filter admits freshly-created rows.
TEST_MODEL_ID = "test-embedding-v1"

TENANT_A = "ten_018f47a5-7b2c-7d10-8f11-123456789abc"
TENANT_B = "ten_028f47a5-7b2c-7d10-8f11-123456789abc"
WORKSPACE_A = "ws_018f47a5-7b2c-7d10-8f11-123456789abc"
RUN_ID = "run_018f47a5-7b2c-7d10-8f11-123456789abc"


class FakeEmbeddingClient:
    def __init__(
        self,
        vector: Sequence[float],
        *,
        model_id: str = TEST_MODEL_ID,
    ) -> None:
        self.vector = vector
        self.model_id = model_id
        self.calls: list[tuple[str, str]] = []

    async def embed(self, *, tenant_id: str, text: str) -> EmbeddingResult:
        self.calls.append((tenant_id, text))
        return EmbeddingResult(vector=self.vector, model_id=self.model_id)


class FakeInstructionsClient(AgentInstructionsClient):
    def __init__(self, instructions: Sequence[str]) -> None:
        self.instructions = list(instructions)
        self.calls: list[tuple[str, str, str, NodeRequirement]] = []

    async def draft_instructions(
        self,
        *,
        tenant_id: str,
        run_id: str,
        node_key: str,
        requirement: NodeRequirement,
    ) -> str:
        self.calls.append((tenant_id, run_id, node_key, requirement))
        return self.instructions.pop(0)


def vector(first: float, second: float = 0.0) -> list[float]:
    return [first, second, *([0.0] * 510)]


@pytest.fixture(scope="module")
def postgres_url() -> Generator[str, None, None]:
    with PostgresContainer(
        image=PGVECTOR_IMAGE,
        dbname="intelligence_db",
        username="intelligence_service",
        password="testpass",
    ) as postgres:
        sync_url = postgres.get_connection_url()
        alembic_config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        alembic_config.set_main_option(
            "script_location",
            str(SERVICE_ROOT / "alembic"),
        )
        alembic_config.set_main_option("sqlalchemy.url", sync_url)
        command.upgrade(alembic_config, "head")
        yield sync_url


@pytest.fixture
async def db_session(postgres_url: str) -> AsyncGenerator[AsyncSession, None]:
    async_url = make_url(postgres_url).set(drivername="postgresql+asyncpg")
    engine = create_async_engine(async_url)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
        await session.rollback()
    await engine.dispose()


def create_request(
    requirement: NodeRequirement,
    *,
    tenant_id: str = TENANT_A,
) -> CreatePersonaRequest:
    return CreatePersonaRequest(
        tenant_id=tenant_id,
        workspace_id=WORKSPACE_A,
        capability_profile_json=requirement.model_dump_json(exclude_none=True),
    )


def binding_request(
    requirement: NodeRequirement,
    *,
    tenant_id: str = TENANT_A,
) -> BindAgentModelToolRequest:
    requirements = NodeRequirements(root={"node.one": requirement})
    return BindAgentModelToolRequest(
        tenant_id=tenant_id,
        run_id=RUN_ID,
        node_key="node.one",
        node_requirements_json=requirements.model_dump_json(exclude_none=True),
    )


def binding_context() -> BindingContext:
    return BindingContext(
        workspace_id=WORKSPACE_A,
        node_type="LLMTask",
        task_category="analysis",
    )


def true_no_match() -> NoAgentMatch:
    return NoAgentMatch(node_key="node.one", reason="no_eligible_agent")


async def table_counts(session: AsyncSession) -> tuple[int, int, int]:
    result = await session.execute(
        text(
            """
SELECT
  (SELECT count(*) FROM agents),
  (SELECT count(*) FROM agent_versions),
  (SELECT count(*) FROM capability_embeddings)
"""
        )
    )
    row = result.one()
    return int(row[0]), int(row[1]), int(row[2])


class TestCreatePersonaContract:
    def test_response_matches_locked_proto_fields(self) -> None:
        agent_id = new_prefixed_id("agt", now_ms=1_700_000_000_000)
        response = CreatePersonaResponse(
            agent_id=agent_id,
            agent_version=1,
            persona_json='{"tier":"STANDARD"}',
        )

        assert response.model_dump() == {
            "agent_id": agent_id,
            "agent_version": 1,
            "persona_json": '{"tier":"STANDARD"}',
        }

    def test_contract_models_reject_extra_fields(self) -> None:
        with pytest.raises(ValidationError):
            CreatePersonaRequest.model_validate(
                {
                    **create_request(NodeRequirement(capabilities=["analysis"])).model_dump(),
                    "invented": True,
                }
            )

    def test_generated_ids_are_uuidv7(self) -> None:
        timestamp_ms = 1_700_000_000_000

        generated = new_prefixed_id("agt", now_ms=timestamp_ms)
        parsed = uuid.UUID(generated.removeprefix("agt_"))

        assert parsed.version == 7
        assert parsed.variant == uuid.RFC_4122
        assert int.from_bytes(parsed.bytes[0:6], byteorder="big") == timestamp_ms

    @pytest.mark.parametrize("invalid_timestamp", [-1, 0x1_0000_0000_0000])
    def test_uuidv7_rejects_timestamp_outside_48_bits(
        self,
        invalid_timestamp: int,
    ) -> None:
        with pytest.raises(ValueError, match="48-bit"):
            new_prefixed_id("agt", now_ms=invalid_timestamp)


class TestAgentAutoCreationIntegration:
    async def test_persists_model_drafted_instructions_on_agent_and_version(
        self,
        db_session: AsyncSession,
    ) -> None:
        requirement = NodeRequirement(
            capabilities=["analysis.reasoning", "document.synthesis"],
            model_alias="STANDARD",
        )
        drafted = (
            "You are an analysis.reasoning and document.synthesis specialist. "
            "Work only from supplied context, check every conclusion, and state uncertainty."
        )
        instructions_client = FakeInstructionsClient([drafted])
        engine = AgentAutoCreationEngine(
            db_session,
            FakeEmbeddingClient(vector(1.0)),
            instructions_client=instructions_client,
        )

        outcome = await engine.create_for_no_match(
            true_no_match(), create_request(requirement), run_id=RUN_ID
        )

        assert isinstance(outcome, CreatePersonaResponse)
        stored = (
            (
                await db_session.execute(
                    text(
                        """
SELECT a.persona_description, av.persona_description AS version_instructions
FROM agents AS a
JOIN agent_versions AS av ON av.agent_id = a.id AND av.tenant_id = a.tenant_id
WHERE a.id = :agent_id
"""
                    ),
                    {"agent_id": outcome.agent_id},
                )
            )
            .mappings()
            .one()
        )
        assert stored["persona_description"] == drafted
        assert stored["version_instructions"] == drafted
        assert json.loads(outcome.persona_json)["persona_description"] == drafted
        assert instructions_client.calls == [(TENANT_A, RUN_ID, "node.one", requirement)]

    async def test_conflict_returns_the_winners_drafted_instructions(
        self,
        db_session: AsyncSession,
    ) -> None:
        requirement = NodeRequirement(capabilities=["analysis.reasoning"])
        instructions_client = FakeInstructionsClient(
            ["Winner instructions.", "Losing caller instructions."]
        )
        engine = AgentAutoCreationEngine(
            db_session,
            FakeEmbeddingClient(vector(1.0)),
            instructions_client=instructions_client,
        )

        first = await engine.create_for_no_match(
            true_no_match(), create_request(requirement), run_id=RUN_ID
        )
        second = await engine.create_for_no_match(
            true_no_match(), create_request(requirement), run_id=RUN_ID
        )

        assert isinstance(first, CreatePersonaResponse)
        assert isinstance(second, CreatePersonaResponse)
        assert json.loads(first.persona_json)["persona_description"] == ("Winner instructions.")
        assert json.loads(second.persona_json)["persona_description"] == ("Winner instructions.")

    @pytest.mark.parametrize(
        "reason",
        ["agent_not_required", "preferred_agent_unavailable"],
    )
    async def test_non_trigger_reasons_return_unchanged_without_side_effects(
        self,
        db_session: AsyncSession,
        reason: str,
    ) -> None:
        no_match = NoAgentMatch.model_validate({"node_key": "node.one", "reason": reason})
        embedding_client = FakeEmbeddingClient(vector(1.0))
        engine = AgentAutoCreationEngine(db_session, embedding_client)
        request = CreatePersonaRequest(
            tenant_id=TENANT_A,
            workspace_id=WORKSPACE_A,
            capability_profile_json="not-json",
        )

        outcome = await engine.create_for_no_match(no_match, request)

        assert outcome is no_match
        assert embedding_client.calls == []
        assert await table_counts(db_session) == (0, 0, 0)

    async def test_creates_the_persona_at_the_requested_tier(
        self,
        db_session: AsyncSession,
    ) -> None:
        # This test used to assert tier == "STANDARD" beside model_alias ==
        # "CEILING" -- it recorded #125's defect rather than catching it. The
        # agent row is what selection-binding filters on, so a STANDARD row for
        # an ADVANCED requirement fails the filter that caused the no-match.
        requirement = NodeRequirement(
            capabilities=["analysis.reasoning", "document.synthesis"],
            model_alias="ADVANCED",
            tools=[ToolRequirement(name="search.web", permissions=["web:read"])],
            maximum_input_bytes=4096,
        )
        embedding_client = FakeEmbeddingClient(vector(1.0))
        engine = AgentAutoCreationEngine(db_session, embedding_client)

        outcome = await engine.create_for_no_match(
            true_no_match(),
            create_request(requirement),
        )

        assert isinstance(outcome, CreatePersonaResponse)
        assert outcome.agent_version == 1
        assert uuid.UUID(outcome.agent_id.removeprefix("agt_")).version == 7
        assert embedding_client.calls == [(TENANT_A, "analysis.reasoning\ndocument.synthesis")]

        result = await db_session.execute(
            text(
                """
SELECT
  a.tenant_id::text AS agent_tenant_id,
  a.workspace_id::text AS workspace_id,
  a.name,
  a.tier,
  a.status,
  a.persona_description,
  av.id AS version_id,
  av.tenant_id::text AS version_tenant_id,
  av.version_number,
  av.capabilities,
  av.model_alias,
  av.tools,
  av.persona_description AS version_persona_description,
  av.published_at IS NOT NULL AS is_published,
  ce.id AS embedding_id,
  ce.tenant_id::text AS embedding_tenant_id,
  ce.capability_description,
  ce.embedding_metadata,
  1.0 - (ce.embedding <=> CAST(:expected_embedding AS vector(512))) AS similarity
FROM agents AS a
JOIN agent_versions AS av
  ON av.tenant_id = a.tenant_id AND av.agent_id = a.id
JOIN capability_embeddings AS ce
  ON ce.tenant_id = a.tenant_id AND ce.agent_id = a.id
WHERE a.id = :agent_id
"""
            ),
            {
                "agent_id": outcome.agent_id,
                "expected_embedding": _vector_literal(vector(1.0)),
            },
        )
        row = result.mappings().one()

        assert row["agent_tenant_id"] == TENANT_A.removeprefix("ten_")
        assert row["version_tenant_id"] == TENANT_A.removeprefix("ten_")
        assert row["embedding_tenant_id"] == TENANT_A.removeprefix("ten_")
        assert row["workspace_id"] == WORKSPACE_A.removeprefix("ws_")
        assert row["name"] == "Capability agent: analysis.reasoning"
        assert row["tier"] == "ADVANCED"
        assert row["status"] == "draft"
        assert row["persona_description"] == (
            "Specialist agent for capabilities: analysis.reasoning, document.synthesis."
        )
        assert uuid.UUID(str(row["version_id"]).removeprefix("agtv_")).version == 7
        assert uuid.UUID(str(row["embedding_id"]).removeprefix("cemb_")).version == 7
        assert row["version_number"] == 1
        assert row["is_published"] is True
        assert row["capabilities"] == ["analysis.reasoning", "document.synthesis"]
        assert row["model_alias"] == "ADVANCED"
        assert row["tools"] == [{"name": "search.web", "permissions": ["web:read"]}]
        assert row["version_persona_description"] == row["persona_description"]
        assert row["capability_description"] == row["persona_description"]
        assert row["embedding_metadata"] == {
            "dimensions": 512,
            "source": "PLAN-8",
            "model_id": TEST_MODEL_ID,
        }
        assert float(row["similarity"]) == pytest.approx(1.0)
        assert json.loads(outcome.persona_json) == {
            "capability_profile": requirement.model_dump(exclude_none=True),
            "persona_description": row["persona_description"],
            "tier": "ADVANCED",
        }

    async def test_declines_a_tier_above_the_configured_ceiling(
        self,
        db_session: AsyncSession,
    ) -> None:
        # The cost hole the tier fix would otherwise open: no cheaper tier
        # satisfies a >= filter, so "create at the requested tier" would let any
        # caller mint the most expensive tier in the system by asking for it.
        requirement = NodeRequirement(
            capabilities=["legal.contract.redline"],
            model_alias="CEILING",
        )
        embedding_client = FakeEmbeddingClient(vector(1.0))
        engine = AgentAutoCreationEngine(db_session, embedding_client)

        outcome = await engine.create_for_no_match(true_no_match(), create_request(requirement))

        assert isinstance(outcome, NoAgentMatch)
        assert outcome.reason == "no_agent_at_required_tier"
        assert await table_counts(db_session) == (0, 0, 0)
        # Declined before spending an embedding call, not after.
        assert embedding_client.calls == []

    async def test_mints_the_top_tier_when_the_ceiling_allows_it(
        self,
        db_session: AsyncSession,
    ) -> None:
        requirement = NodeRequirement(
            capabilities=["legal.contract.redline"],
            model_alias="CEILING",
        )
        engine = AgentAutoCreationEngine(
            db_session, FakeEmbeddingClient(vector(1.0)), maximum_tier="CEILING"
        )

        outcome = await engine.create_for_no_match(true_no_match(), create_request(requirement))

        assert isinstance(outcome, CreatePersonaResponse)
        tier = await db_session.scalar(
            text("SELECT tier FROM agents WHERE id = :agent_id"),
            {"agent_id": outcome.agent_id},
        )
        assert tier == "CEILING"

    async def test_rejects_a_ceiling_that_is_not_a_tier(self) -> None:
        with pytest.raises(ValueError, match="maximum_tier"):
            AgentAutoCreationEngine(
                None,  # type: ignore[arg-type]
                FakeEmbeddingClient(vector(1.0)),
                maximum_tier="ULTRA",
            )

    async def test_a_repeated_capability_set_binds_the_first_agent_again(
        self,
        db_session: AsyncSession,
    ) -> None:
        # #125's unbounded growth: three inserts per call, unconditionally.
        # Fixing the tier converges the *sequential* case through selection --
        # the agent now passes the filter that caused the no-match -- but two
        # concurrent callers still both see no candidate. This engine is the
        # last line, so it is asserted here directly, with no selection in
        # between: a second create for the same capability set writes nothing
        # and binds what the first one made.
        requirement = NodeRequirement(
            capabilities=["document.synthesis", "analysis.reasoning"],
            model_alias="STANDARD",
        )
        engine = AgentAutoCreationEngine(db_session, FakeEmbeddingClient(vector(1.0)))

        first = await engine.create_for_no_match(true_no_match(), create_request(requirement))
        counts_after_first = await table_counts(db_session)
        second = await engine.create_for_no_match(true_no_match(), create_request(requirement))

        assert isinstance(first, CreatePersonaResponse)
        assert isinstance(second, CreatePersonaResponse)
        assert second.agent_id == first.agent_id
        assert second.agent_version == first.agent_version
        assert counts_after_first == (1, 1, 1)
        assert await table_counts(db_session) == (1, 1, 1)

    async def test_the_key_ignores_capability_order(
        self,
        db_session: AsyncSession,
    ) -> None:
        # The resolver builds the capability list from rule order, so the same
        # need can arrive spelled two ways. Sorting before hashing is what stops
        # that being two agents.
        engine = AgentAutoCreationEngine(db_session, FakeEmbeddingClient(vector(1.0)))
        forwards = NodeRequirement(capabilities=["a.one", "b.two"], model_alias="FAST")
        backwards = NodeRequirement(capabilities=["b.two", "a.one"], model_alias="FAST")

        first = await engine.create_for_no_match(true_no_match(), create_request(forwards))
        second = await engine.create_for_no_match(true_no_match(), create_request(backwards))

        assert isinstance(first, CreatePersonaResponse)
        assert isinstance(second, CreatePersonaResponse)
        assert second.agent_id == first.agent_id
        assert await table_counts(db_session) == (1, 1, 1)

    async def test_a_different_workspace_gets_its_own_agent(
        self,
        db_session: AsyncSession,
    ) -> None:
        # The key is scoped to the workspace, not to the tenant: two workspaces
        # needing the same capability each get their own agent.
        requirement = NodeRequirement(capabilities=["a.one"], model_alias="FAST")
        engine = AgentAutoCreationEngine(db_session, FakeEmbeddingClient(vector(1.0)))
        other_workspace = CreatePersonaRequest(
            tenant_id=TENANT_A,
            workspace_id="ws_028f47a5-7b2c-7d10-8f11-123456789abc",
            capability_profile_json=requirement.model_dump_json(exclude_none=True),
        )

        first = await engine.create_for_no_match(true_no_match(), create_request(requirement))
        second = await engine.create_for_no_match(true_no_match(), other_workspace)

        assert isinstance(first, CreatePersonaResponse)
        assert isinstance(second, CreatePersonaResponse)
        assert second.agent_id != first.agent_id
        assert await table_counts(db_session) == (2, 2, 2)

    async def test_created_persona_is_immediately_bindable_by_plan7(
        self,
        db_session: AsyncSession,
    ) -> None:
        requirement = NodeRequirement(
            capabilities=["analysis.reasoning", "document.synthesis"],
            model_alias="STANDARD",
            tools=[ToolRequirement(name="search.web", permissions=["web:read"])],
        )
        embedding_client = FakeEmbeddingClient(vector(1.0))
        creation_engine = AgentAutoCreationEngine(db_session, embedding_client)
        created = await creation_engine.create_for_no_match(
            true_no_match(),
            create_request(requirement),
        )
        assert isinstance(created, CreatePersonaResponse)

        binding_engine = SelectionBindingEngine(db_session, embedding_client)
        bound = await binding_engine.bind(
            binding_request(requirement),
            binding_context(),
        )

        assert bound == BindAgentModelToolResponse(
            agent_id=created.agent_id,
            agent_version=1,
            model_alias="STANDARD",
            tool_names=["search.web"],
            # Read back from the created agent version by the ranked query: the
            # instructions LLMTask will send as the system message.
            instructions=(
                "Specialist agent for capabilities: analysis.reasoning, document.synthesis."
            ),
        )
        assert embedding_client.calls == [
            (TENANT_A, "analysis.reasoning\ndocument.synthesis"),
            (TENANT_A, "analysis.reasoning\ndocument.synthesis"),
        ]

    async def test_bind_auto_creates_and_returns_a_bindable_agent_on_no_match(
        self,
        db_session: AsyncSession,
    ) -> None:
        """The real router wiring: bind() itself triggers creation on a true
        no-match, in one call, rather than the caller having to invoke both
        engines separately (as test_created_persona_is_immediately_bindable_
        by_plan7 above exercises manually)."""
        requirement = NodeRequirement(
            capabilities=["analysis.reasoning", "document.synthesis"],
            model_alias="STANDARD",
            tools=[ToolRequirement(name="search.web", permissions=["web:read"])],
        )
        embedding_client = FakeEmbeddingClient(vector(1.0))
        creation_engine = AgentAutoCreationEngine(db_session, embedding_client)
        binding_engine = SelectionBindingEngine(
            db_session,
            embedding_client,
            persona_creation_engine=creation_engine,
        )

        before = await table_counts(db_session)
        outcome = await binding_engine.bind(
            binding_request(requirement),
            binding_context(),
        )
        after = await table_counts(db_session)

        assert isinstance(outcome, BindAgentModelToolResponse)
        assert outcome.model_alias == "STANDARD"
        assert outcome.tool_names == ["search.web"]
        assert outcome.agent_version == 1
        assert after == (before[0] + 1, before[1] + 1, before[2] + 1)

        rebound = await binding_engine.bind(
            binding_request(requirement),
            binding_context(),
        )
        assert rebound == outcome

    async def test_bind_without_persona_creation_engine_still_returns_no_match(
        self,
        db_session: AsyncSession,
    ) -> None:
        """Backward compatibility: omitting persona_creation_engine (the
        default) must not change existing no-match behavior."""
        requirement = NodeRequirement(capabilities=["analysis.reasoning"])
        embedding_client = FakeEmbeddingClient(vector(1.0))
        binding_engine = SelectionBindingEngine(db_session, embedding_client)

        before = await table_counts(db_session)
        outcome = await binding_engine.bind(
            binding_request(requirement),
            binding_context(),
        )
        after = await table_counts(db_session)

        assert outcome == true_no_match()
        assert after == before

    async def test_a_tier_gap_is_refused_rather_than_auto_created_around(
        self,
        db_session: AsyncSession,
    ) -> None:
        """#125's reproduce, as a regression test.

        An agent exists with the capability at STANDARD; the requirement asks
        for ADVANCED. The tier filter excludes it, so the ranked query finds
        nothing -- and auto-creation used to read that as "nobody has this
        capability" and mint another agent that failed the same filter, once
        per attempt, forever.

        The mock embedding returns the same vector for every text, so
        similarity cannot be what excludes the candidate here. The tier is the
        only discriminator, which is exactly how the issue was provoked.
        """
        embedding_client = FakeEmbeddingClient(vector(1.0))
        creation_engine = AgentAutoCreationEngine(db_session, embedding_client)
        binding_engine = SelectionBindingEngine(
            db_session,
            embedding_client,
            persona_creation_engine=creation_engine,
        )
        existing = await creation_engine.create_for_no_match(
            true_no_match(),
            create_request(
                NodeRequirement(capabilities=["analysis.reasoning"], model_alias="STANDARD")
            ),
        )
        assert isinstance(existing, CreatePersonaResponse)

        before = await table_counts(db_session)
        outcome = await binding_engine.bind(
            binding_request(
                NodeRequirement(capabilities=["analysis.reasoning"], model_alias="ADVANCED")
            ),
            binding_context(),
        )

        assert outcome == NoAgentMatch(node_key="node.one", reason="no_agent_at_required_tier")
        assert await table_counts(db_session) == before

    async def test_a_created_agent_satisfies_the_tier_that_created_it(
        self,
        db_session: AsyncSession,
    ) -> None:
        """The other half of #125: the loop closes.

        Binding an unmet ADVANCED requirement creates an agent, and binding the
        same requirement again returns that agent rather than creating a second
        one -- because it is now created at a tier that passes the filter which
        caused the no-match. Before the fix this wrote three rows per attempt.
        """
        requirement = NodeRequirement(
            capabilities=["legal.contract.redline"], model_alias="ADVANCED"
        )
        embedding_client = FakeEmbeddingClient(vector(1.0))
        binding_engine = SelectionBindingEngine(
            db_session,
            embedding_client,
            persona_creation_engine=AgentAutoCreationEngine(db_session, embedding_client),
        )

        first = await binding_engine.bind(binding_request(requirement), binding_context())
        after_first = await table_counts(db_session)
        second = await binding_engine.bind(binding_request(requirement), binding_context())

        assert isinstance(first, BindAgentModelToolResponse)
        assert first.model_alias == "ADVANCED"
        assert second == first
        assert await table_counts(db_session) == after_first

    async def test_created_agent_cannot_bind_for_another_tenant(
        self,
        db_session: AsyncSession,
    ) -> None:
        requirement = NodeRequirement(capabilities=["analysis.reasoning"])
        embedding_client = FakeEmbeddingClient(vector(1.0))
        creation_engine = AgentAutoCreationEngine(db_session, embedding_client)
        created = await creation_engine.create_for_no_match(
            true_no_match(),
            create_request(requirement),
        )
        assert isinstance(created, CreatePersonaResponse)

        binding_engine = SelectionBindingEngine(db_session, embedding_client)
        cross_tenant = await binding_engine.bind(
            binding_request(requirement, tenant_id=TENANT_B),
            binding_context(),
        )

        assert cross_tenant == NoAgentMatch(
            node_key="node.one",
            reason="no_eligible_agent",
        )

    @pytest.mark.parametrize(
        "requirement",
        [
            NodeRequirement(capabilities=[]),
            NodeRequirement(
                capabilities=["analysis.reasoning"],
                preferred_agent_id=("agt_018f47a5-7b2c-7d10-8f11-123456789abc"),
            ),
        ],
    )
    async def test_inconsistent_no_match_profile_fails_without_writes(
        self,
        db_session: AsyncSession,
        requirement: NodeRequirement,
    ) -> None:
        embedding_client = FakeEmbeddingClient(vector(1.0))
        engine = AgentAutoCreationEngine(db_session, embedding_client)

        with pytest.raises(PersonaCreationValidationError):
            await engine.create_for_no_match(
                true_no_match(),
                create_request(requirement),
            )

        assert embedding_client.calls == []
        assert await table_counts(db_session) == (0, 0, 0)

    async def test_invalid_capability_profile_fails_without_writes(
        self,
        db_session: AsyncSession,
    ) -> None:
        embedding_client = FakeEmbeddingClient(vector(1.0))
        engine = AgentAutoCreationEngine(db_session, embedding_client)
        request = CreatePersonaRequest(
            tenant_id=TENANT_A,
            workspace_id=WORKSPACE_A,
            capability_profile_json="not-json",
        )

        with pytest.raises(PersonaCreationValidationError, match="NodeRequirement"):
            await engine.create_for_no_match(true_no_match(), request)

        assert embedding_client.calls == []
        assert await table_counts(db_session) == (0, 0, 0)

    async def test_invalid_embedding_fails_before_database_writes(
        self,
        db_session: AsyncSession,
    ) -> None:
        engine = AgentAutoCreationEngine(db_session, FakeEmbeddingClient([1.0]))

        with pytest.raises(EmbeddingResultError):
            await engine.create_for_no_match(
                true_no_match(),
                create_request(NodeRequirement(capabilities=["analysis.reasoning"])),
            )

        assert await table_counts(db_session) == (0, 0, 0)

    async def test_three_identical_requests_create_one_agent(
        self,
        db_session: AsyncSession,
    ) -> None:
        """Reproduces the original defect (#125): three identical requests
        used to mint three different agents. Now they must collapse to one,
        and every repeat must return the same usable binding."""
        requirement = NodeRequirement(
            capabilities=["analysis.reasoning", "document.synthesis", "idem.serial"],
            model_alias="STANDARD",
            tools=[ToolRequirement(name="search.web", permissions=["web:read"])],
        )
        embedding_client = FakeEmbeddingClient(vector(1.0))
        engine = AgentAutoCreationEngine(db_session, embedding_client)

        before = await table_counts(db_session)
        outcomes = [
            await engine.create_for_no_match(
                true_no_match(),
                create_request(requirement),
            )
            for _ in range(3)
        ]
        after = await table_counts(db_session)

        assert all(isinstance(o, CreatePersonaResponse) for o in outcomes)
        agent_ids = {o.agent_id for o in outcomes if isinstance(o, CreatePersonaResponse)}
        assert len(agent_ids) == 1
        assert after == (before[0] + 1, before[1] + 1, before[2] + 1)

    async def test_two_concurrent_identical_requests_create_one_agent(
        self,
        postgres_url: str,
    ) -> None:
        """The race that matters: two genuinely concurrent callers for the
        same key must not both create. Both must receive a usable binding to
        the single agent that wins. Two independent sessions/connections are
        required -- sharing one session would serialize on the connection and
        test nothing."""
        requirement = NodeRequirement(
            capabilities=["analysis.reasoning", "document.synthesis", "idem.concurrent"],
            model_alias="STANDARD",
            tools=[ToolRequirement(name="search.web", permissions=["web:read"])],
        )
        async_url = make_url(postgres_url).set(drivername="postgresql+asyncpg")
        engine = create_async_engine(async_url)
        factory = async_sessionmaker(engine, expire_on_commit=False)

        async def create_one() -> CreatePersonaResponse | NoAgentMatch:
            async with factory() as session:
                embedding_client = FakeEmbeddingClient(vector(1.0))
                creation_engine = AgentAutoCreationEngine(session, embedding_client)
                outcome = await creation_engine.create_for_no_match(
                    true_no_match(),
                    create_request(requirement),
                )
                # Mirror the real router (selection_binding/router.py), which
                # commits the session after bind()/create_for_no_match.
                await session.commit()
                return outcome

        try:
            async with factory() as session:
                before = await table_counts(session)
            outcomes = await asyncio.gather(create_one(), create_one())
            async with factory() as session:
                after = await table_counts(session)

            assert all(isinstance(o, CreatePersonaResponse) for o in outcomes)
            agent_ids = {
                o.agent_id for o in outcomes if isinstance(o, CreatePersonaResponse)
            }
            assert len(agent_ids) == 1
            assert after == (before[0] + 1, before[1] + 1, before[2] + 1)

            # Both callers received a binding to the same, usable agent.
            async with factory() as session:
                bound = await SelectionBindingEngine(
                    session, FakeEmbeddingClient(vector(1.0))
                ).bind(
                    binding_request(requirement),
                    binding_context(),
                )
            assert isinstance(bound, BindAgentModelToolResponse)
            assert bound.agent_id in agent_ids
        finally:
            await engine.dispose()

    async def test_reordered_capabilities_hit_the_same_key(
        self,
        db_session: AsyncSession,
    ) -> None:
        """The same capability set in a different order must not create a
        second agent — the key is order-independent."""
        requirement_a = NodeRequirement(
            capabilities=["analysis.reasoning", "document.synthesis", "idem.reorder"],
        )
        requirement_b = NodeRequirement(
            capabilities=["document.synthesis", "idem.reorder", "analysis.reasoning"],
        )
        embedding_client = FakeEmbeddingClient(vector(1.0))
        engine = AgentAutoCreationEngine(db_session, embedding_client)

        before = await table_counts(db_session)
        first = await engine.create_for_no_match(
            true_no_match(),
            create_request(requirement_a),
        )
        second = await engine.create_for_no_match(
            true_no_match(),
            create_request(requirement_b),
        )
        after = await table_counts(db_session)

        assert isinstance(first, CreatePersonaResponse)
        assert isinstance(second, CreatePersonaResponse)
        assert second.agent_id == first.agent_id
        assert after == (before[0] + 1, before[1] + 1, before[2] + 1)

    async def test_different_capability_set_creates_a_second_agent(
        self,
        db_session: AsyncSession,
    ) -> None:
        """The constraint must not be too broad: a genuinely different
        capability set still creates its own agent."""
        embedding_client = FakeEmbeddingClient(vector(1.0))
        engine = AgentAutoCreationEngine(db_session, embedding_client)

        before = await table_counts(db_session)
        first = await engine.create_for_no_match(
            true_no_match(),
            create_request(NodeRequirement(capabilities=["idem.diff.one"])),
        )
        second = await engine.create_for_no_match(
            true_no_match(),
            create_request(NodeRequirement(capabilities=["idem.diff.two"])),
        )
        after = await table_counts(db_session)

        assert isinstance(first, CreatePersonaResponse)
        assert isinstance(second, CreatePersonaResponse)
        assert second.agent_id != first.agent_id
        assert after == (before[0] + 2, before[1] + 2, before[2] + 2)


def _vector_literal(values: Sequence[float]) -> str:
    return "[" + ",".join(str(float(value)) for value in values) + "]"

"""PLAN-8 agent persona creation after a genuine PLAN-7 no-match result."""

import hashlib
import json

from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent_auto_creation.instructions_client import AgentInstructionsClient
from src.agent_auto_creation.models import (
    CreatePersonaRequest,
    CreatePersonaResponse,
    PersonaCreationOutcome,
)
from src.capability_resolver import NodeRequirement
from src.db.ids import new_prefixed_id
from src.selection_binding import (
    EmbeddingClient,
    NoAgentMatch,
    embedding_vector_literal,
)

_SET_TENANT_CONTEXT = text("SELECT set_config('app.current_tenant_id', :tenant_id, true)")

# Created at the tier the requirement asked for, not at a fixed 'STANDARD'.
# selection_binding filters candidates on agents.tier with a >= comparison, so
# a STANDARD agent minted for an ADVANCED requirement failed the very filter
# that caused the no-match -- the next identical request was another no-match
# and another agent, without bound (#125). No cheaper tier can satisfy a >=
# filter, so the requested alias is the only tier that converges.
#
# ON CONFLICT DO NOTHING against the partial unique index added in 0006: two
# concurrent requests for the same capability set in the same workspace both
# see no candidate, and this is what makes the second insert a no-op rather
# than a duplicate. RETURNING yields no row in that case, which is the signal
# to read the winner back instead of writing a version and an embedding for an
# agent that was not created here.
_INSERT_AGENT = text(
    """
INSERT INTO agents
  (id, tenant_id, workspace_id, name, tier, persona_description, status,
   auto_creation_key)
VALUES
  (:agent_id, CAST(:tenant_id AS uuid), CAST(:workspace_id AS uuid),
   :name, :tier, :persona_description, 'draft', :auto_creation_key)
ON CONFLICT (tenant_id, workspace_id, auto_creation_key)
  WHERE auto_creation_key IS NOT NULL
  DO NOTHING
RETURNING id
"""
)

_SELECT_EXISTING_AGENT = text(
    """
SELECT
  a.id AS agent_id,
  a.tier AS tier,
  a.persona_description AS persona_description,
  (
    SELECT MAX(av.version_number)
    FROM agent_versions AS av
    WHERE av.tenant_id = a.tenant_id AND av.agent_id = a.id
  ) AS agent_version
FROM agents AS a
WHERE a.tenant_id = CAST(:tenant_id AS uuid)
  AND a.workspace_id = CAST(:workspace_id AS uuid)
  AND a.auto_creation_key = :auto_creation_key
"""
)

_TIER_RANK: dict[str, int] = {"FAST": 1, "STANDARD": 2, "ADVANCED": 3, "CEILING": 4}
_DEFAULT_TIER = "STANDARD"


def _auto_creation_key(requirement: NodeRequirement) -> str:
    """Stable identity for "an agent for this capability set".

    Capabilities are sorted, so the key does not depend on the order the
    resolver happened to emit them in. Tier is deliberately absent: creation
    only runs when nothing in the workspace has the capability at all, so a
    later request at a different tier is a tier gap against the agent created
    here, never a second capability gap. Tools are absent for the same reason
    they do not affect binding -- the bound tool names come from the
    requirement, not from the agent.
    """
    canonical = json.dumps(sorted(requirement.capabilities), separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# A freshly auto-created agent has never run for real -- it starts 'draft'
# (both selection_binding queries include drafts, so it can still be
# matched and accumulate real performance_records) and is promoted to
# 'active' only once performance.repository's promotion check sees enough
# real successes for it. This is the returned outcome's own binding for
# the request that triggered creation, so its status here has no effect on
# whether *this* request succeeds -- only on later requests.

_INSERT_AGENT_VERSION = text(
    """
INSERT INTO agent_versions
  (id, agent_id, tenant_id, version_number, capabilities, model_alias, tools,
   persona_description, published_at)
VALUES
  (:version_id, :agent_id, CAST(:tenant_id AS uuid), 1,
   CAST(:capabilities_json AS jsonb), :model_alias, CAST(:tools_json AS jsonb),
   :persona_description, now())
"""
)

_INSERT_CAPABILITY_EMBEDDING = text(
    """
INSERT INTO capability_embeddings
  (id, agent_id, tenant_id, capability_description, embedding, embedding_metadata)
VALUES
  (:embedding_id, :agent_id, CAST(:tenant_id AS uuid), :capability_description,
   CAST(:embedding AS vector(512)), CAST(:embedding_metadata_json AS jsonb))
"""
)


class PersonaCreationValidationError(ValueError):
    pass


class AgentAutoCreationEngine:
    """Create one immediately-bindable persona for a true capability gap."""

    def __init__(
        self,
        session: AsyncSession,
        embedding_client: EmbeddingClient,
        *,
        instructions_client: AgentInstructionsClient | None = None,
        maximum_tier: str = "ADVANCED",
    ) -> None:
        if maximum_tier not in _TIER_RANK:
            raise ValueError(
                f"maximum_tier must be one of {sorted(_TIER_RANK)}, got {maximum_tier!r}"
            )
        self._session = session
        self._embedding_client = embedding_client
        self._instructions_client = instructions_client
        self._maximum_tier = maximum_tier

    async def create_for_no_match(
        self,
        no_match: NoAgentMatch,
        request: CreatePersonaRequest,
        *,
        run_id: str | None = None,
    ) -> PersonaCreationOutcome:
        if no_match.reason != "no_eligible_agent":
            return no_match

        requirement = _parse_capability_profile(request.capability_profile_json)
        if not requirement.capabilities:
            raise PersonaCreationValidationError(
                "no_eligible_agent requires at least one capability"
            )
        if requirement.preferred_agent_id is not None:
            raise PersonaCreationValidationError(
                "no_eligible_agent cannot carry preferred_agent_id"
            )

        tier = requirement.model_alias or _DEFAULT_TIER
        if _TIER_RANK[tier] > _TIER_RANK[self._maximum_tier]:
            # Declining is the honest answer, and the only one that converges:
            # minting below the requested tier produces an agent that fails the
            # same >= filter, and minting at it hands any caller the most
            # expensive tier in the system for the asking.
            return NoAgentMatch(
                node_key=no_match.node_key,
                reason="no_agent_at_required_tier",
            )

        if self._instructions_client is None:
            persona_description = _persona_description(requirement)
        else:
            if run_id is None:
                raise PersonaCreationValidationError(
                    "run_id is required to draft agent instructions"
                )
            persona_description = await self._instructions_client.draft_instructions(
                tenant_id=request.tenant_id,
                run_id=run_id,
                node_key=no_match.node_key,
                requirement=requirement,
            )
        embedding_text = "\n".join(requirement.capabilities)
        embedding_result = await self._embedding_client.embed(
            tenant_id=request.tenant_id,
            text=embedding_text,
        )
        embedding = embedding_vector_literal(embedding_result.vector)

        persona = {
            "capability_profile": requirement.model_dump(exclude_none=True),
            "persona_description": persona_description,
            "tier": tier,
        }
        persona_json = json.dumps(persona, separators=(",", ":"), sort_keys=True)
        capabilities_json = json.dumps(requirement.capabilities, separators=(",", ":"))
        tools_json = json.dumps(
            [tool.model_dump(exclude_none=True) for tool in requirement.tools or []],
            separators=(",", ":"),
        )

        tenant_uuid = _raw_uuid(request.tenant_id)
        workspace_uuid = _raw_uuid(request.workspace_id)
        agent_id = new_prefixed_id("agt")

        await self._session.execute(
            _SET_TENANT_CONTEXT,
            {"tenant_id": tenant_uuid},
        )
        auto_creation_key = _auto_creation_key(requirement)
        inserted = await self._session.execute(
            _INSERT_AGENT,
            {
                "agent_id": agent_id,
                "tenant_id": tenant_uuid,
                "workspace_id": workspace_uuid,
                "name": f"Capability agent: {requirement.capabilities[0]}",
                "tier": tier,
                "persona_description": persona_description,
                "auto_creation_key": auto_creation_key,
            },
        )
        if inserted.first() is None:
            # A concurrent request for the same capability set won. Bind to what
            # it created rather than writing a second version and embedding
            # against an agent this call does not own.
            existing = (
                (
                    await self._session.execute(
                        _SELECT_EXISTING_AGENT,
                        {
                            "tenant_id": tenant_uuid,
                            "workspace_id": workspace_uuid,
                            "auto_creation_key": auto_creation_key,
                        },
                    )
                )
                .mappings()
                .first()
            )
            if existing is None:
                # The index refused the insert, so a row matching this key must
                # exist. Not finding it means the two disagree -- report it
                # rather than falling through to a response naming an agent
                # that was never created.
                raise PersonaCreationValidationError(
                    "auto-creation conflicted on an agent that cannot be read back"
                )
            existing_persona = {
                "capability_profile": requirement.model_dump(exclude_none=True),
                "persona_description": existing["persona_description"],
                "tier": existing["tier"],
            }
            return CreatePersonaResponse(
                agent_id=existing["agent_id"],
                agent_version=existing["agent_version"] or 1,
                persona_json=json.dumps(existing_persona, separators=(",", ":"), sort_keys=True),
            )
        await self._session.execute(
            _INSERT_AGENT_VERSION,
            {
                "version_id": new_prefixed_id("agtv"),
                "agent_id": agent_id,
                "tenant_id": tenant_uuid,
                "capabilities_json": capabilities_json,
                "model_alias": requirement.model_alias,
                "tools_json": tools_json,
                "persona_description": persona_description,
            },
        )
        await self._session.execute(
            _INSERT_CAPABILITY_EMBEDDING,
            {
                "embedding_id": new_prefixed_id("cemb"),
                "agent_id": agent_id,
                "tenant_id": tenant_uuid,
                "capability_description": persona_description,
                "embedding": embedding,
                # model_id is not decoration: selection-binding excludes any
                # stored vector whose producing model differs from the query's
                # (task 1.3). Written without it, an agent auto-creation just
                # minted would be invisible to the very lookup that asked for it.
                "embedding_metadata_json": json.dumps(
                    {
                        "dimensions": 512,
                        "source": "PLAN-8",
                        "model_id": embedding_result.model_id,
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                ),
            },
        )

        return CreatePersonaResponse(
            agent_id=agent_id,
            agent_version=1,
            persona_json=persona_json,
        )


def _parse_capability_profile(raw_profile: str) -> NodeRequirement:
    try:
        return NodeRequirement.model_validate_json(raw_profile)
    except (ValidationError, ValueError) as error:
        raise PersonaCreationValidationError(
            "capability_profile_json must match NodeRequirement"
        ) from error


def _persona_description(requirement: NodeRequirement) -> str:
    capabilities = ", ".join(requirement.capabilities)
    return f"Specialist agent for capabilities: {capabilities}."


def _raw_uuid(prefixed_id: str) -> str:
    return prefixed_id.split("_", maxsplit=1)[1]

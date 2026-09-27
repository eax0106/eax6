"""Tenant-safe, performance-weighted agent selection for PLAN-7."""

import json
import logging
import math
import uuid
from collections.abc import Sequence
from typing import TYPE_CHECKING, Protocol

from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

from src.capability_resolver import NodeRequirement, NodeRequirements
from src.db.ids import PLATFORM_TENANT_ID
from src.selection_binding.embedding_client import EmbeddingClient
from src.selection_binding.models import (
    BindAgentModelToolRequest,
    BindAgentModelToolResponse,
    BindingContext,
    BindingOutcome,
    NoAgentMatch,
)
from src.selection_binding.policy_client import RoutingPolicyClient

if TYPE_CHECKING:
    from src.agent_auto_creation.models import CreatePersonaRequest, CreatePersonaResponse

logger = logging.getLogger(__name__)


class PersonaCreationEngine(Protocol):
    """Structural type for AgentAutoCreationEngine, avoiding a circular import
    (agent_auto_creation imports from selection_binding at module level)."""

    async def create_for_no_match(
        self,
        no_match: NoAgentMatch,
        request: "CreatePersonaRequest",
        *,
        run_id: str | None = None,
    ) -> "CreatePersonaResponse | NoAgentMatch": ...


_EMBEDDING_DIMENSIONS = 512

_SET_TENANT_CONTEXT = text("SELECT set_config('app.current_tenant_id', :tenant_id, true)")

# 'draft' agents (see agent_auto_creation.engine's _INSERT_AGENT) are
# eligible here on purpose -- excluding them would mean a freshly
# auto-created agent could never accumulate the real performance_records
# it needs to ever be promoted to 'active' by
# performance.repository.record_observation's promotion check.
#
# A global (platform-wide) agent's real tenant_id is PLATFORM_TENANT_ID
# (see src/db/ids.py), not the caller's -- both queries below OR-bypass
# the tenant_id/workspace_id filters when that's the case, so a global
# agent is visible to every real tenant/workspace, matching the same
# sentinel pattern capability_registry_versions already uses.
_PREFERRED_AGENT_QUERY = text(
    """
SELECT
  a.id AS agent_id,
  a.tier AS agent_tier,
  latest_version.version_number AS agent_version,
  COALESCE(latest_version.persona_description, '') AS agent_instructions
FROM agents AS a
JOIN LATERAL (
  SELECT av.version_number, av.persona_description
  FROM agent_versions AS av
  WHERE av.tenant_id = a.tenant_id
    AND av.agent_id = a.id
    AND av.published_at IS NOT NULL
  ORDER BY av.version_number DESC
  LIMIT 1
) AS latest_version ON TRUE
WHERE (
    a.tenant_id = CAST(:tenant_id AS uuid)
    OR a.tenant_id = CAST(:platform_tenant_id AS uuid)
  )
  AND (
    a.workspace_id = CAST(:workspace_id AS uuid)
    OR a.tenant_id = CAST(:platform_tenant_id AS uuid)
  )
  AND a.id = :preferred_agent_id
  AND a.status IN ('active', 'draft')
  AND (
    CAST(:required_tier AS text) IS NULL
    OR CASE a.tier
         WHEN 'FAST' THEN 1
         WHEN 'STANDARD' THEN 2
         WHEN 'ADVANCED' THEN 3
         WHEN 'CEILING' THEN 4
       END
       >= CASE CAST(:required_tier AS text)
            WHEN 'FAST' THEN 1
            WHEN 'STANDARD' THEN 2
            WHEN 'ADVANCED' THEN 3
            WHEN 'CEILING' THEN 4
          END
  )
LIMIT 1
"""
)

_RANKED_AGENT_QUERY = text(
    """
WITH performance AS (
  SELECT
    pr.agent_id,
    AVG(
      CASE pr.verdict
        WHEN 'success' THEN 1.0
        WHEN 'partial' THEN 0.5
        WHEN 'failure' THEN 0.0
        WHEN 'escalated' THEN 0.0
      END
    )::double precision AS performance_score,
    AVG(pr.latency_ms)::double precision AS mean_latency_ms,
    AVG(pr.token_count)::double precision AS mean_token_count
  FROM performance_records AS pr
  WHERE pr.tenant_id = CAST(:tenant_id AS uuid)
    AND pr.node_type = :node_type
    AND (
      CAST(:task_category AS text) IS NULL
      OR pr.task_category = CAST(:task_category AS text)
    )
  GROUP BY pr.agent_id
), candidate_similarity AS (
  SELECT
    a.id AS agent_id,
    a.tier AS agent_tier,
    latest_version.version_number AS agent_version,
    COALESCE(latest_version.persona_description, '') AS agent_instructions,
    MAX(
      1.0 - (ce.embedding <=> CAST(:query_embedding AS vector(512)))
    )::double precision AS capability_similarity,
    COALESCE(performance.performance_score, 0.5) AS performance_score,
    performance.mean_latency_ms,
    performance.mean_token_count
  FROM agents AS a
  JOIN capability_embeddings AS ce
    ON ce.tenant_id = a.tenant_id
   AND ce.agent_id = a.id
  JOIN LATERAL (
    SELECT av.version_number, av.capabilities, av.persona_description
    FROM agent_versions AS av
    WHERE av.tenant_id = a.tenant_id
      AND av.agent_id = a.id
      AND av.published_at IS NOT NULL
    ORDER BY av.version_number DESC
    LIMIT 1
  ) AS latest_version ON TRUE
  LEFT JOIN performance ON performance.agent_id = a.id
  WHERE (
      a.tenant_id = CAST(:tenant_id AS uuid)
      OR a.tenant_id = CAST(:platform_tenant_id AS uuid)
    )
    -- The agent has to declare what is being asked for, not merely embed near
    -- it. Until this existed, eligibility was tenant, workspace, status, tier
    -- and a vector distance -- a ranking signal doing a matching job, which is
    -- how an unrelated capability could bind (#158).
    --
    -- Containment, with the same `@>` the capability registry already uses on
    -- supported_capabilities: the requirement's set must be a subset of what
    -- the agent published. An empty requirement contains nothing, so `@> '[]'`
    -- holds for every agent, which is the right no-op.
    AND latest_version.capabilities @> CAST(:required_capabilities AS jsonb)
    AND (
      ce.tenant_id = CAST(:tenant_id AS uuid)
      OR ce.tenant_id = CAST(:platform_tenant_id AS uuid)
    )
    AND ce.embedding_metadata->>'model_id' = :embedding_model_id
    AND (
      a.workspace_id = CAST(:workspace_id AS uuid)
      OR a.tenant_id = CAST(:platform_tenant_id AS uuid)
    )
    AND a.status IN ('active', 'draft')
    AND (
      CAST(:required_tier AS text) IS NULL
      OR CASE a.tier
           WHEN 'FAST' THEN 1
           WHEN 'STANDARD' THEN 2
           WHEN 'ADVANCED' THEN 3
           WHEN 'CEILING' THEN 4
         END
         >= CASE CAST(:required_tier AS text)
              WHEN 'FAST' THEN 1
              WHEN 'STANDARD' THEN 2
              WHEN 'ADVANCED' THEN 3
              WHEN 'CEILING' THEN 4
            END
    )
  GROUP BY
    a.id,
    a.tier,
    latest_version.version_number,
    latest_version.persona_description,
    performance.performance_score,
    performance.mean_latency_ms,
    performance.mean_token_count
), ranked AS (
  SELECT
    agent_id,
    agent_tier,
    agent_version,
    agent_instructions,
    capability_similarity,
    performance_score,
    (
      :similarity_weight * capability_similarity
      + :performance_weight * performance_score
    ) AS combined_score,
    -- Same shape architecture_binder.py already scores availability with:
    -- 1/(1+x), which is 1.0 at zero and falls away monotonically, so no
    -- ceiling has to be invented for either quantity. Latency is divided by
    -- 1000 to put a second at 0.5; tokens by 1000 for the same reason, a
    -- thousand-token call scoring the same as a one-second one.
    --
    -- 0.5 for an agent with no history, matching the neutral
    -- performance_score above: never having run is not evidence of being
    -- cheap, and must not beat a measured competitor.
    (
      (
        CASE WHEN mean_latency_ms IS NULL THEN 0.5
             ELSE 1.0 / (1.0 + mean_latency_ms / 1000.0) END
        + CASE WHEN mean_token_count IS NULL THEN 0.5
               ELSE 1.0 / (1.0 + mean_token_count / 1000.0) END
      ) / 2.0
    ) AS efficiency_score
  FROM candidate_similarity
)
SELECT
  agent_id,
  agent_tier,
  agent_version,
  agent_instructions,
  capability_similarity,
  performance_score,
  combined_score,
  efficiency_score
FROM ranked
-- No score floor. Containment above decides eligibility; every score here
-- decides order.
--
-- Two floors used to sit here. Measured against real Titan embeddings, one
-- was unreachable and the other was rejecting agents that declare exactly
-- what was asked for:
--
--   * minimum_capability_similarity = 0.6 could never fire. Clearing
--     combined_score >= 0.7 at similarity_weight 0.8 needs capability
--     similarity >= (0.7 - 0.2 * performance_score) / 0.8, which is 0.625
--     even at a perfect performance_score of 1.0 -- above 0.6 for every
--     input. A filter that cannot reject a row the next filter keeps is dead
--     weight, and re-tuning it could only have moved it between doing
--     nothing and doing the next filter's job.
--
--   * minimum_combined_score = 0.7 did fire, on the wrong rows. A requirement
--     embeds the join of its capabilities, while an agent stores one
--     embedding row per capability, so MAX(similarity) compares a joined
--     query against a single part and falls as the requirement grows:
--     measured 0.77 for two capabilities, 0.75 for three, 0.51 for four. A
--     four-capability requirement therefore could not bind an agent
--     declaring all four, and fell through to auto-creation, minting a
--     duplicate every attempt -- the sprawl #125 and #157 closed, through a
--     different door.
--
-- What the floors were guarding is now guarded by containment: an agent that
-- does not declare the capability is not a candidate at all. One that
-- declares it but carries a stale embedding still binds, and ranks below
-- agents whose embeddings agree with it -- the right answer, because the
-- published capability list, not the vector, is what the agent promised.
ORDER BY
  combined_score + :efficiency_weight * efficiency_score DESC,
  combined_score DESC,
  agent_id ASC
LIMIT 1
"""
)

# Counts capability_embeddings rows that belong to eligible agents for this
# tenant/workspace but were excluded from candidacy by the provenance filter
# (embedding_metadata->>'model_id' != the query model, or absent). Reported as
# a log line so stale vectors are visible rather than silently dropped.
_COUNT_STALE_EMBEDDINGS = text(
    """
SELECT count(*) AS stale_count
FROM capability_embeddings AS ce
JOIN agents AS a
  ON a.tenant_id = ce.tenant_id
 AND a.id = ce.agent_id
WHERE (
    a.tenant_id = CAST(:tenant_id AS uuid)
    OR a.tenant_id = CAST(:platform_tenant_id AS uuid)
  )
  AND (
    ce.tenant_id = CAST(:tenant_id AS uuid)
    OR ce.tenant_id = CAST(:platform_tenant_id AS uuid)
  )
  AND (
    a.workspace_id = CAST(:workspace_id AS uuid)
    OR a.tenant_id = CAST(:platform_tenant_id AS uuid)
  )
  AND a.status IN ('active', 'draft')
  AND (
    ce.embedding_metadata->>'model_id' IS DISTINCT FROM :embedding_model_id
  )
"""
)


class BindingValidationError(ValueError):
    pass


class EmbeddingResultError(ValueError):
    pass


class SelectionBindingEngine:
    """Bind one PLAN-6 requirement record to one eligible published agent."""

    def __init__(
        self,
        session: AsyncSession,
        embedding_client: EmbeddingClient,
        *,
        similarity_weight: float = 0.8,
        # How far measured latency and token cost may move the ranking. Small
        # on purpose: a cheap agent should win between comparable candidates,
        # not beat a clearly better-matched one. The default only applies
        # where the tenant's routing policy does not set one -- like
        # similarity_weight, it is read from the active routing_weights policy
        # per request, so an operator can retune it and drift carries it
        # forward (#159).
        efficiency_weight: float = 0.25,
        policy_client: RoutingPolicyClient | None = None,
        persona_creation_engine: PersonaCreationEngine | None = None,
    ) -> None:
        if not 0.0 <= similarity_weight <= 1.0:
            raise ValueError("similarity_weight must be between 0 and 1")
        if not 0.0 <= efficiency_weight <= 1.0:
            raise ValueError("efficiency_weight must be between 0 and 1")

        self._session = session
        self._embedding_client = embedding_client
        self._similarity_weight = similarity_weight
        self._efficiency_weight = efficiency_weight
        self._performance_weight = 1.0 - similarity_weight
        self._policy_client = policy_client
        self._persona_creation_engine = persona_creation_engine

    async def bind(
        self,
        request: BindAgentModelToolRequest,
        context: BindingContext,
    ) -> BindingOutcome:
        requirement = _requirement_for_node(request)
        tenant_uuid = _database_uuid(request.tenant_id, "ten")
        workspace_uuid = _database_uuid(context.workspace_id, "ws")

        await self._session.execute(
            _SET_TENANT_CONTEXT,
            {"tenant_id": tenant_uuid},
        )

        if requirement.preferred_agent_id is not None:
            return await self._bind_preferred(
                request=request,
                requirement=requirement,
                tenant_uuid=tenant_uuid,
                workspace_uuid=workspace_uuid,
            )

        if not requirement.capabilities:
            return NoAgentMatch(
                node_key=request.node_key,
                reason="agent_not_required",
            )

        embedding_result = await self._embedding_client.embed(
            tenant_id=request.tenant_id,
            text="\n".join(requirement.capabilities),
        )
        query_embedding = embedding_vector_literal(embedding_result.vector)
        similarity_weight, efficiency_weight = await self._load_weights(request.tenant_id)
        query_parameters: dict[str, object] = {
            "tenant_id": tenant_uuid,
            "workspace_id": workspace_uuid,
            "platform_tenant_id": PLATFORM_TENANT_ID,
            "required_tier": requirement.model_alias,
            # Sorted only for a stable query plan and readable logs; `@>` is
            # set containment and does not care about order.
            "required_capabilities": json.dumps(
                sorted(requirement.capabilities), separators=(",", ":")
            ),
            "node_type": context.node_type,
            "task_category": context.task_category,
            "query_embedding": query_embedding,
            "embedding_model_id": embedding_result.model_id,
            "similarity_weight": similarity_weight,
            "performance_weight": 1.0 - similarity_weight,
            "efficiency_weight": efficiency_weight,
        }
        result = await self._session.execute(_RANKED_AGENT_QUERY, query_parameters)
        candidate = result.mappings().first()
        await self._report_stale_embeddings(
            tenant_uuid=tenant_uuid,
            workspace_uuid=workspace_uuid,
            embedding_model_id=embedding_result.model_id,
        )
        if candidate is None:
            return await self._no_candidate(
                request=request,
                context=context,
                requirement=requirement,
                query_parameters=query_parameters,
            )

        return _response(candidate, requirement)

    async def _report_stale_embeddings(
        self,
        *,
        tenant_uuid: str,
        workspace_uuid: str,
        embedding_model_id: str,
    ) -> None:
        """Log how many capability_embeddings rows were excluded as stale.

        A row is stale when its recorded model_id differs from the model that
        produced this query vector (or is absent -- pre-provenance rows). Such
        vectors live in a different embedding space and would otherwise match
        as noise, so they are excluded from candidacy and reported here.
        """
        try:
            result = await self._session.execute(
                _COUNT_STALE_EMBEDDINGS,
                {
                    "tenant_id": tenant_uuid,
                    "workspace_id": workspace_uuid,
                    "platform_tenant_id": PLATFORM_TENANT_ID,
                    "embedding_model_id": embedding_model_id,
                },
            )
            stale_count = int(result.scalar_one())
        except Exception:  # pragma: no cover - reporting must never break binding
            logger.warning(
                "selection_binding: could not count stale embeddings for model %s",
                embedding_model_id,
            )
            return
        if stale_count > 0:
            logger.info(
                "selection_binding: excluded %d stale capability embedding(s) "
                "produced by a different model than %s",
                stale_count,
                embedding_model_id,
            )

    async def _no_candidate(
        self,
        *,
        request: BindAgentModelToolRequest,
        context: BindingContext,
        requirement: NodeRequirement,
        query_parameters: dict[str, object],
    ) -> BindingOutcome:
        """Tell a capability gap apart from a tier gap, then act on which it is.

        One reason code used to cover both, and auto-creation acted on it
        either way -- which is how a tier gap produced an agent that failed the
        very filter that caused the no-match, once per attempt forever.

        The same ranked query, re-run with the tier filter disabled, is what
        separates them: if a capability-eligible agent appears once tier is not
        considered, the requirement's tier is the only thing that excluded it.
        One extra query, and only on the path that already found nothing.
        """
        if requirement.model_alias is not None:
            without_tier = await self._session.execute(
                _RANKED_AGENT_QUERY,
                {**query_parameters, "required_tier": None},
            )
            if without_tier.mappings().first() is not None:
                return NoAgentMatch(
                    node_key=request.node_key,
                    reason="no_agent_at_required_tier",
                )

        no_match = NoAgentMatch(node_key=request.node_key, reason="no_eligible_agent")
        if self._persona_creation_engine is None:
            return no_match
        return await self._create_and_bind(
            no_match=no_match,
            request=request,
            context=context,
            requirement=requirement,
        )

    async def _create_and_bind(
        self,
        *,
        no_match: NoAgentMatch,
        request: BindAgentModelToolRequest,
        context: BindingContext,
        requirement: NodeRequirement,
    ) -> BindingOutcome:
        from src.agent_auto_creation.models import CreatePersonaRequest

        assert self._persona_creation_engine is not None
        persona_request = CreatePersonaRequest(
            tenant_id=request.tenant_id,
            workspace_id=context.workspace_id,
            capability_profile_json=requirement.model_dump_json(exclude_none=True),
        )
        outcome = await self._persona_creation_engine.create_for_no_match(
            no_match, persona_request, run_id=request.run_id
        )
        if isinstance(outcome, NoAgentMatch):
            return outcome
        return BindAgentModelToolResponse(
            agent_id=outcome.agent_id,
            agent_version=outcome.agent_version,
            # The version just created carries these, same as a ranked match.
            instructions=str(json.loads(outcome.persona_json).get("persona_description", "")),
            model_alias=requirement.model_alias or "STANDARD",
            tool_names=[tool.name for tool in requirement.tools or []],
        )

    async def _load_weights(self, tenant_id: str) -> tuple[float, float]:
        """The tenant's routing weights, each falling back on its own.

        A policy that sets one weight and not the other leaves the unset one
        at this engine's default, rather than the whole lookup counting as a
        miss -- bodies written before `efficiency_weight` existed carry only
        `similarity_weight`, and they must keep meaning what they meant.

        Any failure reaching the policy store falls back to both defaults:
        routing on stale weights is a worse answer than routing on the
        configured ones, but refusing to bind because a policy read failed is
        worse than either.
        """
        defaults = (self._similarity_weight, self._efficiency_weight)
        if self._policy_client is None:
            return defaults
        try:
            weights = await self._policy_client.routing_weights(tenant_id)
        except Exception:
            return defaults
        if weights is None:
            return defaults
        return (
            self._similarity_weight
            if weights.similarity_weight is None
            else weights.similarity_weight,
            self._efficiency_weight
            if weights.efficiency_weight is None
            else weights.efficiency_weight,
        )

    async def _bind_preferred(
        self,
        *,
        request: BindAgentModelToolRequest,
        requirement: NodeRequirement,
        tenant_uuid: str,
        workspace_uuid: str,
    ) -> BindingOutcome:
        result = await self._session.execute(
            _PREFERRED_AGENT_QUERY,
            {
                "tenant_id": tenant_uuid,
                "workspace_id": workspace_uuid,
                "platform_tenant_id": PLATFORM_TENANT_ID,
                "preferred_agent_id": requirement.preferred_agent_id,
                "required_tier": requirement.model_alias,
            },
        )
        candidate = result.mappings().first()
        if candidate is None:
            return NoAgentMatch(
                node_key=request.node_key,
                reason="preferred_agent_unavailable",
            )
        return _response(candidate, requirement)


def _requirement_for_node(request: BindAgentModelToolRequest) -> NodeRequirement:
    try:
        requirements = NodeRequirements.model_validate_json(request.node_requirements_json)
    except (json.JSONDecodeError, ValidationError, ValueError) as error:
        raise BindingValidationError(
            "node_requirements_json must match NodeRequirements"
        ) from error

    requirement = requirements.root.get(request.node_key)
    if requirement is None:
        raise BindingValidationError(
            f"node_requirements_json has no entry for node_key={request.node_key}"
        )
    return requirement


def _database_uuid(prefixed_id: str, expected_prefix: str) -> str:
    prefix, raw_uuid = prefixed_id.split("_", maxsplit=1)
    if prefix.casefold() != expected_prefix:
        raise BindingValidationError(f"expected {expected_prefix}_ prefixed identifier")
    try:
        return str(uuid.UUID(raw_uuid))
    except ValueError as error:
        raise BindingValidationError("identifier does not contain a valid UUID") from error


def embedding_vector_literal(values: Sequence[float]) -> str:
    vector = list(values)
    if len(vector) != _EMBEDDING_DIMENSIONS:
        raise EmbeddingResultError(f"embedding must contain exactly {_EMBEDDING_DIMENSIONS} values")
    if any(
        isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
        for value in vector
    ):
        raise EmbeddingResultError("embedding values must be finite numbers")
    if not any(value != 0 for value in vector):
        raise EmbeddingResultError("embedding must not be the zero vector")
    return "[" + ",".join(str(float(value)) for value in vector) + "]"


def _response(
    candidate: RowMapping,
    requirement: NodeRequirement,
) -> BindAgentModelToolResponse:
    return BindAgentModelToolResponse.model_validate(
        {
            "agent_id": candidate["agent_id"],
            "agent_version": candidate["agent_version"],
            "model_alias": requirement.model_alias or candidate["agent_tier"],
            "instructions": candidate["agent_instructions"],
            "tool_names": [tool.name for tool in requirement.tools or []],
        }
    )

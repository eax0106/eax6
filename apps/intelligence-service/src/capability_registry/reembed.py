"""C18: re-embed capability vectors produced by a model other than the live one.

Stored vectors live in their producer's embedding space. Task 1.3 made that
visible -- each row records the producing ``model_id``, and Selection & Binding
excludes any row whose model differs from the query's -- so a stale agent is
harmless but unfindable. This is the repair: re-embed each stale row's own
capability description with the live model and record the new provenance.

Per tenant, under that tenant's row security. A dry run (the default) only
counts; a real run spends one embedding call per stale row, so it is run
deliberately, never on a schedule. Every run reports an upper-bound cost, and a
real run refuses to start when that estimate exceeds its ceiling (D30: USD 1).

    uv run python -m src.capability_registry.reembed --tenant ten_... [--apply]
"""

from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.agent_contracts.embedding_client import (
    EmbeddingClient,
    embedding_vector_literal,
)

_SET_TENANT = text("SELECT set_config('app.current_tenant_id', :tenant_id, true)")

_STALE_ROWS = text(
    """
SELECT id, capability_description, embedding_metadata
FROM capability_embeddings
WHERE tenant_id = CAST(:tenant_id AS uuid)
  AND embedding_metadata->>'model_id' IS DISTINCT FROM :model_id
ORDER BY created_at, id
LIMIT :limit
"""
)

_UPDATE_ROW = text(
    """
UPDATE capability_embeddings
SET embedding = CAST(:embedding AS vector(512)),
    embedding_metadata = CAST(:metadata AS jsonb)
WHERE tenant_id = CAST(:tenant_id AS uuid) AND id = :id
"""
)


# D30 approved spend ceiling for one run, in US dollars.
MAX_RUN_USD = 1.0
# Titan Text Embeddings v2 list price per input token (USD 0.00002 per 1,000).
# One token per character is a deliberate upper bound.
_USD_PER_INPUT_TOKEN = 0.00002 / 1000


class SpendCeilingError(RuntimeError):
    pass


def estimate_reembed_usd(descriptions: list[str]) -> float:
    """Upper-bound cost of embedding each description once."""
    return sum(len(description) for description in descriptions) * _USD_PER_INPUT_TOKEN


@dataclass(frozen=True)
class ReembedResult:
    model_id: str
    stale: int
    reembedded: int
    estimated_usd: float


async def reembed_stale_capabilities(
    session: AsyncSession,
    embedding_client: EmbeddingClient,
    *,
    tenant_id: str,
    live_model_id: str,
    apply: bool,
    limit: int = 500,
    max_usd: float = MAX_RUN_USD,
) -> ReembedResult:
    """Re-embed up to ``limit`` of one tenant's stale rows; count only unless ``apply``."""
    if max_usd > MAX_RUN_USD:
        raise SpendCeilingError(f"ceiling USD {max_usd} exceeds the approved USD {MAX_RUN_USD}")
    tenant_uuid = tenant_id.removeprefix("ten_")
    await session.execute(_SET_TENANT, {"tenant_id": tenant_uuid})
    rows = (
        await session.execute(
            _STALE_ROWS, {"tenant_id": tenant_uuid, "model_id": live_model_id, "limit": limit}
        )
    ).all()
    estimated_usd = estimate_reembed_usd([row.capability_description for row in rows])
    if not apply:
        return ReembedResult(
            model_id=live_model_id, stale=len(rows), reembedded=0, estimated_usd=estimated_usd
        )
    if estimated_usd > max_usd:
        raise SpendCeilingError(
            f"estimated USD {estimated_usd:.6f} for {len(rows)} rows exceeds the "
            f"USD {max_usd} ceiling; nothing re-embedded"
        )

    reembedded = 0
    for row in rows:
        result = await embedding_client.embed(tenant_id=tenant_id, text=row.capability_description)
        if result.model_id != live_model_id:
            # The provider answered from a different model than the one this
            # run is repairing towards; writing it would only make a new
            # kind of stale row.
            raise RuntimeError(
                f"embedding provider returned model {result.model_id!r}, expected {live_model_id!r}"
            )
        previous = row.embedding_metadata if isinstance(row.embedding_metadata, dict) else {}
        metadata = {
            **previous,
            "model_id": result.model_id,
            "reembedded_from": previous.get("model_id"),
            "reembedded_at": datetime.now(UTC).isoformat(),
        }
        await session.execute(
            _UPDATE_ROW,
            {
                "tenant_id": tenant_uuid,
                "id": row.id,
                "embedding": embedding_vector_literal(result.vector),
                "metadata": json.dumps(metadata, separators=(",", ":"), sort_keys=True),
            },
        )
        reembedded += 1
    await session.commit()
    return ReembedResult(
        model_id=live_model_id,
        stale=len(rows),
        reembedded=reembedded,
        estimated_usd=estimated_usd,
    )


async def _main(
    tenant_id: str, apply: bool, limit: int, max_usd: float
) -> None:  # pragma: no cover - operator entry
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from src.agent_contracts.embedding_client import GrpcEmbeddingClient
    from src.config import get_settings
    from src.m2m_auth import lazy_auth0_m2m_token_provider_from_settings

    settings = get_settings()
    client = GrpcEmbeddingClient(
        settings.model_gateway_grpc_target,
        timeout_seconds=settings.model_gateway_grpc_timeout_seconds,
        access_token_provider=lazy_auth0_m2m_token_provider_from_settings(settings),
    )
    probe = await client.embed(tenant_id=tenant_id, text="capability")
    engine = create_async_engine(settings.intelligence_db_url)
    async with async_sessionmaker(engine, expire_on_commit=False)() as session:
        plan = await reembed_stale_capabilities(
            session,
            client,
            tenant_id=tenant_id,
            live_model_id=probe.model_id,
            apply=False,
            limit=limit,
        )
        print(json.dumps({"plan": plan.__dict__, "apply": apply, "max_usd": max_usd}))
        result = plan
        if apply:
            result = await reembed_stale_capabilities(
                session,
                client,
                tenant_id=tenant_id,
                live_model_id=probe.model_id,
                apply=True,
                limit=limit,
                max_usd=max_usd,
            )
    await engine.dispose()
    print(json.dumps(result.__dict__))


if __name__ == "__main__":  # pragma: no cover - operator entry
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--apply", action="store_true", help="re-embed; without it, only count")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument(
        "--max-usd", type=float, default=MAX_RUN_USD, help="refuse when the estimate exceeds this"
    )
    arguments = parser.parse_args()
    asyncio.run(_main(arguments.tenant, arguments.apply, arguments.limit, arguments.max_usd))

"""C18: re-embed capability vectors produced by a model other than the live one.

Stored vectors live in their producer's embedding space. Task 1.3 made that
visible -- each row records the producing ``model_id``, and Selection & Binding
excludes any row whose model differs from the query's -- so a stale agent is
harmless but unfindable. This is the repair: re-embed each stale row's own
capability description with the live model and record the new provenance.

Per tenant, under that tenant's row security. A dry run (the default) only
counts; a real run spends one embedding call per stale row, so it is run
deliberately, never on a schedule.

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


@dataclass(frozen=True)
class ReembedResult:
    model_id: str
    stale: int
    reembedded: int


async def reembed_stale_capabilities(
    session: AsyncSession,
    embedding_client: EmbeddingClient,
    *,
    tenant_id: str,
    live_model_id: str,
    apply: bool,
    limit: int = 500,
) -> ReembedResult:
    """Re-embed up to ``limit`` of one tenant's stale rows; count only unless ``apply``."""
    tenant_uuid = tenant_id.removeprefix("ten_")
    await session.execute(_SET_TENANT, {"tenant_id": tenant_uuid})
    rows = (
        await session.execute(
            _STALE_ROWS, {"tenant_id": tenant_uuid, "model_id": live_model_id, "limit": limit}
        )
    ).all()
    if not apply:
        return ReembedResult(model_id=live_model_id, stale=len(rows), reembedded=0)

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
    return ReembedResult(model_id=live_model_id, stale=len(rows), reembedded=reembedded)


async def _main(
    tenant_id: str, apply: bool, limit: int
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
        result = await reembed_stale_capabilities(
            session,
            client,
            tenant_id=tenant_id,
            live_model_id=probe.model_id,
            apply=apply,
            limit=limit,
        )
    await engine.dispose()
    print(json.dumps(result.__dict__))


if __name__ == "__main__":  # pragma: no cover - operator entry
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", required=True)
    parser.add_argument("--apply", action="store_true", help="re-embed; without it, only count")
    parser.add_argument("--limit", type=int, default=500)
    arguments = parser.parse_args()
    asyncio.run(_main(arguments.tenant, arguments.apply, arguments.limit))

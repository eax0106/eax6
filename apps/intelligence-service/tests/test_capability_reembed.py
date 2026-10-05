"""C18: re-embed capability vectors whose producing model is not the live one."""

import json
from collections.abc import AsyncGenerator, Generator
from pathlib import Path

import pytest
from alembic.config import Config as AlembicConfig
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

from alembic import command
from src.agent_contracts.embedding_client import EmbeddingResult
from src.capability_registry.reembed import (
    SpendCeilingError,
    estimate_reembed_usd,
    reembed_stale_capabilities,
)

SERVICE_ROOT = Path(__file__).parent.parent
TENANT = "ten_018f47a5-7b2c-7d10-8f11-12345678c18a"
TENANT_UUID = TENANT.removeprefix("ten_")
OTHER_UUID = "018f47a5-7b2c-7d10-8f11-12345678c18b"
LIVE = "amazon.titan-embed-text-v2:0"


class RecordingEmbeddings:
    def __init__(self, model_id: str = LIVE) -> None:
        self.model_id = model_id
        self.texts: list[str] = []

    async def embed(self, *, tenant_id: str, text: str) -> EmbeddingResult:
        self.texts.append(text)
        return EmbeddingResult(vector=[0.5] + [0.0] * 511, model_id=self.model_id)


@pytest.fixture(scope="module")
def postgres_url() -> Generator[str, None, None]:
    with PostgresContainer(
        image="pgvector/pgvector:pg16",
        dbname="intelligence_db",
        username="intelligence_service",
        password="testpass",
    ) as postgres:
        sync_url = postgres.get_connection_url()
        config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        config.set_main_option("sqlalchemy.url", sync_url)
        command.upgrade(config, "head")
        yield sync_url


@pytest.fixture
async def session(postgres_url: str) -> AsyncGenerator[AsyncSession, None]:
    engine = create_async_engine(make_url(postgres_url).set(drivername="postgresql+asyncpg"))
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        for tenant in (TENANT_UUID, OTHER_UUID):
            await db.execute(
                text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": tenant}
            )
            await db.execute(
                text("DELETE FROM capability_embeddings WHERE tenant_id = CAST(:t AS uuid)"),
                {"t": tenant},
            )
            await db.execute(
                text("DELETE FROM agents WHERE tenant_id = CAST(:t AS uuid)"), {"t": tenant}
            )
        await db.commit()
        yield db
    await engine.dispose()


async def seed(db: AsyncSession, tenant: str, row_id: str, model_id: str | None) -> None:
    await db.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": tenant})
    agent = f"agt_{row_id}"
    await db.execute(
        text(
            "INSERT INTO agents(id,tenant_id,workspace_id,name,tier,persona_description,status) "
            "VALUES (:id,CAST(:t AS uuid),CAST(:t AS uuid),'a','STANDARD','summariser','active') "
            "ON CONFLICT DO NOTHING"
        ),
        {"id": agent, "t": tenant},
    )
    metadata = {"dimensions": 512, "source": "PLAN-8"} | (
        {} if model_id is None else {"model_id": model_id}
    )
    await db.execute(
        text(
            "INSERT INTO capability_embeddings(id,agent_id,tenant_id,"
            "capability_description,embedding,embedding_metadata) "
            "VALUES (:id,:a,CAST(:t AS uuid),:d,CAST(:v AS vector(512)),CAST(:m AS jsonb))"
        ),
        {
            "id": row_id,
            "a": agent,
            "t": tenant,
            "d": f"describes {row_id}",
            "v": str([0.1] * 512),
            "m": json.dumps(metadata),
        },
    )
    await db.commit()


async def test_dry_run_counts_stale_rows_and_spends_nothing(session: AsyncSession) -> None:
    await seed(session, TENANT_UUID, "cemb_mock", "mock.embedding")
    await seed(session, TENANT_UUID, "cemb_none", None)
    await seed(session, TENANT_UUID, "cemb_live", LIVE)
    embeddings = RecordingEmbeddings()

    result = await reembed_stale_capabilities(
        session, embeddings, tenant_id=TENANT, live_model_id=LIVE, apply=False
    )

    assert (result.stale, result.reembedded) == (2, 0)
    assert result.estimated_usd == estimate_reembed_usd(
        ["describes cemb_mock", "describes cemb_none"]
    )
    assert embeddings.texts == []


async def test_apply_reembeds_only_stale_rows_and_records_provenance(session: AsyncSession) -> None:
    await seed(session, TENANT_UUID, "cemb_mock", "mock.embedding")
    await seed(session, TENANT_UUID, "cemb_live", LIVE)
    await seed(session, OTHER_UUID, "cemb_other", "mock.embedding")
    embeddings = RecordingEmbeddings()

    result = await reembed_stale_capabilities(
        session, embeddings, tenant_id=TENANT, live_model_id=LIVE, apply=True
    )

    assert (result.stale, result.reembedded) == (1, 1)
    assert embeddings.texts == ["describes cemb_mock"]
    await session.execute(
        text("SELECT set_config('app.current_tenant_id', :t, true)"), {"t": TENANT_UUID}
    )
    row = (
        await session.execute(
            text("SELECT embedding_metadata FROM capability_embeddings WHERE id = 'cemb_mock'")
        )
    ).scalar_one()
    assert row["model_id"] == LIVE
    assert row["reembedded_from"] == "mock.embedding"
    assert row["source"] == "PLAN-8"


async def test_refuses_to_write_vectors_from_a_different_model(session: AsyncSession) -> None:
    await seed(session, TENANT_UUID, "cemb_mock", "mock.embedding")

    with pytest.raises(RuntimeError, match="expected"):
        await reembed_stale_capabilities(
            session,
            RecordingEmbeddings(model_id="other-model"),
            tenant_id=TENANT,
            live_model_id=LIVE,
            apply=True,
        )


def test_estimate_is_an_upper_bound_of_one_token_per_character() -> None:
    assert estimate_reembed_usd([]) == 0
    assert estimate_reembed_usd(["a" * 1000, "b" * 1000]) == pytest.approx(0.00004)


async def test_apply_refuses_before_any_call_when_estimate_exceeds_ceiling(
    session: AsyncSession,
) -> None:
    await seed(session, TENANT_UUID, "cemb_mock", "mock.embedding")
    embeddings = RecordingEmbeddings()

    with pytest.raises(SpendCeilingError, match="exceeds the USD 1e-09 ceiling"):
        await reembed_stale_capabilities(
            session,
            embeddings,
            tenant_id=TENANT,
            live_model_id=LIVE,
            apply=True,
            max_usd=0.000000001,
        )
    assert embeddings.texts == []


async def test_ceiling_above_the_approved_amount_is_rejected(session: AsyncSession) -> None:
    with pytest.raises(SpendCeilingError, match="exceeds the approved USD 1.0"):
        await reembed_stale_capabilities(
            session,
            RecordingEmbeddings(),
            tenant_id=TENANT,
            live_model_id=LIVE,
            apply=False,
            max_usd=2.0,
        )

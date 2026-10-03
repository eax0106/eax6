"""Real Postgres HTTP coverage for ArchitectureSpec Registry bindings."""

import asyncio
import hashlib
import json
import secrets
from collections.abc import AsyncGenerator, Generator
from pathlib import Path

import pytest
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.architecture_synthesizer.models import (
    ArchitectureNode,
    ArchitectureSpec,
    EligibleCapabilityRole,
    ExecutionWave,
    SynthesisConstraints,
)
from src.capability_registry.models import RegisterCapability
from src.capability_registry.repository import CapabilityRegistryRepository
from src.db.session import get_db_session
from src.selection_binding.models import BindingRequest
from src.selection_binding.router import router

ROOT = Path(__file__).parent.parent
TENANT_A = "ten_aaaaaaaa-0000-7000-8000-aaaaaaaaaaaa"
TENANT_B = "ten_bbbbbbbb-0000-7000-8000-bbbbbbbbbbbb"
WORKSPACE_A = "ws_cccccccc-0000-7000-8000-cccccccccccc"
WORKSPACE_B = "ws_dddddddd-0000-7000-8000-dddddddddddd"


@pytest.fixture(scope="module")
def postgres_url() -> Generator[str, None, None]:
    with PostgresContainer(
        "pgvector/pgvector:pg16",
        dbname="intelligence_db",
        username="intelligence_service",
        password="testpass",
    ) as postgres:
        url = postgres.get_connection_url()
        config = AlembicConfig(str(ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(ROOT / "alembic"))
        config.set_main_option("sqlalchemy.url", url)
        command.upgrade(config, "head")
        yield url


def seed(url: str, tenant: str, **data: object) -> None:
    async def run() -> None:
        engine = create_async_engine(make_url(url).set(drivername="postgresql+asyncpg"))
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            await CapabilityRegistryRepository(session).register(
                tenant, RegisterCapability.model_validate(data)
            )
        await engine.dispose()

    asyncio.run(run())


@pytest.fixture
def client(postgres_url: str) -> Generator[TestClient, None, None]:
    app = FastAPI()
    app.include_router(router)
    async_url = make_url(postgres_url).set(drivername="postgresql+asyncpg")

    async def session() -> AsyncGenerator[AsyncSession, None]:
        engine = create_async_engine(async_url)
        async with async_sessionmaker(engine, expire_on_commit=False)() as value:
            yield value
        await engine.dispose()

    app.dependency_overrides[get_db_session] = session
    with TestClient(app) as value:
        yield value


def payload(workspace: str = WORKSPACE_A) -> dict[str, object]:
    architecture = ArchitectureSpec(
        source_task_skeleton_version="1",
        topology="single",
        constraints=SynthesisConstraints(),
        nodes=[
            ArchitectureNode(
                source_node_key="node",
                role="direct",
                execution_kind="llm",
                depends_on=[],
                capability_role=EligibleCapabilityRole(
                    source_node_key="node",
                    required_capabilities=["text.generation"],
                    eligible_kinds=["model"],
                ),
            )
        ],
        execution_waves=[ExecutionWave(order=0, node_keys=["node"])],
        rationale=["test"],
        confidence=1,
    )
    return BindingRequest(
        tenant_id=TENANT_A, workspace_id=workspace, architecture=architecture
    ).model_dump(mode="json")


def test_route_filters_tenant_workspace_inactive_and_pins_version(
    client: TestClient, postgres_url: str
) -> None:
    for tenant, identifier, workspace, available in [
        (TENANT_B, "foreign", None, True),
        (TENANT_A, "inactive", WORKSPACE_A, False),
        (TENANT_A, "pinned", WORKSPACE_A, True),
    ]:
        seed(
            postgres_url,
            tenant,
            capability_id=identifier,
            kind="model",
            scope="workspace" if workspace else "tenant",
            workspace_id=workspace,
            supported_capabilities=["text.generation"],
            availability={"available": available, "reliability": 0.9},
            provenance={"source": "test"},
        )
    response = client.post("/selection-binding/bind-architecture", json=payload())
    assert response.status_code == 200
    assert response.json()["bindings"][0]["record_id"] == "pinned"
    assert response.json()["bindings"][0]["version"] == 1
    assert (
        client.post("/selection-binding/bind-architecture", json=payload(WORKSPACE_B)).json()[
            "status"
        ]
        == "blocked"
    )


def test_override_critique_uses_ordinary_rls_registry_and_original_policy(
    postgres_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    seed(
        postgres_url,
        TENANT_A,
        capability_id="native-original",
        kind="model",
        scope="workspace",
        workspace_id=WORKSPACE_A,
        supported_capabilities=["text.generation"],
        availability={
            "available": True,
            "reliability": 1.0,
            "latency_ms_p50": 10,
            "cost_amount": 0.0,
            "cost_unit": "call",
        },
        provenance={"source": "native-registry"},
        metadata={"model_alias": "ADVANCED"},
    )
    output_contract = {
        "type": "object",
        "properties": {"summary": {"type": "number"}},
        "required": ["summary"],
    }
    for tenant, workspace, identifier in [
        (TENANT_A, WORKSPACE_A, "native-fast"),
        (TENANT_A, WORKSPACE_B, "native-other-workspace"),
        (TENANT_B, WORKSPACE_A, "native-other-tenant"),
    ]:
        seed(
            postgres_url,
            tenant,
            capability_id=identifier,
            kind="model",
            scope="workspace",
            workspace_id=workspace,
            supported_capabilities=["native.other"],
            constraints={"required_permissions": ["mail.send"]},
            availability={
                "available": True,
                "reliability": 0.6,
                "latency_ms_p50": 300,
                "cost_amount": 2.0,
                "cost_unit": "call",
            },
            provenance={"source": "native-registry"},
            metadata={"model_alias": "FAST", "output_contract": json.dumps(output_contract)},
        )

    role = "override_reader_" + secrets.token_hex(8)
    password = secrets.token_hex(24)

    async def provision() -> None:
        engine = create_async_engine(make_url(postgres_url).set(drivername="postgresql+asyncpg"))
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    f"CREATE ROLE {role} LOGIN PASSWORD '{password}' "
                    "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS"
                )
            )
            await connection.execute(text(f"GRANT USAGE ON SCHEMA public TO {role}"))
            await connection.execute(
                text(f"GRANT SELECT ON capability_registry_versions TO {role}")
            )
        await engine.dispose()

    asyncio.run(provision())
    ordinary_url = make_url(postgres_url).set(
        drivername="postgresql+asyncpg", username=role, password=password
    )
    app = FastAPI()
    app.include_router(router)
    service_token = secrets.token_urlsafe(32)
    monkeypatch.setenv(
        "INTERNAL_SERVICE_TOKEN_SHA256", hashlib.sha256(service_token.encode()).hexdigest()
    )

    async def session() -> AsyncGenerator[AsyncSession, None]:
        engine = create_async_engine(ordinary_url)
        try:
            async with async_sessionmaker(engine, expire_on_commit=False)() as value:
                identity = (
                    await value.execute(
                        text(
                            "SELECT current_user, rolsuper, rolbypassrls FROM pg_roles "
                            "WHERE rolname = current_user"
                        )
                    )
                ).one()
                assert identity[0] == role and not identity[1] and not identity[2]
                protection = (
                    await value.execute(
                        text(
                            "SELECT relrowsecurity, relforcerowsecurity, "
                            "pg_get_userbyid(relowner) <> current_user FROM pg_class "
                            "WHERE oid = 'capability_registry_versions'::regclass"
                        )
                    )
                ).one()
                assert tuple(protection) == (True, True, True)
                await value.execute(
                    text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
                    {"tenant": TENANT_A.removeprefix("ten_")},
                )
                assert (
                    await value.execute(
                        text(
                            "SELECT count(*) FROM capability_registry_versions "
                            "WHERE owner_tenant_id = CAST(:foreign AS uuid)"
                        ),
                        {"foreign": TENANT_B.removeprefix("ten_")},
                    )
                ).scalar_one() == 0
                yield value
        finally:
            await engine.dispose()

    app.dependency_overrides[get_db_session] = session
    with TestClient(app) as native:
        binding_response = native.post("/selection-binding/bind-architecture", json=payload())
        assert binding_response.status_code == 200
        decision = binding_response.json()
        original = decision["bindings"][0]
        assert original["record_id"] == "native-original" and original["model_alias"] == "ADVANCED"
        request = {
            "tenant_id": TENANT_A,
            "workspace_id": WORKSPACE_A,
            "node_key": "node",
            "choice": {"kind": "model", "value": "FAST"},
            "original_binding": original,
            "required_capabilities": ["text.generation"],
            "required_model_alias": "ADVANCED",
            "policy": decision["policy"],
            "latency_multiplier": 2.0,
        }
        assert native.post("/selection-binding/critique-override", json=request).status_code == 401
        response = native.post(
            "/selection-binding/critique-override",
            json=request,
            headers={"Authorization": "Bearer " + service_token},
        )
        assert response.status_code == 200
        advice = response.json()
        assert advice["original_binding"] == original
        candidate = advice["candidate"]
        assert candidate["record_id"] == "native-fast" and candidate["version"] == 1
        assert candidate["score"] == pytest.approx(0.4 * 0.6 + 0.3 / 1.3 + 0.3 / 3)
        assert candidate["factors"] == {"reliability": 0.6, "latency": 1 / 1.3, "cost": 1 / 3}
        assert candidate["output_contract"] == output_contract
        assert {warning["code"] for warning in advice["warnings"]} == {
            "model_tier",
            "required_capability",
            "account_scope",
            "latency",
        }

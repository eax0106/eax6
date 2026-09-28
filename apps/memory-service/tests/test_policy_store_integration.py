from __future__ import annotations

import asyncio
import json
from collections.abc import Generator
from pathlib import Path
from typing import cast

import pytest
import sqlalchemy as sa
from alembic.config import Config as AlembicConfig
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.policy_store.ads_core_client import AdsCoreMemoryDeliveryUnavailableError
from src.policy_store.models import (
    GetActivePolicyRequest,
    PromoteMemoryRequest,
    RevertMemoryRequest,
    UpdatePolicyRequest,
)
from src.policy_store.repository import (
    MemoryRevertConflictError,
    PolicyPermissionError,
    PolicyVersionConflictError,
    SqlAlchemyPolicyStoreRepository,
)
from src.policy_store.service import PolicyStoreService, PolicyStoreValidationError

SERVICE_ROOT = Path(__file__).parent.parent
TENANT_UUID = "018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
OTHER_TENANT_UUID = "028f4d6e-2b4a-7a3e-8c1a-1234567890ab"
TENANT_ID = f"ten_{TENANT_UUID}"
EVALUATION_RUN_ID = "evr_018f4d6e-2b4a-7a3e-8c1a-1234567890ac"
SECOND_EVALUATION_RUN_ID = "evr_028f4d6e-2b4a-7a3e-8c1a-1234567890ac"
POLICY_ID = "pol_018f4d6e-2b4a-7a3e-8c1a-1234567890ad"
GLOBAL_MEMORY_ID = "mem_018f4d6e-2b4a-7a3e-8c1a-1234567890ae"
PROJECT_MEMORY_ID = "mem_018f4d6e-2b4a-7a3e-8c1a-1234567890af"
TENANT_ROLE = "know15_tenant_writer"
TENANT_PASSWORD = "know15-tenant-test-only"
SYSTEM_ROLE = "policy_system_writer"
SYSTEM_PASSWORD = "know15-system-test-only"


def _role_url(url: str, username: str, password: str) -> str:
    return make_url(url).set(username=username, password=password).render_as_string(
        hide_password=False
    )


@pytest.fixture(scope="module")
def policy_database() -> Generator[dict[str, str], None, None]:
    with PostgresContainer(image="postgres:16-alpine", dbname="policy_db") as postgres:
        admin_url = postgres.get_connection_url()
        config = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        config.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        config.set_main_option("sqlalchemy.url", admin_url)
        command.upgrade(config, "head")

        admin = sa.create_engine(admin_url, isolation_level="AUTOCOMMIT")
        with admin.connect() as connection:
            connection.execute(
                sa.text(f"CREATE ROLE {TENANT_ROLE} LOGIN PASSWORD '{TENANT_PASSWORD}'")
            )
            connection.execute(
                sa.text(f"CREATE ROLE {SYSTEM_ROLE} LOGIN PASSWORD '{SYSTEM_PASSWORD}'")
            )
            connection.execute(
                sa.text(
                    f"GRANT CONNECT ON DATABASE policy_db TO {TENANT_ROLE}, {SYSTEM_ROLE}"
                )
            )
            connection.execute(
                sa.text(f"GRANT USAGE ON SCHEMA public TO {TENANT_ROLE}, {SYSTEM_ROLE}")
            )
            connection.execute(
                sa.text(
                    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public "
                    f"TO {TENANT_ROLE}, {SYSTEM_ROLE}"
                )
            )
        admin.dispose()
        yield {
            "admin": admin_url,
            "tenant": _role_url(admin_url, TENANT_ROLE, TENANT_PASSWORD),
            "system": _role_url(admin_url, SYSTEM_ROLE, SYSTEM_PASSWORD),
        }


@pytest.fixture
def policy_service(policy_database: dict[str, str]) -> Generator[PolicyStoreService, None, None]:
    tenant_engine = sa.create_engine(policy_database["tenant"])
    system_engine = sa.create_engine(policy_database["system"])
    repository = SqlAlchemyPolicyStoreRepository(
        sessionmaker(tenant_engine, class_=Session, expire_on_commit=False),
        sessionmaker(system_engine, class_=Session, expire_on_commit=False),
    )
    yield PolicyStoreService(repository)
    tenant_engine.dispose()
    system_engine.dispose()


def _seed_policy_database(policy_database: dict[str, str]) -> None:
    engine = sa.create_engine(policy_database["admin"])
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                """
INSERT INTO policies(id,scope,scope_id,kind,version,body,status,source)
VALUES (:id,'tenant',CAST(:tenant AS uuid),'routing_weights',1,'{}','draft','human')
ON CONFLICT (id) DO NOTHING
"""
            ),
            {"id": POLICY_ID, "tenant": TENANT_UUID},
        )
        connection.execute(
            sa.text(
                """
INSERT INTO memory_records(id,tenant_id,scope,content,provenance,status)
VALUES
  (:global_id,CAST(:tenant AS uuid),'global',CAST(:global_content AS jsonb),
   CAST(:global_provenance AS jsonb),'candidate'),
  (:project_id,CAST(:tenant AS uuid),'project',CAST(:project_content AS jsonb),
   CAST(:project_provenance AS jsonb),'candidate')
ON CONFLICT (id) DO NOTHING
"""
            ),
            {
                "global_id": GLOBAL_MEMORY_ID,
                "project_id": PROJECT_MEMORY_ID,
                "tenant": TENANT_UUID,
                "global_content": (
                    '{"tenant_id":"ten_private","run_id":"run_private",'
                    '"workspace_id":"ws_private","raw_output":"customer secret",'
                    '"final_verdict":"failed","gates":{"passed":2,"failed":1},'
                    '"recovery_count":1,"recovery_actions":['
                    '{"failure_class":"timeout","strategy":"retry",'
                    '"node_execution_id":"node_private"}],'
                    '"nodes":[{"node_type":"ToolCall","output":"secret"},'
                    '{"node_type":"AcmeCustomerIdentifier"}]}'
                ),
                "global_provenance": (
                    '{"tenant_id":"ten_private","run_id":"run_private",'
                    '"workspace_id":"ws_private","artifact_id":"art_private"}'
                ),
                "project_content": '{"summary":"preserve this exact project learning"}',
                "project_provenance": '{"run_id":"run_project_source"}',
            },
        )
    engine.dispose()


def test_policy_lifecycle_records_promotions_and_rejects_version_conflict(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    _seed_policy_database(policy_database)

    canary = asyncio.run(
        policy_service.update_policy(
            UpdatePolicyRequest(
                tenant_id=TENANT_ID,
                policy_id=POLICY_ID,
                current_version="1",
                patch_json='{"status":"canary","reason":"trial"}',
            ),
            "Bearer integration-token",
        )
    )
    active = asyncio.run(
        policy_service.update_policy(
            UpdatePolicyRequest(
                tenant_id=TENANT_ID,
                policy_id=POLICY_ID,
                current_version="2",
                patch_json='{"status":"active","reason":"healthy canary"}',
            ),
            "Bearer integration-token",
        )
    )
    assert canary.new_version == "2"
    assert active.new_version == "3"

    with pytest.raises(PolicyVersionConflictError, match="expected 2, found 3"):
        asyncio.run(
            policy_service.update_policy(
                UpdatePolicyRequest(
                    tenant_id=TENANT_ID,
                    policy_id=POLICY_ID,
                    current_version="2",
                    patch_json='{"status":"active"}',
                ),
                "Bearer integration-token",
            )
        )

    rolled_back = asyncio.run(
        policy_service.update_policy(
            UpdatePolicyRequest(
                tenant_id=TENANT_ID,
                policy_id=POLICY_ID,
                current_version="3",
                patch_json='{"status":"rolled_back","reason":"incident rollback"}',
            ),
            "Bearer integration-token",
        )
    )
    assert rolled_back.new_version == "4"

    engine = sa.create_engine(policy_database["admin"])
    with engine.connect() as connection:
        policy = connection.execute(
            sa.text("SELECT version,status FROM policies WHERE id=:id"),
            {"id": POLICY_ID},
        ).mappings().one()
        promotions = connection.execute(
            sa.text(
                "SELECT from_version,to_version,action,reason FROM policy_promotions "
                "WHERE policy_id=:id ORDER BY from_version"
            ),
            {"id": POLICY_ID},
        ).mappings().all()
    engine.dispose()
    assert policy == {"version": 4, "status": "rolled_back"}
    assert [row["action"] for row in promotions] == ["promote", "promote", "rollback"]
    assert promotions[-1]["reason"] == "incident rollback"


def test_heal6_recovery_policy_seed_is_real(policy_database: dict[str, str]) -> None:
    engine = sa.create_engine(policy_database["admin"])
    with engine.connect() as connection:
        row = connection.execute(
            sa.text(
                "SELECT id,kind,version,body,status FROM policies "
                "WHERE id='pol_00000000-0000-7000-8000-000000000001'"
            )
        ).mappings().one()
    engine.dispose()
    assert row["kind"] == "recovery_preferences"
    assert row["version"] == 1
    assert row["body"]["policy_version"] == "heal6-deterministic-v1"
    assert row["status"] == "active"


def test_get_active_policy_returns_the_real_seeded_heal6_row(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    response = asyncio.run(
        policy_service.get_active_policy(
            GetActivePolicyRequest(tenant_id=TENANT_ID, kind="recovery_preferences"),
            "Bearer integration-token",
        )
    )
    assert response.found is True
    assert response.policy_id == "pol_00000000-0000-7000-8000-000000000001"
    assert response.version == 1
    assert response.body_json is not None
    body = json.loads(response.body_json)
    assert body["rules"]["timeout"] == ["retry", "swap_agent"]
    assert body["rules"]["rate_limit"] == "backoff"


def test_quality_thresholds_seed_is_real(policy_database: dict[str, str]) -> None:
    engine = sa.create_engine(policy_database["admin"])
    with engine.connect() as connection:
        row = connection.execute(
            sa.text(
                "SELECT id,kind,version,body,status FROM policies "
                "WHERE id='pol_00000000-0000-7000-8000-000000000002'"
            )
        ).mappings().one()
    engine.dispose()
    assert row["kind"] == "quality_thresholds"
    assert row["version"] == 1
    assert row["body"]["threshold"] == 0.7
    assert row["body"]["warn_margin"] == 0.15
    assert row["status"] == "active"


def test_get_active_policy_returns_the_real_seeded_quality_thresholds_row(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    response = asyncio.run(
        policy_service.get_active_policy(
            GetActivePolicyRequest(tenant_id=TENANT_ID, kind="quality_thresholds"),
            "Bearer integration-token",
        )
    )
    assert response.found is True
    assert response.policy_id == "pol_00000000-0000-7000-8000-000000000002"
    assert response.version == 1
    assert response.body_json is not None
    body = json.loads(response.body_json)
    assert body["threshold"] == 0.7
    assert body["warn_margin"] == 0.15


def test_get_active_policy_reports_not_found_honestly_for_an_unpromoted_kind(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    # routing_weights has no seed and this tenant never created a draft --
    # quality_thresholds/recovery_preferences both have a real seeded
    # global row (0002/0004) and would be found via global fallback.
    response = asyncio.run(
        policy_service.get_active_policy(
            GetActivePolicyRequest(tenant_id=TENANT_ID, kind="routing_weights"),
            "Bearer integration-token",
        )
    )
    assert response.found is False
    assert response.policy_id is None
    assert response.body_json is None


def test_get_active_policy_prefers_new_active_version_after_promotion(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    # A dedicated draft row -- the seed row (pol_00000000-...) starts already
    # 'active', and this state machine's only legal transition out of
    # 'active' is 'rolled_back' (terminal), so it can never be walked
    # through draft->canary->active again to prove this. Real promotion
    # of a genuinely new active version needs its own fresh policy row.
    # Starts at version=2: version=1 for this (scope, scope_id, kind) tuple
    # is the real seeded quality_thresholds row (0004).
    fresh_policy_id = "pol_018f4d6e-2b4a-7a3e-8c1a-11111111a001"
    engine = sa.create_engine(policy_database["admin"])
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                """
INSERT INTO policies(id,scope,scope_id,kind,version,body,status,source)
VALUES (:id,'global',NULL,'quality_thresholds',2,'{"rules":{}}','draft','human')
ON CONFLICT (id) DO NOTHING
"""
            ),
            {"id": fresh_policy_id},
        )
    engine.dispose()

    asyncio.run(
        policy_service.update_policy(
            UpdatePolicyRequest(
                tenant_id=TENANT_ID,
                policy_id=fresh_policy_id,
                current_version="2",
                patch_json='{"status":"canary","reason":"trial"}',
            ),
            "Bearer integration-token",
            # global-scope row -- Finding 1's second half now gates this
            global_write_token="integration-global-write-token",
        )
    )
    asyncio.run(
        policy_service.update_policy(
            UpdatePolicyRequest(
                tenant_id=TENANT_ID,
                policy_id=fresh_policy_id,
                current_version="3",
                patch_json=(
                    '{"status":"active","reason":"promote",'
                    ' "body":{"rules":{"min_confidence":0.9}}}'
                ),
            ),
            "Bearer integration-token",
            global_write_token="integration-global-write-token",
        )
    )

    response = asyncio.run(
        policy_service.get_active_policy(
            GetActivePolicyRequest(tenant_id=TENANT_ID, kind="quality_thresholds"),
            "Bearer integration-token",
        )
    )
    assert response.found is True
    assert response.policy_id == fresh_policy_id
    assert response.version == 4
    body = json.loads(response.body_json or "{}")
    assert body["rules"]["min_confidence"] == 0.9


def test_global_and_non_global_memory_promotion_follow_distinct_paths(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    _seed_policy_database(policy_database)
    global_result = asyncio.run(
        policy_service.promote_memory(
            PromoteMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=GLOBAL_MEMORY_ID,
                evaluation_run_id=EVALUATION_RUN_ID,
            ),
            "Bearer integration-token",
            # global-scope record -- Finding 1's second half now gates this
            global_write_token="integration-global-write-token",
        )
    )
    project_result = asyncio.run(
        policy_service.promote_memory(
            PromoteMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=PROJECT_MEMORY_ID,
                evaluation_run_id=EVALUATION_RUN_ID,
            ),
            "Bearer integration-token",
            # project-scope record -- no privileged token needed, proves the
            # gate is scope-specific rather than blanket
        )
    )
    assert global_result.promoted is True
    assert project_result.promoted is True
    repeated_global = asyncio.run(
        policy_service.promote_memory(
            PromoteMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=GLOBAL_MEMORY_ID,
                evaluation_run_id=SECOND_EVALUATION_RUN_ID,
            ),
            "Bearer integration-token",
            global_write_token="integration-global-write-token",
        )
    )
    assert repeated_global.promoted_at == global_result.promoted_at

    engine = sa.create_engine(policy_database["admin"])
    with engine.connect() as connection:
        global_row = connection.execute(
            sa.text(
                "SELECT tenant_id,content,provenance,status,destination "
                "FROM memory_records WHERE id=:id"
            ),
            {"id": GLOBAL_MEMORY_ID},
        ).mappings().one()
        project_row = connection.execute(
            sa.text(
                "SELECT tenant_id::text,content,provenance,status,destination "
                "FROM memory_records WHERE id=:id"
            ),
            {"id": PROJECT_MEMORY_ID},
        ).mappings().one()
    engine.dispose()

    serialized_global = str(dict(global_row))
    for sensitive in (
        "ten_private",
        "run_private",
        "ws_private",
        "art_private",
        "node_private",
        "customer secret",
    ):
        assert sensitive not in serialized_global
    assert global_row["tenant_id"] is None
    assert global_row["status"] == "promoted"
    assert global_row["destination"] == "policy_store"
    assert global_row["content"] == {
        "anonymized": True,
        "failure_classes": ["timeout"],
        "final_verdict": "failed",
        "gates": {"failed": 1, "passed": 2},
        "irreversible": True,
        "node_type_counts": {"ToolCall": 1},
        "recovery_count": 1,
        "schema": "global_memory_v1",
        "strategies": ["retry"],
    }
    assert global_row["provenance"] == {
        "promotion": {
            "anonymized": True,
            "evaluation_run_id": EVALUATION_RUN_ID,
            "irreversible": True,
            "source_identifiers_removed": True,
        }
    }
    assert project_row["tenant_id"] == TENANT_UUID
    assert project_row["content"] == {"summary": "preserve this exact project learning"}
    assert project_row["provenance"]["run_id"] == "run_project_source"
    assert project_row["provenance"]["promotion"] == {
        "evaluation_run_id": EVALUATION_RUN_ID
    }
    assert project_row["destination"] == "ads_memory_namespace"


ADS_CORE_SCOPE_ID = "scp_018f4d6e-2b4a-7a3e-8c1a-1234567890b1"


def _seed_project_memory_with_run_content(
    policy_database: dict[str, str], memory_id: str
) -> None:
    """Realistic memory_learning/extraction.py content shape -- the
    PROJECT_MEMORY_ID fixture above uses a minimal stand-in that doesn't
    exercise statement_for_run_content's real fields."""
    engine = sa.create_engine(policy_database["admin"])
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                """
INSERT INTO memory_records(id,tenant_id,scope,content,provenance,status)
VALUES (:id,CAST(:tenant AS uuid),'project',CAST(:content AS jsonb),
        CAST(:provenance AS jsonb),'candidate')
ON CONFLICT (id) DO NOTHING
"""
            ),
            {
                "id": memory_id,
                "tenant": TENANT_UUID,
                "content": (
                    '{"final_verdict":"completed_verified","gates":{"passed":3,"failed":0},'
                    '"recovery_count":1,"nodes":[],"failed_nodes":[],'
                    '"recovery_actions":[{"failure_class":"timeout","strategy":"retry",'
                    '"node_execution_id":"node_x","outcome":"resolved"}]}'
                ),
                "provenance": '{"run_id":"run_delivery_source"}',
            },
        )
    engine.dispose()


class FakeAdsCoreMemoryClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.raise_unavailable = False

    async def record_memory_namespace(
        self,
        *,
        tenant_id: str,
        scope_id: str,
        kind: str,
        statement: str,
        confidence: float | None,
        provenance: dict[str, object],
    ) -> str:
        # No `authorization` parameter, deliberately: the real client mints its
        # own credential at construction, so a caller cannot hand one in. A
        # fake that still accepted one would let the forwarding come back
        # without failing here.
        if self.raise_unavailable:
            raise AdsCoreMemoryDeliveryUnavailableError("simulated unavailable")
        self.calls.append(
            {
                "tenant_id": tenant_id,
                "scope_id": scope_id,
                "kind": kind,
                "statement": statement,
                "confidence": confidence,
                "provenance": provenance,
            }
        )
        return "mns_test"


def _service_with_ads_core(
    policy_database: dict[str, str], client: FakeAdsCoreMemoryClient
) -> PolicyStoreService:
    tenant_engine = sa.create_engine(policy_database["tenant"])
    system_engine = sa.create_engine(policy_database["system"])
    repository = SqlAlchemyPolicyStoreRepository(
        sessionmaker(tenant_engine, class_=Session, expire_on_commit=False),
        sessionmaker(system_engine, class_=Session, expire_on_commit=False),
    )
    return PolicyStoreService(repository, client)


def test_promote_memory_delivers_a_real_project_memory_to_ads_core(
    policy_database: dict[str, str],
) -> None:
    memory_id = "mem_018f4d6e-2b4a-7a3e-8c1a-1234567890b0"
    _seed_project_memory_with_run_content(policy_database, memory_id)
    client = FakeAdsCoreMemoryClient()
    service = _service_with_ads_core(policy_database, client)

    result = asyncio.run(
        service.promote_memory(
            PromoteMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=memory_id,
                evaluation_run_id=EVALUATION_RUN_ID,
                ads_core_scope_id=ADS_CORE_SCOPE_ID,
            ),
            "Bearer integration-token",
        )
    )

    assert result.promoted is True
    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["tenant_id"] == TENANT_ID
    assert call["scope_id"] == ADS_CORE_SCOPE_ID
    assert call["kind"] == "project_fact"
    assert call["statement"] == (
        "Run completed with verdict 'completed_verified'; 0 node(s) failed; "
        "recovery strategies used: retry."
    )
    assert call["provenance"] == {"memory_id": memory_id}


def test_promote_memory_skips_delivery_without_ads_core_scope_id(
    policy_database: dict[str, str],
) -> None:
    memory_id = "mem_018f4d6e-2b4a-7a3e-8c1a-1234567890b2"
    _seed_project_memory_with_run_content(policy_database, memory_id)
    client = FakeAdsCoreMemoryClient()
    service = _service_with_ads_core(policy_database, client)

    result = asyncio.run(
        service.promote_memory(
            PromoteMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=memory_id,
                evaluation_run_id=EVALUATION_RUN_ID,
            ),
            "Bearer integration-token",
        )
    )

    assert result.promoted is True
    assert client.calls == []


def test_promote_memory_never_fails_when_ads_core_delivery_is_unavailable(
    policy_database: dict[str, str],
) -> None:
    memory_id = "mem_018f4d6e-2b4a-7a3e-8c1a-1234567890b3"
    _seed_project_memory_with_run_content(policy_database, memory_id)
    client = FakeAdsCoreMemoryClient()
    client.raise_unavailable = True
    service = _service_with_ads_core(policy_database, client)

    result = asyncio.run(
        service.promote_memory(
            PromoteMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=memory_id,
                evaluation_run_id=EVALUATION_RUN_ID,
                ads_core_scope_id=ADS_CORE_SCOPE_ID,
            ),
            "Bearer integration-token",
        )
    )

    assert result.promoted is True


def test_promote_memory_does_not_deliver_a_global_scope_memory(
    policy_database: dict[str, str],
) -> None:
    memory_id = "mem_018f4d6e-2b4a-7a3e-8c1a-1234567890b4"
    engine = sa.create_engine(policy_database["admin"])
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                """
INSERT INTO memory_records(id,tenant_id,scope,content,provenance,status)
VALUES (:id,CAST(:tenant AS uuid),'global',CAST(:content AS jsonb),'{}'::jsonb,'candidate')
ON CONFLICT (id) DO NOTHING
"""
            ),
            {
                "id": memory_id,
                "tenant": TENANT_UUID,
                "content": (
                    '{"final_verdict":"failed","gates":{"passed":0,"failed":1},'
                    '"recovery_count":0,"recovery_actions":[],"nodes":[]}'
                ),
            },
        )
    engine.dispose()
    client = FakeAdsCoreMemoryClient()
    service = _service_with_ads_core(policy_database, client)

    result = asyncio.run(
        service.promote_memory(
            PromoteMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=memory_id,
                evaluation_run_id=EVALUATION_RUN_ID,
                ads_core_scope_id=ADS_CORE_SCOPE_ID,
            ),
            "Bearer integration-token",
            global_write_token="integration-global-write-token",
        )
    )

    assert result.promoted is True
    assert client.calls == []


def test_malformed_evaluation_run_id_is_rejected(
    policy_service: PolicyStoreService,
) -> None:
    with pytest.raises(PolicyStoreValidationError, match="evr_ prefixed UUIDv7"):
        asyncio.run(
            policy_service.promote_memory(
                PromoteMemoryRequest(
                    tenant_id=TENANT_ID,
                    memory_id="mem_018f4d6e-2b4a-7a3e-8c1a-1234567890aa",
                    evaluation_run_id="run_not-an-evaluation",
                ),
                "Bearer integration-token",
            )
        )


def test_plain_tenant_role_cannot_write_global_rows(
    policy_database: dict[str, str],
) -> None:
    engine = sa.create_engine(policy_database["tenant"])
    with engine.connect() as connection:
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": OTHER_TENANT_UUID},
        )
        with pytest.raises(sa.exc.DBAPIError):
            connection.execute(
                sa.text(
                    """
INSERT INTO policies(id,scope,scope_id,kind,version,body,status,source)
VALUES ('pol_tenant-global-denied','global',NULL,'routing_weights',99,
        '{}','draft','human')
"""
                )
            )
        connection.rollback()
        connection.execute(
            sa.text("SELECT set_config('app.current_tenant_id', :tenant, true)"),
            {"tenant": OTHER_TENANT_UUID},
        )
        with pytest.raises(sa.exc.DBAPIError):
            connection.execute(
                sa.text(
                    """
INSERT INTO memory_records(id,tenant_id,scope,content,provenance,status)
VALUES ('mem_tenant-global-denied',NULL,'global','{}','{}','candidate')
"""
                )
            )
    engine.dispose()


def test_global_policy_write_rejected_without_privileged_credential(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    """Finding 1, second half: an authenticated-but-ordinary caller must not be
    able to transition the platform-wide recovery_preferences policy just
    because its own target row happens to be scope='global'."""
    with pytest.raises(
        PolicyPermissionError, match="privileged write credential"
    ):
        asyncio.run(
            policy_service.update_policy(
                UpdatePolicyRequest(
                    tenant_id=TENANT_ID,
                    policy_id="pol_00000000-0000-7000-8000-000000000001",
                    current_version="1",
                    patch_json='{"status":"rolled_back","reason":"attacker"}',
                ),
                "Bearer integration-token",
                # no global_write_token
            )
        )

    engine = sa.create_engine(policy_database["admin"])
    with engine.connect() as connection:
        row = connection.execute(
            sa.text(
                "SELECT version,status FROM policies "
                "WHERE id='pol_00000000-0000-7000-8000-000000000001'"
            )
        ).mappings().one()
    engine.dispose()
    assert row == {"version": 1, "status": "active"}, (
        "rejected write must not have touched the row at all"
    )


def test_global_policy_write_succeeds_with_privileged_credential(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    """Positive control: the privileged credential is not decorative -- a
    caller that actually holds it can still perform the real, legitimate
    operation the finding's fix must not break."""
    result = asyncio.run(
        policy_service.update_policy(
            UpdatePolicyRequest(
                tenant_id=TENANT_ID,
                policy_id="pol_00000000-0000-7000-8000-000000000001",
                current_version="1",
                patch_json='{"status":"rolled_back","reason":"legitimate incident response"}',
            ),
            "Bearer integration-token",
            global_write_token="integration-global-write-token",
        )
    )
    assert result.new_version == "2"

    engine = sa.create_engine(policy_database["admin"])
    with engine.connect() as connection:
        row = connection.execute(
            sa.text(
                "SELECT version,status FROM policies "
                "WHERE id='pol_00000000-0000-7000-8000-000000000001'"
            )
        ).mappings().one()
    engine.dispose()
    assert row == {"version": 2, "status": "rolled_back"}


TENANT_SCOPED_GATE_CHECK_POLICY_ID = "pol_018f4d6e-2b4a-7a3e-8c1a-1234567890fa"


def test_global_memory_promotion_rejected_without_privileged_credential(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    """FINDINGS.md names repository.py:71-72 *and* :186-187 as the same
    escalation -- promote_memory's global path must be gated too.

    Seeds its own dedicated row rather than reusing GLOBAL_MEMORY_ID, which
    another test in this module promotes (mutating its status).
    """
    dedicated_id = "mem_018f4d6e-2b4a-7a3e-8c1a-11111111b002"
    engine = sa.create_engine(policy_database["admin"])
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                """
INSERT INTO memory_records(id,tenant_id,scope,content,provenance,status)
VALUES (:id,CAST(:tenant AS uuid),'global','{}','{}','candidate')
ON CONFLICT (id) DO NOTHING
"""
            ),
            {"id": dedicated_id, "tenant": TENANT_UUID},
        )
    engine.dispose()

    with pytest.raises(
        PolicyPermissionError, match="privileged write credential"
    ):
        asyncio.run(
            policy_service.promote_memory(
                PromoteMemoryRequest(
                    tenant_id=TENANT_ID,
                    memory_id=dedicated_id,
                    evaluation_run_id=EVALUATION_RUN_ID,
                ),
                "Bearer integration-token",
                # no global_write_token
            )
        )

    engine = sa.create_engine(policy_database["admin"])
    with engine.connect() as connection:
        row = connection.execute(
            sa.text("SELECT status FROM memory_records WHERE id=:id"),
            {"id": dedicated_id},
        ).mappings().one()
    engine.dispose()
    assert row["status"] == "candidate", (
        "rejected promotion must not have touched the row at all"
    )


def test_ordinary_tenant_scoped_write_unaffected_by_global_write_gate(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    """Negative control: the new gate must only fire for scope='global' rows --
    an ordinary tenant-scoped policy write needs no privileged credential.

    Seeds its own dedicated row rather than reusing POLICY_ID, which earlier
    tests in this module already mutate past version 1.
    """
    engine = sa.create_engine(policy_database["admin"])
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                """
INSERT INTO policies(id,scope,scope_id,kind,version,body,status,source)
VALUES (:id,'tenant',CAST(:tenant AS uuid),'routing_weights',1,'{}','draft','human')
ON CONFLICT (id) DO NOTHING
"""
            ),
            {"id": TENANT_SCOPED_GATE_CHECK_POLICY_ID, "tenant": TENANT_UUID},
        )
    engine.dispose()

    result = asyncio.run(
        policy_service.update_policy(
            UpdatePolicyRequest(
                tenant_id=TENANT_ID,
                policy_id=TENANT_SCOPED_GATE_CHECK_POLICY_ID,
                current_version="1",
                patch_json='{"status":"canary","reason":"trial"}',
            ),
            "Bearer integration-token",
            # no global_write_token -- must not matter, this policy is tenant-scoped
        )
    )
    assert result.new_version == "2"


def _seed_memory(
    policy_database: dict[str, str], *, memory_id: str, scope: str
) -> None:
    engine = sa.create_engine(policy_database["admin"])
    with engine.begin() as connection:
        connection.execute(
            sa.text(
                """
INSERT INTO memory_records(id,tenant_id,scope,content,provenance,status)
VALUES (:id,CAST(:tenant AS uuid),:scope,'{}','{}','candidate')
ON CONFLICT (id) DO NOTHING
"""
            ),
            {"id": memory_id, "tenant": TENANT_UUID, "scope": scope},
        )
    engine.dispose()


def _memory_row(policy_database: dict[str, str], memory_id: str) -> dict[str, object]:
    engine = sa.create_engine(policy_database["admin"])
    with engine.connect() as connection:
        row = connection.execute(
            sa.text(
                "SELECT tenant_id::text,status,destination,provenance,"
                "promoted_at,reverted_at FROM memory_records WHERE id=:id"
            ),
            {"id": memory_id},
        ).mappings().one()
    engine.dispose()
    return dict(row)


def test_revert_memory_transitions_promoted_to_reverted_and_is_idempotent(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    memory_id = "mem_018f4d6e-2b4a-7a3e-8c1a-11111111d001"
    _seed_memory(policy_database, memory_id=memory_id, scope="project")
    asyncio.run(
        policy_service.promote_memory(
            PromoteMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=memory_id,
                evaluation_run_id=EVALUATION_RUN_ID,
            ),
            "Bearer integration-token",
        )
    )

    reverted = asyncio.run(
        policy_service.revert_memory(
            RevertMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=memory_id,
                reason="lesson turned out to generalize incorrectly",
            ),
            "Bearer integration-token",
        )
    )
    assert reverted.reverted is True

    row = _memory_row(policy_database, memory_id)
    assert row["status"] == "reverted"
    assert row["destination"] is None
    assert row["reverted_at"] is not None
    provenance = cast(dict[str, dict[str, object]], row["provenance"])
    assert provenance["revocation"]["reason"] == (
        "lesson turned out to generalize incorrectly"
    )
    # promotion provenance/evaluation_run_id must survive the revert --
    # revocation is additive audit trail, not a history-erasing rewrite.
    assert provenance["promotion"]["evaluation_run_id"] == EVALUATION_RUN_ID

    repeated = asyncio.run(
        policy_service.revert_memory(
            RevertMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=memory_id,
                reason="a different reason on the idempotent replay",
            ),
            "Bearer integration-token",
        )
    )
    assert repeated.reverted_at == reverted.reverted_at


def test_revert_memory_rejects_a_candidate_that_was_never_promoted(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    memory_id = "mem_018f4d6e-2b4a-7a3e-8c1a-11111111d002"
    _seed_memory(policy_database, memory_id=memory_id, scope="failure")

    with pytest.raises(MemoryRevertConflictError, match="candidate"):
        asyncio.run(
            policy_service.revert_memory(
                RevertMemoryRequest(
                    tenant_id=TENANT_ID,
                    memory_id=memory_id,
                    reason="should never apply to a plain candidate",
                ),
                "Bearer integration-token",
            )
        )

    row = _memory_row(policy_database, memory_id)
    assert row["status"] == "candidate"


def test_global_memory_revocation_rejected_without_privileged_credential(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    memory_id = "mem_018f4d6e-2b4a-7a3e-8c1a-11111111d003"
    _seed_memory(policy_database, memory_id=memory_id, scope="global")
    asyncio.run(
        policy_service.promote_memory(
            PromoteMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=memory_id,
                evaluation_run_id=EVALUATION_RUN_ID,
            ),
            "Bearer integration-token",
            global_write_token="integration-global-write-token",
        )
    )

    with pytest.raises(PolicyPermissionError, match="privileged write credential"):
        asyncio.run(
            policy_service.revert_memory(
                RevertMemoryRequest(
                    tenant_id=TENANT_ID,
                    memory_id=memory_id,
                    reason="attempted without the privileged token",
                ),
                "Bearer integration-token",
                # no global_write_token
            )
        )

    row = _memory_row(policy_database, memory_id)
    assert row["status"] == "promoted", (
        "rejected revocation must not have touched the row at all"
    )


def test_global_memory_revocation_succeeds_with_privileged_credential(
    policy_database: dict[str, str],
    policy_service: PolicyStoreService,
) -> None:
    memory_id = "mem_018f4d6e-2b4a-7a3e-8c1a-11111111d004"
    _seed_memory(policy_database, memory_id=memory_id, scope="global")
    asyncio.run(
        policy_service.promote_memory(
            PromoteMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=memory_id,
                evaluation_run_id=EVALUATION_RUN_ID,
            ),
            "Bearer integration-token",
            global_write_token="integration-global-write-token",
        )
    )

    reverted = asyncio.run(
        policy_service.revert_memory(
            RevertMemoryRequest(
                tenant_id=TENANT_ID,
                memory_id=memory_id,
                reason="global lesson found to be tenant-identifying after all",
            ),
            "Bearer integration-token",
            global_write_token="integration-global-write-token",
        )
    )
    assert reverted.reverted is True

    row = _memory_row(policy_database, memory_id)
    assert row["status"] == "reverted"
    # tenant_id must stay NULL: promotion's anonymization already discarded
    # the original tenant-identifying data for good, revert cannot restore it.
    assert row["tenant_id"] is None
    # C11: the free-text reason is not written onto a row every tenant reads.
    provenance = row["provenance"]
    assert isinstance(provenance, dict)
    assert provenance["revocation"] == {"reverted": True}

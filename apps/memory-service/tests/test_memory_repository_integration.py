from __future__ import annotations

import asyncio
import json
from pathlib import Path

import sqlalchemy as sa
from alembic.config import Config as AlembicConfig
from sqlalchemy.orm import Session, sessionmaker
from test_memory_learning import fixture_redact
from testcontainers.community.postgres import PostgresContainer

from alembic import command
from src.memory_learning.extraction import MemoryLearningKernel
from src.memory_learning.models import ProposeWritebackRequest, RunLearningSummary
from src.memory_learning.repository import SqlAlchemyMemoryCandidateRepository

SERVICE_ROOT = Path(__file__).parent.parent
TENANT = "018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ad"


class SeededRunClient:
    async def load_summary(
        self,
        *,
        tenant_id: str,
        run_id: str,
    ) -> RunLearningSummary:
        assert tenant_id == f"ten_{TENANT}"
        assert run_id == RUN
        return RunLearningSummary.model_validate(
            {
                "tenant_id": f"ten_{TENANT}",
                "run_id": RUN,
                "workspace_id": "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ac",
                "verdict": "failed",
                "gates_passed": 2,
                "gates_failed": 1,
                "recovery_count": 2,
                "nodes": [
                    {
                        "node_execution_id": "node_seeded",
                        "node_key": "publish",
                        "node_type": "ToolCall",
                        "status": "failed",
                        "attempt": 3,
                        "input_ref": "research",
                        "output_ref": None,
                        "error_code": "SAFETY_VIOLATION",
                    }
                ],
                "recovery_actions": [
                    {
                        "node_execution_id": "node_seeded",
                        "failure_class": "safety_violation",
                        "strategy": "ask_user",
                        "outcome": "escalated",
                    }
                ],
            }
        )


def test_real_safety_candidate_write_is_durable_and_idempotent() -> None:
    with PostgresContainer(image="postgres:16-alpine", dbname="policy_db") as postgres:
        url = postgres.get_connection_url()
        cfg = AlembicConfig(str(SERVICE_ROOT / "alembic.ini"))
        cfg.set_main_option("script_location", str(SERVICE_ROOT / "alembic"))
        cfg.set_main_option("sqlalchemy.url", url)
        command.upgrade(cfg, "head")
        engine = sa.create_engine(url)
        repository = SqlAlchemyMemoryCandidateRepository(
            sessionmaker(engine, class_=Session, expire_on_commit=False)
        )
        kernel = MemoryLearningKernel(SeededRunClient(), repository, fixture_redact)
        request = ProposeWritebackRequest(
            tenant_id=f"ten_{TENANT}",
            workspace_id="ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ac",
            run_id=RUN,
            verified_output_artifact_id=(
                "art_018f4d6e-2b4a-7a3e-8c1a-1234567890ae"
            ),
            namespace="project/learning",
        )
        first = asyncio.run(
            kernel.propose_writeback(request, "Bearer integration-token")
        )
        second = asyncio.run(
            kernel.propose_writeback(request, "Bearer integration-token")
        )

        assert first.memory_id.startswith("mem_")
        assert second.memory_id == first.memory_id
        assert json.loads(first.candidate_json)["failed_nodes"][0] == {
            "attempt": 3,
            "error_code": "SAFETY_VIOLATION",
            "node_execution_id": "node_seeded",
            "node_key": "publish",
            "node_type": "ToolCall",
            "status": "failed",
        }
        with engine.connect() as connection:
            row = connection.execute(
                sa.text(
                    "SELECT id, tenant_id::text, scope, content, provenance, status, destination "
                    "FROM memory_records"
                )
            ).mappings().one()
        assert row["tenant_id"] == TENANT
        assert row["scope"] == "safety_pattern"
        assert row["content"]["final_verdict"] == "failed"
        assert row["content"]["recovery_count"] == 2
        assert (
            row["content"]["recovery_actions"][0]["failure_class"]
            == "safety_violation"
        )
        assert row["content"]["recovery_actions"][0]["strategy"] == "ask_user"
        assert row["status"] == "candidate"
        assert row["destination"] is None
        assert row["provenance"]["run_id"] == RUN
        engine.dispose()

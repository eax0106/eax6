from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

import httpx

from src.config import get_settings

logger = logging.getLogger(__name__)


async def audit_tenant_assertion(
    tenant_id: str, agent_id: str, action: str, result: str, reason_code: str = ""
) -> None:
    settings = get_settings()
    try:
        if not settings.internal_service_token.strip():
            raise RuntimeError("audit service credential is not configured")
        async with httpx.AsyncClient(timeout=5) as client:
            response = await client.post(
                settings.audit_service_base_url.rstrip("/") + "/internal/audit-events",
                headers={"authorization": f"Bearer {settings.internal_service_token}"},
                json={
                    "tenant_id": tenant_id,
                    "actor_type": "service",
                    "actor_ref": "service:alter-service",
                    "action": action,
                    "target_type": "agent",
                    "target_ref": agent_id,
                    "result": result,
                    "reason_code": reason_code,
                    "context_json": json.dumps({"scope": "tenant_asserted_by_service"}),
                    "occurred_at": datetime.now(UTC).isoformat(),
                },
            )
            response.raise_for_status()
    except Exception as error:
        # Audit writes fail open with a loud log under the existing read policy.
        logger.error(
            "service-asserted tenant audit write failed",
            extra={
                "tenant_id": tenant_id,
                "agent_id": agent_id,
                "action": action,
                "error_type": type(error).__name__,
            },
        )

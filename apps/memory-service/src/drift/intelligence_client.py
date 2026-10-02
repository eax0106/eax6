from __future__ import annotations

from typing import Protocol
from urllib.parse import quote

import httpx
from pydantic import ValidationError

from .models import AgentPerformance


class IntelligencePerformanceUnavailableError(RuntimeError):
    pass


class IntelligencePerformanceClient(Protocol):
    async def load_agent_performance(
        self,
        *,
        tenant_id: str,
        agent_id: str,
        task_class: str,
        limit: int,
    ) -> AgentPerformance: ...


class HttpxIntelligencePerformanceClient:
    def __init__(
        self,
        base_url: str,
        timeout_seconds: float,
        client: httpx.AsyncClient | None = None,
        *,
        service_token: str,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds)
        self._owns_client = client is None
        self._service_token = service_token

    async def load_agent_performance(
        self,
        *,
        tenant_id: str,
        agent_id: str,
        task_class: str,
        limit: int,
    ) -> AgentPerformance:
        if not self._service_token.strip():
            raise IntelligencePerformanceUnavailableError(
                "internal service credential is not configured"
            )
        try:
            response = await self._client.get(
                f"{self._base_url}/internal/performance/agents/{quote(agent_id, safe='')}",
                params={
                    "tenant_id": tenant_id,
                    "task_class": task_class,
                    "limit": str(limit),
                },
                headers={"authorization": f"Bearer {self._service_token}"},
            )
        except httpx.HTTPError as error:
            raise IntelligencePerformanceUnavailableError(
                "intelligence performance request failed"
            ) from error
        if not response.is_success:
            raise IntelligencePerformanceUnavailableError(
                f"intelligence performance request failed with status {response.status_code}"
            )
        try:
            return AgentPerformance.model_validate(response.json())
        except (ValueError, ValidationError) as error:
            raise IntelligencePerformanceUnavailableError(
                "intelligence performance response failed validation"
            ) from error

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

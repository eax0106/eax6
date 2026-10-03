from __future__ import annotations

import asyncio

import grpc

from alter.modelgw.v1 import modelgw_pb2, modelgw_pb2_grpc
from src.m2m_auth import AccessTokenProvider


class MemoryRedactionUnavailableError(RuntimeError):
    pass


class GrpcMemoryRedactor:
    def __init__(self, target: str, provider: AccessTokenProvider) -> None:
        self._channel = grpc.aio.insecure_channel(target)
        self._stub = modelgw_pb2_grpc.ModelgwServiceStub(self._channel)  # type: ignore[no-untyped-call]
        self._provider = provider

    async def redact(self, tenant_id: str, content: str) -> str:
        try:
            metadata = await asyncio.to_thread(self._provider.metadata)
            response = await self._stub.Redact(
                modelgw_pb2.RedactRequest(tenant_id=tenant_id, content=content),
                metadata=metadata,
                timeout=30,
            )
            return str(response.redacted_content)
        except Exception as error:
            raise MemoryRedactionUnavailableError("Memory redaction unavailable") from error

    async def close(self) -> None:
        await self._channel.close()

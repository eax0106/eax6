from collections.abc import Callable

import grpc

from alter.memory.v1 import memory_pb2, memory_pb2_grpc

MemoryAccess = Callable[[str, str], tuple[bool, int]]


class MemoryUnavailableError(RuntimeError):
    pass


class GrpcWorkspaceMemoryClient:
    def __init__(self, address: str, authorization: str) -> None:
        self._channel = grpc.insecure_channel(address)
        self._stub = memory_pb2_grpc.MemoryServiceStub(self._channel)  # type: ignore[no-untyped-call]
        self._authorization = authorization

    def close(self) -> None:
        self._channel.close()

    def access(self, tenant_id: str, workspace_id: str) -> tuple[bool, int]:
        if not self._authorization.startswith("Bearer ") or not self._authorization[7:].strip():
            raise MemoryUnavailableError("Workspace memory settings unavailable")
        try:
            result = self._stub.MemoryAccess(
                memory_pb2.MemoryAccessRequest(
                    tenant_id=tenant_id, workspace_id=workspace_id, kind="workspace"
                ),
                metadata=(("authorization", self._authorization),),
                timeout=15,
            )
            if not 7 <= result.retention_days <= 365:
                raise ValueError("Invalid memory retention window")
            return result.allowed, result.retention_days
        except Exception as error:
            raise MemoryUnavailableError("Workspace memory settings unavailable") from error

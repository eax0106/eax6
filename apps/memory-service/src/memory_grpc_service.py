from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import NoReturn

import grpc
from pydantic import TypeAdapter, ValidationError

from alter.memory.v1 import memory_pb2

from .memory_learning.extraction import MemoryLearningKernel, MemoryLearningValidationError
from .memory_learning.models import ProposeWritebackRequest
from .memory_learning.orchestration_client import (
    OrchestrationUnavailableError,
    RunNotCompletedError,
    RunNotFoundError,
)
from .memory_settings.recall import chat_messages, recall_workflow, store_and_recall_chat
from .memory_settings.redaction import MemoryRedactionUnavailableError
from .memory_settings.repository import (
    MemorySettingsPreconditionError,
    MemorySettingsRepository,
    WorkspaceMemoryValues,
)
from .policy_store.models import PromoteMemoryRequest, UpdatePolicyRequest
from .policy_store.repository import (
    MemoryNotFoundError,
    MemoryPromotionConflictError,
    PolicyNotFoundError,
    PolicyTransitionError,
    PolicyVersionConflictError,
)
from .policy_store.service import PolicyStoreService, PolicyStoreValidationError


class MemoryGrpcService:
    def __init__(
        self,
        learning: MemoryLearningKernel,
        policies: PolicyStoreService,
        settings: MemorySettingsRepository | None = None,
        redact: Callable[[str, str], Awaitable[str]] | None = None,
    ) -> None:
        self._learning = learning
        self._policies = policies
        self._settings = settings
        self._redact = redact

    async def RecallChat(
        self,
        request: memory_pb2.RecallChatRequest,
        context: grpc.aio.ServicerContext[object, object],
    ) -> memory_pb2.RecallChatResponse:
        if self._settings is None or self._redact is None:
            await _abort(context.abort, grpc.StatusCode.UNAVAILABLE, "Memory recall unavailable")
        try:
            chat_messages(request.messages_json, request.conversation_id)
            enabled, _ = await asyncio.to_thread(
                self._settings.access, request.tenant_id, request.workspace_id, "chat"
            )
            if not enabled:
                return memory_pb2.RecallChatResponse(memory_json="[]")
            redacted = await self._redact(request.tenant_id, request.messages_json)
            try:
                chat_messages(redacted, request.conversation_id)
            except ValueError as error:
                raise MemoryRedactionUnavailableError("Memory redaction unavailable") from error
            result = await asyncio.to_thread(
                store_and_recall_chat,
                self._settings,
                request.tenant_id,
                request.workspace_id,
                request.conversation_id,
                redacted,
            )
        except MemoryRedactionUnavailableError:
            await _abort(context.abort, grpc.StatusCode.UNAVAILABLE, "Memory redaction unavailable")
        except ValueError:
            await _abort(context.abort, grpc.StatusCode.INVALID_ARGUMENT, "Invalid chat memory")
        return memory_pb2.RecallChatResponse(memory_json=result)

    async def RecallWorkflow(
        self,
        request: memory_pb2.RecallWorkflowRequest,
        context: grpc.aio.ServicerContext[object, object],
    ) -> memory_pb2.RecallWorkflowResponse:
        if self._settings is None or self._redact is None:
            await _abort(context.abort, grpc.StatusCode.UNAVAILABLE, "Memory recall unavailable")
        try:
            result = await asyncio.to_thread(
                recall_workflow,
                self._settings,
                request.tenant_id,
                request.workspace_id,
                request.workflow_id,
            )
        except ValueError:
            await _abort(context.abort, grpc.StatusCode.INVALID_ARGUMENT, "Invalid workflow memory")
        if result != "[]":
            try:
                result = await self._redact(request.tenant_id, result)
                TypeAdapter(list[dict[str, object]]).validate_json(result)
                if len(result.encode()) > 16_000:
                    raise ValueError("Memory exceeds recall limit")
            except (MemoryRedactionUnavailableError, ValueError):
                await _abort(
                    context.abort, grpc.StatusCode.UNAVAILABLE, "Memory redaction unavailable"
                )
        return memory_pb2.RecallWorkflowResponse(memory_json=result)

    async def GetMemorySettings(
        self,
        request: memory_pb2.GetMemorySettingsRequest,
        context: grpc.aio.ServicerContext[object, object],
    ) -> memory_pb2.GetMemorySettingsResponse:
        if self._settings is None:
            await _abort(context.abort, grpc.StatusCode.UNAVAILABLE, "Memory settings unavailable")
        try:
            result = await asyncio.to_thread(
                self._settings.get, request.tenant_id, request.workspace_id
            )
        except ValueError:
            await _abort(context.abort, grpc.StatusCode.INVALID_ARGUMENT, "Invalid memory scope")
        return memory_pb2.GetMemorySettingsResponse(settings_json=result.model_dump_json())

    async def UpdateMemorySettings(
        self,
        request: memory_pb2.UpdateMemorySettingsRequest,
        context: grpc.aio.ServicerContext[object, object],
    ) -> memory_pb2.UpdateMemorySettingsResponse:
        if self._settings is None:
            await _abort(context.abort, grpc.StatusCode.UNAVAILABLE, "Memory settings unavailable")
        try:
            values = WorkspaceMemoryValues.model_validate_json(request.settings_json)
            if set(values.model_fields_set) != set(WorkspaceMemoryValues.model_fields):
                raise ValueError("All memory settings required")
            result = await asyncio.to_thread(
                self._settings.update,
                request.tenant_id,
                request.workspace_id,
                request.actor_id,
                values,
                request.if_match,
            )
        except MemorySettingsPreconditionError as error:
            code = (
                grpc.StatusCode.FAILED_PRECONDITION
                if error.status == 428
                else grpc.StatusCode.ABORTED
            )
            await _abort(context.abort, code, str(error))
        except ValueError:
            await _abort(context.abort, grpc.StatusCode.INVALID_ARGUMENT, "Invalid memory settings")
        return memory_pb2.UpdateMemorySettingsResponse(settings_json=result.model_dump_json())

    async def MemoryAccess(
        self,
        request: memory_pb2.MemoryAccessRequest,
        context: grpc.aio.ServicerContext[object, object],
    ) -> memory_pb2.MemoryAccessResponse:
        if self._settings is None:
            await _abort(context.abort, grpc.StatusCode.UNAVAILABLE, "Memory settings unavailable")
        try:
            if request.kind not in {"chat", "workflow", "workspace"}:
                raise ValueError("Invalid memory kind")
            allowed, days = await asyncio.to_thread(
                self._settings.access, request.tenant_id, request.workspace_id, request.kind
            )
        except ValueError:
            await _abort(context.abort, grpc.StatusCode.INVALID_ARGUMENT, "Invalid memory scope")
        return memory_pb2.MemoryAccessResponse(allowed=allowed, retention_days=days)

    async def ProposeWriteback(
        self,
        request: memory_pb2.ProposeWritebackRequest,
        context: grpc.aio.ServicerContext[object, object],
    ) -> memory_pb2.ProposeWritebackResponse:
        try:
            result = await self._learning.propose_writeback(
                ProposeWritebackRequest(
                    tenant_id=request.tenant_id,
                    workspace_id=request.workspace_id,
                    run_id=request.run_id,
                    verified_output_artifact_id=request.verified_output_artifact_id,
                    namespace=request.namespace,
                ),
                _authorization(context),
            )
        except ValidationError as error:
            await _abort(context.abort, grpc.StatusCode.INVALID_ARGUMENT, str(error))
        except MemoryLearningValidationError as error:
            await _abort(context.abort, grpc.StatusCode.INVALID_ARGUMENT, str(error))
        except RunNotFoundError as error:
            await _abort(context.abort, grpc.StatusCode.NOT_FOUND, str(error))
        except RunNotCompletedError as error:
            await _abort(context.abort, grpc.StatusCode.FAILED_PRECONDITION, str(error))
        except OrchestrationUnavailableError as error:
            await _abort(context.abort, grpc.StatusCode.UNAVAILABLE, str(error))
        except MemoryRedactionUnavailableError as error:
            await _abort(context.abort, grpc.StatusCode.UNAVAILABLE, str(error))
        return memory_pb2.ProposeWritebackResponse(
            memory_id=result.memory_id, candidate_json=result.candidate_json, skipped=result.skipped
        )

    async def PromoteMemory(
        self,
        request: memory_pb2.PromoteMemoryRequest,
        context: grpc.aio.ServicerContext[object, object],
    ) -> memory_pb2.PromoteMemoryResponse:
        try:
            result = await self._policies.promote_memory(
                PromoteMemoryRequest(
                    tenant_id=request.tenant_id,
                    memory_id=request.memory_id,
                    evaluation_run_id=request.evaluation_run_id,
                    ads_core_scope_id=(
                        request.ads_core_scope_id if request.HasField("ads_core_scope_id") else None
                    ),
                ),
                _authorization(context),
            )
        except (ValidationError, PolicyStoreValidationError) as error:
            await _abort(context.abort, grpc.StatusCode.INVALID_ARGUMENT, str(error))
        except MemoryNotFoundError as error:
            await _abort(context.abort, grpc.StatusCode.NOT_FOUND, str(error))
        except MemoryPromotionConflictError as error:
            await _abort(context.abort, grpc.StatusCode.FAILED_PRECONDITION, str(error))
        return memory_pb2.PromoteMemoryResponse(
            promoted=result.promoted, promoted_at=result.promoted_at.isoformat()
        )

    async def UpdatePolicy(
        self,
        request: memory_pb2.UpdatePolicyRequest,
        context: grpc.aio.ServicerContext[object, object],
    ) -> memory_pb2.UpdatePolicyResponse:
        try:
            result = await self._policies.update_policy(
                UpdatePolicyRequest(
                    tenant_id=request.tenant_id,
                    policy_id=request.policy_id,
                    current_version=request.current_version,
                    patch_json=request.patch_json,
                ),
                _authorization(context),
            )
        except (
            ValidationError,
            PolicyStoreValidationError,
            PolicyTransitionError,
        ) as error:
            await _abort(context.abort, grpc.StatusCode.INVALID_ARGUMENT, str(error))
        except PolicyNotFoundError as error:
            await _abort(context.abort, grpc.StatusCode.NOT_FOUND, str(error))
        except PolicyVersionConflictError as error:
            await _abort(context.abort, grpc.StatusCode.FAILED_PRECONDITION, str(error))
        return memory_pb2.UpdatePolicyResponse(
            policy_id=result.policy_id, new_version=result.new_version
        )


def _authorization(context: grpc.aio.ServicerContext[object, object]) -> str:
    return next(
        (value for key, value in context.invocation_metadata() if key.lower() == "authorization"),
        "",
    )


async def _abort(
    abort: Callable[[grpc.StatusCode, str], Awaitable[None]],
    code: grpc.StatusCode,
    details: str,
) -> NoReturn:
    await abort(code, details)
    raise AssertionError("context.abort must raise")

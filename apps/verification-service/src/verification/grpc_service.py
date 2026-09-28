from __future__ import annotations

import json
from collections.abc import Callable
from typing import cast, get_args

import grpc
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from alter.verify.v1 import verify_pb2

from .engine import HallucinationVerificationEngine
from .errors import VerificationError
from .kernel import VerificationKernel, VerificationValidationError
from .model_gateway_client import ModelGatewayClient
from .models import NodeType, ScoreNodeRequest

_SEVERITY_ENUM = {
    "low": verify_pb2.SAFETY_SEVERITY_LOW,
    "medium": verify_pb2.SAFETY_SEVERITY_MEDIUM,
    "high": verify_pb2.SAFETY_SEVERITY_HIGH,
    "critical": verify_pb2.SAFETY_SEVERITY_CRITICAL,
}


class VerifyGrpcService:
    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        model_gateway: ModelGatewayClient,
        kernel: VerificationKernel,
    ) -> None:
        self._session_factory = session_factory
        self._model_gateway = model_gateway
        self._kernel = kernel

    async def ScoreGate(
        self,
        request: verify_pb2.ScoreGateRequest,
        context: grpc.aio.ServicerContext[
            verify_pb2.ScoreGateRequest, verify_pb2.ScoreGateResponse
        ],
    ) -> verify_pb2.ScoreGateResponse:
        del request
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "ADVANCED score gate ships in HEAL-2")
        raise AssertionError("context.abort must raise")

    async def CheckHallucination(
        self,
        request: verify_pb2.CheckHallucinationRequest,
        context: grpc.aio.ServicerContext[
            verify_pb2.CheckHallucinationRequest, verify_pb2.CheckHallucinationResponse
        ],
    ) -> verify_pb2.CheckHallucinationResponse:
        async with self._session_factory() as session:
            engine = HallucinationVerificationEngine(session, self._model_gateway)
            try:
                result = await engine.check_hallucination(
                    tenant_id=request.tenant_id,
                    run_id=request.run_id,
                    node_execution_id=request.node_execution_id,
                    response_node_ref=request.response_node_ref,
                    evidence_node_refs=tuple(request.evidence_node_refs),
                )
            except VerificationError as error:
                await _abort(context.abort, error)
                raise AssertionError("context.abort must raise")
        return verify_pb2.CheckHallucinationResponse(
            verification_result_id=result.verification_result_id,
            verdict=result.assessment.verdict,
            confidence=1 - result.assessment.hallucination_score,
        )

    async def AssessSeverity(
        self,
        request: verify_pb2.AssessSeverityRequest,
        context: grpc.aio.ServicerContext[
            verify_pb2.AssessSeverityRequest, verify_pb2.AssessSeverityResponse
        ],
    ) -> verify_pb2.AssessSeverityResponse:
        async with self._session_factory() as session:
            engine = HallucinationVerificationEngine(session, self._model_gateway)
            try:
                result = await engine.assess_severity(
                    tenant_id=request.tenant_id,
                    run_id=request.run_id,
                    node_execution_id=request.node_execution_id,
                    finding_json=request.finding_json,
                )
            except VerificationError as error:
                await _abort(context.abort, error)
                raise AssertionError("context.abort must raise")
        return verify_pb2.AssessSeverityResponse(
            severity=result.assessment.severity,
            rationale=result.assessment.rationale,
            severity_tier=_SEVERITY_ENUM[result.assessment.severity],
        )

    async def ScoreNodeInline(
        self,
        request: verify_pb2.ScoreNodeInlineRequest,
        context: grpc.aio.ServicerContext[
            verify_pb2.ScoreNodeInlineRequest, verify_pb2.ScoreNodeInlineResponse
        ],
    ) -> verify_pb2.ScoreNodeInlineResponse:
        if request.node_type not in get_args(NodeType):
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT,
                f"node_type must be one of {get_args(NodeType)}",
            )
            raise AssertionError("context.abort must raise")
        try:
            kernel_request = ScoreNodeRequest(
                tenant_id=request.tenant_id,
                run_id=request.run_id,
                node_execution_id=request.node_execution_id,
                node_key=request.node_key,
                node_type=cast(NodeType, request.node_type),
                config_json=request.config_json,
                output_json=request.output_json,
                success_criteria=tuple(request.success_criteria),
            )
        except ValidationError as error:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(error))
            raise AssertionError("context.abort must raise")

        try:
            result = await self._kernel.score_node(kernel_request)
        except VerificationValidationError as error:
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(error))
            raise AssertionError("context.abort must raise")

        return verify_pb2.ScoreNodeInlineResponse(
            verdict=result.verdict,
            score=result.score,
            threshold=result.threshold,
            reviewer_model=result.reviewer_model,
            details_json=result.details_json,
        )


async def _abort(
    abort: Callable[[grpc.StatusCode, str], object],
    error: VerificationError,
) -> None:
    status = {
        400: grpc.StatusCode.INVALID_ARGUMENT,
        422: grpc.StatusCode.FAILED_PRECONDITION,
        503: grpc.StatusCode.UNAVAILABLE,
    }.get(error.problem.status, grpc.StatusCode.INTERNAL)
    details = json.dumps(error.problem.model_dump(), separators=(",", ":"))
    result = abort(status, details)
    if hasattr(result, "__await__"):
        await result

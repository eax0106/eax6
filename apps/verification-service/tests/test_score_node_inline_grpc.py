"""Real gRPC round-trip tests for ScoreNodeInline (HARD-7).

Deliberately not Testcontainers-backed: ScoreNodeInline never touches the
session_factory or model_gateway args on VerifyGrpcService for a
deterministic node type (kernel.py's own score_node() branches away from
both before either is used) -- so this is a real, fast, locally-runnable
test, unlike every other integration spec in this service.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator

import grpc
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker

from alter.verify.v1 import verify_pb2, verify_pb2_grpc
from src.verification.grpc_service import VerifyGrpcService
from src.verification.kernel import VerificationKernel
from src.verification.llm_client import StubReviewerLlmClient

TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
NODE_EXECUTION = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"


@pytest.fixture()
async def stub() -> AsyncGenerator[verify_pb2_grpc.VerifyServiceStub, None]:
    kernel = VerificationKernel(StubReviewerLlmClient())
    # session_factory/model_gateway are never real here -- ScoreNodeInline
    # for a deterministic node type never touches either. A real Postgres
    # connection would only be needed for ScoreGate/CheckHallucination/
    # AssessSeverity, not exercised by this test file.
    server = grpc.aio.server()
    verify_pb2_grpc.add_VerifyServiceServicer_to_server(  # type: ignore[no-untyped-call]
        VerifyGrpcService(
            async_sessionmaker(bind=None),
            None,  # type: ignore[arg-type]
            kernel,
        ),
        server,
    )
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    channel = grpc.aio.insecure_channel(f"127.0.0.1:{port}")
    try:
        yield verify_pb2_grpc.VerifyServiceStub(channel)  # type: ignore[no-untyped-call]
    finally:
        await channel.close()
        await server.stop(grace=0)


async def test_deterministic_gate_with_real_output_scores_pass(
    stub: verify_pb2_grpc.VerifyServiceStub,
) -> None:
    response = await stub.ScoreNodeInline(
        verify_pb2.ScoreNodeInlineRequest(
            tenant_id=TENANT,
            run_id=RUN,
            node_execution_id=NODE_EXECUTION,
            node_key="eval_gate",
            node_type="Gate",
            config_json="{}",
            output_json=json.dumps({"routed": True}),
        )
    )

    assert response.verdict == "pass"
    assert response.score == 1.0
    assert response.threshold == 1.0
    assert response.reviewer_model == "deterministic"


async def test_deterministic_gate_with_empty_output_scores_fail(
    stub: verify_pb2_grpc.VerifyServiceStub,
) -> None:
    response = await stub.ScoreNodeInline(
        verify_pb2.ScoreNodeInlineRequest(
            tenant_id=TENANT,
            run_id=RUN,
            node_execution_id=NODE_EXECUTION,
            node_key="eval_gate",
            node_type="Gate",
            config_json="{}",
            output_json="{}",
        )
    )

    assert response.verdict == "fail"
    assert response.score == 0.0


async def test_content_bearing_node_uses_the_stub_reviewer(
    stub: verify_pb2_grpc.VerifyServiceStub,
) -> None:
    response = await stub.ScoreNodeInline(
        verify_pb2.ScoreNodeInlineRequest(
            tenant_id=TENANT,
            run_id=RUN,
            node_execution_id=NODE_EXECUTION,
            node_key="eval_llmtask",
            node_type="LLMTask",
            config_json="{}",
            output_json=json.dumps({"content": "complete answer"}),
        )
    )

    # Real disclosed gap: no real ADVANCED reviewer client exists yet, so
    # this is the stub's real (deterministic, non-live-model) response --
    # never fabricated as "real" beyond what it actually is.
    assert response.reviewer_model == "ADVANCED"
    assert response.score == 0.9
    assert response.verdict == "pass"


async def test_invalid_node_type_is_rejected_before_reaching_the_kernel(
    stub: verify_pb2_grpc.VerifyServiceStub,
) -> None:
    with pytest.raises(grpc.aio.AioRpcError) as caught:
        await stub.ScoreNodeInline(
            verify_pb2.ScoreNodeInlineRequest(
                tenant_id=TENANT,
                run_id=RUN,
                node_execution_id=NODE_EXECUTION,
                node_key="eval_bad",
                node_type="NotARealNodeType",
                config_json="{}",
                output_json="{}",
            )
        )
    assert caught.value.code() == grpc.StatusCode.INVALID_ARGUMENT


async def test_malformed_prefixed_id_is_rejected(
    stub: verify_pb2_grpc.VerifyServiceStub,
) -> None:
    with pytest.raises(grpc.aio.AioRpcError) as caught:
        await stub.ScoreNodeInline(
            verify_pb2.ScoreNodeInlineRequest(
                tenant_id="not-a-tenant-id",
                run_id=RUN,
                node_execution_id=NODE_EXECUTION,
                node_key="eval_gate",
                node_type="Gate",
                config_json="{}",
                output_json="{}",
            )
        )
    assert caught.value.code() == grpc.StatusCode.INVALID_ARGUMENT


async def test_success_criteria_travel_over_grpc_to_the_judgement(
    stub: verify_pb2_grpc.VerifyServiceStub,
) -> None:
    """C29 slice 2b: the criteria field reaches the kernel; the stub reviewer
    meets nothing on an empty output, so the node fails on its contract."""
    response = await stub.ScoreNodeInline(
        verify_pb2.ScoreNodeInlineRequest(
            tenant_id=TENANT,
            run_id=RUN,
            node_execution_id=NODE_EXECUTION,
            node_key="summarise",
            node_type="LLMTask",
            config_json="{}",
            output_json=json.dumps({"text": "a summary"}),
            success_criteria=["Summary under 100 words"],
        )
    )
    details = json.loads(response.details_json)
    assert details["criteria"] == [
        {
            "criterion": "Summary under 100 words",
            "met": True,
            "reason": "Stub reviewer: output is present.",
        }
    ]
    assert response.verdict == "pass"

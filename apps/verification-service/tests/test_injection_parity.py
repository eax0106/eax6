"""D15: real language clients share one model-contract case set over native gRPC."""

import asyncio
import json
from pathlib import Path

import grpc

from alter.modelgw.v1 import modelgw_pb2, modelgw_pb2_grpc
from src.verification.model_gateway_client import (
    GrpcModelGatewayClient,
    ModelGatewayInvocationError,
)

ROOT = Path(__file__).resolve().parents[3]
CASES = ROOT / "scripts/safety/injection-cases.json"
TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
NODE = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"


class CaseGateway(modelgw_pb2_grpc.ModelgwServiceServicer):
    def __init__(self, cases: list[dict[str, object]]) -> None:
        self.cases = {case["text"]: case for case in cases}
        self.requests: list[tuple[str, str]] = []

    async def Invoke(self, request, context):  # type: ignore[no-untyped-def]
        assert (request.tenant_id, request.run_id, request.node_execution_id) == (TENANT, RUN, NODE)
        assert request.model_alias == "FAST"
        messages = json.loads(request.input_json)["messages"]
        assert [message["role"] for message in messages] == ["system", "user"]
        subject = messages[1]["content"]
        try:
            decoded = json.loads(subject)
        except json.JSONDecodeError:
            decoded = None
        text = (
            decoded["text"]
            if subject not in self.cases and isinstance(decoded, dict) and set(decoded) == {"text"}
            else subject
        )
        assert text in self.cases
        self.requests.append((text, messages[0]["content"]))
        case = self.cases[text]
        if case.get("transport_error"):
            await context.abort(grpc.StatusCode.UNAVAILABLE, "fixture unavailable")
        return modelgw_pb2.InvokeResponse(
            output_json=json.dumps({"message": {"content": case["model_content"]}})
        )


async def test_classifiers_agree_on_shared_native_cases() -> None:
    cases = json.loads(CASES.read_text())
    assert len(cases) > 0 and len({case["id"] for case in cases}) == len(cases)
    gateway = CaseGateway(cases)
    server = grpc.aio.server()
    modelgw_pb2_grpc.add_ModelgwServiceServicer_to_server(  # type: ignore[no-untyped-call]
        gateway, server
    )
    port = server.add_insecure_port("127.0.0.1:0")
    assert port > 0
    await server.start()
    client = GrpcModelGatewayClient(f"127.0.0.1:{port}")
    process: asyncio.subprocess.Process | None = None
    try:
        process = await asyncio.create_subprocess_exec(
            "node",
            str(ROOT / "scripts/safety/run-injection-cases.mjs"),
            f"127.0.0.1:{port}",
            str(CASES),
            cwd=ROOT,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        output, errors = await asyncio.wait_for(process.communicate(), timeout=60)
        assert process.returncode == 0, errors.decode()
        typescript = json.loads(output)
        assert len(typescript) == len(cases)
        first_requests = list(gateway.requests)
        gateway.requests.clear()
        for case, actual in zip(cases, typescript, strict=True):
            assert actual.pop("id") == case["id"]
            if actual.get("status") == "unavailable":
                assert actual.pop("failurePolicy") == "fail_open"
                assert actual.pop("blocked") is case.get("fallback_blocked", False)
                assert actual.pop("confidence") == 0
            try:
                result = await client.classify_prompt_injection(
                    tenant_id=TENANT, run_id=RUN, node_execution_id=NODE, text=case["text"]
                )
                python = {
                    "status": "classified",
                    "blocked": result.injection_detected,
                    "confidence": result.confidence,
                    "reason": result.reason,
                }
            except ModelGatewayInvocationError:
                python = {"status": "unavailable"}
            assert actual == python == case["expected"], case["id"]
        # The input adapters differ; the actual instruction policy must be identical.
        assert {policy for _, policy in first_requests} == {
            policy for _, policy in gateway.requests
        }
    finally:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        await client.close()
        await server.stop(None)

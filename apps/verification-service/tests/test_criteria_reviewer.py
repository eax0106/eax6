"""C29 slice 2b: the real reviewer's criteria judgement, over its Model
Gateway call (the gRPC stub is replaced; the parsing is the real code)."""

import json

import pytest

from alter.modelgw.v1 import modelgw_pb2
from src.verification.model_gateway_client import (
    GrpcModelGatewayClient,
    ModelGatewayInvocationError,
)

TENANT = "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
RUN = "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
NODE = "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab"
CRITERIA = ("Refund total stated", "Currency given")


class FakeStub:
    def __init__(self, content: str) -> None:
        self.content = content
        self.requests: list[modelgw_pb2.InvokeRequest] = []

    async def Invoke(
        self, request: modelgw_pb2.InvokeRequest, **_: object
    ) -> modelgw_pb2.InvokeResponse:
        self.requests.append(request)
        return modelgw_pb2.InvokeResponse(
            output_json=json.dumps({"message": {"content": self.content}})
        )


def client(content: str) -> tuple[GrpcModelGatewayClient, FakeStub]:
    reviewer = GrpcModelGatewayClient("unused:0")
    fake = FakeStub(content)
    reviewer._stub = fake  # type: ignore[assignment]
    return reviewer, fake


async def judge(reviewer: GrpcModelGatewayClient):  # type: ignore[no-untyped-def]
    return await reviewer.judge_criteria(
        tenant_id=TENANT,
        run_id=RUN,
        node_execution_id=NODE,
        node_type="LLMTask",
        criteria=CRITERIA,
        config_json="{}",
        output_json='{"text": "Total 40"}',
    )


async def test_maps_indexed_judgements_back_to_their_criteria_in_order() -> None:
    reviewer, fake = client(
        json.dumps(
            {
                "criteria": [
                    {"index": 1, "met": False, "reason": "no currency"},
                    {"index": 0, "met": True, "reason": "total is 40"},
                ]
            }
        )
    )
    judgements = await judge(reviewer)
    assert [(j.criterion, j.met) for j in judgements] == [
        ("Refund total stated", True),
        ("Currency given", False),
    ]
    sent = fake.requests[0]
    assert sent.model_alias == "ADVANCED"
    subject = json.loads(json.loads(sent.input_json)["messages"][1]["content"])
    assert subject["success_criteria"] == [
        {"index": 0, "criterion": CRITERIA[0]},
        {"index": 1, "criterion": CRITERIA[1]},
    ]
    assert subject["untrusted_node_output"] == {"text": "Total 40"}


@pytest.mark.parametrize(
    "content",
    [
        "not json",
        json.dumps({"criteria": [{"index": 0, "met": True, "reason": "x"}]}),
        json.dumps(
            {
                "criteria": [
                    {"index": 0, "met": True, "reason": "x"},
                    {"index": 0, "met": True, "reason": "x"},
                ]
            }
        ),
        json.dumps(
            {
                "criteria": [
                    {"index": 0, "met": "yes", "reason": "x"},
                    {"index": 1, "met": True, "reason": "x"},
                ]
            }
        ),
        json.dumps({"verdict": "pass"}),
    ],
    ids=["prose", "one missing", "duplicate index", "non-boolean met", "wrong shape"],
)
async def test_anything_but_one_boolean_judgement_per_criterion_is_an_error(content: str) -> None:
    reviewer, _ = client(content)
    with pytest.raises(ModelGatewayInvocationError, match="invalid criteria judgements"):
        await judge(reviewer)

from __future__ import annotations

from collections.abc import Generator
from typing import cast

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from src.main import app
from src.memory_learning.models import ProposeWritebackResponse
from src.memory_learning.orchestration_client import (
    RunNotCompletedError,
    RunNotFoundError,
)
from src.memory_learning.router import get_kernel

PAYLOAD = {
    "tenant_id": "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
    "workspace_id": "ws_018f4d6e-2b4a-7a3e-8c1a-1234567890ac",
    "run_id": "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ad",
    "verified_output_artifact_id": "art_018f4d6e-2b4a-7a3e-8c1a-1234567890ae",
    "namespace": "project/learning",
}


class FakeKernel:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error

    async def propose_writeback(
        self, request: object, authorization: str
    ) -> ProposeWritebackResponse:
        del request
        assert authorization == "Bearer integration-token"
        if self.error is not None:
            raise self.error
        return ProposeWritebackResponse(
            memory_id="mem_018f4d6e-2b4a-7a3e-8c1a-1234567890af",
            candidate_json='{"ok":true}',
        )


@pytest.fixture(autouse=True)
def _clear_overrides() -> Generator[None, None, None]:
    yield
    app.dependency_overrides.clear()


def post(kernel: FakeKernel) -> Response:
    app.dependency_overrides[get_kernel] = lambda: kernel
    return cast(
        Response,
        TestClient(app).post(
            "/memory/propose-writeback",
            json=PAYLOAD,
            headers={"authorization": "Bearer integration-token"},
        ),
    )


def test_route_matches_locked_proto_shape() -> None:
    response = post(FakeKernel())
    assert response.status_code == 200
    assert response.json() == {
        "memory_id": "mem_018f4d6e-2b4a-7a3e-8c1a-1234567890af",
        "candidate_json": '{"ok":true}',
        "skipped": False,
    }


@pytest.mark.parametrize(
    ("error", "expected_status"),
    [(RunNotFoundError("missing"), 404), (RunNotCompletedError("pending"), 409)],
)
def test_maps_run_errors(error: Exception, expected_status: int) -> None:
    assert post(FakeKernel(error)).status_code == expected_status


def test_request_validation_rejects_bad_prefixed_ids() -> None:
    app.dependency_overrides[get_kernel] = lambda: FakeKernel()
    payload = dict(PAYLOAD)
    payload["tenant_id"] = "bad"
    response = TestClient(app).post(
        "/memory/propose-writeback",
        json=payload,
        headers={"authorization": "Bearer integration-token"},
    )
    assert response.status_code == 422

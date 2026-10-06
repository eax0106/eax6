"""The ADS Q gRPC Retrieve response carries each hit's text (C137)."""

from typing import Any, cast

from alter.adsq.v1 import adsq_pb2
from src.query.grpc_service import AdsqGrpcService
from src.query.models import RetrievalHit, RetrievalRequest, RetrievalResponse
from src.query.service import RetrievalService


class FakeRetrieval:
    def __init__(self) -> None:
        self.requests: list[RetrievalRequest] = []

    def retrieve(self, request: RetrievalRequest) -> RetrievalResponse:
        self.requests.append(request)
        hit = RetrievalHit(
            document_id="doc_1",
            chunk_id="chunk_1",
            seq=0,
            source_id="src_1",
            scope_id="scope_1",
            context="Refunds are issued within 5 business days.",
            reconstructed_context="Refunds are issued within 5 business days.",
            score=0.8,
            confidence=0.8,
            provenance={"document": {"title": "Refund policy"}},
            metadata={},
            freshness_at=None,
            semantic_score=0.8,
            keyword_score=0.5,
        )
        return RetrievalResponse(hits=(hit,), memory_facts=(), audited_at=None)


def test_retrieve_returns_the_chunk_text_with_each_hit() -> None:
    fake = FakeRetrieval()
    service = AdsqGrpcService(cast(RetrievalService, fake))
    response = service.Retrieve(
        adsq_pb2.RetrieveRequest(
            tenant_id="ten_01930000-0000-7000-8000-000000000001",
            workspace_id="ws_01930000-0000-7000-8000-000000000002",
            query="refund window",
            top_k=3,
            requester="tool-gateway",
        ),
        cast(Any, None),
    )
    assert [(hit.document_id, hit.chunk_reference, hit.context) for hit in response.hits] == [
        ("doc_1", "chunk_1", "Refunds are issued within 5 business days.")
    ]
    assert fake.requests[0].top_k == 3

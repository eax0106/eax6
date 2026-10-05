from __future__ import annotations

import json
from typing import cast

import grpc

from alter.adsq.v1 import adsq_pb2

from .models import RetrievalRequest
from .repository import ScopeViolationError
from .service import RetrievalBackpressureError, RetrievalService


class AdsqGrpcService:
    def __init__(self, service: RetrievalService) -> None:
        self._service = service

    def Retrieve(
        self,
        request: adsq_pb2.RetrieveRequest,
        context: grpc.ServicerContext[adsq_pb2.RetrieveRequest, adsq_pb2.RetrieveResponse],
    ) -> adsq_pb2.RetrieveResponse:
        try:
            metadata_filter = json.loads(request.metadata_filter_json or "{}")
            if not isinstance(metadata_filter, dict):
                raise ValueError("metadata_filter_json must encode a JSON object")
            result = self._service.retrieve(
                RetrievalRequest(
                    tenant_id=request.tenant_id,
                    workspace_id=request.workspace_id,
                    requester=request.requester,
                    query=request.query,
                    top_k=request.top_k or 10,
                    scope_ids=tuple(request.scope_ids),
                    metadata_filter=metadata_filter,
                )
            )
        except ScopeViolationError as exc:
            context.abort(grpc.StatusCode.PERMISSION_DENIED, "Requested scope is unavailable")
            raise AssertionError("context.abort must raise") from exc
        except RetrievalBackpressureError as exc:
            context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, str(exc))
            raise AssertionError("context.abort must raise") from exc
        except ValueError as exc:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))
            raise AssertionError("context.abort must raise")
        return adsq_pb2.RetrieveResponse(
            hits=[
                adsq_pb2.RetrievalHit(
                    document_id=hit.document_id,
                    chunk_reference=hit.chunk_id,
                    score=hit.score,
                    confidence=hit.confidence,
                    provenance_json=json.dumps(hit.provenance, separators=(",", ":")),
                    context=hit.context,
                )
                for hit in result.hits
            ]
        )

    def Rerank(
        self,
        request: adsq_pb2.RerankRequest,
        context: grpc.ServicerContext[adsq_pb2.RerankRequest, adsq_pb2.RerankResponse],
    ) -> adsq_pb2.RerankResponse:
        del context
        # Candidates already come from ADS Q. Stable ordering makes this a
        # deterministic score gate rather than a second opaque model call.
        candidates = cast(list[adsq_pb2.RetrievalHit], request.candidates)
        return adsq_pb2.RerankResponse(
            hits=sorted(
                candidates,
                key=lambda hit: (
                    -float(cast(adsq_pb2.RetrievalHit, hit).score),
                    str(cast(adsq_pb2.RetrievalHit, hit).document_id),
                    str(cast(adsq_pb2.RetrievalHit, hit).chunk_reference),
                ),
            )
        )

    def GetProvenance(
        self,
        request: adsq_pb2.GetProvenanceRequest,
        context: grpc.ServicerContext[
            adsq_pb2.GetProvenanceRequest, adsq_pb2.GetProvenanceResponse
        ],
    ) -> adsq_pb2.GetProvenanceResponse:
        provenance = self._service.provenance(
            tenant_id=request.tenant_id, document_id=request.document_id
        )
        if provenance is None:
            context.abort(grpc.StatusCode.NOT_FOUND, "ADS document provenance was not found")
            raise AssertionError("context.abort must raise")
        return adsq_pb2.GetProvenanceResponse(
            provenance_json=json.dumps(provenance, separators=(",", ":")), confidence=1.0
        )

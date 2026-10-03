from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from typing import cast

from sqlalchemy import text
from sqlalchemy.orm import Session, sessionmaker

from src.db.ids import new_prefixed_id, validate_prefixed_id
from src.memory_namespace.models import MemoryFact
from src.memory_namespace.repository import SqlAlchemyMemoryNamespaceRepository

from .models import RetrievalHit, RetrievalRequest

_SET_TENANT = text("SELECT set_config('app.current_tenant_id', :tenant_id, true)")
_QUERY = text(
    """
WITH candidates AS (
  SELECT c.id AS chunk_id, c.seq, c.document_id, c.document_version, d.source_id, c.scope_id,
         c.text_content, COALESCE(c.metadata, '{}'::jsonb) AS metadata,
         dv.provenance, dv.freshness_at, d.title, d.kind AS document_kind,
         s.id AS source_scope_id, src.kind AS source_kind, src.provider AS source_provider,
         1 - (c.embedding <=> CAST(:embedding AS vector)) AS semantic_score,
         ts_rank_cd(c.text_search, websearch_to_tsquery('english', :query)) AS keyword_score
  FROM chunks c
  JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
  JOIN document_versions dv ON dv.document_id = c.document_id
       AND dv.version = c.document_version
  JOIN scopes s ON s.id = c.scope_id AND s.tenant_id = c.tenant_id
  JOIN sources src ON src.id = d.source_id AND src.tenant_id = d.tenant_id
  WHERE c.tenant_id = CAST(:tenant_id AS uuid)
    AND s.workspace_id = CAST(:workspace_id AS uuid)
    AND d.status = 'active'
    AND c.document_version = d.current_version
    AND (
      cardinality(CAST(:scope_ids AS text[])) = 0
      OR c.scope_id = ANY(CAST(:scope_ids AS text[]))
    )
    AND (
      cardinality(CAST(:source_ids AS text[])) = 0
      OR d.source_id = ANY(CAST(:source_ids AS text[]))
    )
    AND COALESCE(c.metadata, '{}'::jsonb) @> CAST(:metadata_filter AS jsonb)
)
SELECT *, (0.7 * semantic_score + 0.3 * LEAST(keyword_score, 1)) AS hybrid_score
FROM candidates
ORDER BY hybrid_score DESC, document_id ASC, chunk_id ASC
LIMIT :limit
"""
)
_VALID_SCOPES = text(
    """SELECT id FROM scopes WHERE tenant_id = CAST(:tenant_id AS uuid)
       AND workspace_id = CAST(:workspace_id AS uuid)
       AND id = ANY(CAST(:scope_ids AS text[]))"""
)
_VALID_SOURCES = text(
    """SELECT src.id FROM sources src
       JOIN scopes s ON s.id = src.scope_id AND s.tenant_id = src.tenant_id
       WHERE src.tenant_id = CAST(:tenant_id AS uuid)
         AND s.workspace_id = CAST(:workspace_id AS uuid)
         AND src.id = ANY(CAST(:source_ids AS text[]))"""
)
_AUDIT = text(
    """
INSERT INTO retrieval_audit
  (id, tenant_id, scope_id, requester, query_hash, scope_inputs, filters,
   candidate_ids, result_doc_ids, confidence, ranking_summary, outcome,
   failure_reason, completed_at)
VALUES (:id, CAST(:tenant_id AS uuid), :scope_id, :requester, :query_hash,
        CAST(:scope_inputs AS jsonb), CAST(:filters AS jsonb),
        CAST(:candidate_ids AS jsonb), CAST(:result_doc_ids AS jsonb), :confidence,
        CAST(:ranking_summary AS jsonb), :outcome, :failure_reason, now())
RETURNING created_at
"""
)
_AUDIT_SCOPE = text(
    """SELECT id FROM scopes WHERE tenant_id = CAST(:tenant_id AS uuid)
       AND workspace_id = CAST(:workspace_id AS uuid) ORDER BY id LIMIT 1"""
)
_PROVENANCE = text(
    """SELECT dv.provenance FROM documents d
       JOIN document_versions dv ON dv.document_id = d.id AND dv.version = d.current_version
       WHERE d.tenant_id = CAST(:tenant_id AS uuid) AND d.id = :document_id"""
)


@dataclass(frozen=True)
class QueryResult:
    hits: tuple[RetrievalHit, ...]
    memory_facts: tuple[MemoryFact, ...] = ()


class SqlAlchemyRetrievalRepository:
    def __init__(
        self,
        sessions: sessionmaker[Session],
        memory_namespace: SqlAlchemyMemoryNamespaceRepository | None = None,
    ) -> None:
        self._sessions = sessions
        # memory_namespace lives in the same ads_db, same sessions factory --
        # no separate connection/config needed to fetch it alongside hits.
        self._memory_namespace = memory_namespace or SqlAlchemyMemoryNamespaceRepository(sessions)

    def validate_scopes(self, request: RetrievalRequest) -> None:
        validate_prefixed_id("ten", request.tenant_id)
        validate_prefixed_id("ws", request.workspace_id)
        if not request.scope_ids:
            raise ScopeViolationError("ADS Q requires at least one explicit scope")
        for scope_id in request.scope_ids:
            validate_prefixed_id(scope_id.split("_", 1)[0], scope_id)
        for source_id in request.source_ids:
            validate_prefixed_id("src", source_id)
        for prefix, value in (("prj", request.project_id), ("wf", request.workflow_id)):
            if value is not None:
                validate_prefixed_id(prefix, value)
                if value not in request.scope_ids:
                    raise ScopeViolationError("Requested scope is unavailable")

        tenant_uuid = request.tenant_id.removeprefix("ten_")
        workspace_uuid = request.workspace_id.removeprefix("ws_")
        with self._sessions.begin() as session:
            session.execute(_SET_TENANT, {"tenant_id": tenant_uuid})
            visible = set(
                session.scalars(
                    _VALID_SCOPES,
                    {
                        "tenant_id": tenant_uuid,
                        "workspace_id": workspace_uuid,
                        "scope_ids": list(request.scope_ids),
                    },
                )
            )
        if visible != set(request.scope_ids):
            raise ScopeViolationError("Requested scope is unavailable")
        if request.source_ids:
            with self._sessions.begin() as session:
                session.execute(_SET_TENANT, {"tenant_id": tenant_uuid})
                visible_sources = set(
                    session.scalars(
                        _VALID_SOURCES,
                        {
                            "tenant_id": tenant_uuid,
                            "workspace_id": workspace_uuid,
                            "source_ids": list(request.source_ids),
                        },
                    )
                )
            if visible_sources != set(request.source_ids):
                raise ScopeViolationError("Requested source is unavailable")

    def retrieve(self, request: RetrievalRequest, embedding: tuple[float, ...]) -> QueryResult:
        if len(embedding) != 1024:
            raise ValueError("ADS Q requires a 1024-dimension query embedding")

        tenant_uuid = request.tenant_id.removeprefix("ten_")
        workspace_uuid = request.workspace_id.removeprefix("ws_")
        with self._sessions.begin() as session:
            session.execute(_SET_TENANT, {"tenant_id": tenant_uuid})
            rows = session.execute(
                _QUERY,
                {
                    "tenant_id": tenant_uuid,
                    "workspace_id": workspace_uuid,
                    "embedding": _vector_literal(embedding),
                    "query": request.query,
                    "scope_ids": list(request.scope_ids),
                    "source_ids": list(request.source_ids),
                    "metadata_filter": json.dumps(request.metadata_filter, separators=(",", ":")),
                    "limit": request.top_k,
                },
            ).mappings()
            hits = tuple(self._hit(row) for row in rows)
        memory_facts = self._memory_namespace.list_active_for_scopes(
            tenant_uuid=tenant_uuid,
            workspace_uuid=workspace_uuid,
            scope_ids=request.scope_ids,
            limit=request.top_k,
        )
        return QueryResult(hits=hits, memory_facts=memory_facts)

    def audit(
        self,
        request: RetrievalRequest,
        *,
        candidates: tuple[RetrievalHit, ...] = (),
        results: tuple[RetrievalHit, ...] = (),
        outcome: str,
        failure_reason: str | None = None,
    ) -> datetime | None:
        validate_prefixed_id("ten", request.tenant_id)
        tenant_uuid = request.tenant_id.removeprefix("ten_")
        workspace_uuid = request.workspace_id.removeprefix("ws_")
        with self._sessions.begin() as session:
            session.execute(_SET_TENANT, {"tenant_id": tenant_uuid})
            scope_id = session.scalar(
                _AUDIT_SCOPE, {"tenant_id": tenant_uuid, "workspace_id": workspace_uuid}
            )
            return cast(
                datetime | None,
                session.scalar(
                    _AUDIT,
                    {
                        "id": new_prefixed_id("rta"),
                        "tenant_id": tenant_uuid,
                        "scope_id": scope_id,
                        "requester": request.requester,
                        "query_hash": hashlib.sha256(
                            request.query.strip().lower().encode("utf-8")
                        ).hexdigest(),
                        "scope_inputs": json.dumps(_scope_inputs(request)),
                        "filters": json.dumps(request.metadata_filter, separators=(",", ":")),
                        "candidate_ids": json.dumps(
                            {"chunk_ids": [hit.chunk_id for hit in candidates]}
                        ),
                        "result_doc_ids": json.dumps(
                            {"document_ids": [hit.document_id for hit in results]}
                        ),
                        "confidence": max((hit.confidence for hit in results), default=0.0),
                        "ranking_summary": json.dumps(_ranking_summary(results)),
                        "outcome": outcome,
                        "failure_reason": failure_reason,
                    },
                ),
            )

    def provenance(self, *, tenant_id: str, document_id: str) -> dict[str, object] | None:
        validate_prefixed_id("ten", tenant_id)
        validate_prefixed_id("doc", document_id)
        with self._sessions.begin() as session:
            tenant_uuid = tenant_id.removeprefix("ten_")
            session.execute(_SET_TENANT, {"tenant_id": tenant_uuid})
            row = session.scalar(
                _PROVENANCE, {"tenant_id": tenant_uuid, "document_id": document_id}
            )
            return None if row is None else dict(cast(dict[str, object], row))

    @staticmethod
    def _hit(row: object) -> RetrievalHit:
        mapped = cast(dict[str, object], row)
        score = float(cast(float, mapped["hybrid_score"]))
        return RetrievalHit(
            document_id=str(mapped["document_id"]),
            chunk_id=str(mapped["chunk_id"]),
            seq=int(cast(int, mapped["seq"])),
            source_id=str(mapped["source_id"]),
            scope_id=str(mapped["scope_id"]),
            context=str(mapped["text_content"]),
            reconstructed_context=str(mapped["text_content"]),
            score=score,
            confidence=max(0.0, min(1.0, score)),
            provenance={
                "ingestion": dict(cast(dict[str, object], mapped["provenance"])),
                "document": {
                    "id": str(mapped["document_id"]),
                    "kind": str(mapped["document_kind"]),
                    "title": mapped["title"],
                    "version": int(cast(int, mapped["document_version"])),
                    "freshness_at": _timestamp(mapped["freshness_at"]),
                },
                "source": {
                    "id": str(mapped["source_id"]),
                    "kind": str(mapped["source_kind"]),
                    "provider": mapped["source_provider"],
                    "scope_id": str(mapped["source_scope_id"]),
                },
            },
            metadata=dict(cast(dict[str, object], mapped["metadata"])),
            freshness_at=cast(datetime | None, mapped["freshness_at"]),
            semantic_score=float(cast(float, mapped["semantic_score"])),
            keyword_score=float(cast(float, mapped["keyword_score"])),
        )


def _vector_literal(values: tuple[float, ...]) -> str:
    return "[" + ",".join(str(value) for value in values) + "]"


def _timestamp(value: object) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


class ScopeViolationError(ValueError):
    """The caller requested a scope not visible inside its trusted workspace."""


def _scope_inputs(request: RetrievalRequest) -> dict[str, object]:
    return {
        "workspace_id": request.workspace_id,
        "scope_ids": request.scope_ids,
        "source_ids": request.source_ids,
        "project_id": request.project_id,
        "workflow_id": request.workflow_id,
    }


def _ranking_summary(results: tuple[RetrievalHit, ...]) -> dict[str, object]:
    return {"result_count": len(results), "scores": [hit.score for hit in results]}

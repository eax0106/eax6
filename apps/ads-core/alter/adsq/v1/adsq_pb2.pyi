from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class RetrievalHit(_message.Message):
    __slots__ = ("document_id", "chunk_reference", "score", "confidence", "provenance_json", "context")
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    CHUNK_REFERENCE_FIELD_NUMBER: _ClassVar[int]
    SCORE_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    PROVENANCE_JSON_FIELD_NUMBER: _ClassVar[int]
    CONTEXT_FIELD_NUMBER: _ClassVar[int]
    document_id: str
    chunk_reference: str
    score: float
    confidence: float
    provenance_json: str
    context: str
    def __init__(self, document_id: _Optional[str] = ..., chunk_reference: _Optional[str] = ..., score: _Optional[float] = ..., confidence: _Optional[float] = ..., provenance_json: _Optional[str] = ..., context: _Optional[str] = ...) -> None: ...

class RetrieveRequest(_message.Message):
    __slots__ = ("tenant_id", "workspace_id", "query", "scope_ids", "top_k", "metadata_filter_json", "requester")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    QUERY_FIELD_NUMBER: _ClassVar[int]
    SCOPE_IDS_FIELD_NUMBER: _ClassVar[int]
    TOP_K_FIELD_NUMBER: _ClassVar[int]
    METADATA_FILTER_JSON_FIELD_NUMBER: _ClassVar[int]
    REQUESTER_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    workspace_id: str
    query: str
    scope_ids: _containers.RepeatedScalarFieldContainer[str]
    top_k: int
    metadata_filter_json: str
    requester: str
    def __init__(self, tenant_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., query: _Optional[str] = ..., scope_ids: _Optional[_Iterable[str]] = ..., top_k: _Optional[int] = ..., metadata_filter_json: _Optional[str] = ..., requester: _Optional[str] = ...) -> None: ...

class RetrieveResponse(_message.Message):
    __slots__ = ("hits",)
    HITS_FIELD_NUMBER: _ClassVar[int]
    hits: _containers.RepeatedCompositeFieldContainer[RetrievalHit]
    def __init__(self, hits: _Optional[_Iterable[_Union[RetrievalHit, _Mapping]]] = ...) -> None: ...

class RerankRequest(_message.Message):
    __slots__ = ("tenant_id", "workspace_id", "query", "candidates")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    QUERY_FIELD_NUMBER: _ClassVar[int]
    CANDIDATES_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    workspace_id: str
    query: str
    candidates: _containers.RepeatedCompositeFieldContainer[RetrievalHit]
    def __init__(self, tenant_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., query: _Optional[str] = ..., candidates: _Optional[_Iterable[_Union[RetrievalHit, _Mapping]]] = ...) -> None: ...

class RerankResponse(_message.Message):
    __slots__ = ("hits",)
    HITS_FIELD_NUMBER: _ClassVar[int]
    hits: _containers.RepeatedCompositeFieldContainer[RetrievalHit]
    def __init__(self, hits: _Optional[_Iterable[_Union[RetrievalHit, _Mapping]]] = ...) -> None: ...

class GetProvenanceRequest(_message.Message):
    __slots__ = ("tenant_id", "document_id")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    DOCUMENT_ID_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    document_id: str
    def __init__(self, tenant_id: _Optional[str] = ..., document_id: _Optional[str] = ...) -> None: ...

class GetProvenanceResponse(_message.Message):
    __slots__ = ("provenance_json", "confidence")
    PROVENANCE_JSON_FIELD_NUMBER: _ClassVar[int]
    CONFIDENCE_FIELD_NUMBER: _ClassVar[int]
    provenance_json: str
    confidence: float
    def __init__(self, provenance_json: _Optional[str] = ..., confidence: _Optional[float] = ...) -> None: ...

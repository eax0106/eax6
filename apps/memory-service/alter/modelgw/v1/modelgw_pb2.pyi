from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable
from typing import ClassVar as _ClassVar, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class InvokeRequest(_message.Message):
    __slots__ = ("tenant_id", "run_id", "node_execution_id", "model_alias", "input_json")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    NODE_EXECUTION_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_ALIAS_FIELD_NUMBER: _ClassVar[int]
    INPUT_JSON_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    run_id: str
    node_execution_id: str
    model_alias: str
    input_json: str
    def __init__(self, tenant_id: _Optional[str] = ..., run_id: _Optional[str] = ..., node_execution_id: _Optional[str] = ..., model_alias: _Optional[str] = ..., input_json: _Optional[str] = ...) -> None: ...

class InvokeResponse(_message.Message):
    __slots__ = ("output_json", "usage_json", "resolved_capability", "cache_hit", "estimated_cost_usd")
    OUTPUT_JSON_FIELD_NUMBER: _ClassVar[int]
    USAGE_JSON_FIELD_NUMBER: _ClassVar[int]
    RESOLVED_CAPABILITY_FIELD_NUMBER: _ClassVar[int]
    CACHE_HIT_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_COST_USD_FIELD_NUMBER: _ClassVar[int]
    output_json: str
    usage_json: str
    resolved_capability: str
    cache_hit: bool
    estimated_cost_usd: str
    def __init__(self, output_json: _Optional[str] = ..., usage_json: _Optional[str] = ..., resolved_capability: _Optional[str] = ..., cache_hit: _Optional[bool] = ..., estimated_cost_usd: _Optional[str] = ...) -> None: ...

class StreamRequest(_message.Message):
    __slots__ = ("tenant_id", "run_id", "node_execution_id", "model_alias", "input_json")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    NODE_EXECUTION_ID_FIELD_NUMBER: _ClassVar[int]
    MODEL_ALIAS_FIELD_NUMBER: _ClassVar[int]
    INPUT_JSON_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    run_id: str
    node_execution_id: str
    model_alias: str
    input_json: str
    def __init__(self, tenant_id: _Optional[str] = ..., run_id: _Optional[str] = ..., node_execution_id: _Optional[str] = ..., model_alias: _Optional[str] = ..., input_json: _Optional[str] = ...) -> None: ...

class StreamResponse(_message.Message):
    __slots__ = ("sequence", "delta", "final", "usage_json", "estimated_cost_usd")
    SEQUENCE_FIELD_NUMBER: _ClassVar[int]
    DELTA_FIELD_NUMBER: _ClassVar[int]
    FINAL_FIELD_NUMBER: _ClassVar[int]
    USAGE_JSON_FIELD_NUMBER: _ClassVar[int]
    ESTIMATED_COST_USD_FIELD_NUMBER: _ClassVar[int]
    sequence: int
    delta: str
    final: bool
    usage_json: str
    estimated_cost_usd: str
    def __init__(self, sequence: _Optional[int] = ..., delta: _Optional[str] = ..., final: _Optional[bool] = ..., usage_json: _Optional[str] = ..., estimated_cost_usd: _Optional[str] = ...) -> None: ...

class RedactRequest(_message.Message):
    __slots__ = ("tenant_id", "run_id", "content")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    run_id: str
    content: str
    def __init__(self, tenant_id: _Optional[str] = ..., run_id: _Optional[str] = ..., content: _Optional[str] = ...) -> None: ...

class RedactResponse(_message.Message):
    __slots__ = ("redacted_content", "redaction_count")
    REDACTED_CONTENT_FIELD_NUMBER: _ClassVar[int]
    REDACTION_COUNT_FIELD_NUMBER: _ClassVar[int]
    redacted_content: str
    redaction_count: int
    def __init__(self, redacted_content: _Optional[str] = ..., redaction_count: _Optional[int] = ...) -> None: ...

class SelectFallbackRequest(_message.Message):
    __slots__ = ("tenant_id", "run_id", "node_execution_id", "failed_alias", "required_capabilities")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    NODE_EXECUTION_ID_FIELD_NUMBER: _ClassVar[int]
    FAILED_ALIAS_FIELD_NUMBER: _ClassVar[int]
    REQUIRED_CAPABILITIES_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    run_id: str
    node_execution_id: str
    failed_alias: str
    required_capabilities: _containers.RepeatedScalarFieldContainer[str]
    def __init__(self, tenant_id: _Optional[str] = ..., run_id: _Optional[str] = ..., node_execution_id: _Optional[str] = ..., failed_alias: _Optional[str] = ..., required_capabilities: _Optional[_Iterable[str]] = ...) -> None: ...

class SelectFallbackResponse(_message.Message):
    __slots__ = ("selected_alias", "reason")
    SELECTED_ALIAS_FIELD_NUMBER: _ClassVar[int]
    REASON_FIELD_NUMBER: _ClassVar[int]
    selected_alias: str
    reason: str
    def __init__(self, selected_alias: _Optional[str] = ..., reason: _Optional[str] = ...) -> None: ...

class EmbedRequest(_message.Message):
    __slots__ = ("tenant_id", "text", "dimensions")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    TEXT_FIELD_NUMBER: _ClassVar[int]
    DIMENSIONS_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    text: str
    dimensions: int
    def __init__(self, tenant_id: _Optional[str] = ..., text: _Optional[str] = ..., dimensions: _Optional[int] = ...) -> None: ...

class EmbedResponse(_message.Message):
    __slots__ = ("embedding", "dimensions", "model_id")
    EMBEDDING_FIELD_NUMBER: _ClassVar[int]
    DIMENSIONS_FIELD_NUMBER: _ClassVar[int]
    MODEL_ID_FIELD_NUMBER: _ClassVar[int]
    embedding: _containers.RepeatedScalarFieldContainer[float]
    dimensions: int
    model_id: str
    def __init__(self, embedding: _Optional[_Iterable[float]] = ..., dimensions: _Optional[int] = ..., model_id: _Optional[str] = ...) -> None: ...

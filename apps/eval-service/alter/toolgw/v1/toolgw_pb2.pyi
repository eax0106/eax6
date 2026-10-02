from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class InvokeToolRequest(_message.Message):
    __slots__ = ("tenant_id", "run_id", "node_execution_id", "tool_name", "input_json", "credential_ref")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    NODE_EXECUTION_ID_FIELD_NUMBER: _ClassVar[int]
    TOOL_NAME_FIELD_NUMBER: _ClassVar[int]
    INPUT_JSON_FIELD_NUMBER: _ClassVar[int]
    CREDENTIAL_REF_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    run_id: str
    node_execution_id: str
    tool_name: str
    input_json: str
    credential_ref: str
    def __init__(self, tenant_id: _Optional[str] = ..., run_id: _Optional[str] = ..., node_execution_id: _Optional[str] = ..., tool_name: _Optional[str] = ..., input_json: _Optional[str] = ..., credential_ref: _Optional[str] = ...) -> None: ...

class InvokeToolResponse(_message.Message):
    __slots__ = ("output_json", "audit_id")
    OUTPUT_JSON_FIELD_NUMBER: _ClassVar[int]
    AUDIT_ID_FIELD_NUMBER: _ClassVar[int]
    output_json: str
    audit_id: str
    def __init__(self, output_json: _Optional[str] = ..., audit_id: _Optional[str] = ...) -> None: ...

class ResolveCredentialRequest(_message.Message):
    __slots__ = ("tenant_id", "integration_id", "credential_ref", "run_id")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    INTEGRATION_ID_FIELD_NUMBER: _ClassVar[int]
    CREDENTIAL_REF_FIELD_NUMBER: _ClassVar[int]
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    integration_id: str
    credential_ref: str
    run_id: str
    def __init__(self, tenant_id: _Optional[str] = ..., integration_id: _Optional[str] = ..., credential_ref: _Optional[str] = ..., run_id: _Optional[str] = ...) -> None: ...

class ResolveCredentialResponse(_message.Message):
    __slots__ = ("resolved_reference", "expires_at")
    RESOLVED_REFERENCE_FIELD_NUMBER: _ClassVar[int]
    EXPIRES_AT_FIELD_NUMBER: _ClassVar[int]
    resolved_reference: str
    expires_at: str
    def __init__(self, resolved_reference: _Optional[str] = ..., expires_at: _Optional[str] = ...) -> None: ...

class FetchUrlRequest(_message.Message):
    __slots__ = ("tenant_id", "run_id", "node_execution_id", "url", "network_policy_json")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    NODE_EXECUTION_ID_FIELD_NUMBER: _ClassVar[int]
    URL_FIELD_NUMBER: _ClassVar[int]
    NETWORK_POLICY_JSON_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    run_id: str
    node_execution_id: str
    url: str
    network_policy_json: str
    def __init__(self, tenant_id: _Optional[str] = ..., run_id: _Optional[str] = ..., node_execution_id: _Optional[str] = ..., url: _Optional[str] = ..., network_policy_json: _Optional[str] = ...) -> None: ...

class FetchUrlResponse(_message.Message):
    __slots__ = ("status_code", "content_artifact_id")
    STATUS_CODE_FIELD_NUMBER: _ClassVar[int]
    CONTENT_ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    status_code: int
    content_artifact_id: str
    def __init__(self, status_code: _Optional[int] = ..., content_artifact_id: _Optional[str] = ...) -> None: ...

from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from typing import ClassVar as _ClassVar, Optional as _Optional

DESCRIPTOR: _descriptor.FileDescriptor

class ProposeWritebackRequest(_message.Message):
    __slots__ = ("tenant_id", "workspace_id", "run_id", "verified_output_artifact_id", "namespace")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    VERIFIED_OUTPUT_ARTIFACT_ID_FIELD_NUMBER: _ClassVar[int]
    NAMESPACE_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    workspace_id: str
    run_id: str
    verified_output_artifact_id: str
    namespace: str
    def __init__(self, tenant_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., run_id: _Optional[str] = ..., verified_output_artifact_id: _Optional[str] = ..., namespace: _Optional[str] = ...) -> None: ...

class ProposeWritebackResponse(_message.Message):
    __slots__ = ("memory_id", "candidate_json", "skipped")
    MEMORY_ID_FIELD_NUMBER: _ClassVar[int]
    CANDIDATE_JSON_FIELD_NUMBER: _ClassVar[int]
    SKIPPED_FIELD_NUMBER: _ClassVar[int]
    memory_id: str
    candidate_json: str
    skipped: bool
    def __init__(self, memory_id: _Optional[str] = ..., candidate_json: _Optional[str] = ..., skipped: _Optional[bool] = ...) -> None: ...

class PromoteMemoryRequest(_message.Message):
    __slots__ = ("tenant_id", "memory_id", "evaluation_run_id", "ads_core_scope_id")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    MEMORY_ID_FIELD_NUMBER: _ClassVar[int]
    EVALUATION_RUN_ID_FIELD_NUMBER: _ClassVar[int]
    ADS_CORE_SCOPE_ID_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    memory_id: str
    evaluation_run_id: str
    ads_core_scope_id: str
    def __init__(self, tenant_id: _Optional[str] = ..., memory_id: _Optional[str] = ..., evaluation_run_id: _Optional[str] = ..., ads_core_scope_id: _Optional[str] = ...) -> None: ...

class PromoteMemoryResponse(_message.Message):
    __slots__ = ("promoted", "promoted_at")
    PROMOTED_FIELD_NUMBER: _ClassVar[int]
    PROMOTED_AT_FIELD_NUMBER: _ClassVar[int]
    promoted: bool
    promoted_at: str
    def __init__(self, promoted: _Optional[bool] = ..., promoted_at: _Optional[str] = ...) -> None: ...

class UpdatePolicyRequest(_message.Message):
    __slots__ = ("tenant_id", "policy_id", "current_version", "patch_json")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    POLICY_ID_FIELD_NUMBER: _ClassVar[int]
    CURRENT_VERSION_FIELD_NUMBER: _ClassVar[int]
    PATCH_JSON_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    policy_id: str
    current_version: str
    patch_json: str
    def __init__(self, tenant_id: _Optional[str] = ..., policy_id: _Optional[str] = ..., current_version: _Optional[str] = ..., patch_json: _Optional[str] = ...) -> None: ...

class UpdatePolicyResponse(_message.Message):
    __slots__ = ("policy_id", "new_version")
    POLICY_ID_FIELD_NUMBER: _ClassVar[int]
    NEW_VERSION_FIELD_NUMBER: _ClassVar[int]
    policy_id: str
    new_version: str
    def __init__(self, policy_id: _Optional[str] = ..., new_version: _Optional[str] = ...) -> None: ...

class GetMemorySettingsRequest(_message.Message):
    __slots__ = ("tenant_id", "workspace_id")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    workspace_id: str
    def __init__(self, tenant_id: _Optional[str] = ..., workspace_id: _Optional[str] = ...) -> None: ...

class UpdateMemorySettingsRequest(_message.Message):
    __slots__ = ("tenant_id", "workspace_id", "actor_id", "settings_json", "if_match")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    ACTOR_ID_FIELD_NUMBER: _ClassVar[int]
    SETTINGS_JSON_FIELD_NUMBER: _ClassVar[int]
    IF_MATCH_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    workspace_id: str
    actor_id: str
    settings_json: str
    if_match: str
    def __init__(self, tenant_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., actor_id: _Optional[str] = ..., settings_json: _Optional[str] = ..., if_match: _Optional[str] = ...) -> None: ...

class GetMemorySettingsResponse(_message.Message):
    __slots__ = ("settings_json",)
    SETTINGS_JSON_FIELD_NUMBER: _ClassVar[int]
    settings_json: str
    def __init__(self, settings_json: _Optional[str] = ...) -> None: ...

class UpdateMemorySettingsResponse(_message.Message):
    __slots__ = ("settings_json",)
    SETTINGS_JSON_FIELD_NUMBER: _ClassVar[int]
    settings_json: str
    def __init__(self, settings_json: _Optional[str] = ...) -> None: ...

class MemoryAccessRequest(_message.Message):
    __slots__ = ("tenant_id", "workspace_id", "kind")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    KIND_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    workspace_id: str
    kind: str
    def __init__(self, tenant_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., kind: _Optional[str] = ...) -> None: ...

class MemoryAccessResponse(_message.Message):
    __slots__ = ("allowed", "retention_days")
    ALLOWED_FIELD_NUMBER: _ClassVar[int]
    RETENTION_DAYS_FIELD_NUMBER: _ClassVar[int]
    allowed: bool
    retention_days: int
    def __init__(self, allowed: _Optional[bool] = ..., retention_days: _Optional[int] = ...) -> None: ...

class RecallChatRequest(_message.Message):
    __slots__ = ("tenant_id", "workspace_id", "conversation_id", "messages_json")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    CONVERSATION_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGES_JSON_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    workspace_id: str
    conversation_id: str
    messages_json: str
    def __init__(self, tenant_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., conversation_id: _Optional[str] = ..., messages_json: _Optional[str] = ...) -> None: ...

class RecallWorkflowRequest(_message.Message):
    __slots__ = ("tenant_id", "workspace_id", "workflow_id")
    TENANT_ID_FIELD_NUMBER: _ClassVar[int]
    WORKSPACE_ID_FIELD_NUMBER: _ClassVar[int]
    WORKFLOW_ID_FIELD_NUMBER: _ClassVar[int]
    tenant_id: str
    workspace_id: str
    workflow_id: str
    def __init__(self, tenant_id: _Optional[str] = ..., workspace_id: _Optional[str] = ..., workflow_id: _Optional[str] = ...) -> None: ...

class RecallChatResponse(_message.Message):
    __slots__ = ("memory_json",)
    MEMORY_JSON_FIELD_NUMBER: _ClassVar[int]
    memory_json: str
    def __init__(self, memory_json: _Optional[str] = ...) -> None: ...

class RecallWorkflowResponse(_message.Message):
    __slots__ = ("memory_json",)
    MEMORY_JSON_FIELD_NUMBER: _ClassVar[int]
    memory_json: str
    def __init__(self, memory_json: _Optional[str] = ...) -> None: ...

from __future__ import annotations

import asyncio
from collections.abc import Iterable
from typing import Protocol

import grpc
from sqlalchemy import Engine

from alter.eval.v1 import eval_pb2_grpc
from src.config import Settings, get_settings
from src.db.session import global_eval_sessions
from src.eval_grpc_service import EvalGrpcService
from src.execution.agent_binding_client import AgentBindingEvalClient
from src.execution.architecture_client import ArchitectureClient
from src.execution.audit_client import AuditEvalClient
from src.execution.credential_client import CredentialEvalClient
from src.execution.idempotency_client import IdempotencyReplayClient
from src.execution.ingestion_client import IngestionEvalClient
from src.execution.intent_client import IntentClient
from src.execution.m2m_auth import Auth0M2mTokenProvider
from src.execution.memory_drift_client import MemoryDriftEvalClient
from src.execution.model_cache_client import ModelGatewayCacheClient
from src.execution.orchestrator import EvalRunOrchestrator
from src.execution.planner_client import PlannerClient
from src.execution.policy_client import PolicyEvalClient
from src.execution.project_client import ProjectEvalClient
from src.execution.recovery_client import RecoveryClient
from src.execution.retrieval_client import RetrievalClient
from src.execution.run_visibility_client import RunVisibilityEvalClient
from src.execution.security_client import SecurityEvalClient, UploadEvalClient
from src.execution.toolgw_client import ToolgwClient
from src.execution.trigger_client import TriggerRegistryClient
from src.execution.verification_client import VerificationClient
from src.execution.verification_severity_client import VerificationSeverityEvalClient
from src.execution.workflow_client import WorkflowEvalClient
from src.promotion_gate import PromotionGateRecorder
from src.release_gates import ReleaseGateRecorder
from src.service_auth import ServiceAuthInterceptor, assert_configured_at_startup


class Closable(Protocol):
    def close(self) -> None: ...


def _build_service(settings: Settings) -> tuple[EvalGrpcService, Engine, tuple[Closable, ...]]:
    engine, sessions = global_eval_sessions(settings.eval_db_url_sync)

    verification_client = VerificationClient(
        settings.verification_grpc_target, service_token=settings.internal_service_token
    )
    planner_client = PlannerClient(
        settings.planner_base_url, service_token=settings.internal_service_token
    )
    retrieval_client = RetrievalClient(
        settings.retrieval_grpc_target, service_token=settings.internal_service_token
    )
    intent_client = IntentClient(settings.intent_grpc_target)
    security_client = SecurityEvalClient(settings.security_eval_base_url)
    upload_client = UploadEvalClient(
        settings.upload_eval_base_url,
        service_token=settings.internal_service_token,
    )
    tenant_isolation_retrieval_client = RetrievalClient(
        settings.tenant_isolation_retrieval_grpc_target,
        service_token=settings.internal_service_token,
    )
    m2m = Auth0M2mTokenProvider(
        token_url=settings.auth0_m2m_token_url,
        audience=settings.auth0_m2m_audience,
        client_id=settings.auth0_m2m_client_id,
        client_secret=settings.auth0_m2m_client_secret,
    )
    toolgw_client = ToolgwClient(settings.toolgw_grpc_target, access_token_provider=m2m)
    recovery_client = RecoveryClient(settings.recovery_grpc_target, settings.orchestration_db_url)
    trigger_registry_client = TriggerRegistryClient(
        settings.trigger_registry_base_url, settings.orchestration_db_url
    )
    credential_client = CredentialEvalClient(settings.credential_base_url, settings.platform_db_url)
    tool_consume_client = ToolgwClient(settings.tool_consume_grpc_target, access_token_provider=m2m)
    idempotency_replay_client = IdempotencyReplayClient(
        tenant_a_base_url=settings.idempotency_tenant_a_base_url,
        tenant_b_base_url=settings.idempotency_tenant_b_base_url,
        db_url=settings.platform_db_url,
    )
    ingestion_client = IngestionEvalClient(
        settings.ingestion_base_url,
        settings.ads_db_url,
        service_token=settings.internal_service_token,
    )
    policy_client = PolicyEvalClient(
        settings.policy_base_url,
        settings.policy_db_url,
        service_token=settings.internal_service_token,
    )
    run_visibility_client = RunVisibilityEvalClient(
        settings.run_visibility_base_url, settings.orchestration_db_url
    )
    model_cache_client = ModelGatewayCacheClient(
        settings.model_gateway_grpc_target, access_token_provider=m2m
    )
    verification_severity_client = VerificationSeverityEvalClient(
        settings.verification_severity_grpc_target,
        settings.orchestration_db_url,
        service_token=settings.internal_service_token,
    )
    audit_client = AuditEvalClient(settings.audit_grpc_target, access_token_provider=m2m)
    memory_drift_client = MemoryDriftEvalClient(
        settings.memory_drift_base_url,
        settings.policy_db_url,
        service_token=settings.internal_service_token,
    )
    workflow_client = WorkflowEvalClient(settings.workflow_base_url, settings.orchestration_db_url)
    agent_binding_client = AgentBindingEvalClient(
        settings.agent_binding_base_url, settings.intelligence_db_url
    )
    project_client = ProjectEvalClient(settings.project_base_url, settings.orchestration_db_url)
    # The Architecture Synthesizer is served by intelligence-service, the same
    # service and base URL as the planner.
    architecture_client = ArchitectureClient(
        settings.planner_base_url, service_token=settings.internal_service_token
    )

    clients: tuple[Closable, ...] = (
        verification_client,
        architecture_client,
        planner_client,
        retrieval_client,
        intent_client,
        security_client,
        upload_client,
        tenant_isolation_retrieval_client,
        toolgw_client,
        recovery_client,
        trigger_registry_client,
        credential_client,
        tool_consume_client,
        idempotency_replay_client,
        ingestion_client,
        policy_client,
        run_visibility_client,
        model_cache_client,
        verification_severity_client,
        audit_client,
        memory_drift_client,
        workflow_client,
        agent_binding_client,
        project_client,
    )
    orchestrator = EvalRunOrchestrator(
        sessions,
        verification_client,
        planner_client,
        retrieval_client,
        intent_client,
        security_client,
        upload_client,
        tenant_isolation_retrieval_client,
        toolgw_client,
        recovery_client,
        trigger_registry_client,
        credential_client,
        tool_consume_client,
        idempotency_replay_client,
        ingestion_client,
        policy_client,
        run_visibility_client,
        model_cache_client,
        verification_severity_client,
        audit_client,
        memory_drift_client,
        workflow_client,
        agent_binding_client,
        project_client,
        architecture_client,
    )
    service = EvalGrpcService(
        orchestrator, ReleaseGateRecorder(sessions), PromotionGateRecorder(sessions)
    )
    return (
        service,
        engine,
        clients,
    )


async def serve() -> None:
    settings = get_settings()
    # A missing credential is a boot failure, never a per-RPC surprise.
    assert_configured_at_startup()
    service, engine, clients = _build_service(settings)
    # Every RPC requires the internal service credential -- interceptor, not
    # per-RPC checks, so a new RPC cannot forget it.
    server = grpc.aio.server(interceptors=[ServiceAuthInterceptor()])
    eval_pb2_grpc.add_EvalServiceServicer_to_server(service, server)  # type: ignore[no-untyped-call]
    server.add_insecure_port(settings.grpc_bind_address)
    await server.start()
    try:
        await server.wait_for_termination()
    finally:
        await server.stop(grace=5)
        _close_all(clients)
        engine.dispose()


def _close_all(clients: Iterable[Closable]) -> None:
    for client in clients:
        client.close()


if __name__ == "__main__":
    asyncio.run(serve())

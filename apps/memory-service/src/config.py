from functools import lru_cache
from typing import Literal

from pydantic import AnyHttpUrl, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    runtime_mode: Literal["real", "mock"] = "mock"
    alter_config_source: Literal["appconfig", "local-file"] = "local-file"
    node_env: str = "development"
    policy_db_url_sync: str = (
        "postgresql+psycopg2://memory_service:memory_local@localhost:5433/policy_db"
    )
    policy_db_system_url_sync: str = (
        "postgresql+psycopg2://policy_system_writer@localhost:5433/policy_db"
    )
    orchestration_service_base_url: AnyHttpUrl = AnyHttpUrl("http://127.0.0.1:3000")
    orchestration_service_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    intelligence_service_base_url: AnyHttpUrl = AnyHttpUrl("http://127.0.0.1:8000")
    intelligence_service_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    ads_core_base_url: AnyHttpUrl = AnyHttpUrl("http://127.0.0.1:8000")
    ads_core_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    cost_ledger_service_base_url: AnyHttpUrl = AnyHttpUrl("http://127.0.0.1:8000")
    cost_ledger_service_timeout_seconds: float = Field(default=5.0, gt=0, le=30)
    # This service's own machine-to-machine identity, used for every outbound
    # call it makes. It previously forwarded whichever credential its caller
    # arrived with, which made the callee authorise the caller rather than
    # memory-service, and replayed a token minted for one audience against
    # another. Same four settings ads-core, intelligence-service and
    # eval-service already declare.
    #
    # Empty defaults, and LazyAuth0M2mTokenProvider validates them on the
    # first outbound call rather than at import: a deployment that makes no
    # outbound call should not be forced to configure one, and a misconfigured
    # one should fail where the call is, naming the call.
    auth0_m2m_token_url: str = ""
    auth0_m2m_audience: str = ""
    auth0_m2m_client_id: str = ""
    auth0_m2m_client_secret: str = ""
    # SHA-256 of the shared deletion service token audit-service presents to erasure providers.
    deletion_service_token_sha256: str = ""
    drift_failure_threshold: float = Field(default=0.2, ge=0, le=1)
    drift_window_size: int = Field(default=20, ge=2, le=100)
    # gt=0, not ge=0: DriftDetector rejects a significance_level of exactly
    # 0 (would mean "never statistically significant", not a real gate).
    drift_significance_level: float = Field(default=0.05, gt=0, le=1)

    @model_validator(mode="after")
    def reject_mock_runtime_in_production(self) -> "Settings":
        if self.runtime_mode == "mock" and self.node_env == "production":
            raise ValueError("RUNTIME_MODE=mock is not allowed when NODE_ENV=production")
        return self

    model_config = SettingsConfigDict(
        env_file=".env.local",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()

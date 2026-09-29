from functools import lru_cache
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    runtime_mode: Literal["real", "mock"] = "mock"
    alter_config_source: Literal["appconfig", "local-file"] = "local-file"
    node_env: str = "development"
    intelligence_db_url: str = "postgresql+asyncpg://intelligence_service:intelligence_local@localhost:5433/intelligence_db"
    intelligence_db_url_sync: str = "postgresql+psycopg2://intelligence_service:intelligence_local@localhost:5433/intelligence_db"
    intelligence_drift_reader_db_url: str = "postgresql+asyncpg://intelligence_drift_reader:intelligence_drift_reader_local@localhost:5433/intelligence_db"
    adsq_grpc_target: str = "localhost:50050"
    adsq_grpc_timeout_seconds: float = 3.0
    model_gateway_grpc_target: str = "localhost:50051"
    model_gateway_grpc_timeout_seconds: float = 15.0
    auth0_m2m_token_url: str = ""
    auth0_m2m_audience: str = ""
    auth0_m2m_client_id: str = ""
    auth0_m2m_client_secret: str = ""
    memory_service_base_url: str = "http://localhost:8002"
    internal_service_token: str = ""
    # SHA-256 of the shared deletion service token audit-service presents to erasure providers.
    deletion_service_token_sha256: str = ""
    # A role that may list every tenant (deletion-ledger replay); empty disables that route.
    intelligence_deletion_db_url_sync: str = ""
    capability_grpc_bind_address: str = "0.0.0.0:50061"
    draft_agent_promotion_threshold: int = 3
    # Highest tier agent auto-creation may mint. A genuine capability gap is
    # created at the tier the requirement asked for, because no cheaper tier
    # satisfies a >= filter -- so without a ceiling any caller could cause a
    # CEILING agent to exist just by asking for one. Above this, the no-match
    # is returned instead, which is a real answer rather than a failure to
    # route around.
    agent_auto_creation_max_tier: str = "STANDARD"

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

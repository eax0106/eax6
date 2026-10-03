from functools import lru_cache
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    runtime_mode: Literal["real", "mock"] = "mock"
    alter_config_source: Literal["appconfig", "local-file"] = "local-file"
    node_env: str = "development"
    ads_db_url: str = "postgresql+asyncpg://ads_core:ads_core_local@localhost:5434/ads_db"
    ads_db_url_sync: str = "postgresql+psycopg2://ads_core:ads_core_local@localhost:5434/ads_db"
    # Dedicated BYPASSRLS connection used only by the authenticated internal
    # deletion API to enumerate subjects and perform cross-tenant retention.
    # Production injects this connection string from the existing secrets path.
    ads_deletion_db_url_sync: str = (
        "postgresql+psycopg2://ads_deletion:ads_deletion_local@localhost:5434/ads_db"
    )
    ads_ingestion_max_content_bytes: int = 25 * 1024 * 1024
    ads_ingestion_allowed_mime_types: str = (
        "application/json,text/plain,application/pdf,image/png,image/jpeg"
    )
    ads_ingestion_stub_bad_signatures: str = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE"
    # Empty is allowed and fail-closed: router.py compares a caller's digest
    # against this, so an unset value rejects every deletion request. The
    # previous Field(default="", min_length=64) could never validate its own
    # default, so the service refused to start -- and refused to migrate --
    # until the credential was set, even for work that never touches deletion.
    deletion_service_token_sha256: str = Field(
        default="",
        pattern=r"^$|^[0-9a-f]{64}$",
    )
    model_gateway_grpc_target: str = "localhost:50051"
    memory_service_address: str = "localhost:50060"
    memory_service_authorization: str = ""
    auth0_m2m_token_url: str = ""
    auth0_m2m_audience: str = ""
    auth0_m2m_client_id: str = ""
    auth0_m2m_client_secret: str = ""

    # KNOW-6: presigned uploads. Empty bucket name (default) means "no real
    # AWS/S3 config present" -- the app wires InMemoryObjectStorageProvider
    # in that case, never assumes credentials exist. Setting a bucket name
    # (and optionally an endpoint_url for LocalStack) is required to
    # activate the real S3ObjectStorageProvider.
    ads_uploads_bucket_name: str = ""
    ads_uploads_s3_endpoint_url: str | None = None
    ads_uploads_s3_region: str = "ap-south-1"
    ads_uploads_presign_expiry_seconds: int = 900
    ads_connectors_secrets_region: str | None = None
    ads_q_max_concurrency: int = Field(default=16, ge=1, le=128)

    @model_validator(mode="after")
    def reject_mock_runtime_in_production(self) -> "Settings":
        if self.runtime_mode == "mock" and self.node_env == "production":
            raise ValueError("RUNTIME_MODE=mock is not allowed when NODE_ENV=production")
        return self

    model_config = SettingsConfigDict(
        env_file=".env.local",
        env_file_encoding="utf-8",
        case_sensitive=False,
        validate_default=True,
        # .env.local is shared by every service in the monorepo, so it always
        # carries keys this service does not declare -- another service's
        # database URL, another service's bind address. Rejecting them made
        # ads-core the one service that could not start from the documented
        # steps, failing on a variable belonging to memory-service rather than
        # on anything of its own.
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()

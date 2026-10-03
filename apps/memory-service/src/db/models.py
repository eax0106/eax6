from datetime import datetime

from sqlalchemy import DateTime, Integer, Numeric, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.sql import func


class Base(DeclarativeBase):
    pass


class Policy(Base):
    __tablename__ = "policies"
    __table_args__ = (
        UniqueConstraint(
            "scope", "scope_id", "kind", "version", name="policies_scope_version_unique"
        ),
    )

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    scope: Mapped[str] = mapped_column(Text, nullable=False)
    scope_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    body: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    eval_gate_run_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class PolicyPromotion(Base):
    __tablename__ = "policy_promotions"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    policy_id: Mapped[str] = mapped_column(Text, nullable=False)
    from_version: Mapped[int | None] = mapped_column(Integer)
    to_version: Mapped[int | None] = mapped_column(Integer)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class DriftScore(Base):
    __tablename__ = "drift_scores"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    # Set on agent rows, NULL on model/provider ones: model and provider drift
    # are platform-wide facts every tenant may read, while agent drift belongs
    # to one tenant and drift_read scopes it on this column.
    tenant_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    subject_type: Mapped[str] = mapped_column(Text, nullable=False)
    subject_ref: Mapped[str] = mapped_column(Text, nullable=False)
    task_class: Mapped[str | None] = mapped_column(Text)
    score: Mapped[float] = mapped_column(Numeric, nullable=False)
    baseline: Mapped[float | None] = mapped_column(Numeric)
    window: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    action_taken: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class MemoryRecord(Base):
    __tablename__ = "memory_records"

    id: Mapped[str] = mapped_column(Text, primary_key=True)
    tenant_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    workspace_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False))
    memory_kind: Mapped[str | None] = mapped_column(Text)
    context_id: Mapped[str | None] = mapped_column(Text)
    scope: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    provenance: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    destination: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    promoted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reverted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

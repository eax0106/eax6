from __future__ import annotations

import json
import uuid

from sqlalchemy import CursorResult, text
from sqlalchemy.engine import RowMapping
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.ids import PLATFORM_TENANT_ID

from .models import CapabilityRecord, CapabilitySearch, RegisterCapability

_SET_TENANT = text("SELECT set_config('app.current_tenant_id', :tenant_id, true)")


class CapabilityRegistryError(ValueError):
    pass


def _uuid(value: str, prefix: str | None = None) -> str:
    raw = value.split("_", 1)[1] if prefix is not None and value.startswith(f"{prefix}_") else value
    try:
        return str(uuid.UUID(raw))
    except ValueError as error:
        raise CapabilityRegistryError("invalid tenant or workspace identifier") from error


class CapabilityRegistryRepository:
    """Facts-only, tenant-scoped catalog; it never ranks or binds candidates."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def register(self, tenant_id: str, request: RegisterCapability) -> CapabilityRecord:
        tenant = _uuid(tenant_id, "ten")
        owner = PLATFORM_TENANT_ID if request.scope == "global" else tenant
        if request.scope == "global" and tenant != PLATFORM_TENANT_ID:
            raise CapabilityRegistryError("global records require platform tenant context")
        try:
            await self._session.execute(_SET_TENANT, {"tenant_id": owner})
            record = await self._insert_version(owner, request)
            await self._session.commit()
            return record
        except IntegrityError as error:
            await self._session.rollback()
            raise CapabilityRegistryError(
                "an active version already exists; use supersede to create a replacement"
            ) from error
        except Exception:
            await self._session.rollback()
            raise

    async def _insert_version(
        self, owner: str, request: RegisterCapability
    ) -> CapabilityRecord:
        result = await self._session.execute(
            text(
                "SELECT COALESCE(MAX(version), 0) + 1 "
                "FROM capability_registry_versions "
                "WHERE owner_tenant_id = CAST(:owner AS uuid) "
                "AND capability_id = :capability_id"
            ),
            {"owner": owner, "capability_id": request.capability_id},
        )
        version = int(result.scalar_one())
        await self._session.execute(
            text("""INSERT INTO capability_registry_versions
              (capability_id, version, owner_tenant_id, scope, workspace_id, kind,
               supported_capabilities, side_effects, constraints, availability, provenance,
               metadata, status)
              VALUES (:capability_id, :version, CAST(:owner AS uuid), :scope,
               CAST(:workspace_id AS uuid), :kind, CAST(:capabilities AS jsonb),
               :side_effects, CAST(:constraints AS jsonb), CAST(:availability AS jsonb),
               CAST(:provenance AS jsonb), CAST(:metadata AS jsonb), 'active')"""),
            {
                "capability_id": request.capability_id,
                "version": version,
                "owner": owner,
                "scope": request.scope,
                "workspace_id": _uuid(request.workspace_id, "ws") if request.workspace_id else None,
                "kind": request.kind,
                "capabilities": json.dumps(request.supported_capabilities),
                "side_effects": request.side_effects,
                "constraints": request.constraints.model_dump_json(),
                "availability": request.availability.model_dump_json(),
                "provenance": json.dumps(request.provenance),
                "metadata": json.dumps(request.metadata),
            },
        )
        return CapabilityRecord(
            **request.model_dump(), version=version, status="active", owner_tenant_id=owner
        )

    async def search(self, tenant_id: str, query: CapabilitySearch) -> list[CapabilityRecord]:
        tenant = _uuid(tenant_id, "ten")
        await self._session.execute(_SET_TENANT, {"tenant_id": tenant})
        result = await self._session.execute(
            text("""SELECT capability_id, version, owner_tenant_id::text, scope,
                 workspace_id::text, kind, supported_capabilities, side_effects, constraints,
                 availability, provenance, metadata, status
          FROM capability_registry_versions
          WHERE (owner_tenant_id = CAST(:tenant AS uuid) OR scope = 'global')
            AND (CAST(:kind AS text) IS NULL OR kind = CAST(:kind AS text))
            AND (CAST(:model_alias AS text) IS NULL
                 OR metadata ->> 'model_alias' = CAST(:model_alias AS text))
            AND (CAST(:workspace_id AS uuid) IS NULL OR workspace_id IS NULL
                 OR workspace_id = CAST(:workspace_id AS uuid))
            AND (:include_inactive OR status = 'active')
            AND supported_capabilities @> CAST(:capabilities AS jsonb)
          ORDER BY capability_id ASC, version DESC
          LIMIT :limit OFFSET :offset"""),
            {
                "tenant": tenant,
                "kind": query.kind,
                "model_alias": query.model_alias,
                "workspace_id": _uuid(query.workspace_id, "ws") if query.workspace_id else None,
                "include_inactive": query.include_inactive,
                "capabilities": json.dumps(query.capabilities),
                "limit": query.limit,
                "offset": query.offset,
            },
        )
        return [_record(row) for row in result.mappings()]

    async def get(self, tenant_id: str, capability_id: str, version: int) -> CapabilityRecord:
        if version <= 0:
            raise CapabilityRegistryError("version must be positive")
        tenant = _uuid(tenant_id, "ten")
        await self._session.execute(_SET_TENANT, {"tenant_id": tenant})
        result = await self._session.execute(
            text(
                "SELECT capability_id, version, owner_tenant_id::text, scope, "
                "workspace_id::text, kind, supported_capabilities, side_effects, constraints, "
                "availability, provenance, metadata, status "
                "FROM capability_registry_versions "
                "WHERE capability_id = :capability_id AND version = :version "
                "AND (owner_tenant_id = CAST(:tenant AS uuid) OR scope = 'global')"
            ),
            {"tenant": tenant, "capability_id": capability_id, "version": version},
        )
        row = result.mappings().first()
        if row is None:
            raise CapabilityRegistryError("capability version not found")
        return _record(row)

    async def deactivate(self, tenant_id: str, capability_id: str, version: int) -> None:
        tenant = _uuid(tenant_id, "ten")
        try:
            await self._session.execute(_SET_TENANT, {"tenant_id": tenant})
            result = await self._session.execute(
                text(
                    "UPDATE capability_registry_versions SET status = 'deprecated' "
                    "WHERE owner_tenant_id = CAST(:tenant AS uuid) "
                    "AND capability_id = :capability_id AND version = :version "
                    "AND status = 'active'"
                ),
                {"tenant": tenant, "capability_id": capability_id, "version": version},
            )
            if not isinstance(result, CursorResult) or result.rowcount != 1:
                raise CapabilityRegistryError("only an active owned version may be deactivated")
            await self._session.commit()
        except Exception:
            await self._session.rollback()
            raise

    async def supersede(
        self, tenant_id: str, capability_id: str, request: RegisterCapability
    ) -> CapabilityRecord:
        if capability_id != request.capability_id:
            raise CapabilityRegistryError("superseding record must keep capability_id")
        tenant = _uuid(tenant_id, "ten")
        try:
            await self._session.execute(_SET_TENANT, {"tenant_id": tenant})
            active = await self._session.execute(
                text(
                    "UPDATE capability_registry_versions SET status = 'superseded' "
                    "WHERE owner_tenant_id = CAST(:tenant AS uuid) "
                    "AND capability_id = :capability_id AND status = 'active'"
                ),
                {"tenant": tenant, "capability_id": capability_id},
            )
            if not isinstance(active, CursorResult) or active.rowcount != 1:
                raise CapabilityRegistryError("exactly one active version is required to supersede")
            record = await self._insert_version(tenant, request)
            await self._session.commit()
            return record
        except Exception:
            await self._session.rollback()
            raise


def _record(row: RowMapping) -> CapabilityRecord:
    value = dict(row)
    return CapabilityRecord(
        capability_id=value["capability_id"],
        version=value["version"],
        owner_tenant_id=value["owner_tenant_id"],
        kind=value["kind"],
        scope=value["scope"],
        workspace_id=value["workspace_id"],
        supported_capabilities=value["supported_capabilities"],
        side_effects=value["side_effects"],
        constraints=value["constraints"],
        availability=value["availability"],
        provenance=value["provenance"],
        metadata=value["metadata"],
        status=value["status"],
    )

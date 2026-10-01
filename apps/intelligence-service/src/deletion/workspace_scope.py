"""D2 workspace erasure scope, derived from the live schema.

The same rule as ``planWorkspaceScope`` in @alterx/adapters: a table holds a
workspace's rows when it carries ``tenant_id`` and ``workspace_id`` itself, or
when a foreign key leads to a table that does. Predicates bind ``:tenant`` and
``:workspace`` (bare uuids, compared as text).
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.orm import Session

_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]*$")


@dataclass(frozen=True)
class WorkspaceScopePlan:
    scoped: dict[str, str]
    unscoped: tuple[str, ...]


def plan_workspace_scope(
    session: Session,
    tables: Sequence[str],
    tenant_columns: Mapping[str, str] | None = None,
) -> WorkspaceScopePlan:
    """``tenant_columns`` names a table's tenant column when it is not ``tenant_id``."""
    tenant_columns = tenant_columns or {}
    for table in tables:
        _identifier(table)
    columns: dict[str, set[str]] = {}
    for table_name, column_name in session.execute(
        text(
            "SELECT table_name, column_name FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = ANY(:tables)"
        ),
        {"tables": list(tables)},
    ).all():
        columns.setdefault(table_name, set()).add(column_name)
    foreign_keys = session.execute(
        text(
            "SELECT child.relname::text, parent.relname::text, "
            "array_agg(ca.attname::text ORDER BY k.ord), "
            "array_agg(pa.attname::text ORDER BY k.ord) "
            "FROM pg_constraint c "
            "JOIN pg_class child ON child.oid = c.conrelid "
            "JOIN pg_class parent ON parent.oid = c.confrelid "
            "JOIN pg_namespace n ON n.oid = child.relnamespace AND n.nspname = current_schema() "
            "CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(ck, pk, ord) "
            "JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.ck "
            "JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.pk "
            "WHERE c.contype = 'f' AND child.relname = ANY(:tables) "
            "AND parent.relname = ANY(:tables) "
            "GROUP BY c.oid, c.conname, child.relname, parent.relname ORDER BY c.conname"
        ),
        {"tables": list(tables)},
    ).all()

    predicates: dict[str, str] = {}
    for table in tables:
        own = columns.get(table, set())
        tenant_column = _identifier(tenant_columns.get(table, "tenant_id"))
        if tenant_column in own and "workspace_id" in own:
            predicates[table] = (
                f"{tenant_column}::text = :tenant AND workspace_id::text = :workspace"
            )
    changed = True
    while changed:
        changed = False
        for table in tables:
            if table in predicates:
                continue
            for child, parent, child_columns, parent_columns in foreign_keys:
                if child != table or parent == table or parent not in predicates:
                    continue
                child_list = ", ".join(_identifier(column) for column in child_columns)
                parent_list = ", ".join(_identifier(column) for column in parent_columns)
                predicates[table] = (
                    f"({child_list}) IN (SELECT {parent_list} FROM {parent} "
                    f"WHERE {predicates[parent]})"
                )
                changed = True
                break
    return WorkspaceScopePlan(
        scoped={table: predicates[table] for table in tables if table in predicates},
        unscoped=tuple(table for table in tables if table not in predicates),
    )


def _identifier(value: str) -> str:
    if not _IDENTIFIER.match(value):
        raise ValueError(f"Unsafe SQL identifier in workspace scope: {value}")
    return value

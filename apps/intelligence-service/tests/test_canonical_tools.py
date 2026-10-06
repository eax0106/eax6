"""The canonical tool list must match the contract the tool gateway dispatches."""

import ast
import re
from pathlib import Path

from src.capability_registry.canonical_tools import CANONICAL_TOOL_SIDE_EFFECTS, tool_capability

REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACT = REPO_ROOT / "packages/contracts/src/tool-names.ts"
VERSIONS = Path(__file__).resolve().parents[1] / "alembic/versions"
MIGRATIONS = (
    VERSIONS / "0008_register_canonical_tools.py",
    VERSIONS / "0010_register_workspace_tools.py",
)


def _contract_tool_names() -> list[str]:
    source = CONTRACT.read_text()
    body = re.search(r"ToolNameSchema = z\.enum\(\[(.*?)\]\)", source, re.DOTALL)
    assert body is not None, "ToolNameSchema enum not found in tool-names.ts"
    return re.findall(r'"([^"]+)"', body.group(1))


def test_names_match_the_contract_in_order() -> None:
    assert list(CANONICAL_TOOL_SIDE_EFFECTS) == _contract_tool_names()


def _migration_tools(path: Path) -> dict[str, bool]:
    tree = ast.parse(path.read_text())
    tools = next(
        node.value
        for node in tree.body
        if isinstance(node, ast.AnnAssign)
        and isinstance(node.target, ast.Name)
        and node.target.id == "_TOOLS"
        and node.value is not None
    )
    return dict(ast.literal_eval(tools))


def test_the_registering_migrations_together_register_exactly_these_labels() -> None:
    # Each migration copies its values so it keeps its meaning; taken in order
    # they must add up to the current list, with no tool registered twice.
    registered: dict[str, bool] = {}
    for path in MIGRATIONS:
        tools = _migration_tools(path)
        assert not set(tools) & set(registered), f"{path.name} re-registers a tool"
        registered.update(tools)
    assert registered == CANONICAL_TOOL_SIDE_EFFECTS


def test_only_reads_are_free_of_side_effects() -> None:
    assert sorted(name for name, acts in CANONICAL_TOOL_SIDE_EFFECTS.items() if not acts) == [
        "browser.extract",
        "database.select",
        "knowledge.search",
        "search.web",
    ]


def test_tool_capability_is_none_outside_the_list() -> None:
    assert tool_capability("search.web") == "tool.search.web"
    assert tool_capability("youtube_upload") is None

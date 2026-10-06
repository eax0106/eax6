"""The canonical tools and whether each acts on the outside world.

packages/contracts/src/tool-names.ts (ToolNameSchema) is the source of truth
for the names; tests/test_canonical_tools.py fails if this list drifts from it.
The tool gateway dispatches exactly these, so a tool name outside this list
cannot run.

Each tool is registered in the Capability Registry as a global record whose
only capability is ``tool.<name>`` (migration 0008), and the resolver gives a
ToolCall node that capability. That is how a tool node's side effects reach
synthesis, which approves only actions that may have them.

Read-only means the call cannot send, create, change or delete anything,
here or elsewhere. When in doubt a tool has side effects:
browser.navigate can trigger state-changing GET endpoints, and opening or
closing a browser session is not a read.
"""

CANONICAL_TOOL_SIDE_EFFECTS: dict[str, bool] = {
    "search.web": False,
    "database.select": False,
    "database.insert": True,
    "database.update": True,
    "database.delete": True,
    "browser.session.create": True,
    "browser.navigate": True,
    "browser.click": True,
    "browser.extract": False,
    "browser.session.close": True,
    "email.send": True,
    "knowledge.search": False,
    "whatsapp.send": True,
}

TOOL_CAPABILITY_PREFIX = "tool."


def tool_capability(tool_name: str) -> str | None:
    """The capability a node calling this tool requires, or None for a name
    outside the canonical list, which the Registry holds no record for."""

    if tool_name not in CANONICAL_TOOL_SIDE_EFFECTS:
        return None
    return f"{TOOL_CAPABILITY_PREFIX}{tool_name}"

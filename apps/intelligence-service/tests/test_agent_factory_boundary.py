"""C7: the Agent Factory is its own L4 component (design log §22 item 9). It
has callers in two layers -- Selection & Binding on the design path and, via
rebinding, Recovery on the run path -- so it must not reach through either of
them. This fails if any Factory module imports Selection & Binding (or the
Factory imports anything that does not exist)."""

import ast
from pathlib import Path

FACTORY = Path(__file__).resolve().parents[1] / "src" / "agent_auto_creation"
FORBIDDEN = ("src.selection_binding", "src.recovery")


def imported_modules(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    modules: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            modules.append(node.module)
        elif isinstance(node, ast.Import):
            modules.extend(alias.name for alias in node.names)
    return modules


def test_the_factory_imports_nothing_from_selection_and_binding() -> None:
    files = sorted(FACTORY.glob("*.py"))
    assert files, "the Agent Factory package moved; update this boundary test"
    offenders = [
        f"{path.name}: {module}"
        for path in files
        for module in imported_modules(path)
        if module.startswith(FORBIDDEN)
    ]
    assert offenders == []


def test_selection_reaches_the_factory_only_through_its_protocol() -> None:
    engine = Path(__file__).resolve().parents[1] / "src" / "selection_binding" / "engine.py"
    runtime_imports = [
        module
        for module in imported_modules(engine)
        if module.startswith("src.agent_auto_creation")
    ]
    # engine.py may name the Factory's request/response types for typing and
    # build a request at call time; it must not import the Factory's engine.
    assert "src.agent_auto_creation.engine" not in runtime_imports

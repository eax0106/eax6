"""The D18 starter set as authored: eight Alter-authored templates, each a
well-formed definition the engine can instantiate (compilation itself is
proven by the engine's own spec over the same files)."""

import json
import re
from pathlib import Path

import pytest

from src.capability_registry.canonical_tools import CANONICAL_TOOL_SIDE_EFFECTS
from src.capability_registry.templates import TemplateDefinition

TEMPLATE_DIR = Path(__file__).parent.parent / "src" / "capability_registry" / "templates" / "v1"
FILES = sorted(TEMPLATE_DIR.glob("*.json"))
PLACEHOLDER = re.compile(r"\$alter:(credential|connection):([a-z0-9-]+)")
RUN_SCOPED_CREDENTIALS = {"email-send", "web-search", "knowledge-search", "whatsapp-send"}


def _definition(path: Path) -> TemplateDefinition:
    return TemplateDefinition.model_validate(json.loads(path.read_text()))


def _tool_nodes(definition: TemplateDefinition) -> list[dict[str, object]]:
    return [node for node in definition.skeleton["nodes"] if node["type"] == "tool"]


def test_the_set_is_exactly_the_eight_d18_templates() -> None:
    ids = [_definition(path).template_id for path in FILES]
    assert ids == [
        "lead-capture-crm-welcome",
        "support-email-triage",
        "invoice-email-to-sheet",
        "weekly-report-digest",
        "knowledge-qa",
        "meeting-notes-summary",
        "brand-mention-alert",
        "whatsapp-faq-responder",
    ]


@pytest.mark.parametrize("path", FILES, ids=lambda path: path.stem)
def test_each_template_is_well_formed(path: Path) -> None:
    definition = _definition(path)
    skeleton = definition.skeleton
    assert skeleton["success_criteria"], "a template states its own success criteria"
    for node in _tool_nodes(definition):
        config = node["config"]
        assert isinstance(config, dict)
        arguments = config["arguments"]
        assert isinstance(arguments, dict)
        assert config["tool_name"] in CANONICAL_TOOL_SIDE_EFFECTS
        if "required_connector" in config:
            assert "credential_ref" not in config
            assert arguments["databaseId"] == (
                f"$alter:connection:{config['required_connector']}"
            )
        else:
            match = PLACEHOLDER.fullmatch(str(config["credential_ref"]))
            assert match is not None and match.group(1) == "credential"
            assert match.group(2) in RUN_SCOPED_CREDENTIALS
    connectors = {
        config["required_connector"]
        for node in _tool_nodes(definition)
        for config in [node["config"]]
        if isinstance(config, dict) and "required_connector" in config
    }
    assert connectors == {
        requirement.connector_type
        for requirement in definition.requirements
        if requirement.kind == "connection"
    }, "every connection a template needs is listed as a requirement"


@pytest.mark.parametrize("path", FILES, ids=lambda path: path.stem)
def test_templates_carry_no_tenant_or_workspace_identifiers(path: Path) -> None:
    raw = path.read_text()
    assert not re.search(r"\b(ten|ws|wf|usr|run)_[0-9a-f]{8}-", raw)
    assert "/alter/integrations/" not in raw
    assert "/tenant/" not in raw

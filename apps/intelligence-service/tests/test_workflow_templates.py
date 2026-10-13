"""The D18 starter set as authored: eight Alter-authored templates, each a
well-formed definition the engine can instantiate (compilation itself is
proven by the engine's own spec over the same files). templates/v4 is the
current set; v1 to v3 stay as revisions 0011 to 0013 seeded them."""

import importlib.util
import json
import re
from pathlib import Path

import pytest

from src.capability_registry.canonical_tools import CANONICAL_TOOL_SIDE_EFFECTS
from src.capability_registry.templates import TemplateDefinition

TEMPLATES = Path(__file__).parent.parent / "src" / "capability_registry" / "templates"
TEMPLATE_DIR = TEMPLATES / "v4"
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


def _retrieval_nodes_feeding_a_model(
    definition: TemplateDefinition,
) -> list[tuple[dict[str, object], list[str]]]:
    """Read-only tool nodes (a search) whose output an llm node then judges."""
    nodes = definition.skeleton["nodes"]
    found = []
    for node in _tool_nodes(definition):
        config = node["config"]
        assert isinstance(config, dict)
        if CANONICAL_TOOL_SIDE_EFFECTS[str(config["tool_name"])]:
            continue
        consumers = [
            str(other["key"])
            for other in nodes
            if other["type"] == "llm" and node["key"] in other["depends_on"]
        ]
        if consumers:
            found.append((node, consumers))
    return found


@pytest.mark.parametrize("path", FILES, ids=lambda path: path.stem)
def test_a_search_filtered_downstream_is_not_judged_on_the_filter(path: Path) -> None:
    """Without its own criteria, a search step is reviewed against the run's
    purpose, so a real result set with a namesake or an unrelated passage fails
    it (live run_69ef088e: brand-mention-alert's web search failed three times
    on a namesake company). Its criteria must state its own job and hand
    relevance to the model step that filters its output."""
    for node, consumers in _retrieval_nodes_feeding_a_model(_definition(path)):
        criteria = node.get("success_criteria")
        assert isinstance(criteria, list) and criteria, (
            f"{node['key']} feeds {consumers} but states no success criteria of its own"
        )
        text = " ".join(str(criterion) for criterion in criteria)
        assert any(f"the {consumer} step" in text for consumer in consumers), (
            f"{node['key']}'s criteria must leave relevance to {consumers}"
        )


def test_brand_alert_search_accepts_namesakes() -> None:
    definition = next(
        _definition(path)
        for path in FILES
        if _definition(path).template_id == "brand-mention-alert"
    )
    search = next(node for node in definition.skeleton["nodes"] if node["key"] == "search")
    text = " ".join(search.get("success_criteria", [])).lower()
    assert "namesake" in text and "acceptable" in text


def test_v2_supersedes_exactly_the_three_search_templates() -> None:
    """Revision 0012 inserts a new version only for a v2 file that differs
    from v1; every v2 file has its v1 counterpart."""
    versions = Path(__file__).parent.parent / "alembic" / "versions"
    path = versions / "0012_template_search_criteria.py"
    spec = importlib.util.spec_from_file_location("revision_0012", path)
    assert spec is not None and spec.loader is not None
    revision = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(revision)
    assert [file.name for file in FILES] == sorted(
        file.name for file in (TEMPLATES / "v1").glob("*.json")
    )
    assert [_definition(file).template_id for file in revision.changed_files()] == [
        "knowledge-qa",
        "brand-mention-alert",
        "whatsapp-faq-responder",
    ]


def _revision(name: str):  # type: ignore[no-untyped-def]
    path = Path(__file__).parent.parent / "alembic" / "versions" / name
    spec = importlib.util.spec_from_file_location(name.removesuffix(".py"), path)
    assert spec is not None and spec.loader is not None
    revision = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(revision)
    return revision


def test_v3_supersedes_only_knowledge_qa() -> None:
    """Revision 0013 inserts a new version only for a v3 file that differs
    from v2; every v3 file has its v2 counterpart."""
    revision = _revision("0013_knowledge_qa_answer_prompt.py")
    assert [file.name for file in FILES] == sorted(
        file.name for file in (TEMPLATES / "v2").glob("*.json")
    )
    assert [_definition(file).template_id for file in revision.changed_files()] == [
        "knowledge-qa"
    ]


def test_knowledge_qa_answer_compares_against_the_source_before_concluding() -> None:
    """The cheap answer model misread "free above INR 999" for INR 1500 until
    the prompt made it quote the deciding sentence and compare explicitly."""
    definition = _definition(TEMPLATE_DIR / "05-knowledge-qa.json")
    answer = next(node for node in definition.skeleton["nodes"] if node["key"] == "answer")
    config = answer["config"]
    assert isinstance(config, dict)
    assert config["model_alias"] == "STANDARD"
    prompt = str(config["prompt"]).lower()
    assert "word for word" in prompt and "compare" in prompt
    assert "never use outside knowledge" in prompt


def test_v4_supersedes_only_knowledge_qa() -> None:
    """Revision 0014 inserts a new version only for a v4 file that differs
    from v3; every v4 file has its v3 counterpart."""
    revision = _revision("0014_knowledge_qa_run_criteria.py")
    assert [file.name for file in FILES] == sorted(
        file.name for file in (TEMPLATES / "v3").glob("*.json")
    )
    assert [_definition(file).template_id for file in revision.changed_files()] == [
        "knowledge-qa"
    ]


def test_knowledge_qa_run_criteria_count_the_attached_text_as_support() -> None:
    """The end-of-run review read "when no passage or attached text supports an
    answer" as "the search was empty" and failed a correct answer drawn from the
    attached text (live run_c582a4c5). The run's criteria must say the attached
    text is a source on its own and state the two outcomes as one rule."""
    definition = _definition(TEMPLATE_DIR / "05-knowledge-qa.json")
    criteria = " ".join(definition.skeleton["success_criteria"]).lower()
    assert "empty search result does not mean" in criteria
    assert "either" in criteria and "supported true" in criteria and "supported false" in criteria
    assert "when no passage or attached text supports" not in criteria

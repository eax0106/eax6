"""D15: find additional Python safety implementations using the stdlib AST."""

import ast
import copy
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
canonical = "apps/verification-service/src/verification/model_gateway_client.py"
primitives = {
    "classify_prompt_injection", "screen_injection", "validate_ssrf_target",
    "create_ssrf_guard", "redact_pii",
}


class NormalizeNames(ast.NodeTransformer):
    def visit_Name(self, node):
        node.id = "_"
        return node

    def visit_Attribute(self, node):
        node.attr = "_"
        return self.generic_visit(node)


def signature(node):
    body = ast.Module(body=copy.deepcopy(node.body), type_ignores=[])
    if sum(1 for _ in ast.walk(body)) < 60:
        return None
    return ast.dump(NormalizeNames().visit(body), include_attributes=False)


tree = ast.parse((root / canonical).read_text())
owner = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "GrpcModelGatewayClient")
implementation = next(node for node in owner.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "classify_prompt_injection")
expected = signature(implementation)
assert expected is not None
findings = []
directories = [directory / "src" for directory in (root / "apps").iterdir() if directory.is_dir()]
directories.append(root / "scripts/gates/probes")
for directory in directories:
    for path in directory.rglob("*.py"):
        if "generated" in path.parts or path.name.startswith("test_"):
            continue
        file = path.relative_to(root).as_posix()
        tree = ast.parse(path.read_text())
        parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            parent = parents.get(node)
            owner_name = parent.name if isinstance(parent, ast.ClassDef) else ""
            if file == canonical and owner_name == "GrpcModelGatewayClient" and node.name == "classify_prompt_injection":
                continue
            # The existing development-only reviewer stub is not a production classifier.
            if file == "apps/verification-service/src/verification/llm_client.py" and owner_name == "StubReviewerLlmClient":
                continue
            if all(isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant)
                   and (statement.value.value is Ellipsis or isinstance(statement.value.value, str))
                   for statement in node.body):
                continue
            value = signature(node)
            if node.name in primitives or (value is not None and value == expected):
                findings.append({"file": file, "line": node.lineno,
                                 "message": f'Safety implementation "{node.name}" must reuse its canonical implementation'})
print(json.dumps(findings))

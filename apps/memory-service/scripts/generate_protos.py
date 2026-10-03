"""Generate the Python gRPC bindings consumed by memory-service."""

from __future__ import annotations

import argparse
import filecmp
import subprocess
import sys
import tempfile
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]
PROTO_ROOT = REPO_ROOT / "packages" / "contracts" / "proto"
PROTO_FILES = ("alter/memory/v1/memory.proto", "alter/modelgw/v1/modelgw.proto")


def generate(output: Path) -> None:
    subprocess.run(
        [
            sys.executable,
            "-m",
            "grpc_tools.protoc",
            f"-I{PROTO_ROOT}",
            f"--python_out={output}",
            f"--pyi_out={output}",
            f"--grpc_python_out={output}",
            *(str(PROTO_ROOT / path) for path in PROTO_FILES),
        ],
        check=True,
    )


def generated_files(root: Path) -> dict[str, Path]:
    return {
        str(path.relative_to(root)): path
        for path in root.glob("alter/**/*.py*")
        if path.is_file() and "_pb2" in path.name and path.suffix in {".py", ".pyi"}
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not args.check:
        generate(SERVICE_ROOT)
        return 0
    with tempfile.TemporaryDirectory(prefix="alterx-memory-proto-") as directory:
        generated_root = Path(directory)
        generate(generated_root)
        expected = generated_files(generated_root)
        actual = generated_files(SERVICE_ROOT)
        mismatches = [
            name
            for name, expected_path in expected.items()
            if name not in actual
            or not filecmp.cmp(expected_path, actual[name], shallow=False)
        ]
        extras = sorted(set(actual) - set(expected))
        if not mismatches and not extras:
            return 0
    print("Python protobuf bindings are stale; run scripts/generate_protos.py")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Generate the Python gRPC bindings consumed by ads-core."""

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
PROTO_FILES = (
    "alter/modelgw/v1/modelgw.proto",
    "alter/adsq/v1/adsq.proto",
    "alter/memory/v1/memory.proto",
)


def generate(output: Path) -> None:
    command = [
        sys.executable,
        "-m",
        "grpc_tools.protoc",
        f"-I{PROTO_ROOT}",
        f"--python_out={output}",
        f"--pyi_out={output}",
        f"--grpc_python_out={output}",
        *(str(PROTO_ROOT / path) for path in PROTO_FILES),
    ]
    subprocess.run(command, check=True)


def generated_files(root: Path) -> dict[str, Path]:
    return {
        str(path.relative_to(root)): path
        for path in root.glob("alter/**/*.py*")
        if path.is_file() and "_pb2" in path.name and path.suffix in {".py", ".pyi"}
    }


def check() -> int:
    with tempfile.TemporaryDirectory(prefix="alterx-ads-core-proto-") as directory:
        generated_root = Path(directory)
        generate(generated_root)
        expected = generated_files(generated_root)
        actual = generated_files(SERVICE_ROOT)
        mismatches = [
            relative
            for relative, expected_path in expected.items()
            if relative not in actual
            or not filecmp.cmp(expected_path, actual[relative], shallow=False)
        ]
        extras = sorted(set(actual) - set(expected))
        if mismatches or extras:
            print("Python protobuf bindings are stale; run scripts/generate_protos.py")
            for relative in sorted(mismatches + extras):
                print(f"  {relative}")
            return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        return check()
    generate(SERVICE_ROOT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Arithmetic oracle for the digest's rule: totals retain input units.

Each case uses decimal addition over the original amounts, never the model's
answer or a reviewer's arithmetic. The fixtures also drive fresh live trials.
"""

import json
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest

CASES = json.loads(Path(__file__).with_name("weekly_digest_golden.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_expected_totals_follow_the_records(case: dict[str, Any]) -> None:
    records = case["records"]
    expected = case["expected"]
    assert expected["included"] == len(records)
    assert set(expected["by_type"]) == {record["type"] for record in records}
    for kind, group in expected["by_type"].items():
        matching = [record for record in records if record["type"] == kind]
        assert group["count"] == len(matching)
        total = sum((Decimal(str(record["amount"])) for record in matching), Decimal(0))
        assert Decimal(str(group["total"])) == total

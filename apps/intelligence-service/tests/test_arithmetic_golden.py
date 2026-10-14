"""Oracle: count every record; sum decimal spellings, then round once, half away
from zero. An unknown scalar term yields unknown, never a partial total.
These rules apply regardless of template, node key, field names, or units.
"""
import json
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

import pytest

CASES = json.loads(Path(__file__).with_name("arithmetic_golden.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_arithmetic_expectations_follow_decimal_rules(case: dict[str, Any]) -> None:
    config, source, expected = case["config"], case["input"], case["expected"]
    operation = next(iter(config))
    options = config[operation]
    quantum = Decimal(10) ** -options.get("decimal_places", 2)

    def total(values: list[Any]) -> Decimal | None:
        if None in values:
            return None
        return sum((Decimal(str(value)) for value in values), Decimal(0)).quantize(
            quantum, rounding=ROUND_HALF_UP
        )

    if operation == "decimal_sum":
        terms = []
        for path in options["fields"]:
            value = source
            for part in path.split("."):
                value = value[part]
            terms.append(value)
        result = expected[options["output_field"]]
        assert (None if result is None else Decimal(str(result))) == total(terms)
        return
    records = source[options["records_field"]]
    assert expected["included"] == len(records)
    group_field = options.get("group_field")
    amount_field = options.get("amount_field")
    if group_field:
        assert set(expected["by_type"]) == {row[group_field] for row in records}
        for key, group in expected["by_type"].items():
            rows = [row for row in records if row[group_field] == key]
            assert group["count"] == len(rows)
            if amount_field:
                assert Decimal(str(group["total"])) == total([r[amount_field] for r in rows])
    elif amount_field:
        assert Decimal(str(expected["total"])) == total([r[amount_field] for r in records])

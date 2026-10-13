import { z } from "zod";
import { NodeHandlerValidationError } from "../handler";

const fields = z.object({
  records_field: z.string().min(1),
  group_field: z.string().min(1),
  amount_field: z.string().min(1),
}).strict();

/** Counts and decimal sums in the input's units, rounded only at the end. */
export function aggregateRecords(input: Record<string, unknown>, config: unknown): Record<string, unknown> {
  const parsed = fields.safeParse(config);
  if (!parsed.success) throw new NodeHandlerValidationError("Invalid record_aggregation fields");
  const { records_field, group_field, amount_field } = parsed.data;
  const records = input[records_field];
  if (!Array.isArray(records)) throw new NodeHandlerValidationError("Aggregation requires a records array");
  const groups = new Map<string, { count: number; units: bigint; scale: number }>();
  for (const record of records) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new NodeHandlerValidationError("Aggregation records must be objects");
    }
    const kind: unknown = record[group_field];
    const amount: unknown = record[amount_field];
    if (typeof kind !== "string" || kind.length === 0 || typeof amount !== "number" || !Number.isFinite(amount)) {
      throw new NodeHandlerValidationError("Aggregation requires a group string and finite numeric amount");
    }
    // JSON numbers' decimal spelling is the contract, not their binary
    // floating-point expansion. BigInt retains every digit while summing.
    const [mantissa, exponent = "0"] = String(amount).split("e");
    const fractionalDigits = mantissa!.split(".")[1]?.length ?? 0;
    let scale = fractionalDigits - Number(exponent);
    let units = BigInt(mantissa!.replace(".", ""));
    if (scale < 0) { units *= 10n ** BigInt(-scale); scale = 0; }
    const group = groups.get(kind) ?? { count: 0, units: 0n, scale: 0 };
    const commonScale = Math.max(scale, group.scale);
    group.units = group.units * 10n ** BigInt(commonScale - group.scale)
      + units * 10n ** BigInt(commonScale - scale);
    group.scale = commonScale;
    group.count += 1;
    groups.set(kind, group);
  }
  return {
    included: records.length,
    by_type: Object.fromEntries([...groups].map(([kind, group]) => [kind, {
      count: group.count, total: roundedTotal(group.units, group.scale),
    }])),
  };
}

function roundedTotal(units: bigint, scale: number): number {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  // Round the final exact sum to two decimals, ties away from zero.
  const divisor = 10n ** BigInt(Math.max(0, scale - 2));
  const cents = scale <= 2 ? absolute * 10n ** BigInt(2 - scale)
    : (absolute + divisor / 2n) / divisor;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new NodeHandlerValidationError("Aggregation total exceeds safe numeric precision");
  }
  const total = Number(negative ? -cents : cents) / 100;
  // Safe integer cents alone do not guarantee a JSON number can retain them
  // at large magnitudes. Verify the decimal spelling the next node receives.
  const [whole, fraction = ""] = String(Math.abs(total)).split(".");
  if (fraction.length > 2 || BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0")) !== cents) {
    throw new NodeHandlerValidationError("Aggregation total exceeds safe numeric precision");
  }
  return total;
}

import { z } from "zod";
import { NodeHandlerValidationError } from "../handler";

const decimalPlaces = z.number().int().min(0).max(15).default(2);
const recordAggregation = z.object({
  records_field: z.string().min(1),
  group_field: z.string().min(1).optional(),
  amount_field: z.string().min(1).optional(),
  decimal_places: decimalPlaces,
}).strict();
const decimalSum = z.object({
  fields: z.array(z.string().min(1)).min(1),
  output_field: z.string().min(1),
  decimal_places: decimalPlaces,
}).strict();

// Shared by compilation and execution; unrelated Merge config stays unchanged.
export const MergeArithmeticConfigSchema = z.object({
  record_aggregation: recordAggregation.optional(),
  decimal_sum: decimalSum.optional(),
}).passthrough().refine(config => config.record_aggregation === undefined || config.decimal_sum === undefined,
  "Use one arithmetic operation per Merge node");

/** Counts and decimal sums in the input's units, rounded only at the end. */
export function aggregateRecords(input: Record<string, unknown>, config: unknown): Record<string, unknown> {
  const parsed = recordAggregation.safeParse(config);
  if (!parsed.success) throw new NodeHandlerValidationError("Invalid record_aggregation fields");
  const { records_field, group_field, amount_field, decimal_places } = parsed.data;
  const records = input[records_field];
  if (!Array.isArray(records)) throw new NodeHandlerValidationError("Aggregation requires a records array");
  const groups = new Map<string, { count: number; amounts: number[] }>();
  for (const record of records) {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new NodeHandlerValidationError("Aggregation records must be objects");
    }
    const kind: unknown = group_field === undefined ? "" : record[group_field];
    if (typeof kind !== "string" || (group_field !== undefined && kind.length === 0)) {
      throw new NodeHandlerValidationError("Aggregation requires a non-empty group string");
    }
    const group = groups.get(kind) ?? { count: 0, amounts: [] };
    if (amount_field !== undefined) group.amounts.push(finiteAmount(record[amount_field]));
    group.count += 1;
    groups.set(kind, group);
  }
  const totals = (amounts: number[]) => amount_field === undefined ? {}
    : { total: sumDecimals(amounts, decimal_places) };
  if (group_field === undefined) {
    return { included: records.length, ...totals(groups.get("")?.amounts ?? []) };
  }
  return {
    included: records.length,
    by_type: Object.fromEntries([...groups].map(([kind, group]) => [kind, {
      count: group.count, ...totals(group.amounts),
    }])),
  };
}

/** Add extracted fields without delegating arithmetic to the extracting model.
 * An explicitly unknown (null) term makes the result unknown, never zero.
 */
export function sumDecimalFields(input: Record<string, unknown>, config: unknown): Record<string, unknown> {
  const parsed = decimalSum.safeParse(config);
  if (!parsed.success) throw new NodeHandlerValidationError("Invalid decimal_sum fields");
  const { fields, output_field, decimal_places } = parsed.data;
  const amounts = fields.map(path => {
    let value: unknown = input;
    for (const part of path.split(".")) {
      if (typeof value !== "object" || value === null || !Object.hasOwn(value, part)) {
        throw new NodeHandlerValidationError(`Missing decimal_sum field: ${path}`);
      }
      value = (value as Record<string, unknown>)[part];
    }
    return value === null ? null : finiteAmount(value);
  });
  return { ...input, [output_field]: amounts.includes(null) ? null
    : sumDecimals(amounts as number[], decimal_places) };
}

function finiteAmount(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new NodeHandlerValidationError("Arithmetic requires finite numeric amounts");
  }
  return amount;
}

function decimalParts(amount: number): { units: bigint; scale: number } {
  // JSON numbers' decimal spelling is the contract, not their binary expansion.
  const [mantissa, exponent = "0"] = String(amount).split("e");
  const fractionalDigits = mantissa!.split(".")[1]?.length ?? 0;
  const scale = fractionalDigits - Number(exponent);
  const units = BigInt(mantissa!.replace(".", ""));
  return scale < 0 ? { units: units * 10n ** BigInt(-scale), scale: 0 } : { units, scale };
}

function sumDecimals(amounts: number[], places: number): number {
  let units = 0n;
  let scale = 0;
  for (const amount of amounts) {
    const term = decimalParts(amount);
    const commonScale = Math.max(scale, term.scale);
    units = units * 10n ** BigInt(commonScale - scale)
      + term.units * 10n ** BigInt(commonScale - term.scale);
    scale = commonScale;
  }
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  // Round the final exact sum, ties away from zero, in the declared units.
  const divisor = 10n ** BigInt(Math.max(0, scale - places));
  const rounded = scale <= places ? absolute * 10n ** BigInt(places - scale)
    : (absolute + divisor / 2n) / divisor;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new NodeHandlerValidationError("Arithmetic total exceeds safe numeric precision");
  }
  const total = Number(negative ? -rounded : rounded) / 10 ** places;
  // Verify the decimal spelling the next node receives, including exponents.
  const wire = decimalParts(Math.abs(total));
  const commonScale = Math.max(places, wire.scale);
  if (wire.units * 10n ** BigInt(commonScale - wire.scale)
      !== rounded * 10n ** BigInt(commonScale - places)) {
    throw new NodeHandlerValidationError("Arithmetic total exceeds safe numeric precision");
  }
  return total;
}

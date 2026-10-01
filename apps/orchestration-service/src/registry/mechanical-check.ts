/**
 * Design log §5.2: the mechanical half of per-node verification -- confirm
 * the external system reflects the claimed action, rather than trusting
 * that the call returned. It is judged only on what the external system
 * itself reported back, never on the call not having thrown.
 *
 * What each side-effecting tool can honestly confirm today:
 * - database insert/update/delete: the database's own count of affected
 *   rows. A write that changed nothing did not do what was claimed; §4
 *   calls that a target resource mismatch, which a person must redirect.
 * - email.send: the provider's message id. That proves the provider
 *   accepted the message, not that it was delivered; delivery needs the
 *   provider's event stream, which is not wired.
 * - browser.click: the browser returns nothing to check, so the action is
 *   recorded as unconfirmed rather than passed.
 */
export type MechanicalCheck =
  | { readonly confirmed: true; readonly basis: string }
  | { readonly confirmed: false; readonly reason: string }
  | { readonly unconfirmable: true; readonly reason: string };

const DATABASE_WRITES = new Set(["database.insert", "database.update", "database.delete"]);

export function mechanicalCheck(
  toolName: string,
  output: Readonly<Record<string, unknown>>,
): MechanicalCheck | undefined {
  if (DATABASE_WRITES.has(toolName)) {
    const rowCount = output["rowCount"];
    if (typeof rowCount !== "number" || !Number.isInteger(rowCount)) {
      return { confirmed: false, reason: `${toolName} returned no affected-row count to confirm against` };
    }
    return rowCount > 0
      ? { confirmed: true, basis: `database reported ${rowCount} affected row(s)` }
      : { confirmed: false, reason: `${toolName} affected no rows: the target the step was meant to change is not there` };
  }
  if (toolName === "email.send") {
    const messageId = output["messageId"];
    return typeof messageId === "string" && messageId.trim().length > 0
      ? { confirmed: true, basis: "provider accepted the message (message id returned); delivery is not confirmed" }
      : { confirmed: false, reason: "email.send returned no provider message id" };
  }
  if (toolName === "browser.click") {
    return { unconfirmable: true, reason: "the browser returns no state after a click to confirm against" };
  }
  return undefined;
}

export class MechanicalCheckFailedError extends Error {
  constructor(detail: string, readonly code = "MECHANICAL_CHECK_FAILED") {
    super(detail);
    this.name = "MechanicalCheckFailedError";
  }
}

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
 *   provider's event stream; later Delivery/Bounce updates the side-effect.
 * - browser.click: a declared expected page state is checked against the
 *   post-click snapshot; without one the action stays unconfirmed.
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
    const confirmation = output["confirmation"];
    if (confirmation !== null && typeof confirmation === "object" &&
        (confirmation as Record<string, unknown>)["status"] === "failed") {
      return { confirmed: false, reason: String((confirmation as Record<string, unknown>)["reason"] ?? "expected page state did not match") };
    }
    if (
      confirmation !== null &&
      typeof confirmation === "object" &&
      (confirmation as Record<string, unknown>)["status"] === "confirmed"
    ) {
      return {
        confirmed: true,
        basis: String((confirmation as Record<string, unknown>)["basis"] ?? "expected page state matched"),
      };
    }
    return {
      unconfirmable: true,
      reason:
        confirmation !== null && typeof confirmation === "object"
          ? String((confirmation as Record<string, unknown>)["reason"] ?? "expected page state was not confirmed")
          : "browser.click returned no confirmation",
    };
  }
  return undefined;
}

export class MechanicalCheckFailedError extends Error {
  readonly code = "MECHANICAL_CHECK_FAILED";

  constructor(detail: string) {
    super(detail);
    this.name = "MechanicalCheckFailedError";
  }
}

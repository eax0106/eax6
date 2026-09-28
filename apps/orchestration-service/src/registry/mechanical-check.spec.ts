import { describe, expect, it } from "vitest";

import { mechanicalCheck } from "./mechanical-check";

// C36, design log §5.2: judged on what the external system reported.
describe("mechanicalCheck", () => {
  it("confirms a database write only by the rows the database says it changed", () => {
    expect(mechanicalCheck("database.update", { rowCount: 2, rows: [] })).toEqual({
      confirmed: true,
      basis: "database reported 2 affected row(s)",
    });
    expect(mechanicalCheck("database.delete", { rowCount: 0, rows: [] })).toMatchObject({ confirmed: false });
    expect(mechanicalCheck("database.insert", { rows: [] })).toMatchObject({ confirmed: false });
  });

  it("confirms an email only as accepted by the provider", () => {
    expect(mechanicalCheck("email.send", { messageId: "0100-abc", acceptedAt: "2026-09-28T10:00:00Z" })).toMatchObject({
      confirmed: true,
      basis: expect.stringContaining("delivery is not confirmed"),
    });
    expect(mechanicalCheck("email.send", {})).toMatchObject({ confirmed: false });
  });

  it("records a click as unconfirmable, never as confirmed", () => {
    expect(mechanicalCheck("browser.click", {})).toEqual({
      unconfirmable: true,
      reason: "the browser returns no state after a click to confirm against",
    });
  });

  it("does not apply to reads", () => {
    expect(mechanicalCheck("database.select", { rowCount: 0, rows: [] })).toBeUndefined();
    expect(mechanicalCheck("search.web", {})).toBeUndefined();
  });
});

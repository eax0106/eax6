import { describe, expect, it } from "vitest";

import { TOOL_NAMES } from "@alterx/contracts";

import {
  TOOL_CATALOG,
  catalogDrift,
  dispatchedToolNames,
  toolNamesInFamily,
  undispatchedToolNames,
} from "./tool-catalog";

describe("tool catalogue", () => {
  it("covers the canonical set exactly, with nothing either side", () => {
    // The whole point of 3.5: the declared set and the catalogue are one
    // thing. Adding a name to ToolNameSchema without saying whether it
    // dispatches fails here rather than being discovered at call time.
    expect(catalogDrift()).toEqual([]);
    expect(TOOL_CATALOG).toHaveLength(TOOL_NAMES.length);
  });

  it("counts the tools that do not dispatch", () => {
    // Not a placeholder. This was the unanswerable question: the denominator
    // was unpinned, so "how many tools are missing" could only be estimated
    // by reading the dispatcher. It is now zero, and stays a fact -- adding a
    // declared tool without a dispatch turns this red until someone sets the
    // flag deliberately.
    expect(undispatchedToolNames()).toEqual([]);
    expect(dispatchedToolNames()).toHaveLength(TOOL_NAMES.length);
  });

  it("declares six families and no others", () => {
    const families = [...new Set(TOOL_CATALOG.map((entry) => entry.family))];
    expect(families).toEqual(["search", "database", "browser", "email", "knowledge", "whatsapp"]);
    expect(families.flatMap((family) => [...toolNamesInFamily(family)])).toHaveLength(
      TOOL_NAMES.length,
    );
  });

  it("names every tool in its own family's namespace", () => {
    // browser.* and database.* are matched by set membership, not by prefix,
    // so a name whose prefix disagrees with its family would be catalogued in
    // one place and dispatched from another.
    for (const entry of TOOL_CATALOG) {
      expect(entry.name.startsWith(`${entry.family}.`)).toBe(true);
    }
  });
});

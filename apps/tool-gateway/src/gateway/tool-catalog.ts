import { TOOL_NAMES, type ToolName } from "@alterx/contracts";

/**
 * Which of the canonical tools (ToolNameSchema) the gateway actually
 * dispatches, and through what.
 *
 * This is the tool-side counterpart of orchestration's node-type-catalog:
 * `dispatchImplemented` is what turns "how many tools are missing" from an
 * estimate someone reads out of an `if` chain into a number a test asserts.
 *
 * Every entry is currently implemented -- the six families are the whole
 * declared set, not a wired subset of a larger one. That is the answer to
 * the question, not an absence of one: a name outside this catalogue is not
 * a missing tool, it is not a tool.
 */
export type ToolFamily = "search" | "database" | "browser" | "email" | "knowledge" | "whatsapp";

export interface ToolCatalogEntry {
  readonly name: ToolName;
  readonly family: ToolFamily;
  /** Provider the dispatch runs through, for the operator reading this. */
  readonly provider: string;
  readonly dispatchImplemented: boolean;
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  { name: "search.web", family: "search", provider: "Tavily", dispatchImplemented: true },
  { name: "database.select", family: "database", provider: "tenant database", dispatchImplemented: true },
  { name: "database.insert", family: "database", provider: "tenant database", dispatchImplemented: true },
  { name: "database.update", family: "database", provider: "tenant database", dispatchImplemented: true },
  { name: "database.delete", family: "database", provider: "tenant database", dispatchImplemented: true },
  { name: "browser.session.create", family: "browser", provider: "Browserbase", dispatchImplemented: true },
  { name: "browser.navigate", family: "browser", provider: "Browserbase", dispatchImplemented: true },
  { name: "browser.click", family: "browser", provider: "Browserbase", dispatchImplemented: true },
  { name: "browser.extract", family: "browser", provider: "Browserbase", dispatchImplemented: true },
  { name: "browser.session.close", family: "browser", provider: "Browserbase", dispatchImplemented: true },
  { name: "email.send", family: "email", provider: "AWS SES", dispatchImplemented: true },
  { name: "knowledge.search", family: "knowledge", provider: "ADS (workspace documents)", dispatchImplemented: true },
  { name: "whatsapp.send", family: "whatsapp", provider: "Meta WhatsApp Cloud API", dispatchImplemented: true },
];

const CATALOG_BY_NAME = new Map<string, ToolCatalogEntry>(
  TOOL_CATALOG.map((entry) => [entry.name, entry]),
);

export function isCanonicalToolName(toolName: string): toolName is ToolName {
  return CATALOG_BY_NAME.has(toolName);
}

/** Declared tools that dispatch. */
export function dispatchedToolNames(): readonly ToolName[] {
  return TOOL_CATALOG.filter((entry) => entry.dispatchImplemented).map(
    (entry) => entry.name,
  );
}

/** Declared tools that do not dispatch yet -- the count 3.5 asked for. */
export function undispatchedToolNames(): readonly ToolName[] {
  return TOOL_CATALOG.filter((entry) => !entry.dispatchImplemented).map(
    (entry) => entry.name,
  );
}

/** Every dispatched tool in one family, in declaration order. */
export function toolNamesInFamily(family: ToolFamily): readonly ToolName[] {
  return TOOL_CATALOG.filter(
    (entry) => entry.family === family && entry.dispatchImplemented,
  ).map((entry) => entry.name);
}

/** Names in the catalogue but absent from the canonical enum, or vice versa. */
export function catalogDrift(): readonly string[] {
  const declared = new Set<string>(TOOL_NAMES);
  const catalogued = new Set(CATALOG_BY_NAME.keys());
  return [
    ...[...declared].filter((name) => !catalogued.has(name)),
    ...[...catalogued].filter((name) => !declared.has(name)),
  ];
}

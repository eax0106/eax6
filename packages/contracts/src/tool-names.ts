import { z } from "./zod";

/**
 * The canonical tool set the Tool Gateway offers.
 *
 * Before this existed, `tool_name` was a free string end to end: the proto
 * declares it `string`, the compiler passes it through untouched, the
 * capability resolver's ToolRequirement.name accepts any non-empty string,
 * and tool permission policies are keyed by `"{tenant}:{toolName}"` records
 * with no key validation. The only place that knew the real set was the
 * dispatcher's `if` chain in tool-gateway, which meant the denominator --
 * how many tools the system claims to offer -- could not be counted without
 * reading that chain, and could change without anything noticing.
 *
 * Pinned here for the same reason NodeTypeSchema pins the eleven node types:
 * one declared set, one place to change it, and a catalogue that has to
 * agree with it. `apps/tool-gateway/src/gateway/tool-catalog.ts` records
 * which of these actually dispatch.
 *
 * Grouped by family, in dispatch order. Six families, thirteen tools.
 */
export const ToolNameSchema = z.enum([
  // search -- Tavily
  "search.web",
  // database -- per-tenant database credentials
  "database.select",
  "database.insert",
  "database.update",
  "database.delete",
  // browser -- Browserbase
  "browser.session.create",
  "browser.navigate",
  "browser.click",
  "browser.extract",
  "browser.session.close",
  // email -- AWS SES
  "email.send",
  // knowledge -- the workspace's own documents (ADS)
  "knowledge.search",
  // whatsapp -- the workspace's connected WhatsApp Business account
  "whatsapp.send",
]);

/** Every canonical tool name, in declaration order. */
export const TOOL_NAMES = ToolNameSchema.options;

export type ToolName = z.infer<typeof ToolNameSchema>;

/**
 * Tools whose call changes something outside Alter that repeating would
 * change again: a second row, a second deletion, a second email, a second
 * click on a submit button. Design log §4's idempotency gate refuses to
 * re-run a node that called one of these once it may already have acted.
 *
 * Reads (search, select, extract, navigate) and the browser session's own
 * lifecycle are not here: repeating them repeats a read or opens another
 * disposable session, not an irreversible external action.
 */
export const SIDE_EFFECT_TOOL_NAMES: readonly ToolName[] = [
  "database.insert",
  "database.update",
  "database.delete",
  "browser.click",
  "email.send",
  "whatsapp.send",
];

export function hasExternalSideEffect(toolName: string): boolean {
  return (SIDE_EFFECT_TOOL_NAMES as readonly string[]).includes(toolName);
}


import { describe, expect, it } from "vitest";
import { HostedFormDefinitionSchema, hostedFormValuesSchema } from "./public-forms";

const definition = { title: "Contact us", fields: [{ name: "email", label: "Your email", type: "email", required: true }, { name: "message", label: "Message", type: "textarea", required: false, maxLength: 1000 }] };
describe("D16 minimal hosted form definition", () => {
  it("accepts bounded typed fields without server tokens or an upload field", () => {
    expect(HostedFormDefinitionSchema.parse(definition)).toMatchObject(definition);
    expect(HostedFormDefinitionSchema.parse({ ...definition, fields: [{ name: "quantity", label: "Quantity", type: "number", min: 0, max: 10 }, { name: "topic", label: "Topic", type: "select", options: ["Sales", "Support"] }] }).fields).toHaveLength(2);
  });
  it("refuses duplicate/special field names, unsupported types, oversized and inconsistent definitions", () => {
    const first = definition.fields[0]!;
    for (const fields of [[], [first, first], [{ ...first, name: "__proto__" }], [{ ...first, name: "constructor" }], [{ ...first, type: "file" }], [{ ...first, type: "select" }], [{ ...first, type: "select", options: ["Same", "Same"] }], [{ name: "amount", label: "Amount", type: "number", min: 5, max: 4 }], [{ ...first, label: "x".repeat(121) }], Array.from({ length: 21 }, (_, i) => ({ ...first, name: `field_${i}` }))]) {
      expect(HostedFormDefinitionSchema.safeParse({ ...definition, fields }).success).toBe(false);
    }
    for (const extra of [{ token: "client-token" }, { tokenHash: "client-hash" }, { uploads: true }]) expect(HostedFormDefinitionSchema.safeParse({ ...definition, ...extra }).success).toBe(false);
  });
});

describe("D16 submitted values", () => {
  const schema = hostedFormValuesSchema(HostedFormDefinitionSchema.parse({ title: "Inquiry", fields: [
    { name: "email", label: "Email", type: "email", required: true }, { name: "note", label: "Note", type: "text", required: true, maxLength: 40 },
    { name: "quantity", label: "Quantity", type: "number", min: 0, max: 10 }, { name: "topic", label: "Topic", type: "select", options: ["Sales", "Support"] },
  ] }));
  const valid = { email: "lead@example.com", note: "  Case-preserved inquiry  ", quantity: 5, topic: "Sales" };
  it("preserves bounded values and permits omitted optional fields", () => {
    expect(schema.parse(valid)).toEqual(valid);
    expect(schema.parse({ email: valid.email, note: valid.note })).toEqual({ email: valid.email, note: valid.note });
  });
  it("rejects missing/blank, unlisted, nonfinite/coerced, nested, unknown and excessive values", () => {
    for (const input of [{ ...valid, email: undefined }, { ...valid, email: "invalid" }, { ...valid, note: "   " }, { ...valid, note: "x".repeat(41) }, { ...valid, quantity: "5" }, { ...valid, quantity: Infinity }, { ...valid, quantity: 11 }, { ...valid, quantity: -1 }, { ...valid, topic: "Other" }, { ...valid, note: { file: "data" } }, { ...valid, uploads: [] }, { ...valid, tenantId: "ten_forged" }, { ...valid, turnstileToken: "metadata" }, JSON.parse('{"email":"lead@example.com","note":"ok","__proto__":{}}')]) expect(schema.safeParse(input).success).toBe(false);
  });
});

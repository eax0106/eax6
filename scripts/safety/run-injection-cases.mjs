import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PromptInjectionClassifier } from "@alterx/auth";
import { ModelGatewayClient } from "@alterx/adapters";

const [address, casePath] = process.argv.slice(2);
if (!address || !casePath) throw new Error("Usage: run-injection-cases.mjs ADDRESS CASES");
const classifier = new PromptInjectionClassifier(new ModelGatewayClient({
  address, protoPath: resolve("packages/contracts/proto/alter/modelgw/v1/modelgw.proto"),
}));
const results = [];
for (const item of JSON.parse(readFileSync(casePath, "utf8"))) {
  try {
    const result = await classifier.classify({
      tenantId: "ten_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      runId: "run_018f4d6e-2b4a-7a3e-8c1a-1234567890ab",
      nodeExecutionId: "node_018f4d6e-2b4a-7a3e-8c1a-1234567890ab", text: item.text,
    });
    results.push(result.failOpenCause
      ? { id: item.id, status: "unavailable", failurePolicy: "fail_open", blocked: result.blocked, confidence: result.confidence }
      : { id: item.id, status: "classified", blocked: result.blocked, confidence: result.confidence, reason: result.reason ?? null });
  } catch (error) {
    results.push({ id: item.id, status: "exception", errorType: error.constructor.name });
  }
}
process.stdout.write(JSON.stringify(results), () => process.exit(0));

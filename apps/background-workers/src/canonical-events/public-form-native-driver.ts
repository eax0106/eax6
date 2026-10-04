// Controlled SQS edge feeds the production consumer and actual localhost gRPC client.
import { RunDispatchClient } from "@alterx/adapters";
import { createMockQueueMessageConsumer, type JsonValue } from "@alterx/shared-clients";
import { CanonicalEventConsumerService } from "./canonical-event-consumer.service";

process.once("message", (config: { address: string; protoPath: string }) => {
const dispatch = new RunDispatchClient({ address: config.address, protoPath: config.protoPath });
const queue = createMockQueueMessageConsumer();
const consumer = new CanonicalEventConsumerService(queue, "canonical-events", dispatch);
process.on("message", (message: { requestId: number; event: JsonValue }) => {
  queue.enqueue("canonical-events", message.event);
  void consumer.pollOnce().then(result => process.send?.({ requestId: message.requestId, result })).catch(() => process.send?.({ requestId: message.requestId, error: "Canonical consumer failed" }));
});
process.on("disconnect", () => process.exit(0));
process.send?.({ ready: true });

});

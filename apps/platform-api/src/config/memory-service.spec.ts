import { expect, it } from "vitest";
import { memoryServiceConnection } from "./memory-service";

it.each([{}, { MEMORY_SERVICE_ADDRESS: "localhost:50054" }, { MEMORY_SERVICE_AUTHORIZATION: "Bearer fixture" },
  { MEMORY_SERVICE_ADDRESS: "localhost:50054", MEMORY_SERVICE_AUTHORIZATION: "Basic fixture" },
  { MEMORY_SERVICE_ADDRESS: "localhost:50054", MEMORY_SERVICE_AUTHORIZATION: "Bearer " }])("requires both an address and nonempty bearer authorization", environment => {
  expect(memoryServiceConnection(environment)).toBeUndefined();
});
it("returns the explicitly configured connection", () => {
  expect(memoryServiceConnection({ MEMORY_SERVICE_ADDRESS: " localhost:50054 ", MEMORY_SERVICE_AUTHORIZATION: " Bearer fixture " }))
    .toEqual({ address: "localhost:50054", authorization: "Bearer fixture" });
});

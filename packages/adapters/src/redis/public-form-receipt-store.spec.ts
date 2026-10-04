import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { RedisPublicFormReceiptStore } from "./public-form-receipt-store";

describe("real atomic public form verified receipts", () => {
  let container: StartedTestContainer;
  let first: RedisPublicFormReceiptStore, second: RedisPublicFormReceiptStore;
  const hash = () => randomBytes(32).toString("hex");
  beforeAll(async () => {
    container = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
    const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
    first = new RedisPublicFormReceiptStore(url); second = new RedisPublicFormReceiptStore(url);
  });
  afterAll(async () => { await first?.close(); await second?.close(); await container?.stop(); });
  it("binds one payload hash across concurrent replicas, without overwriting the winner", async () => {
    const key = hash(), a = hash(), b = hash();
    const results = await Promise.all([first.reserve(key, a), second.reserve(key, b)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? a : b;
    expect(await second.get(key)).toEqual({ payloadHash: winner, published: false });
    expect(await first.reserve(key, winner)).toBe(true);
    await first.markPublished(key, winner);
    expect(await second.get(key)).toEqual({ payloadHash: winner, published: true });
    await second.markPublished(key, hash());
    expect(await first.get(key)).toEqual({ payloadHash: winner, published: true });
  });
  it("rejects raw identifiers and probes the actual backing store", async () => {
    expect(await first.get(hash())).toBeNull();
    await expect(first.get("raw-input")).rejects.toThrow("opaque hashes");
    await expect(first.reserve(hash(), "raw-input")).rejects.toThrow("opaque hashes");
    await expect(first.probe()).resolves.toBeUndefined();
  });
});

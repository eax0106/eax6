import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { RedisPublicFormRateLimiter } from "./public-form-rate-limiter";

describe("real Redis public form attempt limits", () => {
  let container: StartedTestContainer;
  let url: string;
  const clients: RedisPublicFormRateLimiter[] = [];
  const hash = () => randomBytes(32).toString("hex");
  const limiter = (form: number, visitor: number, namespace: "public-form:page" | "public-form:submit" = "public-form:submit", windowSeconds = 60) => {
    const value = new RedisPublicFormRateLimiter(url, namespace, { form, visitor, windowSeconds }); clients.push(value); return value;
  };
  beforeAll(async () => {
    container = await new GenericContainer("redis:7-alpine").withExposedPorts(6379).start();
    url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  });
  afterAll(async () => { await Promise.all(clients.map(client => client.close())); await container?.stop(); });
  it("enforces one form budget atomically across replicas and different visitors", async () => {
    const replicas = [limiter(7, 100), limiter(7, 100)], form = hash();
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) => replicas[index % 2]!.consume(form, hash())));
    expect(results.filter(Boolean)).toHaveLength(7);
  });
  it("shares a visitor budget across forms, while isolating other visitors and page requests", async () => {
    const submit = limiter(100, 3), page = limiter(100, 3, "public-form:page"), visitor = hash();
    expect(await submit.consume(hash(), visitor)).toBe(true);
    expect(await submit.consume(hash(), visitor)).toBe(true);
    expect(await submit.consume(hash(), visitor)).toBe(true);
    expect(await submit.consume(hash(), visitor)).toBe(false);
    expect(await submit.consume(hash(), hash())).toBe(true);
    expect(await page.consume(hash(), visitor)).toBe(true);
  });
  it("expires bounded attempt counters and rejects malformed keys/configuration", async () => {
    const client = limiter(1, 1, "public-form:submit", 1), form = hash(), visitor = hash();
    expect(await client.consume(form, visitor)).toBe(true);
    expect(await client.consume(form, visitor)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(await client.consume(form, visitor)).toBe(true);
    await expect(client.consume("raw-ip", visitor)).rejects.toThrow("opaque hashes");
    expect(() => limiter(0, 1)).toThrow("positive integers");
    expect(() => new RedisPublicFormRateLimiter("https://example.com", "public-form:submit", { form: 1, visitor: 1, windowSeconds: 1 })).toThrow("requires Redis");
  });
});

import Redis from "ioredis";

const consumeCounters = `
local form = redis.call('INCR', KEYS[1])
if form == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local visitor = redis.call('INCR', KEYS[2])
if visitor == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end
if form > tonumber(ARGV[2]) or visitor > tonumber(ARGV[3]) then return 0 end
return 1`;

/** Count attempts atomically across process replicas; never store an IP address. */
export class RedisPublicFormRateLimiter {
  private readonly client: Redis;
  constructor(url: string, private readonly namespace: "public-form:page" | "public-form:submit",
    private readonly limits: { form: number; visitor: number; windowSeconds: number }) {
    for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Public form rate limits must be positive integers");
    const parsed = new URL(url);
    if (!["redis:", "rediss:"].includes(parsed.protocol)) throw new Error("Public form rate store requires Redis");
    this.client = new Redis(url, { lazyConnect: true, connectTimeout: 1000, commandTimeout: 2000, maxRetriesPerRequest: 1, retryStrategy: () => null });
    this.client.on("error", () => { /* Calls propagate unavailability to the HTTP boundary. */ });
  }
  async consume(formHash: string, visitorHash: string): Promise<boolean> {
    if (![formHash, visitorHash].every(value => /^[a-f0-9]{64}$/.test(value))) throw new Error("Rate keys require opaque hashes");
    const allowed = await this.client.eval(consumeCounters, 2,
      `${this.namespace}:form:${formHash}`, `${this.namespace}:visitor:${visitorHash}`,
      this.limits.windowSeconds, this.limits.form, this.limits.visitor);
    if (allowed !== 0 && allowed !== 1) throw new Error("Invalid rate store result");
    return allowed === 1;
  }
  async close(): Promise<void> { this.client.disconnect(); }
}

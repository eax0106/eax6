import Redis from "ioredis";

/** Five-minute verified retry state: opaque hashes only, no submitted values. */
export class RedisPublicFormReceiptStore {
  private readonly client: Redis;
  constructor(url: string) {
    const parsed = new URL(url);
    if (!["redis:", "rediss:"].includes(parsed.protocol)) throw new Error("Public form receipts require Redis");
    this.client = new Redis(url, { lazyConnect: true, connectTimeout: 1000, commandTimeout: 2000, maxRetriesPerRequest: 1, retryStrategy: () => null });
    this.client.on("error", () => { /* Calls propagate unavailability. */ });
  }
  private key(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Receipt keys require opaque hashes");
    return `public-form:receipt:${hash}`;
  }
  async get(key: string) {
    const value = await this.client.get(this.key(key));
    if (value === null) return null;
    const match = /^([a-f0-9]{64}):(verified|published)$/.exec(value);
    if (!match) throw new Error("Invalid public form receipt");
    return { payloadHash: match[1]!, published: match[2] === "published" };
  }
  async reserve(key: string, payloadHash: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(payloadHash)) throw new Error("Receipt values require opaque hashes");
    const result = await this.client.eval(`
      local value = redis.call('GET', KEYS[1])
      if value then
        if string.sub(value, 1, 64) == ARGV[1] then return 1 else return 0 end
      end
      redis.call('SET', KEYS[1], ARGV[1] .. ':verified', 'EX', 300)
      return 1`, 1, this.key(key), payloadHash);
    if (result !== 0 && result !== 1) throw new Error("Invalid public form receipt result");
    return result === 1;
  }
  async markPublished(key: string, payloadHash: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(payloadHash)) throw new Error("Receipt values require opaque hashes");
    await this.client.eval(`
      local value = redis.call('GET', KEYS[1])
      if value and string.sub(value, 1, 64) == ARGV[1] then
        redis.call('SET', KEYS[1], ARGV[1] .. ':published', 'EX', 300)
      end
      return 1`, 1, this.key(key), payloadHash);
  }
  async close(): Promise<void> { this.client.disconnect(); }
  async probe(): Promise<void> {
    if (await this.client.ping() !== "PONG") throw new Error("Public form retry store unavailable");
  }
}

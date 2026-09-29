import type {
  EngineCallerContext,
  EngineEventStream,
  EngineSseMessage,
} from "../engine";
import { describe, expect, it, vi } from "vitest";
import { StreamRevocationBus } from "./revocation";
import { StreamGateway } from "./stream-gateway";
import type { StreamFrame, StreamingConfig } from "./types";

const runId = "run_018f47a5-7b2c-7d10-8f11-123456789abc";
const projectId = "prj_018f47a5-7b2c-7d10-8f11-123456789abc";
const context: EngineCallerContext = {
  userId: "usr_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenantId: "ten_018f47a5-7b2c-7d10-8f11-123456789abc",
  workspaceId: "ws_018f47a5-7b2c-7d10-8f11-123456789abc",
  sessionId: "session-a",
  authTime: 1_700_000_000,
  roles: ["viewer"],
  permissions: ["runs:read"],
  traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
};
const config: StreamingConfig = {
  replayBufferSize: 2,
  subscriberQueueSize: 2,
  heartbeatMs: 60_000,
  replayGraceMs: 0,
};

describe("StreamGateway", () => {
  it("resumes a new channel from Engine's durable cursor after refresh", async () => {
    const source = new PushStream<EngineSseMessage>();
    const engine = engineStub(source);
    const gateway = new StreamGateway(engine.value, config, new StreamRevocationBus());
    const frames: StreamFrame[] = [];

    const connection = await gateway.connect(
      subscription("refreshed", frames, `${runId}:12`),
    );
    connection.start();

    expect(engine.stream).toHaveBeenCalledWith(
      `/api/v1/runs/${runId}/stream`,
      context,
      { lastEventId: "12" },
    );
    source.push(runStatus(13, "running"));
    await vi.waitFor(() => expect(eventIds(frames)).toEqual([`${runId}:13`]));
    expect(eventTypes(frames)).not.toContain("stream.resync");
    connection.close();
  });

  it("fans one Engine subscription to tabs and keeps sibling alive", async () => {
    const source = new PushStream<EngineSseMessage>();
    const close = vi.fn(() => source.end());
    const engine = engineStub(source, close);
    const gateway = new StreamGateway(engine.value, config, new StreamRevocationBus());
    const tabA: StreamFrame[] = [];
    const tabB: StreamFrame[] = [];
    const first = await gateway.connect(subscription("tab-a", tabA));
    const second = await gateway.connect(subscription("tab-b", tabB));
    first.start();
    second.start();

    source.push(runStatus(1, "running"));
    await vi.waitFor(() => expect(tabA).toHaveLength(1));
    expect(tabB).toHaveLength(1);
    expect(engine.stream).toHaveBeenCalledOnce();

    first.close();
    source.push(runStatus(2, "paused"));
    await vi.waitFor(() => expect(tabB).toHaveLength(2));
    expect(tabA).toHaveLength(1);
    expect(close).not.toHaveBeenCalled();

    second.close();
    expect(close).toHaveBeenCalledOnce();
    expect(gateway.activeChannelCount()).toBe(0);
  });

  it("replays after Last-Event-ID and emits resync for stale ids", async () => {
    const source = new PushStream<EngineSseMessage>();
    const engine = engineStub(source);
    const gateway = new StreamGateway(engine.value, config, new StreamRevocationBus());
    const primaryFrames: StreamFrame[] = [];
    const primary = await gateway.connect(
      subscription("primary", primaryFrames),
    );
    primary.start();
    source.push(runStatus(1, "running"));
    source.push(runStatus(2, "paused"));
    source.push(runStatus(3, "completed"));
    await vi.waitFor(() => expect(primaryFrames).toHaveLength(3));

    const replayed: StreamFrame[] = [];
    const replay = await gateway.connect(
      subscription("replay", replayed, `${runId}:2`),
    );
    replay.start();
    await vi.waitFor(() => expect(replayed).toHaveLength(1));
    expect(eventTypes(replayed)).toEqual(["run.status"]);
    expect(eventIds(replayed)).toEqual([`${runId}:3`]);

    const staleFrames: StreamFrame[] = [];
    const stale = await gateway.connect(
      subscription("stale", staleFrames, `${runId}:1`),
    );
    stale.start();
    await vi.waitFor(() => expect(staleFrames).toHaveLength(1));
    expect(eventTypes(staleFrames)).toEqual(["stream.resync"]);
    expect(eventData(staleFrames)[0]).toMatchObject({
      reason: "stale_event_id",
      refetch: true,
    });

    primary.close();
    replay.close();
    stale.close();
  });

  it("retains replay across last-tab refresh for a bounded grace window", async () => {
    const source = new PushStream<EngineSseMessage>();
    const close = vi.fn(() => source.end());
    const engine = engineStub(source, close);
    const gateway = new StreamGateway(
      engine.value,
      { ...config, replayGraceMs: 50 },
      new StreamRevocationBus(),
    );
    const initialFrames: StreamFrame[] = [];
    const initial = await gateway.connect(subscription("initial", initialFrames));
    initial.start();
    source.push(runStatus(1, "running"));
    await vi.waitFor(() => expect(initialFrames).toHaveLength(1));

    initial.close();
    expect(gateway.activeChannelCount()).toBe(1);
    expect(close).not.toHaveBeenCalled();
    source.push(runStatus(2, "paused"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const resumedFrames: StreamFrame[] = [];
    const resumed = await gateway.connect(
      subscription("resumed", resumedFrames, `${runId}:1`),
    );
    resumed.start();
    await vi.waitFor(() => expect(resumedFrames).toHaveLength(1));
    expect(eventIds(resumedFrames)).toEqual([`${runId}:2`]);
    expect(engine.stream).toHaveBeenCalledOnce();

    resumed.close();
    await vi.waitFor(() => expect(gateway.activeChannelCount()).toBe(0));
    expect(close).toHaveBeenCalledOnce();

    const nextSource = new PushStream<EngineSseMessage>();
    const closeNext = vi.fn(() => nextSource.end());
    engine.stream.mockResolvedValueOnce(stream(nextSource, closeNext));
    const expiredFrames: StreamFrame[] = [];
    const expired = await gateway.connect(
      subscription("expired", expiredFrames, `${runId}:2`),
    );
    expired.start();
    expect(engine.stream).toHaveBeenLastCalledWith(
      `/api/v1/runs/${runId}/stream`,
      context,
      { lastEventId: "2" },
    );
    nextSource.push(runStatus(3, "completed"));
    await vi.waitFor(() => expect(expiredFrames).toHaveLength(1));
    expect(eventIds(expiredFrames)).toEqual([`${runId}:3`]);
    expect(engine.stream).toHaveBeenCalledTimes(2);

    expired.close();
    await vi.waitFor(() => expect(gateway.activeChannelCount()).toBe(0));
    expect(closeNext).toHaveBeenCalledOnce();
  });

  it("closes active streams on session revocation or Engine revocation signal", async () => {
    const bus = new StreamRevocationBus();
    const source = new PushStream<EngineSseMessage>();
    const engine = engineStub(source);
    const gateway = new StreamGateway(engine.value, config, bus);
    const connection = await gateway.connect(subscription("revoked", []));
    connection.start();

    bus.publish({ tenantId: "other-tenant", sessionId: context.sessionId });
    expect(gateway.activeChannelCount()).toBe(1);
    bus.publish({
      tenantId: context.tenantId,
      userId: context.userId,
      sessionId: context.sessionId,
    });
    await connection.closed;
    expect(gateway.activeChannelCount()).toBe(0);

    const nextSource = new PushStream<EngineSseMessage>();
    engine.stream.mockResolvedValueOnce(stream(nextSource));
    const engineSignal = await gateway.connect(subscription("engine-signal", []));
    engineSignal.start();
    nextSource.push({ event: "permission.revoked", data: { reason: "role_changed" } });
    await engineSignal.closed;
    expect(gateway.activeChannelCount()).toBe(0);
  });

  it("coalesces rapid same-key updates for a slow consumer", async () => {
    const source = new PushStream<EngineSseMessage>();
    const gateway = new StreamGateway(
      engineStub(source).value,
      config,
      new StreamRevocationBus(),
    );
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const frames: StreamFrame[] = [];
    let first = true;
    const connection = await gateway.connect({
      ...subscription("slow", frames),
      sink: async (frame) => {
        frames.push(frame);
        if (first) {
          first = false;
          await blocked;
        }
      },
    });
    connection.start();
    source.push(runStatus(1, "running"));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    for (let seq = 2; seq <= 10; seq += 1) {
      source.push(runStatus(seq, "running"));
    }
    await vi.waitFor(() => expect(connection.pendingFrames()).toBe(1));
    release();
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(eventIds(frames)).toEqual([`${runId}:1`, `${runId}:10`]);
    connection.close();
  });

  it("bounds non-coalescible terminal frames and emits resync on overflow", async () => {
    const source = new PushStream<EngineSseMessage>();
    const gateway = new StreamGateway(
      engineStub(source).value,
      config,
      new StreamRevocationBus(),
    );
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const frames: StreamFrame[] = [];
    const connection = await gateway.connect({
      ...subscription("terminal", frames),
      target: { kind: "terminal", projectId, runId },
      sink: async (frame) => {
        frames.push(frame);
        if (frames.length === 1) {
          await blocked;
        }
      },
    });
    connection.start();
    source.push(terminalFrame(1, "one"));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    source.push(terminalFrame(2, "two"));
    source.push(terminalFrame(3, "three"));
    await vi.waitFor(() => expect(connection.pendingFrames()).toBe(2));
    source.push(terminalFrame(4, "four"));
    await vi.waitFor(() => expect(connection.pendingFrames()).toBe(1));
    release();
    await vi.waitFor(() =>
      expect(eventTypes(frames)).toContain("stream.resync"),
    );
    connection.close();
  });

  it("sends fixed heartbeat comments and rejects duplicate tab ids", async () => {
    vi.useFakeTimers();
    try {
      const source = new PushStream<EngineSseMessage>();
      const gateway = new StreamGateway(
        engineStub(source).value,
        { ...config, heartbeatMs: 50 },
        new StreamRevocationBus(),
      );
      const frames: StreamFrame[] = [];
      const connection = await gateway.connect(subscription("same-tab", frames));
      connection.start();
      connection.start();
      await vi.advanceTimersByTimeAsync(50);
      expect(frames).toContainEqual({ kind: "comment", comment: "keepalive" });
      await expect(
        gateway.connect(subscription("same-tab", [])),
      ).rejects.toMatchObject({
        problem: { status: 409, error_code: "STREAM_TAB_ALREADY_CONNECTED" },
      });
      connection.close();
      connection.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a contract-invalid event and keeps delivering the ones after it", async () => {
    const source = new PushStream<EngineSseMessage>();
    const gateway = new StreamGateway(engineStub(source).value, config, new StreamRevocationBus());
    const frames: StreamFrame[] = [];
    const connection = await gateway.connect(subscription("skip-invalid", frames));
    connection.start();

    source.push(runStatus(1, "running"));
    source.push({ id: "2", event: "run.status", data: { seq: 2, event: "run.status", run_id: runId, ts: "2026-07-24T10:00:00.000Z", data: { status: "not-a-status" } } });
    source.push({ id: "3", event: "run.status", data: { raw: true } });
    source.push(runStatus(4, "completed"));

    await vi.waitFor(() => expect(eventIds(frames)).toEqual([`${runId}:1`, `${runId}:4`]));
    expect(gateway.activeChannelCount()).toBe(1);
    connection.close();
  });

  it("closes subscriber when sink fails or upstream data is for another run", async () => {
    const source = new PushStream<EngineSseMessage>();
    const gateway = new StreamGateway(
      engineStub(source).value,
      config,
      new StreamRevocationBus(),
    );
    const failedSink = await gateway.connect({
      ...subscription("failed-sink", []),
      sink: async () => {
        throw new Error("socket closed");
      },
    });
    failedSink.start();
    source.push(runStatus(1, "running"));
    await failedSink.closed;
    expect(gateway.activeChannelCount()).toBe(0);

    const invalidSource = new PushStream<EngineSseMessage>();
    const invalidGateway = new StreamGateway(
      engineStub(invalidSource).value,
      config,
      new StreamRevocationBus(),
    );
    const invalid = await invalidGateway.connect(subscription("invalid", []));
    invalid.start();
    invalidSource.push({
      event: "run.status",
      data: { seq: 1, event: "run.status", run_id: "run_018f47a5-7b2c-7d10-8f11-000000000000", ts: "2026-07-24T10:00:00.000Z", data: { status: "running" } },
    });
    await invalid.closed;
    expect(invalidGateway.activeChannelCount()).toBe(0);
    invalid.start();
  });
});

function subscription(
  tabId: string,
  frames: StreamFrame[],
  lastEventId?: string,
) {
  return {
    tabId,
    ...(lastEventId ? { lastEventId } : {}),
    target: { kind: "run" as const, runId },
    context,
    sink: async (frame: StreamFrame) => {
      frames.push(frame);
    },
  };
}

function runStatus(
  seq: number,
  status: "running" | "paused" | "completed",
): EngineSseMessage {
  return {
    id: String(seq),
    event: "run.status",
    data: {
      seq,
      event: "run.status",
      run_id: runId,
      ts: "2026-07-24T10:00:00.000Z",
      data: { status },
    },
  };
}

function terminalFrame(seq: number, data: string): EngineSseMessage {
  return {
    id: String(seq),
    event: "terminal.frame",
    data: {
      seq,
      event: "terminal.frame",
      run_id: runId,
      ts: "2026-07-24T10:00:00.000Z",
      data: { stream: "stdout", data },
    },
  };
}

function engineStub(
  source: PushStream<EngineSseMessage>,
  close = vi.fn(() => source.end()),
) {
  const streamMethod = vi.fn(async () => stream(source, close));
  return {
    stream: streamMethod,
    value: { stream: streamMethod } as unknown as import("../engine").EngineClient,
  };
}

function stream(
  source: PushStream<EngineSseMessage>,
  close = vi.fn(() => source.end()),
): EngineEventStream {
  return { messages: source, close };
}

function eventTypes(frames: StreamFrame[]): string[] {
  return frames.flatMap((frame) =>
    frame.kind === "event" ? [frame.event.type] : [],
  );
}

function eventIds(frames: StreamFrame[]): string[] {
  return frames.flatMap((frame) =>
    frame.kind === "event" ? [frame.event.id] : [],
  );
}

function eventData(frames: StreamFrame[]): Array<Record<string, unknown>> {
  return frames.flatMap((frame) =>
    frame.kind === "event" ? [frame.event.data] : [],
  );
}

class PushStream<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
    } else {
      this.values.push(value);
    }
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) {
          return { done: false, value };
        }
        if (this.ended) {
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

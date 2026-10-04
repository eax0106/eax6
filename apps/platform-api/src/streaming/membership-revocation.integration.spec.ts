import { describe, expect, it, vi } from "vitest";
import type {
  EngineCallerContext,
  EngineEventStream,
  EngineSseMessage,
} from "../engine";
import { computeEtag } from "../concurrency";
import { MembersService } from "../members/members.service";
import type { ActorContext } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { StreamRevocationBus } from "./revocation";
import { StreamGateway } from "./stream-gateway";

const tenantId = "ten_018f47a5-7b2c-7d10-8f11-123456789abc";
const removedUserId = "usr_018f47a5-7b2c-7d10-8f11-123456789abc";

describe("membership stream revocation", () => {
  it("closes an active stream when membership is removed mid-stream", async () => {
    const source = new PendingStream<EngineSseMessage>();
    const close = vi.fn(() => source.end());
    const engine = {
      stream: vi.fn(async (): Promise<EngineEventStream> => ({
        messages: source,
        close,
      })),
    };
    const revocations = new StreamRevocationBus();
    const gateway = new StreamGateway(
      engine as unknown as import("../engine").EngineClient,
      {
        replayBufferSize: 8,
        subscriberQueueSize: 8,
        heartbeatMs: 60_000,
        replayGraceMs: 1_000,
      },
      revocations,
    );
    const connection = await gateway.connect({
      tabId: "active-tab",
      target: {
        kind: "run",
        runId: "run_018f47a5-7b2c-7d10-8f11-123456789abc",
      },
      context: streamContext(),
      sink: async () => undefined,
    });
    connection.start();
    const row = {
      id: "018f47a5-7b2c-7d10-8f11-123456789abe",
      tenantId,
      workspaceId: "018f47a5-7b2c-7d10-8f11-123456789abc",
      userId: removedUserId,
      role: "viewer",
      scope: "workspace" as const,
      email: "viewer@example.test",
      name: "Viewer",
      tenantOwner: false,
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ workspace_id: row.workspaceId }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ organization: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    let committed = false;
    const publish = vi.spyOn(revocations, "publish");
    revocations.subscribe(() => expect(committed).toBe(true));
    const recordEvent = vi.fn().mockResolvedValue(undefined);
    const members = new MembersService(
      {
        withTenant: async (_tenant: string, operation: (client: unknown) => Promise<unknown>) => {
          const result = await operation({ query });
          committed = true;
          return result;
        },
      } as unknown as PlatformDb,
      revocations,
      { recordEvent, getEvent: vi.fn() },
    );

    await members.remove(adminActor(), row.id, "workspace", computeEtag(row));
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "workspace.member.removed", target_ref: row.id,
    }));
    expect(publish).toHaveBeenCalledWith({ tenantId, userId: removedUserId });
    await connection.closed;

    expect(close).toHaveBeenCalledOnce();
    expect(gateway.activeChannelCount()).toBe(0);
  });
});

function streamContext(): EngineCallerContext {
  return {
    userId: removedUserId,
    tenantId,
    workspaceId: "ws_018f47a5-7b2c-7d10-8f11-123456789abc",
    sessionId: "removed-session",
    authTime: 1_700_000_000,
    roles: ["viewer"],
    permissions: ["runs:read"],
    traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  };
}

function adminActor(): ActorContext {
  return {
    user_id: "admin-user",
    tenant_id: tenantId,
    session_id: "admin-session",
    roles: ["owner"],
    permissions: [],
  };
}

class PendingStream<T> implements AsyncIterable<T> {
  private done = false;
  private resolve:
    | ((result: IteratorResult<T>) => void)
    | undefined;

  end(): void {
    this.done = true;
    this.resolve?.({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.done) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolve = resolve;
        });
      },
    };
  }
}

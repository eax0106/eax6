import { APP_FILTER } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  EngineClient,
  EngineExceptionFilter,
  type EngineAuthProvider,
  type EngineConfig,
} from "../engine";
import {
  IdempotencyExceptionFilter,
  IdempotencyInterceptor,
  PgIdempotencyStore,
  type IdempotencyExecution,
  type StoredHttpResponse,
} from "../idempotency";
import { RbacModule, type ActorContextType, type RbacRequest } from "../rbac";
import { AdsController } from "./ads.controller";
import { AdsExceptionFilter } from "./ads-exception.filter";
import { AdsService } from "./ads.service";

/**
 * The actor context is built from `workspace_members.workspace_id`, a bare
 * UUID (see ActorContextGuard). ads-core validates `ws_<uuid>` on every
 * scoped call and answers 422 to anything else, so the workspace id must leave
 * platform-api prefixed. These cases drive the real controller, service and
 * EngineClient with a production-shaped actor and inspect what ads-core is
 * actually sent.
 */
const workspaceUuid = "018f47a5-7b2c-7d10-8f11-00000000000a";
const tenantUuid = "018f47a5-7b2c-7d10-8f11-0000000000aa";
const actor: ActorContextType = {
  user_id: "usr_018f47a5-7b2c-7d10-8f11-0000000000ab",
  tenant_id: tenantUuid,
  workspace_id: workspaceUuid,
  session_id: "session-ads-scope",
  auth_time: 1_700_000_000,
  roles: ["admin"],
  permissions: ["knowledge:read", "knowledge:admin"],
};

const config: EngineConfig = {
  baseUrl: "https://engine.test",
  adsCoreBaseUrl: "https://ads.test",
  costLedgerBaseUrl: "https://costs.test",
  evalFacadeTokenRef: "env:EVAL_FACADE_TOKEN",
  deploymentAdminServiceTokenRef: "env:DEPLOYMENT_ADMIN_TOKEN",
  auditServiceBaseUrl: "https://audit.test",
  auditQueryServiceTokenRef: "env:AUDIT_QUERY_TOKEN",
  m2mTokenUrl: "https://identity.test/oauth/token",
  m2mAudience: "https://engine.test",
  m2mClientId: "platform-api",
  m2mClientSecretRef: "env:ENGINE_SECRET",
  requestTimeoutMs: 1_000,
  planningTimeoutMs: 120_000,
};

const authProvider: EngineAuthProvider = {
  authorize: vi.fn().mockResolvedValue({
    m2mAccessToken: "m2m-token",
    actorToken: "actor-token",
  }),
};

describe("ADS calls carry the prefixed workspace id to ads-core", () => {
  let app: NestFastifyApplication;
  const fetchImpl = vi.fn<typeof fetch>();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [AdsController],
      providers: [
        {
          provide: EngineClient,
          useFactory: () =>
            new EngineClient(config, authProvider, fetchImpl, async () => {}),
        },
        {
          provide: AdsService,
          inject: [EngineClient],
          useFactory: (client: EngineClient) => new AdsService(client),
        },
        AdsExceptionFilter,
        IdempotencyInterceptor,
        IdempotencyExceptionFilter,
        { provide: PgIdempotencyStore, useValue: new PassThroughIdempotencyStore() },
        { provide: APP_FILTER, useClass: EngineExceptionFilter },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app
      .getHttpAdapter()
      .getInstance()
      .addHook(
        "preHandler",
        (request: FastifyRequest, _reply: unknown, done: () => void) => {
          (request as RbacRequest).actorContext = actor;
          done();
        },
      );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    fetchImpl.mockReset();
  });

  afterAll(async () => app.close());

  it("creates a knowledge source with X-Alter-Workspace-Id ws_<uuid>", async () => {
    fetchImpl.mockResolvedValue(
      json(201, {
        id: "src_018f47a5-7b2c-7d10-8f11-0000000000b1",
        scope_id: "scp_018f47a5-7b2c-7d10-8f11-0000000000b2",
        connector: "drive",
        status: "pending",
      }),
    );

    const response = await inject("POST", "/api/v1/ads/sources", { connector: "drive" }, {
      "idempotency-key": "create-source",
    });

    expect(response.statusCode).toBe(201);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://ads.test/ads/sources");
    expect(headersOf(init)).toMatchObject({
      "X-Alter-Tenant-Id": `ten_${tenantUuid}`,
      "X-Alter-Workspace-Id": `ws_${workspaceUuid}`,
    });
  });

  it("lists sources with X-Alter-Workspace-Id ws_<uuid>", async () => {
    fetchImpl.mockResolvedValue(json(200, { data: [], has_more: false, next_cursor: null }));

    await inject("GET", "/api/v1/ads/sources");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("https://ads.test/ads/sources");
    expect(headersOf(init)["X-Alter-Workspace-Id"]).toBe(`ws_${workspaceUuid}`);
  });

  it("queries with ws_<uuid> in both the header and the body ads-core compares", async () => {
    fetchImpl.mockResolvedValue(json(200, { results: [] }));

    await inject("POST", "/api/v1/ads/query", {
      query: "refund policy",
      scope_ids: [`ws_${workspaceUuid}`],
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://ads.test/ads/query");
    expect(headersOf(init)["X-Alter-Workspace-Id"]).toBe(`ws_${workspaceUuid}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body["workspace_id"]).toBe(`ws_${workspaceUuid}`);
    expect(body["tenant_id"]).toBe(`ten_${tenantUuid}`);
  });

  it("does not double-prefix an actor workspace id that is already prefixed", async () => {
    fetchImpl.mockResolvedValue(json(200, { data: [], has_more: false, next_cursor: null }));
    const prefixedActor = { ...actor, workspace_id: `ws_${workspaceUuid}` };
    const original = actor.workspace_id;
    Object.assign(actor, prefixedActor);
    try {
      await inject("GET", "/api/v1/ads/sources");
    } finally {
      Object.assign(actor, { workspace_id: original });
    }

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(headersOf(init)["X-Alter-Workspace-Id"]).toBe(`ws_${workspaceUuid}`);
  });

  function inject(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ statusCode: number }> {
    return app.getHttpAdapter().getInstance().inject({
      method,
      url,
      payload: body as never,
      headers,
    } as never) as Promise<{ statusCode: number }>;
  }
});

class PassThroughIdempotencyStore {
  async execute(
    _input: IdempotencyExecution,
    operation: () => Promise<StoredHttpResponse>,
  ) {
    return { ...(await operation()), replayed: false };
  }
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

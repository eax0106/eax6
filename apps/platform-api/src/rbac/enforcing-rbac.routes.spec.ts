// C34: workspace isolation on project and workflow routes lives in the
// enforcing composition (EnforcingRbacModule, app.module), which binds a
// :projectId / :workflowId route to the workspace that owns the resource.
// Every other controller spec binds the default RbacModule, where those ids
// stay unbound -- so a regression in that binding passed them all. This mounts
// the real ProjectController and WorkflowController behind the production
// resolution rules (only the Engine and the platform DB are faked) and proves
// an actor with a role in workspace A is refused workspace B's resources.
import { APP_FILTER } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConcurrencyExceptionFilter,
  ETAG_RESOURCE_RESOLVER,
  EtagResponseInterceptor,
  IfMatchGuard,
} from "../concurrency";
import { EngineClient, EngineExceptionFilter } from "../engine";
import { IdempotencyExceptionFilter, IdempotencyInterceptor, PgIdempotencyStore } from "../idempotency";
import { ProjectController } from "../projects/project.controller";
import { ProjectExceptionFilter } from "../projects/project-exception.filter";
import { ProjectService } from "../projects/project.service";
import type { PlatformDb } from "../signup/platform-db";
import { WorkflowController } from "../workflows/workflow.controller";
import { WorkflowEtagResolver } from "../workflows/workflow-etag.resolver";
import { WorkflowExceptionFilter } from "../workflows/workflow-exception.filter";
import { WorkflowService } from "../workflows/workflow.service";
import {
  ParamWorkspaceResolver,
  RbacModule,
  defaultWorkspaceResolutionRules,
  resourceWorkspaceResolverToken,
  type ActorContextType,
  type RbacRequest,
} from ".";

const tenantId = "ten_018f47a5-7b2c-7d10-8f11-123456789abc";
const workspaceA = "ws_018f47a5-7b2c-7d10-8f11-00000000000a";
const workspaceB = "ws_018f47a5-7b2c-7d10-8f11-00000000000b";
const projectInA = "prj_018f47a5-7b2c-7d10-8f11-0000000000a1";
const projectInB = "prj_018f47a5-7b2c-7d10-8f11-0000000000b1";
const workflowInA = "wf_018f47a5-7b2c-7d10-8f11-0000000000a2";
const workflowInB = "wf_018f47a5-7b2c-7d10-8f11-0000000000b2";

const owners: Record<string, string> = {
  [`/api/v1/projects/${projectInA}`]: workspaceA,
  [`/api/v1/projects/${projectInB}`]: workspaceB,
  [`/api/v1/workflows/${workflowInA}`]: workspaceA,
  [`/api/v1/workflows/${workflowInB}`]: workspaceB,
};

// Admin of A only; the flat role union says "admin", which must not stretch to B.
const adminOfA: ActorContextType = {
  user_id: "usr_018f47a5-7b2c-7d10-8f11-123456789abc",
  tenant_id: tenantId,
  workspace_id: workspaceA,
  session_id: "session-a",
  auth_time: 1_700_000_000,
  roles: ["admin"],
  permissions: ["projects:read", "projects:write", "workflows:read", "workflows:write"],
  workspaceRoles: [{ workspaceId: workspaceA, role: "admin" }],
};

describe("enforcing RBAC on real project and workflow routes (C34)", () => {
  let app: NestFastifyApplication;
  const engine = {
    get: vi.fn(async (path: string) => {
      const workspace = owners[path];
      if (!workspace) return { status: 404, body: { error_code: "NOT_FOUND" }, headers: {} };
      return {
        status: 200,
        body: { id: path.split("/").pop(), workspace_id: workspace, tenant_id: tenantId, name: "x", status: "draft" },
        headers: {},
      };
    }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [ProjectController, WorkflowController],
      providers: [
        { provide: ProjectService, inject: [EngineClient], useFactory: (client: EngineClient) => new ProjectService(client) },
        ProjectExceptionFilter,
        WorkflowService,
        WorkflowEtagResolver,
        WorkflowExceptionFilter,
        IdempotencyInterceptor,
        IdempotencyExceptionFilter,
        IfMatchGuard,
        EtagResponseInterceptor,
        ConcurrencyExceptionFilter,
        { provide: EngineClient, useValue: engine },
        { provide: ETAG_RESOURCE_RESOLVER, useExisting: WorkflowEtagResolver },
        { provide: PgIdempotencyStore, useValue: {} },
        { provide: APP_FILTER, useClass: EngineExceptionFilter },
      ],
    })
      // The production rules, exactly as EnforcingRbacModule builds them.
      .overrideProvider(resourceWorkspaceResolverToken)
      .useValue(
        new ParamWorkspaceResolver(
          defaultWorkspaceResolutionRules({ engineClient: engine as unknown as EngineClient, db: {} as PlatformDb }),
        ),
      )
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook("preHandler", (request: FastifyRequest, _reply: unknown, done: () => void) => {
      const value = request.headers["x-test-actor"];
      if (typeof value === "string") (request as RbacRequest).actorContext = JSON.parse(value) as ActorContextType;
      done();
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => engine.get.mockClear());
  afterAll(async () => app.close());

  const get = (url: string) => app.inject({ method: "GET", url, headers: { "x-test-actor": JSON.stringify(adminOfA) } });

  it.each([
    ["project", `/api/v1/projects/${projectInA}`],
    ["workflow", `/api/v1/workflows/${workflowInA}`],
  ])("lets the admin of workspace A read a %s in A", async (_kind, url) => {
    expect((await get(url)).statusCode).toBe(200);
  });

  it.each([
    ["project", `/api/v1/projects/${projectInB}`],
    ["workflow", `/api/v1/workflows/${workflowInB}`],
  ])("refuses the admin of workspace A a %s in B, whatever the flat role says", async (_kind, url) => {
    const response = await get(url);
    expect(response.statusCode).toBe(403);
    // Only the ownership lookup reached the engine; the resource itself was never read.
    expect(engine.get).toHaveBeenCalledTimes(1);
  });

  it("answers a resource the engine cannot find as not found, never as another workspace's data", async () => {
    expect((await get("/api/v1/projects/prj_018f47a5-7b2c-7d10-8f11-00000000dead")).statusCode).toBe(404);
  });
});

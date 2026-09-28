import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAuditService } from "../admin-audit";
import { RbacModule, type RbacRequest } from "../rbac";
import { AdminPublisherController } from "./admin-publisher.controller";
import { AdminPublisherRepository, AdminPublisherUnavailableError } from "./admin-publisher.repository";
import { AdminPublisherService } from "./admin-publisher.service";
import { PublisherService } from "./publisher.service";

const tenantId = "018f47a5-7b2c-7d10-8f11-123456789abc";
const submissionId = "kyc_018f47a5-7b2c-7d10-8f11-123456789def";
const url = `/api/v1/admin/publisher/verifications/${tenantId}/${submissionId}/actions/review`;

describe("Admin seller-verification routes (task B2.4)", () => {
  let app: NestFastifyApplication;
  const repository = { listPending: vi.fn(async () => [{ id: submissionId, tenant_id: tenantId, publisher_id: "pub_1", documents: [], submitted_at: "x" }]) };
  const publisher = {
    reviewVerification: vi.fn(async (_tenant: string, id: string, _reviewer: string, input: { decision: string }) => ({ id, status: input.decision })),
  };
  const audit = { record: vi.fn(async () => "a".repeat(64)) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [AdminPublisherController],
      providers: [
        AdminPublisherService,
        { provide: AdminPublisherRepository, useValue: repository },
        { provide: PublisherService, useValue: publisher },
        { provide: AdminAuditService, useValue: audit },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook("preHandler", (request: FastifyRequest, _reply, done) => {
      const value = request.headers["x-test-staff"];
      if (typeof value === "string") (request as RbacRequest).staffActorContext = JSON.parse(value);
      done();
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => app.close());

  const staff = (roles: string[]) =>
    JSON.stringify({ staff_user_id: "stf_1", identity_ref: "auth0|1", email: "ops@alter.example", roles });

  it("lets admins and security staff read the queue, not support or billing ops, and never a tenant user", async () => {
    const get = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/api/v1/admin/publisher/verifications", headers });
    expect((await get({ "x-test-staff": staff(["staff_security"]) })).statusCode).toBe(200);
    expect((await get({ "x-test-staff": staff(["staff_admin"]) })).statusCode).toBe(200);
    expect((await get({ "x-test-staff": staff(["staff_support"]) })).statusCode).toBe(403);
    expect((await get({ "x-test-staff": staff(["staff_billing_ops"]) })).statusCode).toBe(403);
    expect((await get({})).statusCode).toBeGreaterThanOrEqual(401);
  });

  it("approves in the submission's tenant as the staff member and audits the decision", async () => {
    const response = await app.inject({ method: "POST", url, headers: { "x-test-staff": staff(["staff_security"]) }, payload: { decision: "approved" } });
    expect(response.statusCode).toBe(201);
    expect(publisher.reviewVerification).toHaveBeenCalledWith(tenantId, submissionId, "stf_1", { decision: "approved" });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      tenantId, actorType: "admin", actorRef: "stf_1", action: "publisher.kyc.approved", targetRef: submissionId,
    }));
  });

  it("refuses a rejection without a reason, a malformed id, and a support user", async () => {
    const post = (path: string, payload: unknown, roles = ["staff_admin"]) =>
      app.inject({ method: "POST", url: path, headers: { "x-test-staff": staff(roles) }, payload: payload as object });
    expect((await post(url, { decision: "rejected" })).statusCode).toBe(400);
    expect((await post(url.replace(tenantId, "not-a-tenant"), { decision: "approved" })).statusCode).toBe(400);
    expect((await post(url, { decision: "approved" }, ["staff_support"])).statusCode).toBe(403);
    expect(publisher.reviewVerification).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("answers 503 when the Operations pool is not configured", async () => {
    repository.listPending.mockRejectedValueOnce(new AdminPublisherUnavailableError());
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/publisher/verifications", headers: { "x-test-staff": staff(["staff_admin"]) } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error_code: "PUBLISHER_REVIEW_UNAVAILABLE" });
  });
});

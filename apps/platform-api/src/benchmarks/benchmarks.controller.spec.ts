import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EvalFacadeClient } from "../engine";
import { RbacModule, type RbacRequest } from "../rbac";
import { EvalHistoryClient } from "./history.client";
import { BenchmarksController } from "./benchmarks.controller";
import { BenchmarksExceptionFilter } from "./benchmarks-exception.filter";
import { BenchmarksService } from "./benchmarks.service";

describe("Benchmark relay routes", () => {
  let app: NestFastifyApplication;
  const history = {list:vi.fn().mockResolvedValue({data:[],nextCursor:null})};
  const client = {
    runEvaluation: vi.fn().mockResolvedValue({
      evaluation_run_id: "evr_1",
      status: "completed",
      results_json: "{}",
    }),
    checkReleaseGate: vi.fn().mockResolvedValue({ passed: true, failed_thresholds: [] }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RbacModule],
      controllers: [BenchmarksController],
      providers: [
        BenchmarksService,
        { provide: EvalHistoryClient, useValue: history },
        BenchmarksExceptionFilter,
        { provide: EvalFacadeClient, useValue: client },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.getHttpAdapter().getInstance().addHook(
      "preHandler",
      (request: FastifyRequest, _reply: unknown, done: () => void) => {
        const value = request.headers["x-test-staff"];
        if (typeof value === "string") {
          (request as RbacRequest).staffActorContext = JSON.parse(value);
        }
        done();
      },
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => app.close());

  it("reads bounded history for current authorized staff and denies other roles",async()=>{
    for(const role of ["staff_admin","staff_security"]){const response=await inject({method:"GET",url:"/api/v1/admin/benchmarks/runs?limit=10&golden_set=planner",headers:{"x-test-staff":JSON.stringify(staff([role]))}});expect(response.statusCode).toBe(200);expect(response.json()).toEqual({data:[],nextCursor:null});}
    expect(history.list).toHaveBeenCalledWith({limit:10,golden_set:"planner"},undefined);
    for(const roles of [undefined,["staff_support"],["staff_billing_ops"]]){const response=await inject({method:"GET",url:"/api/v1/admin/benchmarks/runs",headers:roles?{"x-test-staff":JSON.stringify(staff(roles))}:{}});expect(response.statusCode).toBe(403);}
    const bad=await inject({method:"GET",url:"/api/v1/admin/benchmarks/runs?limit=101",headers:{"x-test-staff":JSON.stringify(staff(["staff_admin"]))}});expect(bad.statusCode).toBe(400);
  });

  it("relays the current run and release-gate shapes for authorized staff only", async () => {
    const headers = {
      "content-type": "application/json",
      "x-test-staff": JSON.stringify(staff(["staff_admin"])),
    };
    const run = await inject({
      method: "POST",
      url: "/api/v1/admin/benchmarks/actions/run",
      headers,
      payload: JSON.stringify({ golden_set_name: "planner" }),
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ evaluation_run_id: "evr_1", status: "completed" });
    expect(client.runEvaluation).toHaveBeenCalledWith({ golden_set_name: "planner" }, undefined);

    const gate = await inject({
      method: "GET",
      url: "/api/v1/admin/benchmarks/release-gates/engine?evaluation_run_id=evr_1",
      headers: { "x-test-staff": JSON.stringify(staff(["staff_security"])) },
    });
    expect(gate.statusCode).toBe(200);
    expect(gate.json()).toEqual({ passed: true, failed_thresholds: [] });
    expect(client.checkReleaseGate).toHaveBeenCalledWith({
      release_gate_key: "engine",
      evaluation_run_id: "evr_1",
    }, undefined);

    const denied = await inject({
      method: "POST",
      url: "/api/v1/admin/benchmarks/actions/run",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ golden_set_name: "planner" }),
    });
    expect(denied.statusCode).toBe(403);
    expect(client.runEvaluation).toHaveBeenCalledTimes(1);
  });

  it("rejects legacy input and a missing evaluation run identifier", async () => {
    const headers = {
      "content-type": "application/json",
      "x-test-staff": JSON.stringify(staff(["staff_admin"])),
    };
    const legacy = await inject({
      method: "POST",
      url: "/api/v1/admin/benchmarks/actions/run",
      headers,
      payload: JSON.stringify({ golden_set_reference: "legacy" }),
    });
    expect(legacy.statusCode).toBe(400);
    expect(legacy.headers["content-type"]).toContain("application/problem+json");
    expect(legacy.json()).toMatchObject({ error_code: "BENCHMARKS_VALIDATION_FAILED" });

    const missingRun = await inject({
      method: "GET",
      url: "/api/v1/admin/benchmarks/release-gates/engine",
      headers,
    });
    expect(missingRun.statusCode).toBe(400);
    expect(client.checkReleaseGate).toHaveBeenCalledTimes(1);
  });

  function inject(input: {
    method: "GET" | "POST";
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }) {
    return app.getHttpAdapter().getInstance().inject(input);
  }
});

function staff(roles: string[]) {
  return {
    staff_user_id: "stf_test",
    identity_ref: "auth0|test",
    email: "ops@example.com",
    roles,
  };
}

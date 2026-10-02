import { randomUUID } from "node:crypto";
import { Controller, Get, Headers, HttpException, Param, Req, Res } from "@nestjs/common";
import type { IdentityTenantGatewayRequest } from "@alterx/auth";
import type { ProblemDetails } from "@alterx/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { RunStreamEventService, type StreamPage } from "./run-stream-event.service";

const HEARTBEAT_MS = 15_000;

@Controller("api/v1")
export class RunStreamController {
  constructor(private readonly events: RunStreamEventService) {}

  @Get("runs/:id/stream")
  async stream(
    @Req() request: FastifyRequest & IdentityTenantGatewayRequest,
    @Res() reply: FastifyReply,
    @Param("id") runId: string,
    @Headers("last-event-id") lastEventId: string | undefined,
  ): Promise<void> {
    await this.openStream(
      request,
      reply,
      runId,
      lastEventId,
      "/runs/{id}/stream",
      () => this.events.runIsVisible(request.actorContext!.tenant_id, runId),
      (tenantId, cursor) => this.events.listAfter(tenantId, runId, cursor),
    );
  }

  @Get("projects/:projectId/builds/:runId/stream")
  async terminal(
    @Req() request: FastifyRequest & IdentityTenantGatewayRequest,
    @Res() reply: FastifyReply,
    @Param("projectId") projectId: string,
    @Param("runId") runId: string,
    @Headers("last-event-id") lastEventId: string | undefined,
  ): Promise<void> {
    await this.openStream(
      request,
      reply,
      runId,
      lastEventId,
      "/projects/{projectId}/builds/{runId}/stream",
      () => this.events.projectRunIsVisible(request.actorContext!.tenant_id, projectId, runId),
      (tenantId, cursor) => this.events.listTerminalAfter(tenantId, runId, cursor),
    );
  }

  private async openStream(
    request: FastifyRequest & IdentityTenantGatewayRequest,
    reply: FastifyReply,
    runId: string,
    lastEventId: string | undefined,
    instance: string,
    visible: () => Promise<boolean>,
    listEvents: (tenantId: string, cursor: number) => Promise<StreamPage>,
  ): Promise<void> {
    const tenantId = request.actorContext?.tenant_id;
    if (!tenantId) {
      throw problem(reply, 401, "AUTH_CONTEXT_REQUIRED", "Authenticated tenant context is required.", instance);
    }
    if (
      lastEventId !== undefined &&
      !/^(0|[1-9]\d*)$/.test(lastEventId)
    ) {
      throw problem(reply, 400, "INVALID_LAST_EVENT_ID", "Last-Event-ID must be a non-negative integer.", instance);
    }
    let cursor = lastEventId === undefined ? 0 : Number(lastEventId);
    if (!Number.isSafeInteger(cursor)) {
      throw problem(reply, 400, "INVALID_LAST_EVENT_ID", "Last-Event-ID is outside the supported range.", instance);
    }
    if (!(await visible())) {
      throw problem(reply, 404, "RUN_NOT_FOUND", "The requested run was not found.", instance);
    }
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    reply.raw.flushHeaders();
    const deadline = request.actorTokenExpiresAtMs ?? Date.now() + 300_000;
    let heartbeatAt = Date.now() + HEARTBEAT_MS;
    while (!reply.raw.writableEnded && !reply.raw.destroyed && Date.now() < deadline) {
      const page = await listEvents(tenantId, cursor);
      for (const event of page.events) {
        await write(reply, `id: ${event.seq}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      cursor = page.readThrough;
      if (Date.now() >= heartbeatAt) {
        await write(reply, ": keepalive\n\n");
        heartbeatAt = Date.now() + HEARTBEAT_MS;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    reply.raw.end();
  }
}

async function write(reply: FastifyReply, frame: string): Promise<void> {
  if (reply.raw.write(frame)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      reply.raw.off("drain", done);
      reply.raw.off("close", done);
      resolve();
    };
    reply.raw.once("drain", done);
    reply.raw.once("close", done);
  });
}

function problem(
  reply: FastifyReply,
  status: number,
  errorCode: string,
  detail: string,
  instance: string,
): HttpException {
  reply.header("content-type", "application/problem+json");
  const body: ProblemDetails = {
    type: `https://alter.dev/problems/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: status === 404 ? "Not Found" : status === 401 ? "Unauthorized" : "Bad Request",
    status,
    detail,
    instance,
    error_code: errorCode,
    trace_id: prefixedUuidV7("trc"),
    request_id: prefixedUuidV7("req"),
    retryable: false,
    field_errors: [],
    documentation_key: `runs.stream.${errorCode.toLowerCase().replaceAll("_", "-")}`,
  };
  return new HttpException(body, status);
}

function prefixedUuidV7(prefix: "trc" | "req"): `${typeof prefix}_${string}` {
  const uuid = randomUUID();
  return `${prefix}_${uuid.slice(0, 14)}7${uuid.slice(15)}`;
}

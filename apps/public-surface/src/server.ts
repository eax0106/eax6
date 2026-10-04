import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { PublicFormHttpError, type PublicFormService } from "./public-form.service";
import { renderPublicForm } from "./render-form";

export function createPublicSurfaceServer(service: PublicFormService, siteKey: string, origin: string, readiness: () => Promise<void>, trustProxy: false | string[] = false) {
  const app = Fastify({ logger: false, bodyLimit: 40 * 1024, trustProxy, requestTimeout: 30000, routerOptions: { maxParamLength: 128 } });
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").header("x-content-type-options", "nosniff");
  });
  app.setErrorHandler((error, _request, reply) => {
    const parserStatus = error instanceof Error && "statusCode" in error ? error.statusCode : undefined;
    const status = error instanceof PublicFormHttpError ? error.status : (parserStatus === 413 || parserStatus === 415 || parserStatus === 400 ? parserStatus : 503);
    reply.code(status).send({ message: error instanceof PublicFormHttpError ? error.message : status === 503 ? "Form temporarily unavailable" : "Invalid submission" });
  });
  app.get("/health", async () => { await readiness(); return { component: "public-surface", database: "connected", rateStore: "connected" }; });
  app.get<{ Params: { token: string } }>("/f/:token", async (request, reply) => {
    const page = await service.page(request.params.token, request.ip), nonce = randomBytes(18).toString("base64");
    reply.header("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; style-src 'unsafe-inline'; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    return reply.type("text/html; charset=utf-8").send(renderPublicForm(page.definition, siteKey, page.context, nonce));
  });
  app.post<{ Params: { token: string } }>("/f/:token", async (request, reply) => {
    if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new PublicFormHttpError(403, "Submission origin refused");
    if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new PublicFormHttpError(415, "Only JSON form fields are accepted");
    await service.submit(request.params.token, request.ip, request.body);
    return reply.code(202).send({ accepted: true });
  });
  return app;
}

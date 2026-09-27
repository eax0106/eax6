import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpCode, HttpException, Inject, Optional, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Public, RequireStaffRole, StaffActorContext } from "../rbac/decorators";
import { type StaffActorContext as StaffActor, staffRoles } from "../rbac/types";
import { StaffService } from "./staff.service";

/** The cookie StaffAuthMiddleware reads. Scoped to the API, never readable by script. */
export const STAFF_ACCESS_COOKIE = "alter_staff_access";
const BASE = "/api/v1/admin/session";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
/** Test seam for the staff identity provider's token endpoint. */
export const STAFF_SESSION_FETCH = "STAFF_SESSION_FETCH";

/**
 * Staff sign-in for the admin console (task B1.0). Staff authenticate against
 * the dedicated staff Auth0 tenant (AUTH0_STAFF_DOMAIN), never the customer
 * tenant, using authorization code with PKCE: the browser holds the verifier,
 * this controller builds the authorize URL and exchanges the code.
 *
 * A token is only turned into a session when StaffService.resolve recognises
 * the person as a staff user -- an Auth0 account that exists but was never
 * added to staff_users gets a 403 and no cookie.
 */
@Controller(BASE)
export class StaffSessionController {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly staff: StaffService,
    @Optional() @Inject(STAFF_SESSION_FETCH) fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  @Post("login")
  @Public()
  @HttpCode(200)
  login(@Body() body: unknown): { url: string } {
    const config = staffAuthConfig(`${BASE}/login`);
    const { redirectUri, state, codeChallenge } = requireStrings(body, ["redirectUri", "state", "codeChallenge"], `${BASE}/login`);
    const url = new URL(`https://${config.domain}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: redirectUri,
      scope: "openid profile email",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString() };
  }

  @Get("callback")
  @Public()
  async callback(
    @Query("code") code: string | undefined,
    @Query("redirect_uri") redirectUri: string | undefined,
    @Query("code_verifier") codeVerifier: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const instance = `${BASE}/callback`;
    const config = staffAuthConfig(instance);
    if (!code || !redirectUri || !codeVerifier) {
      return sendProblem(reply, 400, "INVALID_CALLBACK", "code, redirect_uri and code_verifier are required", instance);
    }
    const tokenResponse = await this.fetchImpl(`https://${config.domain}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    }).catch(() => undefined);
    if (!tokenResponse?.ok) {
      return sendProblem(reply, 401, "STAFF_SIGN_IN_FAILED", "The staff identity provider did not accept the sign-in", instance);
    }
    const token = (await tokenResponse.json()) as { access_token?: string; expires_in?: number };
    if (!token.access_token) {
      return sendProblem(reply, 401, "STAFF_SIGN_IN_FAILED", "No access token was issued", instance);
    }
    const staffUser = await this.staff.resolve(token.access_token);
    if (!staffUser) {
      return sendProblem(reply, 403, "STAFF_NOT_RECOGNISED", "This account is not a staff member", instance);
    }
    const maxAge = Math.max(60, Math.min(token.expires_in ?? 3600, 8 * 3600));
    reply
      .header("Set-Cookie", serializeCookie(token.access_token, maxAge))
      .status(200)
      .send({ email: staffUser.email, roles: staffUser.roles });
  }

  @Get()
  @RequireStaffRole(...staffRoles)
  session(@StaffActorContext() staff: StaffActor | undefined): { email: string; roles: readonly string[] } {
    return { email: staff?.email ?? "", roles: staff?.roles ?? [] };
  }

  @Post("logout")
  @Public()
  @HttpCode(204)
  logout(@Req() _request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply): void {
    reply.header("Set-Cookie", serializeCookie("", 0));
  }
}

function serializeCookie(value: string, maxAgeSeconds: number): string {
  return `${STAFF_ACCESS_COOKIE}=${value}; Max-Age=${maxAgeSeconds}; Path=/api/v1; HttpOnly; Secure; SameSite=Lax`;
}

function staffAuthConfig(instance: string): { domain: string; clientId: string } {
  const domain = process.env.AUTH0_STAFF_DOMAIN?.trim();
  const clientId = process.env.AUTH0_STAFF_CLIENT_ID?.trim();
  if (!domain || !clientId) {
    throw new StaffSessionUnavailable(instance);
  }
  return { domain, clientId };
}

function requireStrings<K extends string>(body: unknown, keys: readonly K[], instance: string): Record<K, string> {
  const record = (body ?? {}) as Record<string, unknown>;
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new StaffSessionBadRequest(`${key} is required`, instance);
    }
    out[key] = value;
  }
  return out;
}

function problem(status: number, errorCode: string, detail: string, instance: string) {
  return {
    type: `https://errors.alter.ai/${errorCode.toLowerCase().replaceAll("_", "-")}`,
    title: errorCode,
    status,
    detail,
    instance,
    error_code: errorCode,
    trace_id: `trc_${randomUUID()}`,
    request_id: `req_${randomUUID()}`,
    retryable: status >= 500,
    field_errors: [],
    documentation_key: errorCode.toLowerCase().replaceAll("_", "."),
  };
}

function sendProblem(reply: FastifyReply, status: number, code: string, detail: string, instance: string): void {
  reply.status(status).type("application/problem+json").send(problem(status, code, detail, instance));
}

class StaffSessionUnavailable extends HttpException {
  constructor(instance: string) {
    super(
      problem(503, "STAFF_SIGN_IN_UNAVAILABLE", "Staff sign-in is not configured (AUTH0_STAFF_DOMAIN, AUTH0_STAFF_CLIENT_ID)", instance),
      503,
    );
  }
}

class StaffSessionBadRequest extends HttpException {
  constructor(detail: string, instance: string) {
    super(problem(400, "VALIDATION_FAILED", detail, instance), 400);
  }
}

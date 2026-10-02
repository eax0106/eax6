import { createHash, timingSafeEqual } from "node:crypto";
import { Body, Controller, Headers, HttpCode, HttpException, Inject, Post } from "@nestjs/common";
import { Public as InternalConnectionServiceAuth } from "@alterx/auth";
import { ConnectionCredentialLookupSchema, ConnectionRegistrySnapshotSchema } from "@alterx/contracts";
import { ConnectionRegistryConflictError, ConnectionRegistryUnavailableError, ConnectionRegistryService } from "./connection-registry.service";

export const CONNECTION_LOOKUP_TOKEN_HASH = Symbol("CONNECTION_LOOKUP_TOKEN_HASH");
export const CONNECTION_REGISTRY_TOKEN_HASH = Symbol("CONNECTION_REGISTRY_TOKEN_HASH");

@InternalConnectionServiceAuth()
@Controller("internal/connections")
export class ConnectionRegistryController {
  constructor(private readonly registry: ConnectionRegistryService,
    @Inject(CONNECTION_REGISTRY_TOKEN_HASH) private readonly tokenHash: string,
    @Inject(CONNECTION_LOOKUP_TOKEN_HASH) private readonly lookupTokenHash: string) {}

  @Post("resolve")
  @HttpCode(200)
  async resolve(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const actual = createHash("sha256").update(token).digest(), expected = Buffer.from(this.lookupTokenHash, "hex");
    if (!token || expected.length !== actual.length || !timingSafeEqual(actual, expected)) throw new HttpException("Internal service authentication required", 401);
    const parsed = ConnectionCredentialLookupSchema.safeParse(body);
    if (!parsed.success) throw new HttpException("Invalid credential lookup", 400);
    try { return await this.registry.resolve(parsed.data); }
    catch (error) {
      if (error instanceof ConnectionRegistryUnavailableError) throw new HttpException({ error_code: "CREDENTIAL_MISSING" }, 409);
      throw error;
    }
  }

  @Post("upsert")
  @HttpCode(200)
  async upsert(@Body() body: unknown, @Headers("authorization") authorization?: string) {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const actual = createHash("sha256").update(token).digest(), expected = Buffer.from(this.tokenHash, "hex");
    if (!token || expected.length !== actual.length || !timingSafeEqual(actual, expected)) throw new HttpException("Internal service authentication required", 401);
    const parsed = ConnectionRegistrySnapshotSchema.safeParse(body);
    if (!parsed.success) throw new HttpException("Invalid connection snapshot", 400);
    try { return await this.registry.upsert(parsed.data); }
    catch (error) {
      if (error instanceof ConnectionRegistryConflictError) throw new HttpException(error.message, 409);
      throw error;
    }
  }
}

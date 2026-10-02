import { HttpException, type ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { PUBLIC_ROUTE_METADATA } from "./public-route";
import { SessionGatewayUploadAllowlistGuard } from "./upload-allowlist.guard";
import type { IdentityTenantGatewayRequest } from "./types";

function contextFor(
  headers: Record<string, string | string[] | undefined>,
  publicRoute = false,
  method = "POST",
): ExecutionContext {
  const request: IdentityTenantGatewayRequest = {
    headers,
    method,
    url: "/v1/upload",
  };
  const handler = () => undefined;
  if (publicRoute) {
    Reflect.defineMetadata(PUBLIC_ROUTE_METADATA, true, handler);
  }
  return {
    getHandler: () => handler,
    getClass: () => class TestController {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ header: () => undefined }),
    }),
  } as unknown as ExecutionContext;
}

describe("SessionGatewayUploadAllowlistGuard", () => {
  it("bypasses the check for public routes", () => {
    const guard = new SessionGatewayUploadAllowlistGuard();
    expect(
      guard.canActivate(contextFor({ "content-type": "application/exe" }, true)),
    ).toBe(true);
  });

  it("rejects a body-bearing request with no content-type header", () => {
    const guard = new SessionGatewayUploadAllowlistGuard();
    expect(() => guard.canActivate(contextFor({}))).toThrow(HttpException);
  });

  it("allows a bodyless request with no content-type header", () => {
    const guard = new SessionGatewayUploadAllowlistGuard();
    expect(guard.canActivate(contextFor({}, false, "GET"))).toBe(true);
  });

  it("allows an allowlisted content-type", () => {
    const guard = new SessionGatewayUploadAllowlistGuard();
    expect(
      guard.canActivate(contextFor({ "content-type": "application/json" })),
    ).toBe(true);
  });

  it("allows an allowlisted content-type with a charset parameter", () => {
    const guard = new SessionGatewayUploadAllowlistGuard();
    expect(
      guard.canActivate(
        contextFor({ "content-type": "application/json; charset=utf-8" }),
      ),
    ).toBe(true);
  });

  it("rejects a non-allowlisted content-type with 415", () => {
    const guard = new SessionGatewayUploadAllowlistGuard();
    expect(() =>
      guard.canActivate(
        contextFor({ "content-type": "application/x-msdownload" }),
      ),
    ).toThrow(HttpException);
    try {
      guard.canActivate(
        contextFor({ "content-type": "application/x-msdownload" }),
      );
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(415);
    }
  });

  it("respects a custom allowlist", () => {
    const guard = new SessionGatewayUploadAllowlistGuard({
      allowedContentTypes: ["application/x-custom"],
    });
    expect(
      guard.canActivate(contextFor({ "content-type": "application/x-custom" })),
    ).toBe(true);
    expect(() =>
      guard.canActivate(contextFor({ "content-type": "application/json" })),
    ).toThrow(HttpException);
  });

  it("rejects a request whose content-length exceeds the maximum", () => {
    const guard = new SessionGatewayUploadAllowlistGuard({
      maxContentLengthBytes: 100,
    });
    expect(() =>
      guard.canActivate(
        contextFor({
          "content-type": "application/json",
          "content-length": "101",
        }),
      ),
    ).toThrow(HttpException);
  });

  it("allows a request at exactly the content-length maximum", () => {
    const guard = new SessionGatewayUploadAllowlistGuard({
      maxContentLengthBytes: 100,
    });
    expect(
      guard.canActivate(
        contextFor({
          "content-type": "application/json",
          "content-length": "100",
        }),
      ),
    ).toBe(true);
  });

  it("allows a chunked request with an allowlisted content type", () => {
    const guard = new SessionGatewayUploadAllowlistGuard();
    expect(
      guard.canActivate(
        contextFor({
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        }),
      ),
    ).toBe(true);
  });
});

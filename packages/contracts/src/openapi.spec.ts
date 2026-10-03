import SwaggerParser from "@apidevtools/swagger-parser";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenApiDocument, V1_ROUTE_SPECS } from "./openapi";

const artifactPath = resolve(
  process.cwd(),
  "packages/contracts/openapi.json",
);

describe("OpenAPI generation", () => {
  it("documents strict canonical node comparison, advisory facts and recursive declared port types", () => {
    const document = createOpenApiDocument();
    expect(document.paths?.["/api/v1/workflows/{id}/node-overrides/compare"]?.post).toMatchObject({
      requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NodeOverrideRequest" } } } },
      responses: { "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/NodeOverrideComparison" } } } } },
    });
    expect(document.components?.schemas?.NodeOverrideRequest).toMatchObject({ additionalProperties: false, required: ["nodeKey", "choice", "dag"] });
    expect(document.components?.schemas?.NodeDataContract).toMatchObject({ type: "object", properties: { items: { $ref: "#/components/schemas/NodeDataContract" } } });
    expect(document.components?.schemas?.NodeOverrideComparison).toMatchObject({ properties: { approval_required: { type: "boolean" }, cost: { type: "object" } } });
  });
  it("generates a valid OpenAPI 3.1.1 document", async () => {
    const document = createOpenApiDocument();
    await SwaggerParser.validate(
      structuredClone(document) as never,
    );

    expect(document.openapi).toBe("3.1.1");
  });

  it("covers every API Spec section 7.1 through 7.10 operation", () => {
    const document = createOpenApiDocument();
    const paths = document.paths ?? {};

    for (const route of V1_ROUTE_SPECS) {
      const operation = paths[
        `/api/v1${route.path}`
      ]?.[route.method];

      expect(operation, `${route.method} ${route.path}`).toBeDefined();
    }

    const operationCount = Object.values(paths).reduce(
      (count, pathItem) =>
        count +
        ["get", "post", "put", "patch", "delete"].filter(
          (method) =>
            pathItem?.[method as keyof typeof pathItem] !== undefined,
        ).length,
      0,
    );
    expect(operationCount).toBe(V1_ROUTE_SPECS.length);
    // 109 before the seven Voice channel operations were removed with Voice.
    // Two node override operations added by D20.
    expect(operationCount).toBe(104);
  });

  it("documents the test-version workflow action", () => {
    const operation = createOpenApiDocument().paths?.[
      "/api/v1/workflows/{id}/actions/test-version"
    ]?.post;

    expect(operation?.requestBody).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/TestVersionRequest" },
        },
      },
    });
    expect(operation?.responses?.[200]).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/TestVersionResult" },
        },
      },
    });
  });

  it("documents ADS source permission routes", () => {
    const document = createOpenApiDocument();
    const get =
      document.paths?.["/api/v1/ads/sources/{id}/permissions"]?.get;
    const put =
      document.paths?.["/api/v1/ads/sources/{id}/permissions"]?.put;

    expect(
      get?.responses?.[200]?.content?.["application/json"]?.schema,
    ).toEqual(
      expect.objectContaining({
        allOf: expect.arrayContaining([
          { $ref: "#/components/schemas/AdsSourcePermissions" },
        ]),
      }),
    );
    expect(put?.requestBody).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/AdsSourcePermissions" },
        },
      },
    });
    expect(put?.responses?.[200]).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/AdsSourcePermissions" },
        },
      },
    });
    expect(document.components?.schemas?.AdsSourcePermissions).toMatchObject({
      properties: expect.objectContaining({
        visibility: expect.any(Object),
        shared_with: expect.any(Object),
        retention_days: expect.any(Object),
      }),
    });
  });

  it("documents ADS retrieval request and response shapes", () => {
    const document = createOpenApiDocument();
    const query = document.paths?.["/api/v1/ads/query"]?.post;

    expect(query?.requestBody).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/AdsRetrievalRequest" },
        },
      },
    });
    expect(query?.responses?.[200]).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/AdsRetrievalResponse" },
        },
      },
    });
    expect(document.components?.schemas?.AdsRetrievalResult).toMatchObject({
      required: expect.arrayContaining([
        "id",
        "document_id",
        "chunk_id",
        "score",
        "confidence",
        "provenance",
      ]),
    });
  });

  it("documents ADS upload signed URL and ingestion job shapes", () => {
    const document = createOpenApiDocument();
    const upload = document.paths?.["/api/v1/ads/ingestion/uploads"]?.post;
    const job = document.paths?.["/api/v1/ads/ingestion/jobs/{id}"]?.get;

    expect(upload?.responses?.[202]).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/AdsUploadStartResponse" },
        },
      },
    });
    expect(job?.responses?.[200]).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/AdsIngestionJob" },
        },
      },
    });
    expect(document.components?.schemas?.AdsUploadStartResponse).toMatchObject({
      required: expect.arrayContaining(["ingestion_job_id", "upload"]),
    });
    expect(document.components?.schemas?.SignedReference).toMatchObject({
      required: expect.arrayContaining(["signed_url", "expires_at"]),
    });
    expect(document.components?.schemas?.AdsIngestionJob).toMatchObject({
      required: expect.arrayContaining([
        "status",
        "progress",
        "document_ids",
        "failure_detail",
      ]),
    });
  });

  it("documents both auth headers, problem responses, and idempotency", () => {
    const document = createOpenApiDocument();
    const paths = document.paths ?? {};
    const securitySchemes = document.components?.securitySchemes;

    expect(securitySchemes).toHaveProperty("M2MAuth");
    expect(securitySchemes).toHaveProperty("ActorToken");

    for (const route of V1_ROUTE_SPECS) {
      const operation = paths[
        `/api/v1${route.path}`
      ]?.[route.method];
      if (operation === undefined) {
        throw new Error(`Missing OpenAPI operation: ${route.method} ${route.path}`);
      }

      const defaultResponse = operation.responses?.default;
      expect(defaultResponse).toMatchObject({
        content: {
          "application/problem+json": {
            schema: { $ref: "#/components/schemas/ProblemDetails" },
          },
        },
      });

      if (route.method !== "get" && route.idempotent !== false) {
        expect(operation.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              in: "header",
              name: "Idempotency-Key",
              required: true,
            }),
          ]),
        );
      }
    }
  });

  it("documents tracing headers on every response and Location on 202 responses", () => {
    const document = createOpenApiDocument();
    const paths = document.paths ?? {};

    for (const route of V1_ROUTE_SPECS) {
      const operation = paths[`/api/v1${route.path}`]?.[route.method];
      if (operation === undefined) {
        throw new Error(`Missing OpenAPI operation: ${route.method} ${route.path}`);
      }

      for (const [status, responseOrReference] of Object.entries(
        operation.responses ?? {},
      )) {
        if ("$ref" in responseOrReference) {
          throw new Error(`Unexpected response reference: ${route.method} ${route.path}`);
        }

        expect(responseOrReference.headers).toEqual(
          expect.objectContaining({
            request_id: expect.any(Object),
            trace_id: expect.any(Object),
          }),
        );

        if (status === "202") {
          expect(responseOrReference.headers).toEqual(
            expect.objectContaining({ Location: expect.any(Object) }),
          );
        }
      }
    }
  });

  it("encodes cursor pagination defaults and maximums", () => {
    const document = createOpenApiDocument();
    const runsOperation = document.paths?.["/api/v1/runs"]?.get;
    const limitParameter = runsOperation?.parameters?.find(
      (parameter) =>
        "name" in parameter && parameter.name === "limit",
    );

    expect(limitParameter).toMatchObject({
      in: "query",
      required: false,
      schema: {
        default: 50,
        maximum: 200,
        minimum: 1,
        type: "integer",
      },
    });
  });

  it("matches the committed generated artifact without drift", async () => {
    const generated = `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`;
    const committed = await readFile(artifactPath, "utf8");

    expect(committed.replace(/\r\n/g, "\n")).toBe(generated);
  });
});

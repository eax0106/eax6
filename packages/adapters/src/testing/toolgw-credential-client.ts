import { credentials, loadPackageDefinition, type Client, type Metadata } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import type { ToolgwResolveCredentialRequest, ToolgwResolveCredentialResponse } from "@alterx/contracts";
import type { ToolGatewayClientConfig } from "../grpc/toolgw-client";
import { serviceAuthorizationMetadata } from "../grpc/service-auth";

/** Native credential RPC for integration fixtures, with the production auth metadata. */
export async function resolveToolGatewayCredential(config: ToolGatewayClientConfig, request: ToolgwResolveCredentialRequest): Promise<ToolgwResolveCredentialResponse> {
  const definition = loadSync(config.protoPath, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  type CredentialClient = Client & { resolveCredential(request: ToolgwResolveCredentialRequest, metadata: Metadata, options: { deadline: Date }, callback: (error: Error | null, response: ToolgwResolveCredentialResponse) => void): void };
  const proto = loadPackageDefinition(definition) as unknown as { alter: { toolgw: { v1: { ToolgwService: new(address: string, creds: ReturnType<typeof credentials.createInsecure>) => CredentialClient } } } };
  const client = new proto.alter.toolgw.v1.ToolgwService(config.address, credentials.createInsecure());
  try {
    const metadata = await serviceAuthorizationMetadata(config.accessTokenProvider);
    return await new Promise<ToolgwResolveCredentialResponse>((resolve, reject) => {
      client.resolveCredential(request, metadata, { deadline: new Date(Date.now() + (config.timeoutMs ?? 10_000)) }, (error, response) => error ? reject(error) : resolve(response));
    });
  } finally { client.close(); }
}

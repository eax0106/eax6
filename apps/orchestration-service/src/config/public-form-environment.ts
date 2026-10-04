import { PublicFormTokenCodec } from "@alterx/auth";

export function loadPublicFormLinkEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const key = environment.PUBLIC_FORM_TOKEN_KEY?.trim(), address = environment.PUBLIC_FORM_BASE_URL?.trim();
  if (!key && !address) return undefined;
  if (!key || !address) throw new Error("PUBLIC_FORM_TOKEN_KEY and PUBLIC_FORM_BASE_URL must be configured together");
  const url = new URL(address);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      !(url.protocol === "https:" || (url.protocol === "http:" && local && environment.NODE_ENV !== "production"))) throw new Error("Public form base URL must be an HTTPS origin");
  return { codec: new PublicFormTokenCodec(key), baseUrl: url.origin };
}

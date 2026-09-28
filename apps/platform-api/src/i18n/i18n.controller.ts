import { Body, Controller, Get, Param, Patch, UseFilters } from "@nestjs/common";
import { ActorContext, RequireTenantRole, RequireWorkspaceRole, type ActorContextType } from "../rbac";
import { I18nExceptionFilter } from "./i18n-exception.filter";
import { I18nService } from "./i18n.service";
import { I18nHttpError } from "./problem";
import type { I18nBundle, LanguagePreference, SupportedLocale } from "./types";
import { supportedLocales } from "./types";

@Controller("/api/v1/i18n")
@UseFilters(I18nExceptionFilter)
export class I18nController {
  constructor(private readonly i18n: I18nService) {}

  @Get("bundles/:locale/:namespace")
  @RequireTenantRole("member")
  getBundle(
    @Param("locale") locale: string,
    @Param("namespace") namespace: string,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<I18nBundle> {
    const instance = `/api/v1/i18n/bundles/${locale}/${namespace}`;
    return this.i18n.getBundle(
      parseLocale(locale, instance),
      parseNamespace(namespace, instance),
      requireActor(actor, instance).tenant_id,
    );
  }

  @Get("users/me/language")
  @RequireTenantRole("member")
  getUserLanguage(@ActorContext() actor: ActorContextType | undefined): Promise<LanguagePreference> {
    return this.i18n.getUserLanguage(requireActor(actor, "/api/v1/i18n/users/me/language"));
  }

  @Patch("users/me/language")
  @RequireTenantRole("member")
  updateUserLanguage(
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<LanguagePreference> {
    const instance = "/api/v1/i18n/users/me/language";
    return this.i18n.updateUserLanguage(
      requireActor(actor, instance),
      parseLanguage(body, instance),
    );
  }

  @Patch("workspaces/:workspaceId/language")
  @RequireWorkspaceRole("admin")
  updateWorkspaceLanguage(
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
    @ActorContext() actor: ActorContextType | undefined,
  ): Promise<LanguagePreference> {
    const instance = `/api/v1/i18n/workspaces/${workspaceId}/language`;
    return this.i18n.updateWorkspaceLanguage(
      requireActor(actor, instance),
      workspaceId,
      parseLanguage(body, instance),
    );
  }
}

function parseLocale(value: string, instance: string): SupportedLocale {
  if (supportedLocales.includes(value as SupportedLocale)) {
    return value as SupportedLocale;
  }
  throw new I18nHttpError(400, "I18N_LOCALE_INVALID", "Locale must be en or hi", instance);
}

function parseNamespace(value: string, instance: string): string {
  if (/^[a-z][a-z0-9_-]{0,63}$/.test(value)) return value;
  throw new I18nHttpError(400, "I18N_NAMESPACE_INVALID", "Namespace is invalid", instance);
}

function parseLanguage(body: unknown, instance: string): SupportedLocale {
  if (
    typeof body === "object" &&
    body !== null &&
    "language" in body &&
    typeof body.language === "string"
  ) {
    return parseLocale(body.language, instance);
  }
  throw new I18nHttpError(400, "I18N_LANGUAGE_REQUIRED", "Language must be en or hi", instance);
}

function requireActor(actor: ActorContextType | undefined, instance: string): ActorContextType {
  if (actor) return actor;
  throw new I18nHttpError(401, "AUTHENTICATION_REQUIRED", "Authenticated actor required", instance);
}

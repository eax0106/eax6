import type { ActorContext } from "../rbac/types";
import { PlatformDb } from "../signup/platform-db";
import { I18nHttpError } from "./problem";
import type {
  I18nBundle,
  I18nBundleRow,
  LanguagePreference,
  SupportedLocale,
  UserLanguageRow,
  WorkspaceLanguageRow,
} from "./types";

const bundleCacheTtlMs = 5 * 60 * 1_000;

interface CachedBundle {
  expiresAt: number;
  value: I18nBundle;
}

export class I18nService {
  private readonly bundleCache = new Map<string, CachedBundle>();

  constructor(
    private readonly db: Pick<PlatformDb, "queryTenant">,
    private readonly now = () => Date.now(),
  ) {}

  async getBundle(
    locale: SupportedLocale,
    namespace: string,
    tenantId: string,
  ): Promise<I18nBundle> {
    const cacheKey = `${locale}:${namespace}`;
    const cached = this.bundleCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    const rows = await this.db.queryTenant<I18nBundleRow>(
      tenantId,
      `SELECT key, value
         FROM i18n_bundles
        WHERE locale = $1 AND namespace = $2
        ORDER BY key`,
      [locale, namespace],
    );
    if (rows.length === 0) {
      throw new I18nHttpError(
        404,
        "I18N_BUNDLE_NOT_FOUND",
        "Translation bundle not found",
        `/api/v1/i18n/bundles/${locale}/${namespace}`,
      );
    }

    const value: I18nBundle = {
      locale,
      namespace,
      messages: Object.fromEntries(rows.map((row) => [row.key, row.value])),
    };
    // Bundles are migration-managed product copy; a short per-instance TTL is sufficient for MVP.
    this.bundleCache.set(cacheKey, { value, expiresAt: this.now() + bundleCacheTtlMs });
    return value;
  }

  async resolveLocale(
    userId: string,
    workspaceId: string | undefined,
    tenantId: string,
  ): Promise<SupportedLocale> {
    const user = await this.db.queryTenant<UserLanguageRow>(
      tenantId,
      `SELECT u.preferred_language AS language
         FROM users u
         JOIN tenant_members tm ON tm.user_id = u.id
        WHERE u.id = $1 AND tm.tenant_id = $2
        LIMIT 1`,
      [userId, tenantId],
    );
    if (user[0]?.language) return user[0].language;

    if (!workspaceId) return "en";
    const workspace = await this.db.queryTenant<WorkspaceLanguageRow>(
      tenantId,
      `SELECT default_language AS language
         FROM workspaces
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [workspaceId, tenantId],
    );
    return workspace[0]?.language ?? "en";
  }

  /** The signed-in user's saved language, so a new device starts in it. */
  async getUserLanguage(actor: ActorContext): Promise<LanguagePreference> {
    const rows = await this.db.queryTenant<LanguagePreference>(
      actor.tenant_id,
      `SELECT u.preferred_language AS language
         FROM users u
        WHERE u.id = $1
          AND EXISTS (
            SELECT 1
              FROM tenant_members
             WHERE tenant_id = $2 AND user_id = $1
          )`,
      [actor.user_id, actor.tenant_id],
    );
    return required(rows[0], "I18N_USER_NOT_FOUND", "/api/v1/i18n/users/me/language");
  }

  async updateUserLanguage(
    actor: ActorContext,
    language: SupportedLocale,
  ): Promise<LanguagePreference> {
    const rows = await this.db.queryTenant<LanguagePreference>(
      actor.tenant_id,
      `UPDATE users
          SET preferred_language = $1
        WHERE id = $2
          AND EXISTS (
            SELECT 1
              FROM tenant_members
             WHERE tenant_id = $3 AND user_id = $2
          )
        RETURNING preferred_language AS language`,
      [language, actor.user_id, actor.tenant_id],
    );
    return required(rows[0], "I18N_USER_NOT_FOUND", "/api/v1/i18n/users/me/language");
  }

  async updateWorkspaceLanguage(
    actor: ActorContext,
    workspaceId: string,
    language: SupportedLocale,
  ): Promise<LanguagePreference> {
    if (!actor.workspace_id || actor.workspace_id !== workspaceId) {
      throw new I18nHttpError(
        403,
        "I18N_WORKSPACE_MISMATCH",
        "Workspace actor context required",
        `/api/v1/i18n/workspaces/${workspaceId}/language`,
      );
    }
    const rows = await this.db.queryTenant<LanguagePreference>(
      actor.tenant_id,
      `UPDATE workspaces
          SET default_language = $1
        WHERE id = $2 AND tenant_id = $3
        RETURNING default_language AS language`,
      [language, workspaceId, actor.tenant_id],
    );
    return required(
      rows[0],
      "I18N_WORKSPACE_NOT_FOUND",
      `/api/v1/i18n/workspaces/${workspaceId}/language`,
      404,
    );
  }
}

function required<T>(
  value: T | undefined,
  errorCode: string,
  instance: string,
  status = 404,
): T {
  if (!value) throw new I18nHttpError(status, errorCode, "Language preference not found", instance);
  return value;
}

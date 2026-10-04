import type { SsoConfig } from "../identity-provider.interface";

export interface LoginDto {
  tenantId?: string;
  organizationId?: string;
  invitation?: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  connection?: "google-oauth2" | "Username-Password-Authentication";
}

export interface CallbackQueryDto {
  invitation?: string;
  code?: string;
  redirect_uri?: string;
  code_verifier?: string;
}

export interface RefreshDto {
  refreshToken?: string;
}

export interface MfaEnrollDto {
  userId?: string;
}

export interface MfaChallengeDto {
  userId?: string;
  enrollmentId: string;
  otp: string;
}

export interface ConfigureSsoDto {
  tenantId: string;
  config: SsoConfig;
}

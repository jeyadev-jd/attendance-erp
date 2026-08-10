import type { Role } from "@attendance/db/types";
import type { SupabaseClient } from "@supabase/supabase-js";

export type Bindings = {
  /** Supabase project URL. Set via `wrangler secret put`. */
  SUPABASE_URL: string;
  /**
   * Supabase service_role key — bypasses RLS, so it is a full-access database
   * credential. Set via `wrangler secret put`, never in wrangler.toml [vars],
   * never in apps/web, never in a client bundle.
   */
  SUPABASE_SERVICE_ROLE_KEY: string;
  JWT_SECRET: string;
  JWT_EXPIRY_SECONDS: string;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_USER: string;
  SMTP_PASS: string;
  OTP_TTL_MINUTES: string;
  TEMP_STUDENT_PASSWORD: string;
};

export type JwtPayload = {
  sub: string; // user id
  organizationId: string;
  role: Role;
  mustChangePassword: boolean;
  exp: number;
  iat: number;
};

export type Variables = {
  /** Set for every request by supabaseMiddleware. */
  supabase: SupabaseClient;
  user: JwtPayload;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };

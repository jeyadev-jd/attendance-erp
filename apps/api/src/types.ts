import type { PrismaClient, Role } from "@attendance/db";
import type { SupabaseClient } from "@supabase/supabase-js";

export type Bindings = {
  /** D1 database binding — see [[d1_databases]] in wrangler.toml. */
  DB: D1Database;
  /**
   * Supabase project URL. Optional while the migration runs: production still
   * serves from D1, and only the preview configuration sets these.
   */
  SUPABASE_URL?: string;
  /**
   * Supabase service_role key — bypasses RLS, so it is a full-access database
   * credential. Set via `wrangler secret put`, never in wrangler.toml [vars],
   * never in apps/web, never in a client bundle.
   */
  SUPABASE_SERVICE_ROLE_KEY?: string;
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
  prisma: PrismaClient;
  /**
   * Supabase client, present only when the Worker is configured for Supabase.
   * Routes still on Prisma ignore it; migrated routes read it instead of `prisma`.
   * Optional so both paths coexist during the incremental cutover.
   */
  supabase?: SupabaseClient;
  user: JwtPayload;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };

import type { PrismaClient, Role } from "@attendance/db";

export type Bindings = {
  /** D1 database binding — see [[d1_databases]] in wrangler.toml. */
  DB: D1Database;
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
  user: JwtPayload;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };

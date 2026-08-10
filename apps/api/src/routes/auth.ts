import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import bcrypt from "bcryptjs";
import type { AppEnv } from "../types";
import { signJwt } from "../lib/jwt";
import { generateOtp, hashOtp } from "../lib/otp";
import { sendMail, otpEmailTemplate } from "../lib/mailer";
import { loginSchema, requestOtpSchema, changePasswordSchema } from "../schemas/auth";
import { requireSupabase } from "../middleware/supabase";
import * as repo from "@attendance/db/repos/auth";
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_OTP_ATTEMPTS = 5;

const auth = new Hono<AppEnv>();

async function issueTokenFor(
  c: any,
  user: { id: string; organizationId: string; role: any; mustChangePassword: boolean }
) {
  const expirySeconds = Number(c.env.JWT_EXPIRY_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    {
      sub: user.id,
      organizationId: user.organizationId,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
      iat: now,
      exp: now + expirySeconds,
    },
    c.env.JWT_SECRET
  );
}

async function emailOtp(c: any, db: SupabaseClient, email: string, userId: string) {
  const otp = generateOtp();
  const ttlMinutes = Number(c.env.OTP_TTL_MINUTES);
  await repo.setOtp(db, userId, await hashOtp(otp), new Date(Date.now() + ttlMinutes * 60_000));
  const { subject, text, html } = otpEmailTemplate(otp, ttlMinutes);
  await sendMail(
    {
      host: c.env.SMTP_HOST,
      port: Number(c.env.SMTP_PORT),
      user: c.env.SMTP_USER,
      pass: c.env.SMTP_PASS,
    },
    { to: email, subject, text, html }
  );
}

// NOTE: a public POST /auth/register used to live here. It was mounted in the
// unauthenticated route group despite being documented "admin-only", which let
// anyone create a SUPER_ADMIN for any organization. Staff creation now lives in
// the JWT-guarded /api/users router; students are created via /api/students.

/**
 * Login. If the account still has the shared temporary password
 * (mustChangePassword = true), we don't issue an access token — we email an
 * OTP and the client must complete /auth/complete-first-login instead.
 */
auth.post("/login", async (c) => {
  const body = loginSchema.parse(await c.req.json());
  const db = requireSupabase(c);

  const user = await repo.findActiveByEmail(db, body.email);
  if (!user) throw new HTTPException(401, { message: "Invalid credentials" });

  const valid = await bcrypt.compare(body.password, user.passwordHash);
  if (!valid) throw new HTTPException(401, { message: "Invalid credentials" });

  if (user.mustChangePassword) {
    await emailOtp(c, db, user.email, user.id);
    return c.json({ requiresOtp: true, requiresPasswordChange: true, email: user.email });
  }

  const token = await issueTokenFor(c, user);
  return c.json({ token, mustChangePassword: false });
});

/** Resend OTP — used for first-login setup or password reset ("forgot password"). */
auth.post("/request-otp", async (c) => {
  const body = requestOtpSchema.parse(await c.req.json());
  const db = requireSupabase(c);
  const user = await repo.findActiveByEmail(db, body.email);
  // Always respond 200 to avoid leaking which emails are registered.
  if (user) await emailOtp(c, db, user.email, user.id);
  return c.json({ sent: true });
});

/**
 * Completes first-login setup (or a forgot-password reset): verifies the OTP,
 * sets the new password, clears mustChangePassword, and issues a real token.
 */
auth.post("/complete-first-login", async (c) => {
  const body = changePasswordSchema.parse(await c.req.json());
  const db = requireSupabase(c);

  const user = await repo.findActiveByEmail(db, body.email);
  if (!user || !user.otpHash || !user.otpExpiresAt) {
    throw new HTTPException(400, { message: "No OTP request found — request a new one" });
  }
  if (user.otpAttempts >= MAX_OTP_ATTEMPTS) {
    throw new HTTPException(429, { message: "Too many attempts — request a new OTP" });
  }
  if (new Date(user.otpExpiresAt).getTime() < Date.now()) {
    throw new HTTPException(400, { message: "OTP expired — request a new one" });
  }

  const providedHash = await hashOtp(body.otp);
  if (providedHash !== user.otpHash) {
    // The count comes from the row just read, so the increment costs no extra query.
    await repo.bumpOtpAttempts(db, user.id, user.otpAttempts + 1);
    throw new HTTPException(400, { message: "Incorrect OTP" });
  }

  const passwordHash = await bcrypt.hash(body.newPassword, 10);
  const updated = await repo.completePasswordChange(db, user.id, passwordHash);

  const token = await issueTokenFor(c, updated);
  return c.json({ token, mustChangePassword: false });
});

export default auth;

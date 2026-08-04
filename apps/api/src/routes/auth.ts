import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import bcrypt from "bcryptjs";
import type { AppEnv } from "../types";
import { signJwt } from "../lib/jwt";
import { generateOtp, hashOtp } from "../lib/otp";
import { sendMail, otpEmailTemplate } from "../lib/mailer";
import { loginSchema, requestOtpSchema, changePasswordSchema } from "../schemas/auth";

const MAX_OTP_ATTEMPTS = 5;

const auth = new Hono<AppEnv>();

async function issueTokenFor(c: any, user: { id: string; organizationId: string; role: any; mustChangePassword: boolean }) {
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

async function emailOtp(c: any, email: string, userId: string) {
  const prisma = c.get("prisma");
  const otp = generateOtp();
  const ttlMinutes = Number(c.env.OTP_TTL_MINUTES);
  await prisma.user.update({
    where: { id: userId },
    data: {
      otpHash: await hashOtp(otp),
      otpExpiresAt: new Date(Date.now() + ttlMinutes * 60_000),
      otpAttempts: 0,
    },
  });
  const { subject, text, html } = otpEmailTemplate(otp, ttlMinutes);
  await sendMail(
    { host: c.env.SMTP_HOST, port: Number(c.env.SMTP_PORT), user: c.env.SMTP_USER, pass: c.env.SMTP_PASS },
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
  const prisma = c.get("prisma");

  const user = await prisma.user.findFirst({ where: { email: body.email, isActive: true } });
  if (!user) throw new HTTPException(401, { message: "Invalid credentials" });

  const valid = await bcrypt.compare(body.password, user.passwordHash);
  if (!valid) throw new HTTPException(401, { message: "Invalid credentials" });

  if (user.mustChangePassword) {
    await emailOtp(c, user.email, user.id);
    return c.json({ requiresOtp: true, requiresPasswordChange: true, email: user.email });
  }

  const token = await issueTokenFor(c, user);
  return c.json({ token, mustChangePassword: false });
});

/** Resend OTP — used for first-login setup or password reset ("forgot password"). */
auth.post("/request-otp", async (c) => {
  const body = requestOtpSchema.parse(await c.req.json());
  const prisma = c.get("prisma");
  const user = await prisma.user.findFirst({ where: { email: body.email, isActive: true } });
  // Always respond 200 to avoid leaking which emails are registered.
  if (user) await emailOtp(c, user.email, user.id);
  return c.json({ sent: true });
});

/**
 * Completes first-login setup (or a forgot-password reset): verifies the OTP,
 * sets the new password, clears mustChangePassword, and issues a real token.
 */
auth.post("/complete-first-login", async (c) => {
  const body = changePasswordSchema.parse(await c.req.json());
  const prisma = c.get("prisma");

  const user = await prisma.user.findFirst({ where: { email: body.email, isActive: true } });
  if (!user || !user.otpHash || !user.otpExpiresAt) {
    throw new HTTPException(400, { message: "No OTP request found — request a new one" });
  }
  if (user.otpAttempts >= MAX_OTP_ATTEMPTS) {
    throw new HTTPException(429, { message: "Too many attempts — request a new OTP" });
  }
  if (user.otpExpiresAt.getTime() < Date.now()) {
    throw new HTTPException(400, { message: "OTP expired — request a new one" });
  }

  const providedHash = await hashOtp(body.otp);
  if (providedHash !== user.otpHash) {
    await prisma.user.update({ where: { id: user.id }, data: { otpAttempts: { increment: 1 } } });
    throw new HTTPException(400, { message: "Incorrect OTP" });
  }

  const passwordHash = await bcrypt.hash(body.newPassword, 10);
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      mustChangePassword: false,
      otpHash: null,
      otpExpiresAt: null,
      otpAttempts: 0,
    },
  });

  const token = await issueTokenFor(c, updated);
  return c.json({ token, mustChangePassword: false });
});

export default auth;

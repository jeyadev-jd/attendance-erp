// Auth repository — PostgREST equivalents of the user lookups in
// apps/api/src/routes/auth.ts.
//
// This is the only router mounted BEFORE jwtMiddleware, so it is the one place the
// application talks to the database on behalf of an unauthenticated caller. Two
// consequences shape everything here:
//
//   * Reads select credential columns deliberately and narrowly. login needs
//     passwordHash, the OTP flow needs otpHash/otpExpiresAt/otpAttempts. Nothing
//     else does, and no route returns them — they are compared in the Worker and
//     discarded.
//
//   * Lookups are by email across the whole table, not scoped to an organization,
//     because the caller has not proven which organization they belong to yet. The
//     organizationId comes back FROM the user row and is what every later request is
//     scoped by.
import type { SupabaseClient } from "@supabase/supabase-js";
import { maybeOne, normaliseDates, DATE_FIELDS } from "../supabase";

/** The columns the login and OTP flows need. Never returned to a caller. */
export type AuthUser = {
  id: string;
  organizationId: string;
  email: string;
  passwordHash: string;
  role: string;
  mustChangePassword: boolean;
  isActive: boolean;
  otpHash: string | null;
  otpExpiresAt: string | null;
  otpAttempts: number;
};

const COLS =
  "id,organizationId,email,passwordHash,role,mustChangePassword,isActive," +
  "otpHash,otpExpiresAt,otpAttempts";

/**
 * Active user by email.
 *
 * Replaces prisma.user.findFirst({ where: { email, isActive: true } }). Inactive
 * accounts are excluded here rather than checked afterwards, so a deactivated user
 * is indistinguishable from a non-existent one.
 */
export async function findActiveByEmail(db: SupabaseClient, email: string) {
  const row = maybeOne<AuthUser>(
    await db.from("users").select(COLS).eq("email", email).eq("isActive", true).maybeSingle(),
    "auth.findActiveByEmail"
  );
  return row ? normaliseDates(row, DATE_FIELDS) : null;
}

/** Stores a freshly issued OTP hash and resets the attempt counter. */
export async function setOtp(
  db: SupabaseClient,
  userId: string,
  otpHash: string,
  expiresAt: Date
) {
  const { error } = await db
    .from("users")
    .update({
      otpHash,
      otpExpiresAt: expiresAt.toISOString(),
      otpAttempts: 0,
      updatedAt: new Date().toISOString(),
    })
    .eq("id", userId);
  if (error) throw new Error(`auth.setOtp: ${error.message}`);
}

/**
 * Records a failed OTP attempt.
 *
 * Prisma expressed this as `{ increment: 1 }`, which PostgREST has no equivalent
 * for. The caller has just read the row to compare the OTP, so it already holds the
 * current count and passes the incremented value — no extra round trip, and no
 * read-modify-write beyond the one the flow already performs.
 */
export async function bumpOtpAttempts(db: SupabaseClient, userId: string, next: number) {
  const { error } = await db
    .from("users")
    .update({ otpAttempts: next, updatedAt: new Date().toISOString() })
    .eq("id", userId);
  if (error) throw new Error(`auth.bumpOtpAttempts: ${error.message}`);
}

/**
 * Completes first-login setup: sets the new password, clears the OTP state, and
 * lifts the forced-password-change flag.
 *
 * Returns the fields the token is minted from, so the route does not re-read.
 */
export async function completePasswordChange(
  db: SupabaseClient,
  userId: string,
  passwordHash: string
) {
  const { data, error } = await db
    .from("users")
    .update({
      passwordHash,
      mustChangePassword: false,
      otpHash: null,
      otpExpiresAt: null,
      otpAttempts: 0,
      updatedAt: new Date().toISOString(),
    })
    .eq("id", userId)
    .select("id,organizationId,role,mustChangePassword")
    .single();
  if (error) throw new Error(`auth.completePasswordChange: ${error.message}`);
  return data as {
    id: string;
    organizationId: string;
    role: string;
    mustChangePassword: boolean;
  };
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authApi, ApiError } from "@/lib/api";

/**
 * Requests a reset OTP, then hands off to /first-login, which already handles
 * "verify OTP + set new password" — the reset and first-login flows are identical
 * on the API side (request-otp -> complete-first-login).
 */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await authApi.requestOtp(email);
      // The API always reports success so it never reveals which emails are registered.
      router.push(`/first-login?email=${encodeURIComponent(email)}&reset=1`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send OTP");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-xl border bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Reset your password</h1>
          <p className="mt-1 text-sm text-slate-500">
            Enter your college email and we'll send a one-time password to verify it's you.
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full min-h-[44px] rounded-md border px-3 text-base sm:text-sm"
            placeholder="you@sriher.edu.in"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading || !email}
          className="w-full min-h-[44px] rounded-md bg-slate-900 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Sending…" : "Send OTP"}
        </button>

        <p className="text-center text-sm">
          <Link href="/login" className="text-slate-600 underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
}

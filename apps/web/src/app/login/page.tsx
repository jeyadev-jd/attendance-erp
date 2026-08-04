"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authApi, ApiError } from "@/lib/api";
import { useAuthStore, decodeClaims } from "@/store/authStore";
import { PasswordInput } from "@/components/PasswordInput";
import { homeFor } from "@/components/AppShell";

export default function LoginPage() {
  const router = useRouter();
  const setToken = useAuthStore((s) => s.setToken);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await authApi.login(email, password);
      if (res.requiresPasswordChange) {
        // OTP already emailed by the API on this call — go straight to verification.
        router.push(`/first-login?email=${encodeURIComponent(email)}`);
        return;
      }
      if (res.token) {
        setToken(res.token);
        // Students get their own portal; admins/faculty land on the ops dashboard.
        router.push(homeFor(decodeClaims(res.token)?.role));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-xl border bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Attendance Portal Login</h1>

        <div className="space-y-1">
          <label className="text-sm font-medium">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
            placeholder="you@college.edu"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Password</label>
          <PasswordInput value={password} onChange={setPassword} required />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-slate-900 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>

        <Link
          href="/forgot-password"
          className="flex min-h-[44px] w-full items-center justify-center rounded-md border text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Forgot password?
        </Link>
      </form>
    </div>
  );
}

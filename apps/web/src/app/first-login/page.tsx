"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authApi, ApiError } from "@/lib/api";
import { useAuthStore, decodeClaims } from "@/store/authStore";
import { PasswordInput } from "@/components/PasswordInput";
import { homeFor } from "@/components/AppShell";

export default function FirstLoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const setToken = useAuthStore((s) => s.setToken);

  const [email] = useState(params.get("email") ?? "");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  async function onResend() {
    setError(null);
    setInfo(null);
    setResending(true);
    try {
      await authApi.requestOtp(email);
      setInfo("A new OTP has been emailed to you.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not resend OTP");
    } finally {
      setResending(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      const res = await authApi.completeFirstLogin(email, otp, newPassword);
      setToken(res.token);
      router.push(homeFor(decodeClaims(res.token)?.role));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-xl border bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-xl font-semibold">Verify & set new password</h1>
          <p className="mt-1 text-sm text-slate-500">
            We emailed a 6-digit OTP to <span className="font-medium">{email}</span>.
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">OTP</label>
          <input
            required
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            className="w-full rounded-md border px-3 py-2 text-center text-lg tracking-widest"
            placeholder="000000"
          />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">New password</label>
          <PasswordInput value={newPassword} onChange={setNewPassword} required minLength={8} />
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium">Confirm new password</label>
          <PasswordInput value={confirmPassword} onChange={setConfirmPassword} required minLength={8} />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {info && <p className="text-sm text-emerald-600">{info}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-slate-900 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? "Verifying…" : "Verify & continue"}
        </button>

        <button
          type="button"
          onClick={onResend}
          disabled={resending}
          className="w-full text-center text-xs text-slate-500 underline disabled:opacity-50"
        >
          {resending ? "Resending…" : "Resend OTP"}
        </button>
      </form>
    </div>
  );
}

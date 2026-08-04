import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "SUPER_ADMIN" | "ADMIN" | "CLASS_ADMIN" | "FACULTY" | "STUDENT";

export type JwtClaims = {
  sub: string;
  organizationId: string;
  role: Role;
  mustChangePassword: boolean;
  exp: number;
  iat: number;
};

/**
 * Decodes the JWT payload for UI routing/permission decisions only.
 * Signature is never verified client-side — the API re-validates every request,
 * so a tampered token buys nothing beyond a broken-looking UI.
 */
export function decodeClaims(token: string | null): JwtClaims | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}

type AuthState = {
  token: string | null;
  setToken: (token: string | null) => void;
  logout: () => void;
  // zustand's persist middleware reads localStorage asynchronously after mount, so on
  // first render `token` is briefly null even for a signed-in user. Any guard that
  // redirects to /login on `!token` must wait for this flag first, or it fires on
  // every hard navigation/reload before the real token loads.
  hasHydrated: boolean;
  setHasHydrated: (v: boolean) => void;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      setToken: (token) => set({ token }),
      logout: () => set({ token: null }),
      hasHydrated: false,
      setHasHydrated: (v) => set({ hasHydrated: v }),
    }),
    {
      name: "attendance-auth",
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);

/** Claims for the current token, or null when signed out / token malformed. */
export function useClaims(): JwtClaims | null {
  const token = useAuthStore((s) => s.token);
  return decodeClaims(token);
}

const ADMIN_ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "CLASS_ADMIN"];

/** Mirrors the API's roleGuard: only these roles may mark or edit attendance. */
export function isAdminRole(role: Role | undefined | null): boolean {
  return !!role && ADMIN_ROLES.includes(role);
}

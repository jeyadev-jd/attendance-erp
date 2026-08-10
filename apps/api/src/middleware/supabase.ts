import type { MiddlewareHandler } from "hono";
import { getSupabase } from "@attendance/db/supabase";
import type { AppEnv } from "../types";

/**
 * Sets the Supabase client that every route reads from.
 *
 * Built per request: the client wraps `fetch` and holds no socket, so there is
 * nothing to pool and nothing to go stale — the failure mode that ruled out an
 * earlier pooled-TCP design for this Worker.
 */
export const supabaseMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set(
    "supabase",
    getSupabase({
      SUPABASE_URL: c.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: c.env.SUPABASE_SERVICE_ROLE_KEY,
    })
  );
  await next();
};

/**
 * Reads the Supabase client.
 *
 * Kept as a helper rather than inlining `c.get("supabase")` at every call site: it
 * narrows the type and fails loudly if the middleware has not run, instead of a
 * route reaching for `.from()` on undefined deep inside a request.
 */
export function requireSupabase(c: { get: (k: "supabase") => unknown }) {
  const db = c.get("supabase");
  if (!db) {
    throw new Error(
      "Supabase client missing — supabaseMiddleware must run before any route. " +
        "Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set (wrangler secret put)."
    );
  }
  return db as import("@supabase/supabase-js").SupabaseClient;
}

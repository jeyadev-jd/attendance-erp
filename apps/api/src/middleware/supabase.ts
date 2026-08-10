import type { MiddlewareHandler } from "hono";
import { getSupabase } from "@attendance/db/supabase";
import type { AppEnv } from "../types";

/**
 * Attaches a Supabase client to the request when the Worker is configured for it.
 *
 * Runs alongside prismaMiddleware rather than replacing it: during the incremental
 * migration some routes read `c.get("supabase")` and the rest still read
 * `c.get("prisma")`, so both must be available in the same request. Production sets
 * no Supabase vars, so this is a no-op there and D1 continues to serve every route.
 *
 * The client is built per request. It wraps `fetch` and holds no socket, so there is
 * nothing to pool and nothing to go stale — the failure mode that ruled out the
 * earlier Hyperdrive/pg.Pool design.
 */
export const supabaseMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const url = c.env.SUPABASE_URL;
  const key = c.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    c.set("supabase", getSupabase({ SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: key }));
  }
  await next();
};

/**
 * Reads the Supabase client, failing loudly if the Worker was not configured.
 *
 * A migrated route must never silently fall back to Prisma/D1: that would mean
 * production quietly serving from the database we are migrating away from, and the
 * cutover would appear to succeed while nothing had actually moved.
 */
export function requireSupabase(c: { get: (k: "supabase") => unknown }) {
  const db = c.get("supabase");
  if (!db) {
    throw new Error(
      "Supabase is not configured for this Worker. Set SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY (wrangler secret put) before using a migrated route."
    );
  }
  return db as import("@supabase/supabase-js").SupabaseClient;
}

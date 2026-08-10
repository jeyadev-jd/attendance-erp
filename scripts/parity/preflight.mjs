// Phase 4 preflight — row-count parity between local D1 and Supabase.
//
// Runs before any analytics comparison. If the two databases do not hold identical
// data, an analytics "match" proves nothing and a "mismatch" cannot be attributed to
// SQL logic, so this gate is hard: any difference stops the run.
//
// Local D1 only (wrangler --local). Never touches remote D1. Reads only.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

export const TABLES = [
  "users",
  "students",
  "faculty",
  "sections",
  "subjects",
  "attendance",
  "bunk_flags",
  "health_scores",
  "notifications",
  "audit_logs",
  "timetables",
  "calendar_days",
  "hour_configs",
  "timetable_overrides",
];

const DEV_VARS = "apps/api/.dev.vars";

/**
 * Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from .dev.vars.
 *
 * The file is gitignored and never written to by this harness. The key is returned
 * for use and never logged — every diagnostic in this file prints table names and
 * counts only.
 */
export function loadEnv() {
  if (!existsSync(DEV_VARS)) {
    throw new Error(
      `${DEV_VARS} not found. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to it (do not commit).`
    );
  }
  const env = {};
  for (const line of readFileSync(DEV_VARS, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n\r]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      `${DEV_VARS} is missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY. ` +
        `Add them locally; never paste the service-role key into chat or commit it.`
    );
  }
  return { url, key };
}

export function supabaseClient() {
  const { url, key } = loadEnv();
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Runs a read-only query against the LOCAL D1 sandbox and returns parsed rows.
 *
 * The SQL goes through a temp file rather than --command: on Windows the shell
 * re-splits an inline query on spaces and wrangler sees "Unknown arguments".
 */
export function d1Query(sql) {
  const file = `${tmpdir()}/parity-${randomUUID()}.sql`;
  writeFileSync(file, sql);
  let out;
  try {
    // shell:true is required for npx on Windows; safe here because the SQL lives in
    // a file and the only interpolated value is a generated temp path.
    out = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "attendance-db", "--local", "--file", `"${file}"`, "--json"],
      { cwd: "apps/api", encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: true }
    );
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* best effort */
    }
  }
  // wrangler prints a banner before the JSON; take from the first bracket on.
  const start = out.indexOf("[");
  if (start === -1) throw new Error(`no JSON in wrangler output: ${out.slice(0, 300)}`);
  const parsed = JSON.parse(out.slice(start));
  return parsed[0]?.results ?? [];
}

/** Exact row count from Supabase with head:true — transfers no rows, only the count. */
async function supabaseCount(db, table) {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
  if (error) throw new Error(`supabase count ${table}: ${error.message}`);
  return count ?? 0;
}

export async function runPreflight() {
  const db = supabaseClient();

  // One D1 query per table: SQLite caps compound SELECT terms, and separate
  // queries keep the failure attributable to a specific table.
  const rows = [];
  for (const t of TABLES) {
    const d1 = d1Query(`SELECT COUNT(*) AS n FROM ${t};`)[0]?.n ?? 0;
    const sb = await supabaseCount(db, t);
    rows.push({ table: t, d1, supabase: sb, status: d1 === sb ? "MATCH" : "DIFFER" });
  }

  const mismatches = rows.filter((r) => r.status === "DIFFER");
  return { rows, ok: mismatches.length === 0, mismatches };
}

export function printCountTable(rows) {
  console.log("\nDATA PARITY");
  console.log("---------------");
  console.log("table                  | D1     | Supabase | status");
  console.log("-----------------------+--------+----------+--------");
  for (const r of rows) {
    console.log(
      `${r.table.padEnd(22)} | ${String(r.d1).padEnd(6)} | ${String(r.supabase).padEnd(8)} | ${r.status}`
    );
  }
}

// Allow running standalone: `node scripts/parity/preflight.mjs`
const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) {
  runPreflight()
    .then(({ rows, ok, mismatches }) => {
      printCountTable(rows);
      if (!ok) {
        console.error(`\nPREFLIGHT FAILED — ${mismatches.length} table(s) differ.`);
        for (const m of mismatches) {
          console.error(`  ${m.table}: D1=${m.d1} Supabase=${m.supabase} (delta ${m.supabase - m.d1})`);
        }
        process.exit(1);
      }
      console.log("\nPREFLIGHT PASSED — all tables match.");
    })
    .catch((e) => {
      console.error(`PREFLIGHT ERROR: ${e.message}`);
      process.exit(1);
    });
}

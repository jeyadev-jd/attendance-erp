// Cutover: makes Supabase the only runtime database.
//
// Run this ONLY after production has been verified on Supabase. It is the change the
// migration has been building toward, and it is deliberately one commit so that
// `git revert` restores the D1 Worker exactly.
//
// What it does:
//   1. Deletes the 19 Prisma route files.
//   2. Renames each *Supabase.ts route into its place, dropping the suffix.
//   3. Rewrites index.ts: /api/v2/* mounts become /api/*, Prisma imports removed,
//      the scheduled() handler drops its D1 branch.
//   4. Removes prismaMiddleware, the D1 lib helpers, and the Prisma barrel.
//   5. Strips [[d1_databases]] from wrangler.toml and the Prisma deps from
//      package.json.
//
// What it deliberately KEEPS:
//   * packages/db/prisma/  — schema and migrations, as historical record
//   * backups/             — the export and every SQL file
//   Neither is reachable at runtime; both are wanted for rollback and audit.
//
// The frontend is not touched. Routes, methods, shapes and status codes are
// unchanged: /api/departments still answers, from Supabase instead of D1.
//
// Usage:
//   node scripts/cutover.mjs --dry-run   (default: prints the plan, changes nothing)
//   node scripts/cutover.mjs --apply
import { readFileSync, writeFileSync, unlinkSync, renameSync, existsSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const log = (...a) => console.log(APPLY ? "[apply]" : "[dry-run]", ...a);

const ROUTES = [
  "departments",
  "subjects",
  "sections",
  "faculty",
  "academicYears",
  "semesters",
  "students",
  "users",
  "notifications",
  "settings",
  "auditLogs",
  "hourConfig",
  "calendar",
  "timetable",
  "attendance",
  "studentPortal",
  "analytics",
  "reports",
];

const R = "apps/api/src/routes";

// ── 1 + 2. Replace each Prisma route with its Supabase counterpart ────────────
for (const name of ROUTES) {
  const legacy = `${R}/${name}.ts`;
  const migrated = `${R}/${name}Supabase.ts`;
  if (!existsSync(migrated)) {
    console.error(`MISSING: ${migrated} — cutover aborted`);
    process.exit(1);
  }
  log(`replace ${legacy} <- ${migrated}`);
  if (APPLY) {
    if (existsSync(legacy)) unlinkSync(legacy);
    renameSync(migrated, legacy);
  }
}

// ── 3. index.ts ──────────────────────────────────────────────────────────────
{
  const p = "apps/api/src/index.ts";
  let s = readFileSync(p, "utf8");

  // Drop the duplicated Supabase imports; the originals now point at the same files.
  s = s.replace(/^import \w+Supabase from "\.\/routes\/\w+Supabase";\n/gm, "");
  // /api/v2/* mounts become the real ones; the old Prisma mounts go.
  s = s.replace(/^app\.route\("\/api\/(?!v2)[^"]*", (?!\w+Supabase)\w+\);\n/gm, "");
  s = s.replace(/"\/api\/v2\//g, '"/api/');
  s = s.replace(/(\w+)Supabase\)/g, "$1)");

  // Prisma runtime removed.
  s = s.replace(/^import \{ getPrismaClient \} from "@attendance\/db";\n/m, "");
  s = s.replace(/^import \{ prismaMiddleware \} from "\.\/middleware\/prisma";\n/m, "");
  s = s.replace(/^import \{ runNightlyJob \} from "\.\/lib\/cron";\n/m, "");
  s = s.replace(
    /^import \{ runNightlyJob as runNightlyJobSupabase \} from "\.\/lib\/cronSupabase";\n/m,
    'import { runNightlyJob } from "./lib/cronSupabase";\n'
  );
  s = s.replace(/^app\.use\("\*", prismaMiddleware\);\n/m, "");
  s = s.replace(
    /\/\/ No-op unless SUPABASE_URL[\s\S]*?\/\/ which sets neither — keeps serving every route from D1\.\n/m,
    ""
  );
  s = s.replace(
    /\/\/ Migration preview:[\s\S]*?\/\/ replace their \/api counterparts\.\n/m,
    ""
  );

  // scheduled(): Supabase only. The D1 fallback existed so production could keep
  // running the old job during the migration; there is no old job now.
  s = s.replace(
    /  \/\*\*\n   \* Nightly job\.[\s\S]*?\n  \},\n/m,
    `  async scheduled(_event: ScheduledEvent, env: AppEnv["Bindings"], ctx: ExecutionContext) {
    const db = getSupabase({
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    });
    ctx.waitUntil(
      runNightlyJob(db).then((result) => {
        console.log("Nightly cron completed", JSON.stringify(result));
      })
    );
  },
`
  );

  log("rewrite index.ts");
  if (APPLY) writeFileSync(p, s);
}

// ── 4. Delete the Prisma-only modules ────────────────────────────────────────
for (const p of [
  "apps/api/src/middleware/prisma.ts",
  "apps/api/src/lib/cron.ts",
  "apps/api/src/lib/attendanceContext.ts",
  "apps/api/src/lib/semesterGuard.ts",
  "apps/api/src/lib/settings.ts",
  "packages/db/src/index.ts",
]) {
  log(`delete ${p}`);
  if (APPLY && existsSync(p)) unlinkSync(p);
}

// Rename the Supabase-suffixed libs into their place.
for (const [from, to] of [
  ["apps/api/src/lib/cronSupabase.ts", "apps/api/src/lib/cron.ts"],
  ["apps/api/src/lib/attendanceContextSupabase.ts", "apps/api/src/lib/attendanceContext.ts"],
  ["apps/api/src/lib/semesterGuardSupabase.ts", "apps/api/src/lib/semesterGuard.ts"],
]) {
  log(`rename ${from} -> ${to}`);
  if (APPLY && existsSync(from)) renameSync(from, to);
}

// ── 5. types.ts, wrangler.toml, package.json ─────────────────────────────────
{
  const p = "apps/api/src/types.ts";
  let s = readFileSync(p, "utf8");
  s = s.replace(
    /^import type \{ PrismaClient, Role \} from "@attendance\/db";\n/m,
    'import type { Role } from "@attendance/db/types";\n'
  );
  s = s.replace(/^  \/\*\* D1 database binding[\s\S]*?  DB: D1Database;\n/m, "");
  s = s.replace(/^  \/\*\* Previous D1 database[\s\S]*?  DB\?: D1Database;\n/m, "");
  // Supabase vars are required now, not optional.
  s = s.replace(/  SUPABASE_URL\?: string;/, "  SUPABASE_URL: string;");
  s = s.replace(
    /  SUPABASE_SERVICE_ROLE_KEY\?: string;/,
    "  SUPABASE_SERVICE_ROLE_KEY: string;"
  );
  s = s.replace(/^  prisma: PrismaClient;\n/m, "");
  s = s.replace(/  supabase\?: SupabaseClient;/, "  supabase: SupabaseClient;");
  log("rewrite types.ts");
  if (APPLY) writeFileSync(p, s);
}

{
  const p = "apps/api/src/middleware/roleGuard.ts";
  let s = readFileSync(p, "utf8");
  s = s.replace(
    /^import type \{ Role \} from "@attendance\/db";\n/m,
    'import type { Role } from "@attendance/db/types";\n'
  );
  log("rewrite roleGuard.ts");
  if (APPLY) writeFileSync(p, s);
}

{
  const p = "apps/api/src/lib/calculators.ts";
  let s = readFileSync(p, "utf8");
  s = s.replace(
    /^import type \{ AttendanceStatus \} from "@attendance\/db";\n/m,
    'import type { AttendanceStatus } from "@attendance/db/types";\n'
  );
  log("rewrite calculators.ts");
  if (APPLY) writeFileSync(p, s);
}

{
  const p = "apps/api/wrangler.toml";
  let s = readFileSync(p, "utf8");
  s = s.replace(/# D1 — the live datastore[\s\S]*?migrations_dir = "[^"]*"\n\n/m, "");
  s = s.replace(
    /# Secrets \(set via `wrangler secret put`, never committed\):\n/,
    "# Secrets (set via `wrangler secret put`, never committed):\n" +
      "#   SUPABASE_URL                — Supabase project URL\n" +
      "#   SUPABASE_SERVICE_ROLE_KEY   — bypasses RLS; never expose to the browser\n"
  );
  log("rewrite wrangler.toml (remove [[d1_databases]])");
  if (APPLY) writeFileSync(p, s);
}

{
  const p = "packages/db/package.json";
  const j = JSON.parse(readFileSync(p, "utf8"));
  delete j.dependencies["@prisma/adapter-d1"];
  delete j.dependencies["@prisma/client"];
  j.exports = {
    "./supabase": "./src/supabase.ts",
    "./queries": "./src/queries.ts",
    "./types": "./src/types.ts",
    "./ids": "./src/ids.ts",
    "./repos/*": "./src/repos/*.ts",
  };
  delete j.main;
  delete j.types;
  log("rewrite packages/db/package.json (drop Prisma deps, drop '.' export)");
  if (APPLY) writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
}

console.log(
  APPLY
    ? "\nCUTOVER APPLIED. Next: npm install, tsc --noEmit, run the contract gate, then deploy."
    : "\nDry run only. Re-run with --apply to make these changes."
);

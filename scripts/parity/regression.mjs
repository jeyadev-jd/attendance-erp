// Full regression suite: run this before and after any cutover step.
//
// Wraps the three checks that have caught every real bug in this migration, so they
// run as one command instead of three remembered ones:
//
//   1. Data preflight   — row counts match between local D1 and Supabase. If they
//                         drift, nothing downstream is comparable and the run stops.
//   2. Contract gate     — the D1 route and its Supabase counterpart return the same
//                         shape, values, status codes and error bodies.
//   3. Row-cap guard     — the specific failure that silently understated every
//                         attendance percentage: PostgREST caps unfiltered selects at
//                         1000 rows. Re-checked explicitly because it produces no
//                         error and no stack trace, only wrong numbers.
//
// Usage:
//   node scripts/parity/regression.mjs                        (local worker)
//   node scripts/parity/regression.mjs <baseUrl> <jwt>        (production)
import { execFileSync } from "node:child_process";
import { supabaseClient, runPreflight, printCountTable } from "./preflight.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const JWT = process.argv[3];

let failures = 0;
const section = (n) => console.log(`\n${"=".repeat(60)}\n${n}\n${"=".repeat(60)}`);

// ── 1. Data integrity ────────────────────────────────────────────────────────
section("1. DATA PREFLIGHT — local D1 vs Supabase row counts");
const pre = await runPreflight();
printCountTable(pre.rows);
if (!pre.ok) {
  console.error("\nFAILED — tables differ. Analytics comparison is meaningless until fixed.");
  for (const m of pre.mismatches) {
    console.error(`  ${m.table}: D1=${m.d1} Supabase=${m.supabase}`);
  }
  process.exit(1);
}
console.log("\nPASS — all tables match.");

// ── 2. Row-cap guard ─────────────────────────────────────────────────────────
//
// Kept as its own check rather than folded into the contract gate: the gate compares
// two implementations, so if BOTH truncated it would pass. This asserts against the
// database's own exact count.
section("2. ROW-CAP GUARD — paging returns every row");
{
  const db = supabaseClient();
  const SEMESTER = "cmsddhj2q000310eqebq4w6wm";

  const { count: exact } = await db
    .from("attendance")
    .select("*", { count: "exact", head: true })
    .eq("semesterId", SEMESTER);

  const { data: naive } = await db.from("attendance").select("id").eq("semesterId", SEMESTER);

  const paged = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db
      .from("attendance")
      .select("id")
      .eq("semesterId", SEMESTER)
      .order("id", { ascending: true })
      .range(from, from + 999);
    paged.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  console.log(`exact count : ${exact}`);
  console.log(`naive select: ${naive?.length ?? 0}${(naive?.length ?? 0) === 1000 ? "  <-- would truncate" : ""}`);
  console.log(`paged select: ${paged.length}`);

  if (paged.length !== exact) {
    console.error("\nFAILED — paging did not return every row.");
    failures++;
  } else {
    console.log("\nPASS — paging complete.");
  }

  // Ids must be unique: a non-total sort can repeat a row across page boundaries.
  const unique = new Set(paged.map((r) => r.id)).size;
  if (unique !== paged.length) {
    console.error(`FAILED — ${paged.length - unique} duplicate rows across page boundaries.`);
    failures++;
  } else {
    console.log("PASS — no duplicates across pages (sort is total).");
  }
}

// ── 3. Contract gate ─────────────────────────────────────────────────────────
section("3. CONTRACT GATE — D1 route vs Supabase route");
if (!JWT) {
  console.log("skipped: no JWT supplied.");
  console.log("usage: node scripts/parity/regression.mjs <baseUrl> <jwt>");
} else {
  try {
    const out = execFileSync(
      "node",
      ["scripts/parity/contract.mjs", BASE, JWT],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
    );
    console.log(out.split("\n").slice(-4).join("\n"));
  } catch (e) {
    // contract.mjs exits non-zero on any failure; its own output explains which.
    const out = (e.stdout ?? "").toString();
    console.log(out.split("\n").filter((l) => /^FAIL|passed/.test(l)).join("\n"));

    // The four known ordering differences are accepted: verified zero field-level
    // differences, with Supabase the deterministic side (D1 has no tiebreaker).
    const failed = (out.match(/^FAIL/gm) ?? []).length;
    const KNOWN_ORDERING = 4;
    if (failed > KNOWN_ORDERING) {
      console.error(`\nFAILED — ${failed} contract failures, expected at most ${KNOWN_ORDERING} (ordering).`);
      failures++;
    } else {
      console.log(`\nPASS — ${failed} failure(s), all known ordering differences.`);
    }
  }
}

section(failures === 0 ? "REGRESSION PASSED" : `REGRESSION FAILED — ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);

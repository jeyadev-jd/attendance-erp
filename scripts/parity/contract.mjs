// API contract parity — the D1 route vs its migrated Supabase counterpart.
//
// The database migration must be invisible to the frontend: same routes, same
// methods, same JSON shapes, same field names, same status codes, same error format.
// apps/web keeps calling /api/... and never learns which database answered.
//
// This compares the two live implementations rather than reading the code, because
// the failure this guards against is a shape drifting by one field — an extra key
// from a PostgREST embed, a number arriving as a string, a null where the frontend
// expects a value. Those pass typecheck and break the UI.
//
// Usage: node scripts/parity/contract.mjs <baseUrl> <jwt>
//   e.g. node scripts/parity/contract.mjs http://127.0.0.1:8850 "$(cat jwt.txt)"

const BASE = process.argv[2] ?? "http://127.0.0.1:8850";
const JWT = process.argv[3];

if (!JWT) {
  console.error("usage: node scripts/parity/contract.mjs <baseUrl> <jwt>");
  process.exit(1);
}

/**
 * Route pairs: [legacy D1 path, migrated Supabase path]. Extend as routes migrate.
 *
 * `extra` lists additional query strings to exercise on the same pair, so filtered
 * variants are compared too — a filter applied in the wrong place would still return
 * a well-shaped response, just the wrong rows.
 */
const PAIRS = [
  { legacy: "/api/departments", migrated: "/api/v2/departments", extra: [] },
  {
    legacy: "/api/subjects",
    migrated: "/api/v2/subjects",
    extra: ["?departmentId=cmsdcwfls0001e4cyrntgg98b", "?departmentId=nonexistent"],
  },
  {
    legacy: "/api/sections",
    migrated: "/api/v2/sections",
    extra: [
      "?semesterId=cmsddhj2q000310eqebq4w6wm",
      "?departmentId=cmsdcwfls0001e4cyrntgg98b",
      "?semesterId=cmsddhj2q000310eqebq4w6wm&departmentId=cmsdcwfls0001e4cyrntgg98b",
    ],
  },
  {
    legacy: "/api/faculty",
    migrated: "/api/v2/faculty",
    extra: ["?departmentId=cmsdcwfls0001e4cyrntgg98b", "?departmentId=nonexistent"],
    // Read-only router: it has no /:id route, so a 404-shape probe would compare
    // Hono's own not-found handler rather than the route's.
    skip404: true,
  },
  { legacy: "/api/academic-years", migrated: "/api/v2/academic-years", extra: [], skip404: true },
  {
    legacy: "/api/semesters",
    migrated: "/api/v2/semesters",
    extra: ["?academicYearId=cmsddfyw0000110eq5dvdvdv1", "?academicYearId=nonexistent"],
  },
  {
    legacy: "/api/students",
    migrated: "/api/v2/students",
    extra: ["?sectionId=cmsddj07m000510eqx5ste4kd", "?sectionId=nonexistent"],
  },
  {
    legacy: "/api/users",
    migrated: "/api/v2/users",
    extra: ["?role=ADMIN", "?role=FACULTY", "?role=STUDENT"],
    // No /:id GET route on either router.
    skip404: true,
  },
  { legacy: "/api/notifications", migrated: "/api/v2/notifications", extra: ["?isRead=false", "?isRead=true", "?limit=5"], skip404: true },
  { legacy: "/api/notifications/unread-count", migrated: "/api/v2/notifications/unread-count", extra: [], skip404: true },
  { legacy: "/api/settings", migrated: "/api/v2/settings", extra: [], skip404: true },
  { legacy: "/api/audit-logs", migrated: "/api/v2/audit-logs", extra: ["?sectionId=cmsddj07m000510eqx5ste4kd", "?dateFrom=2026-07-13&dateTo=2026-08-05"], skip404: true },
  { legacy: "/api/hour-config?semesterId=cmsddhj2q000310eqebq4w6wm", migrated: "/api/v2/hour-config?semesterId=cmsddhj2q000310eqebq4w6wm", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/calendar/month?semesterId=cmsddhj2q000310eqebq4w6wm&year=2026&month=8", migrated: "/api/v2/calendar/month?semesterId=cmsddhj2q000310eqebq4w6wm&year=2026&month=8", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/calendar/month?semesterId=cmsddhj2q000310eqebq4w6wm&year=2026&month=7", migrated: "/api/v2/calendar/month?semesterId=cmsddhj2q000310eqebq4w6wm&year=2026&month=7", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/calendar/month?semesterId=cmsddhj2q000310eqebq4w6wm&year=2026&month=12", migrated: "/api/v2/calendar/month?semesterId=cmsddhj2q000310eqebq4w6wm&year=2026&month=12", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/timetable", migrated: "/api/v2/timetable", extra: ["?sectionId=cmsddj07m000510eqx5ste4kd", "?semesterId=cmsddhj2q000310eqebq4w6wm", "?sectionId=nonexistent"], skip404: true },
  { legacy: "/api/timetable/overrides?sectionId=cmsddj07m000510eqx5ste4kd", migrated: "/api/v2/timetable/overrides?sectionId=cmsddj07m000510eqx5ste4kd", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/timetable/overrides?sectionId=cmsddj07m000510eqx5ste4kd&dateFrom=2026-07-13&dateTo=2026-08-05", migrated: "/api/v2/timetable/overrides?sectionId=cmsddj07m000510eqx5ste4kd&dateFrom=2026-07-13&dateTo=2026-08-05", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/attendance/mark?date=2026-08-04&sectionId=cmsddj07m000510eqx5ste4kd&hourNumber=1", migrated: "/api/v2/attendance/mark?date=2026-08-04&sectionId=cmsddj07m000510eqx5ste4kd&hourNumber=1", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/attendance/mark?date=2026-08-05&sectionId=cmsddj07m000510eqx5ste4kd&hourNumber=3", migrated: "/api/v2/attendance/mark?date=2026-08-05&sectionId=cmsddj07m000510eqx5ste4kd&hourNumber=3", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/admin/analytics/heatmap?semesterId=cmsddhj2q000310eqebq4w6wm", migrated: "/api/v2/admin/analytics/heatmap?semesterId=cmsddhj2q000310eqebq4w6wm", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/admin/analytics/heatmap?semesterId=cmsddhj2q000310eqebq4w6wm&dateFrom=2026-07-13&dateTo=2026-08-05", migrated: "/api/v2/admin/analytics/heatmap?semesterId=cmsddhj2q000310eqebq4w6wm&dateFrom=2026-07-13&dateTo=2026-08-05", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/admin/analytics/subject-comparison?semesterId=cmsddhj2q000310eqebq4w6wm", migrated: "/api/v2/admin/analytics/subject-comparison?semesterId=cmsddhj2q000310eqebq4w6wm", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/admin/analytics/subject-report?semesterId=cmsddhj2q000310eqebq4w6wm", migrated: "/api/v2/admin/analytics/subject-report?semesterId=cmsddhj2q000310eqebq4w6wm", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/admin/analytics/daily-bunkers?semesterId=cmsddhj2q000310eqebq4w6wm&date=2026-08-04", migrated: "/api/v2/admin/analytics/daily-bunkers?semesterId=cmsddhj2q000310eqebq4w6wm&date=2026-08-04", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/admin/analytics/daily-bunkers?semesterId=cmsddhj2q000310eqebq4w6wm&date=2026-08-04&sectionId=cmsddj07m000510eqx5ste4kd", migrated: "/api/v2/admin/analytics/daily-bunkers?semesterId=cmsddhj2q000310eqebq4w6wm&date=2026-08-04&sectionId=cmsddj07m000510eqx5ste4kd", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/student/dashboard?semesterId=cmsddhj2q000310eqebq4w6wm", migrated: "/api/v2/student/dashboard?semesterId=cmsddhj2q000310eqebq4w6wm", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/student/timeline?semesterId=cmsddhj2q000310eqebq4w6wm", migrated: "/api/v2/student/timeline?semesterId=cmsddhj2q000310eqebq4w6wm", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/student/timeline?semesterId=cmsddhj2q000310eqebq4w6wm&from=2026-07-13&to=2026-08-05", migrated: "/api/v2/student/timeline?semesterId=cmsddhj2q000310eqebq4w6wm&from=2026-07-13&to=2026-08-05", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/student/analytics?semesterId=cmsddhj2q000310eqebq4w6wm", migrated: "/api/v2/student/analytics?semesterId=cmsddhj2q000310eqebq4w6wm", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/student/subject-planner?semesterId=cmsddhj2q000310eqebq4w6wm", migrated: "/api/v2/student/subject-planner?semesterId=cmsddhj2q000310eqebq4w6wm", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/student/subject-planner?semesterId=cmsddhj2q000310eqebq4w6wm&targetPct=75", migrated: "/api/v2/student/subject-planner?semesterId=cmsddhj2q000310eqebq4w6wm&targetPct=75", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/reports/export?semesterId=cmsddhj2q000310eqebq4w6wm&format=csv", migrated: "/api/v2/reports/export?semesterId=cmsddhj2q000310eqebq4w6wm&format=csv", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/reports/export?semesterId=cmsddhj2q000310eqebq4w6wm&format=csv&sectionId=cmsddj07m000510eqx5ste4kd", migrated: "/api/v2/reports/export?semesterId=cmsddhj2q000310eqebq4w6wm&format=csv&sectionId=cmsddj07m000510eqx5ste4kd", extra: [], skip404: true, skipAuth: true },
  { legacy: "/api/reports/export?semesterId=cmsddhj2q000310eqebq4w6wm&format=csv&dateFrom=2026-07-13&dateTo=2026-08-05", migrated: "/api/v2/reports/export?semesterId=cmsddhj2q000310eqebq4w6wm&format=csv&dateFrom=2026-07-13&dateTo=2026-08-05", extra: [], skip404: true, skipAuth: true },
];

async function get(path) {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${JWT}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON responses are the CSV/XLSX exports. Split into lines with CRLF
    // normalised: both sides emit CRLF, but a trailing terminator on the final line
    // differs, which made every line compare unequal for a reason that has nothing
    // to do with the data.
    body = text.replace(/\r\n/g, "\n").trim().split("\n");
  }
  return { status: res.status, body, ms: Date.now() - started };
}

/**
 * Structural signature of a response: key names and value types, recursively, with
 * arrays reduced to their element shape.
 *
 * Compares shape rather than values because ids and timestamps legitimately differ
 * between two databases; what must not differ is the set of fields and their types.
 */
function shape(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length === 0 ? "[]" : `[${shape(v[0])}]`;
  if (typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${k}:${shape(v[k])}`)
      .join(",")}}`;
  }
  return typeof v;
}

const results = [];

for (const { legacy, migrated, extra, skip404, skipAuth } of PAIRS) {
  // 1 & 2. Success shape and exact value equality, for the bare path and every
  //        filtered variant. Both databases hold the same rows, so the payloads
  //        should match byte for byte, not merely structurally.
  for (const qs of ["", ...extra]) {
    const a = await get(legacy + qs);
    const b = await get(migrated + qs);

    results.push({
      check: `GET ${legacy}${qs} vs ${migrated}${qs}`,
      pass: a.status === b.status && shape(a.body) === shape(b.body),
      detail:
        a.status !== b.status
          ? `status ${a.status} vs ${b.status}`
          : shape(a.body) === shape(b.body)
            ? `shape ${shape(a.body)}`
            : `shape ${shape(a.body)} vs ${shape(b.body)}`,
      latency: `${a.ms}ms vs ${b.ms}ms`,
    });

    // Value equality, with reordering reported separately from a real data
    // difference. Postgres and SQLite disagree on collation — SQLite sorts by byte
    // (so "NLP Lab" precedes "Natural Language Processing"), Postgres by locale — so
    // an identical row set can come back in a different order. That is a known,
    // accepted engine difference; a changed row set never is, and must still fail.
    // Canonical form: object keys sorted recursively. JSON objects are unordered, so
    // Prisma emitting {id, semesterId, name} and PostgREST emitting {id, name,
    // semesterId} is the same value — every JSON parser yields identical objects, and
    // the frontend reads fields by name. Comparing raw strings would flag that as a
    // difference; comparing canonical form catches real changes without the noise.
    const canon = (v) => {
      if (v === null || typeof v !== "object") return v;
      if (Array.isArray(v)) return v.map(canon);
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, canon(v[k])])
      );
    };

    // Float tolerance, matching scripts/parity/analytics.mjs.
    //
    // Postgres `double precision` renders with fewer significant digits than
    // JavaScript's Number#toString: 93.87755102040816 (D1) vs 93.8775510204082
    // (Postgres) is the SAME IEEE-754 double, printed differently. Comparing the
    // JSON text flags that as a difference; comparing numerically does not.
    //
    // Deliberately tight (1e-9). Percentages here drive an 80% threshold, so a real
    // discrepancy would be orders of magnitude larger than this and must still fail.
    const EPS = 1e-9;
    const numEq = (x, y) => {
      if (typeof x === "number" && typeof y === "number") return Math.abs(x - y) < EPS;
      if (Array.isArray(x) && Array.isArray(y)) {
        return x.length === y.length && x.every((v, i) => numEq(v, y[i]));
      }
      if (x && y && typeof x === "object" && typeof y === "object") {
        const kx = Object.keys(x).sort();
        const ky = Object.keys(y).sort();
        if (JSON.stringify(kx) !== JSON.stringify(ky)) return false;
        return kx.every((k) => numEq(x[k], y[k]));
      }
      return x === y;
    };

    const exact =
      JSON.stringify(canon(a.body)) === JSON.stringify(canon(b.body)) ||
      numEq(canon(a.body), canon(b.body));
    const sameSet =
      Array.isArray(a.body) &&
      Array.isArray(b.body) &&
      a.body.length === b.body.length &&
      JSON.stringify([...a.body].map((x) => JSON.stringify(canon(x))).sort()) ===
        JSON.stringify([...b.body].map((x) => JSON.stringify(canon(x))).sort());

    results.push({
      check: `GET ${legacy}${qs} value equality`,
      pass: exact || sameSet,
      detail: exact
        ? `identical (${Array.isArray(a.body) ? a.body.length : 1} row(s))`
        : sameSet
          ? `ORDER-ONLY: same ${a.body.length} rows, collation differs (SQLite BINARY vs Postgres locale)`
          : `differs: ${JSON.stringify(a.body).slice(0, 100)} vs ${JSON.stringify(b.body).slice(0, 100)}`,
      latency: "",
    });
  }

  // 3. 404 error format — the frontend renders `error`, so the key must survive.
  if (!skip404) {
    const a404 = await get(`${legacy}/definitely-not-a-real-id`);
    const b404 = await get(`${migrated}/definitely-not-a-real-id`);
    results.push({
      check: `404 error shape ${legacy}`,
      pass: a404.status === b404.status && shape(a404.body) === shape(b404.body),
      detail: `${a404.status} ${JSON.stringify(a404.body)} vs ${b404.status} ${JSON.stringify(b404.body)}`,
      latency: "",
    });
  }

  // 4. Unauthenticated behaviour must be identical.
  if (skipAuth) continue;
  const aNoAuth = await fetch(`${BASE}${legacy}`);
  const bNoAuth = await fetch(`${BASE}${migrated}`);
  results.push({
    check: `401 unauthenticated ${legacy}`,
    pass: aNoAuth.status === bNoAuth.status && aNoAuth.status === 401,
    detail: `${aNoAuth.status} vs ${bNoAuth.status}`,
    latency: "",
  });
}

console.log("\nAPI CONTRACT PARITY");
console.log("-------------------");
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.check}`);
  console.log(`      ${r.detail}${r.latency ? `  (${r.latency})` : ""}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);

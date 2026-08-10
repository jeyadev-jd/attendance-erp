// Primary-key generation for Supabase inserts.
//
// Prisma's `@default(cuid())` is a CLIENT-side default: Prisma generates the id and
// sends it with the INSERT. Postgres never had a DEFAULT on these columns, and the
// D1 export carried the schema across as `"id" TEXT NOT NULL PRIMARY KEY` with no
// default, so an insert issued through PostgREST supplies no id and fails with
//   null value in column "id" ... violates not-null constraint
//
// Every one of the 20 tables is affected, so id generation has to live somewhere in
// the Supabase path. Doing it here rather than adding a database DEFAULT keeps the
// id format identical to the 2767 rows already migrated, and avoids a schema change
// that would have to be reconciled with Prisma while D1 is still production.
//
// Format: cuid v1, matching what Prisma emits — 'c' + timestamp + counter +
// fingerprint + randomness, base36. Existing ids look like "cmsd884iu00002tatypx25tzk".

const BLOCK = 4;
const BASE = 36;

// Initialised lazily on first use, not at module scope: the Workers runtime forbids
// random generation and async I/O while the global scope is evaluating
// ("Disallowed operation called within global scope"), so seeding either of these at
// import time refuses to boot the Worker.
let counter: number | null = null;

function pad(str: string, size: number): string {
  return str.length >= size ? str.slice(-size) : str.padStart(size, "0");
}

function randomBlock(): string {
  // crypto.getRandomValues is available in Workers, Node 18+, and browsers.
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return pad((buf[0] % BASE ** BLOCK).toString(BASE), BLOCK);
}

function nextCounter(): number {
  if (counter === null) counter = Math.floor(Math.random() * BASE ** BLOCK);
  counter = counter < BASE ** BLOCK ? counter : 0;
  return counter++;
}

// Stable per-isolate fingerprint, computed on first use for the global-scope reason
// above. In a Worker there is no hostname or pid, so this is random per isolate —
// which serves the same purpose: separating ids generated concurrently in different
// isolates during the same millisecond.
let fingerprint: string | null = null;

function getFingerprint(): string {
  if (fingerprint === null) fingerprint = randomBlock();
  return fingerprint;
}

/** Generates a cuid in Prisma's format. */
export function cuid(): string {
  const timestamp = Date.now().toString(BASE);
  const count = pad(nextCounter().toString(BASE), BLOCK);
  return `c${timestamp}${count}${getFingerprint()}${randomBlock()}${randomBlock()}`;
}

/**
 * Timestamp for columns Prisma fills client-side (`@default(now())`, `@updatedAt`).
 *
 * Those are also Prisma-side defaults, so a PostgREST insert must supply them
 * explicitly. Returns an ISO-8601 string, which is what timestamptz accepts and what
 * the migrated rows already contain.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

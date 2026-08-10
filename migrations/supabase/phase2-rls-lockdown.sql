-- ============================================================================
-- Phase 2 — Supabase security lockdown (model C-3: service-role Worker + deny-all RLS)
--
-- Context: the D1 export was loaded into this project before RLS was applied, so
-- every application table is currently readable through the publishable (anon) key.
-- Verified exposed: users.passwordHash (bcrypt), student names/roll numbers,
-- institutional email addresses, and 2450 attendance rows.
--
-- Model: this database has no Supabase Auth users. Authentication is custom HS256
-- JWT issued by the Cloudflare Worker, so auth.uid() is meaningless here and
-- per-user RLS policies cannot be expressed. Instead the Worker connects with the
-- service_role key (which bypasses RLS by design) and remains the only gateway;
-- every other role is denied outright. Authorization continues to be enforced in
-- the Worker exactly as it is today — this file does not change that.
--
-- Therefore: RLS is enabled with NO policies created. No policy = no row passes,
-- for anon and authenticated alike. That is the intended end state, not an omission.
--
-- Idempotent: safe to run more than once.
-- Run as the project owner in the Supabase SQL Editor.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Revoke table privileges from the PostgREST-facing roles.
--
-- RLS alone would suffice for row access, but revoking GRANTs is the second,
-- independent lock: without SELECT privilege the request fails at permission
-- check before RLS is ever consulted. Defense in depth against a future
-- policy being added by mistake.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
REVOKE USAGE ON SCHEMA public FROM anon, authenticated;

-- Stop future tables from inheriting privileges automatically. Without this, a
-- table created later by the owner could silently become anon-readable again.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Enable + FORCE RLS on every table in public, and drop any existing policy.
--
-- FORCE makes RLS apply to the table owner too, so ownership alone is not a way
-- around it. service_role holds BYPASSRLS and is unaffected — that is what keeps
-- the Worker working.
--
-- Looping over pg_tables rather than naming 20 tables: this cannot miss a table,
-- and it stays correct if the import added something not in the Prisma schema.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t   record;
  pol record;
BEGIN
  FOR t IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE public.%I FORCE  ROW LEVEL SECURITY', t.tablename);

    -- Remove any permissive policy that already exists. Requirement 4 of the
    -- brief: no accidental public SELECT policy may survive this run.
    FOR pol IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t.tablename
    LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, t.tablename);
    END LOOP;
  END LOOP;
END $$;

COMMIT;

-- ============================================================================
-- Verification — run after COMMIT. Expected results are stated per query.
-- ============================================================================

-- V1. Every table: rls_enabled = true AND rls_forced = true. No exceptions.
SELECT
  c.relname                          AS table_name,
  c.relrowsecurity                   AS rls_enabled,
  c.relforcerowsecurity              AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
ORDER BY c.relname;

-- V2. Policy count MUST be 0. Any row here is a way in that shouldn't exist.
SELECT COUNT(*) AS policy_count_must_be_zero
FROM pg_policies
WHERE schemaname = 'public';

-- V3. Residual grants to anon/authenticated MUST be 0.
SELECT COUNT(*) AS anon_grants_must_be_zero
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated');

-- V4. Confirm service_role still bypasses RLS (the Worker depends on this).
--     Expect rolbypassrls = true.
SELECT rolname, rolbypassrls
FROM pg_roles
WHERE rolname IN ('service_role', 'anon', 'authenticated')
ORDER BY rolname;

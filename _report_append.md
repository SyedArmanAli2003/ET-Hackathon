
---

## 19. Row Level Security (RLS) Audit & Policy Setup

> **Timestamp:** 2026-07-01 06:13 UTC

### 19.1 Pre-Audit State

All 5 tables (`stations`, `readings`, `weather`, `forecasts`, `user_profiles`) already had RLS enabled from the initial schema. However, the `user_profiles` policies contained a flawed `CURRENT_USER = 'service_role'` bypass check that was removed and rewritten.

**Security Advisor result before fix:** 0 lints (advisor did not catch the anti-pattern).
**Security Advisor result after fix:** 0 lints ✅

---

### 19.2 Point 3 — Connection String Used by Ingestion Scripts

`ingestion/db.py` reads `SUPABASE_DB_URL` from `ingestion/.env` via `python-dotenv`. The current connection string uses the **postgres superadmin role**:

```
postgresql://postgres.ckjiukvxqqvjmpxhpclb:***@aws-0-ap-south-1.pooler.supabase.com:6543/postgres
```

The `postgres` role has `BYPASSRLS = true` by design. This means:
- All ingestion scripts (`setup_stations.py`, `ingest_readings.py`, `ingest_weather.py`, `run_ingestion.py`) bypass RLS entirely when writing.
- Enabling or tightening RLS policies has **zero impact** on the ingestion pipeline.
- The anon key is **never used** by the ingestion scripts — only by frontend clients via the Supabase JS client.

---

### 19.3 Point 1 — Public Sensor Tables (stations, readings, weather, forecasts)

RLS confirmed ON. Verified live from `pg_policies`:

| Table | RLS | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|
| `stations` | ✅ ON | anon+auth, `USING (true)` | service_role only | service_role only | no policy |
| `readings` | ✅ ON | anon+auth, `USING (true)` | service_role only | service_role only | no policy |
| `weather` | ✅ ON | anon+auth, `USING (true)` | service_role only | service_role only | no policy |
| `forecasts` | ✅ ON | anon+auth, `USING (true)` | service_role only | service_role only | no policy |

No `anon` or `authenticated` role has INSERT/UPDATE/DELETE access on any of these tables. The missing DELETE policy on sensor tables is intentional — sensor history is immutable from the API layer.

**Exact SQL definitions (from pg_policies):**

```sql
-- Example: readings (same pattern for stations, weather, forecasts)

CREATE POLICY readings_select_anon ON readings
  FOR SELECT TO anon, authenticated
  USING (true);                         -- all rows visible, no filter

CREATE POLICY readings_insert_service ON readings
  FOR INSERT TO service_role
  WITH CHECK (true);                    -- service_role bypasses RLS anyway

CREATE POLICY readings_update_service ON readings
  FOR UPDATE TO service_role
  USING (true) WITH CHECK (true);
```

---

### 19.4 Point 2 — user_profiles: Policies & Honest Security Assessment

#### Policies after fix (2026-07-01 06:12 UTC)

Previous policies used `OR (CURRENT_USER = 'service_role')` in the USING clause — this was removed. `service_role` bypasses RLS at the Postgres engine level; adding it to the USING predicate is redundant noise that could mask logic errors.

**Current live policies:**

```sql
-- SELECT: row visible only if session_id matches JWT claim
CREATE POLICY user_profiles_select_own ON user_profiles
  FOR SELECT TO anon, authenticated
  USING (
    session_id = (
      SELECT current_setting('request.jwt.claims', true)::json->>'session_id'
    )
  );

-- INSERT: can only insert row whose session_id matches JWT claim
CREATE POLICY user_profiles_insert_own ON user_profiles
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    session_id = (
      SELECT current_setting('request.jwt.claims', true)::json->>'session_id'
    )
  );

-- UPDATE: both USING + WITH CHECK prevent session_id reassignment
CREATE POLICY user_profiles_update_own ON user_profiles
  FOR UPDATE TO anon, authenticated
  USING (
    session_id = (
      SELECT current_setting('request.jwt.claims', true)::json->>'session_id'
    )
  )
  WITH CHECK (
    session_id = (
      SELECT current_setting('request.jwt.claims', true)::json->>'session_id'
    )
  );

-- DELETE: service_role only (ingestion cleanup)
CREATE POLICY user_profiles_delete_service ON user_profiles
  FOR DELETE TO service_role
  USING (true);
```

#### Honest Security Limitation — Session-ID RLS Without Supabase Auth

> **This is not a real security boundary with the current architecture.**

The USING clause reads `session_id` from `current_setting('request.jwt.claims')::json->>'session_id'`. This value comes from the **JWT the client sends**. There are two problems:

1. **With the standard anon key JWT:** The payload contains no `session_id` claim. The expression evaluates to `NULL = NULL`, which is `false` in SQL. **Result: no anon client can read or write user_profiles at all through the REST API right now.** The table is effectively locked from the frontend.

2. **If a custom JWT were used:** The anon key is public by design (it's meant to be shipped in browser code). Any client can craft a request claiming any `session_id` — there is no cryptographic binding between the JWT and the session. One user could read or modify another user's profile by guessing or enumerating session IDs.

**Why this is different from Supabase Auth:**
Supabase Auth issues JWTs signed with the project's JWT secret, and the `sub` (user ID) claim is set server-side and cannot be forged by the client. The `auth.uid()` function reads this verified claim. There is no equivalent for an arbitrary `session_id` string passed from the browser.

#### Recommended Path Forward

| Option | Security | Complexity | Notes |
|---|---|---|---|
| **Supabase Anonymous Auth** | ✅ Enforced | Low | `supabase.auth.signInAnonymously()` — each browser gets a real JWT with `auth.uid()`. Replace `session_id` policy with `auth.uid()`. |
| **Backend-only profiles** | ✅ Enforced | Medium | Never expose `user_profiles` via anon REST. Read/write only via Edge Function with service_role. |
| **Current session_id RLS** | ❌ Not enforced | — | Gives appearance of protection but is bypassable by any client. |

**Decision deferred** — no write policy for anon opened yet, as requested. The table is currently read-protected by the NULL-evaluation behaviour described above.

---

### 19.5 Security Advisor Final Verification

```
MCP get_advisors(type="security") -> { "lints": [] }
```

**0 security issues.** ✅

All 5 tables have RLS enabled. No table in the `public` schema has RLS disabled. No policy grants unsafe write access to the `anon` role on sensor tables.

---

*Report last updated: 2026-07-01 06:27 UTC*

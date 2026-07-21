
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: user_profiles.session_id  →  user_id uuid (FK to auth.users)
--
-- Why ALTER and not rebuild:
--   ALTER TABLE renames the column in-place, preserving indexes, sequences,
--   and dependent objects without touching any other table.
--
-- Steps:
--   1. Drop the stale RLS policies that reference session_id
--   2. Rename the column and change its type
--   3. Add NOT NULL constraint + unique index (one profile per auth user)
--   4. Add FK to auth.users(id) with ON DELETE CASCADE
--   5. Re-create all 4 RLS policies using (select auth.uid()) = user_id
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Drop old policies (they reference session_id; must drop before column rename)
DROP POLICY IF EXISTS user_profiles_select_own  ON user_profiles;
DROP POLICY IF EXISTS user_profiles_insert_own  ON user_profiles;
DROP POLICY IF EXISTS user_profiles_update_own  ON user_profiles;
DROP POLICY IF EXISTS user_profiles_delete_service ON user_profiles;

-- 2. Rename column: session_id (text) → user_id (uuid)
--    Cast is safe because the table currently has 0 rows.
--    For future reference: if rows existed we would need an explicit USING clause.
ALTER TABLE user_profiles
  RENAME COLUMN session_id TO user_id;

ALTER TABLE user_profiles
  ALTER COLUMN user_id TYPE uuid
    USING user_id::uuid;

-- 3. Enforce uniqueness: one profile per Supabase Auth user
ALTER TABLE user_profiles
  ALTER COLUMN user_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_user_id_key
  ON user_profiles (user_id);

-- 4. FK → auth.users: deleting an anonymous auth user cascade-deletes their profile
ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES auth.users (id)
    ON DELETE CASCADE;

-- 5. Re-create RLS policies using auth.uid()
--    auth.uid() reads the verified `sub` claim from the Supabase-signed JWT.
--    It cannot be forged by the client — the JWT is signed server-side.

-- SELECT: a user can only see their own row
CREATE POLICY user_profiles_select_own
  ON user_profiles
  FOR SELECT
  TO anon, authenticated
  USING ( (SELECT auth.uid()) = user_id );

-- INSERT: can only create a row for themselves
--    WITH CHECK ensures user_id in the new row matches the caller's auth.uid()
CREATE POLICY user_profiles_insert_own
  ON user_profiles
  FOR INSERT
  TO anon, authenticated
  WITH CHECK ( (SELECT auth.uid()) = user_id );

-- UPDATE: can only update their own row, and cannot reassign user_id to another uid
CREATE POLICY user_profiles_update_own
  ON user_profiles
  FOR UPDATE
  TO anon, authenticated
  USING     ( (SELECT auth.uid()) = user_id )
  WITH CHECK( (SELECT auth.uid()) = user_id );

-- DELETE: service_role only (admin cleanup / GDPR erasure)
CREATE POLICY user_profiles_delete_service
  ON user_profiles
  FOR DELETE
  TO service_role
  USING (true);
;

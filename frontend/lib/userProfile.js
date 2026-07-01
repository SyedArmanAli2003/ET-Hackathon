/**
 * frontend/lib/userProfile.js
 *
 * getOrCreateProfile — Anonymous Auth + user_profiles upsert
 * ──────────────────────────────────────────────────────────
 *
 * SECURITY MODEL (Option 1 — Supabase Anonymous Auth)
 * ─────────────────────────────────────────────────────
 * Each browser gets a genuine Supabase Auth identity via signInAnonymously().
 * The resulting JWT is signed server-side; auth.uid() cannot be forged by
 * the client. Row isolation on user_profiles is enforced by:
 *
 *   USING ( (SELECT auth.uid()) = user_id )
 *
 * This is real cryptographic isolation, not "security through obscurity".
 *
 * CALL ONCE PER APP LOAD (e.g. in _app.jsx / layout.tsx / App.vue):
 * ───────────────────────────────────────────────────────────────────
 *   import { getOrCreateProfile } from './lib/userProfile'
 *   const profile = await getOrCreateProfile(supabase)
 *
 * The function:
 *   1. Restores an existing Supabase session from localStorage (if present).
 *   2. If no session exists, calls signInAnonymously() to create one.
 *   3. Upserts a user_profiles row on user_id (= auth.uid()) with
 *      DO NOTHING on conflict — never overwriting existing preferences.
 *   4. Returns the profile row.
 *
 * NO RESET BUG:
 * ─────────────────────────────────────────────────────────────────
 * The upsert uses ON CONFLICT (user_id) DO NOTHING.
 * preferred_language, vulnerability_flags, preferred_station, name
 * are ONLY written on the first INSERT. Subsequent loads return the
 * existing row unchanged. This was the exact bug that was previously
 * fixed for the session_id version — carried forward intentionally.
 */

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<Object>} The user's profile row from user_profiles
 */
export async function getOrCreateProfile(supabase) {
  // ── Step 1: Restore or create an anonymous session ────────────────────────
  // getSession() reads from localStorage. If the user already signed in
  // (even anonymously) in a previous visit, we reuse that identity.
  let { data: { session } } = await supabase.auth.getSession()

  if (!session) {
    // First visit — create a new anonymous identity.
    // Supabase creates an entry in auth.users and returns a signed JWT.
    // The sub claim in this JWT is the permanent user_id for this browser.
    const { data, error } = await supabase.auth.signInAnonymously()
    if (error) throw new Error(`signInAnonymously failed: ${error.message}`)
    session = data.session
  }

  // auth.uid() on the DB side reads session.user.id from the JWT sub claim.
  const userId = session.user.id

  // ── Step 2: Upsert profile row (insert defaults on first visit only) ───────
  // ON CONFLICT (user_id) DO NOTHING is intentional:
  //   - First visit → inserts a row with default values.
  //   - Subsequent visits → does nothing, preserves all user preferences.
  //
  // If DO UPDATE were used here, every page load would reset preferred_language
  // and vulnerability_flags to their defaults — the "reset on every load" bug.
  const { error: upsertError } = await supabase
    .from('user_profiles')
    .upsert(
      {
        user_id:             userId,
        vulnerability_flags: [],       // default: no flags
        preferred_language:  'en',     // default: English
        // name and preferred_station intentionally omitted —
        // they are set explicitly later in the user's onboarding flow
      },
      {
        onConflict:     'user_id',  // unique index target
        ignoreDuplicates: true,     // = DO NOTHING on conflict
      }
    )

  if (upsertError) throw new Error(`Profile upsert failed: ${upsertError.message}`)

  // ── Step 3: Fetch and return the row ─────────────────────────────────────
  // The RLS policy USING ((SELECT auth.uid()) = user_id) ensures we can only
  // ever retrieve our own row — no additional WHERE clause needed.
  const { data: profile, error: fetchError } = await supabase
    .from('user_profiles')
    .select('*')
    .single()

  if (fetchError) throw new Error(`Profile fetch failed: ${fetchError.message}`)
  return profile
}

/**
 * Update specific profile fields.
 * Only the calling user's row is updateable (enforced by RLS).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Partial<{name: string, vulnerability_flags: string[], preferred_station: string, preferred_language: string}>} updates
 */
export async function updateProfile(supabase, updates) {
  // No user_id in the update payload — RLS USING clause handles row targeting.
  // WITH CHECK ( (SELECT auth.uid()) = user_id ) prevents user_id reassignment.
  const { error } = await supabase
    .from('user_profiles')
    .update(updates)
    .eq('user_id', (await supabase.auth.getUser()).data.user.id)

  if (error) throw new Error(`Profile update failed: ${error.message}`)
}

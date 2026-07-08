/**
 * lib/supabaseClient.ts — Single shared Supabase client instance.
 *
 * Both lib/data.ts (public reads) and the onboarding flow (auth + profile
 * writes) import this same client so we never end up with two GoTrueClient
 * instances fighting over the same localStorage session key.
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey);

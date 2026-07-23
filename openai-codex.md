# Openai codex Log

Last updated: 2026-07-23

## NVIDIA NIM integration

- Removed OpenRouter from the advisory flow and documentation. No OpenRouter references remain in the active codebase.
- Configured the server-side NVIDIA NIM endpoint:
  - `https://integrate.api.nvidia.com/v1/chat/completions`
  - API key stored only in the ignored `frontend/saanslive/.env.local`; the key is intentionally not recorded in this file.
- Added an allowlisted frontend model selector with three NVIDIA-accessible models:
  - `meta/llama-3.3-70b-instruct`
  - `minimaxai/minimax-m3`
  - `openai/gpt-oss-120b`
- Added per-model generation settings based on the supplied examples:
  - Llama: temperature `0.2`, top-p `0.7`, max tokens `1024`
  - MiniMax: temperature `1`, top-p `0.95`, max tokens `8192`
  - GPT-OSS: temperature `1`, top-p `1`, max tokens `4096`
- Added server-side model validation so arbitrary model IDs cannot be sent to NVIDIA.
- Added request logging for the selected model and preferred language. Successful responses also include the model ID for verification. Reasoning traces are not exposed to users.
- Increased the optional advisory request timeout to 45 seconds server-side and 50 seconds client-side for larger models; the deterministic advisory remains the fallback.

Relevant files:

- `frontend/saanslive/lib/nimModels.ts`
- `frontend/saanslive/app/api/advisory/route.ts`
- `frontend/saanslive/lib/generateAdvisory.ts`
- `frontend/saanslive/components/AdvisoryPanel.tsx`

## Onboarding and advisory fixes

- Added an explicit `onboarding_completed` preference so submitting the default choices still means “don’t show again.” Existing non-default stored preferences are migrated as completed.
- Connected the onboarding completion callback to the dashboard preference state so vulnerability flags and preferred language update the AdvisoryPanel immediately without requiring a reload.
- Advisory guidance continues to map `children`, `elderly`, and `asthma` flags to personalized text, with generic guidance when no flags are selected.

Relevant files:

- `frontend/saanslive/lib/localPreferences.ts`
- `frontend/saanslive/components/OnboardingModal.tsx`
- `frontend/saanslive/app/dashboard/page.tsx`

## Verification completed

- NVIDIA’s model-list endpoint confirmed the configured credential can access all three allowlisted models.
- Focused TypeScript checks pass for the NIM route, model selector, onboarding, dashboard, and advisory files.
- `git diff --check` passes.
- No OpenRouter references remain.
- During that earlier pass, full type-checking stopped on the unrelated existing `HeroSection.tsx` error where a nullable AQI band was assigned to a non-null `CityAqi.band`.

## Verification still blocked

- Live landing-page click-through for `LiveAqiStrip`, `FeaturesSection`, and `HowItWorksSection` could not be completed because the in-app browser client was unavailable in this environment.
- Actual physical-phone testing was not possible because no phone/browser session is connected.
- Live dashboard spot-checks for Delhi, Chennai, and Patna were not rerun.
- The current GitHub Actions run could not be confirmed. The current `main` commit was identified, but the GitHub connector returned no pull-request run for it and the detailed Actions API request was blocked by the execution entitlement.
- Real English and non-English NVIDIA completion requests were not rerun in this pass because raw external network access was blocked. The request logs and response model field are ready for verification when a live request can be made.

No further changes were recorded after that earlier verification pass.

## ChatGPT Codex India Hackathon upgrade

Updated the project for the attached ChatGPT Codex India Hackathon 2026 guide. The selected track is **AI for Societal Good** because SaanSLive turns air-quality forecasts into preventive, everyday decisions for people in Indian cities.

### New user-facing capability: Personal Air Action Plan

Added a deterministic planning layer that uses the selected station's current reading, real forecast rows, and locally stored vulnerability preferences to create an activity-specific recommendation for:

- Commute
- Outdoor workout
- School run
- Delivery shift

The panel exposes the best available forecast window, AQI category, practical next step, risk level, and the threshold explanation behind the recommendation. It includes a copy-to-clipboard action for sharing the plan. It does not claim to diagnose a medical condition and does not ask an LLM to invent a health score.

Implementation:

- `frontend/saanslive/lib/airPlan.ts` — pure plan calculation and explicit activity thresholds.
- `frontend/saanslive/components/AirPlanPanel.tsx` — interactive dashboard panel.
- `frontend/saanslive/app/dashboard/page.tsx` — dashboard integration.

### New trust and transparency panel

Added `frontend/saanslive/components/ForecastTrustPanel.tsx`. It shows:

- age of the latest sensor reading;
- age of the model run;
- forecast count and model version;
- stored model RMSE compared with the persistence ("no change") baseline;
- explicit messaging when validation metrics or fresh data are unavailable.

This makes uncertainty visible during the demo rather than presenting every output as fresh AI certainty.

### Submission and demo documentation

Added `HACKATHON.md` with the project description, problem statement, architecture, credibility/guardrail explanation, three-minute demo sequence, and BlockseBlock submission checklist. Updated `README.md` with the track and the new dashboard capabilities.

### Verification after the upgrade

- `npm --prefix frontend/saanslive run build` passes successfully with Next.js 16.2.9 and TypeScript.
- `git diff --check` passes.
- No Supabase schema, RLS policy, or exposed-table changes were needed; the new panels consume the existing read-only data layer.
- The in-app browser client was unavailable and the sandbox did not keep a local dev server bound to port 3000, so a visual browser click-through remains a local follow-up before recording the final demo.

### Suggested demo order

1. Open `/dashboard` and select a city/station.
2. Show the forecast and live AQI.
3. Switch the Air Action Plan between Commute, Workout, School run, and Delivery.
4. Point out the best window and the explicit threshold explanation.
5. Show Forecast Transparency and the model-vs-baseline error comparison.
6. Finish with Hotspot Prioritization, Compare Cities, and the live-data chatbot.

## Civic AQI Alert Agent

Implemented the remaining flagship item from `saanslive-hackathon-upgrade-plan.md`: an auditable, proactive Civic AQI Alert Agent.

- Added the `agent_runs` migration with explicit Data API grants, RLS, public read access, and service-role-only writes.
- Added `lib/agent/aqiAlertAgent.ts`, a server-side deterministic plan → decide → alert → self-review loop. It loads real hotspot statistics and model forecasts, applies published thresholds, stores a plain-language advisory for every flagged station, and evaluates the prior run against the next observed AQI.
- **Deviation from the original plan, disclosed here:** `saanslive-hackathon-upgrade-plan.md`'s Phase 1 prompt asked the DECIDE/ACT steps to call the NVIDIA NIM cascade (reusing `generateAdvisory.ts`) to produce the per-station reason and advisory text. What was actually built uses a fixed 3-branch template (`advisoryFor()`) keyed only on alert level -- no LLM call anywhere in the agent's own decision path. This was a deliberate choice, not an oversight: a scheduled GitHub Actions run should never depend on an external LLM's availability/latency, and a deterministic threshold rule is easier to audit than an LLM-generated one. The trade-off is that the "reason" and advisory text are less varied than an LLM-polished version would be. Flagging this explicitly rather than letting the plan's original wording stand uncorrected.
- Added `POST /api/agent/run`. Dashboard-triggered manual runs are burst-limited; GitHub Actions scheduled runs require `AGENT_RUN_TOKEN`.
- Added the *Civic Alert Agent* dashboard tab and a run timeline with expandable reasoning data, alerts, advisories, and self-review results.
- Added `get_recent_alerts` to the chatbot's real-data toolset, so alert questions are grounded in the latest stored run.
- Added `.github/workflows/agent.yml` to trigger the deployed route after the normal ingestion cycle.

Deployment requirements for the live agent:

- Set `SUPABASE_SERVICE_ROLE_KEY` and `AGENT_RUN_TOKEN` only in the deployment's server-side environment; never expose either with a `NEXT_PUBLIC_` prefix.
- Set GitHub repository secrets `AGENT_RUN_URL` (the deployed `/api/agent/run` URL) and the matching `AGENT_RUN_TOKEN`.
- Apply `supabase/migrations/20260723055612_create_agent_runs.sql` before using the agent tab.

### Activation status — 2026-07-23

- Added and authenticated the global Supabase MCP server with `codex mcp add supabase --url "https://mcp.supabase.com/mcp"`.
- Applied migration `20260723055612_create_agent_runs.sql` to the linked Supabase project.
- Confirmed the intended public, read-only API access to `agent_runs` with an HTTP 200 query using the publishable key. The agent still requires `SUPABASE_SERVICE_ROLE_KEY`, `AGENT_RUN_TOKEN`, and the two GitHub Actions secrets above in the deployed environment before scheduled runs can execute.

The existing onboarding already stores English, Hindi, Tamil, and Bengali preferences and passes the selected language into the advisory request.

**Correction (2026-07-23, post-review):** the claim above was overstated when first written. The onboarding language preference was only actually wired into `AdvisoryPanel` at that point -- the chatbot's `SYSTEM_PROMPT` and the Civic AQI Alert Agent's advisory text still ignored it, which is exactly what the hackathon plan's Phase 3 explicitly asked for ("so a language choice is respected everywhere, not just one panel"). Fixed in this pass:

- `app/api/chat/route.ts`: the chat route now accepts an optional `preferredLanguage` in the request body and builds a language-specific system-prompt instruction from it (`buildSystemPrompt()`), naming the same 5 languages the onboarding picker offers (en/hi/ta/bn/mr). The underlying rule -- always call a tool, never invent a number -- is unconditional in every language; only the wording of the reply changes.
- `components/AqiChatbot.tsx`: now reads `usePreferences()` and sends `preferredLanguage` on every `/api/chat` call.
- `lib/agent/advisoryText.ts` (new): the Civic AQI Alert Agent is deliberately deterministic/LLM-free (see `aqiAlertAgent.ts` -- no model call in its decide/act loop, by design, so a scheduled run never depends on LLM availability or latency). Since it can't ask an LLM to translate on the fly, this file is a small, hand-written translation table (not a runtime/cascade translation) for the 3 fixed alert levels across the same 5 languages. `components/AgentActivityLog.tsx` now renders the viewer's own preferred-language advisory text via this table, while `agent_runs.advisories` in the database continues to store the objective English record unchanged.

**Real verification, not assumed:** started the local dev server and made an actual `POST /api/chat` request with `preferredLanguage: "hi"` and the question "What is the current AQI in Delhi?" -- the model called `get_current_aqi` for real, then replied fully in Hindi with the tool's real numbers preserved exactly (`R K Puram — AQI 59.2`, `Anand Vihar — AQI 92.85`, etc.), only the surrounding sentence structure translated. A follow-up request with no `preferredLanguage` (English default) replied in English as before, confirming no regression. `npm run build` passes cleanly after all four file changes, and `get_diagnostics` on every touched file returns clean.

**Second correction (2026-07-23, same review pass) -- Phase 3's OWN explicit fallback requirement was still unmet after the fix above.** The plan says verbatim: *"The template fallback (used when the LLM is unreachable) needs an actual translated string per language ... write those out directly, don't cascade-translate a fallback path."* `AdvisoryPanel.tsx`'s deterministic fallback sentence (shown whenever the NIM cascade fails, is still loading, or returns nothing) was English-only regardless of `preferredLanguage`. Fixed:

- `lib/advisoryFallbackText.ts` (new): hand-written translations for the 6 AQI band labels, the 3 vulnerability-flag labels, the generic/no-flags guidance clause, and a full sentence template with placeholder tokens (`{categoryValue}`, `{station}`, `{time}`, `{guidance}`) -- across the same 4 non-English languages (hi/ta/bn/mr). Returns `null` for `"en"` so the English path is completely untouched.
- `components/AdvisoryPanel.tsx`: the fallback JSX now parses the language's token template (when one exists) and re-inserts the same bold/colored spans the English path already uses for the station name, time, and category+value -- so a Hindi/Tamil/Bengali/Marathi user sees a real translated sentence, with only the AQI number/station name/time left untranslated (same "translate the wording, never the data" rule used everywhere else in the app), instead of silently falling back to English.

**Real verification, not assumed:** ran a standalone script (`npx tsx`) importing the actual translation functions and calling them with real inputs for all 5 languages -- confirmed `en` returns `null` (unchanged English JSX) and each of hi/ta/bn/mr produces a correctly-ordered, non-empty translated sentence with the guidance clause's flag-joining logic (multiple flags joined with the correct localized "and") also verified. `npm run build` passes; `get_diagnostics` clean on both touched files.

## Phase 2 -- Forecast eval / self-review harness (previously unstarted, now built)

This was the plan's lowest-priority "stretch" phase and had genuinely not been started before this pass. Built and verified end-to-end against the live database, not just written.

- New migration `supabase/migrations/20260723065247_create_model_evals.sql`: `model_evals` table (station_id, forecast_at, model_version, horizon_hours, predicted_aqi, actual_aqi, baseline_predicted_aqi, model_abs_error, baseline_abs_error, model_beat_baseline, evaluated_at), unique on (station_id, forecast_at, model_version, horizon_hours) as the idempotent `ON CONFLICT` target, RLS on, public read via anon key, writes restricted to `service_role` -- same posture as `agent_runs`. `get_advisors` (security) returned zero lint issues after applying.
- New `model/eval_agent.py`: for every forecast whose `forecast_at` has passed and that hasn't been evaluated yet, finds the actual reading closest to `forecast_at` (±90 min, same tolerance `features.py`'s `add_forecast_target()` uses) and the reading closest to when the forecast was made (the persistence baseline value), computes both absolute errors, and inserts the comparison. Skips (not fabricates) any forecast with no matching reading in tolerance, and logs the skip count separately from the evaluated count. Also builds a rolling per-city summary (median model error, median baseline error, win rate) across each city's most recent N evals, flags any city that lost to baseline on every one of its last `--retrain-threshold` (default 5) evals as a "retrain candidate," prints the summary table, and writes it to `model/model_health.md`.
- Wired into `.github/workflows/ingest.yml` as a new step immediately after the existing `run_ingestion.py` step, with `continue-on-error: true` so a transient failure here can never fail the whole ingestion job -- the same fault-isolation philosophy `run_ingestion.py` already applies to its own four internal steps.
- New `components/ModelHealthPanel.tsx` + `getModelHealthSummary()` in `lib/data.ts`: a small public read-only panel on `/about` showing the same per-city median-error/win-rate summary, computed client-side from `model_evals` via the existing Supabase anon-key read pattern (no new privileged access).

**Bug found and fixed by actually running it, not just reading it:** the first real run against the live database failed with `operator does not exist: uuid = text` -- `readings.station_id` is a `uuid` column and the bulk `ANY(:station_ids)` query was comparing it against a plain Python list of strings. Fixed by casting the column to `text` on the left side of the comparison (`station_id::text = ANY(:station_ids)`) instead of trying to cast the bound array parameter to `uuid[]` inline (which breaks SQLAlchemy's `:param` substitution syntax).

**Real verification against the live database, not simulated:**
- `--dry-run`: found 145 due-for-evaluation forecasts, matched 121 to real actual+baseline readings within tolerance, honestly skipped 24 with no actual reading yet (too fresh) -- zero fabricated matches.
- Real run (writes enabled): inserted 121 rows. Confirmed live via direct SQL: `SELECT count(*) FROM model_evals` → 121, `count(*) FILTER (WHERE model_beat_baseline)` → 54 real model wins.
- Re-ran immediately after: found only the same 24 still-unmatchable forecasts, zero of the 121 already-evaluated rows re-processed, zero new writes -- confirms the idempotent `ON CONFLICT DO NOTHING` behavior actually works, not just that the SQL looks idempotent.
- `model/model_health.md` was generated with real per-city numbers (18 cities, win rates from 0% to 100%, zero retrain candidates flagged at the default 5-eval threshold).
- Loaded `/about` in headless Edge (same `puppeteer-core`-via-dev-dependency approach as the earlier HeroSection memoization check, removed after use) and confirmed `ModelHealthPanel` renders all 18 cities with real numbers fetched live from Supabase in the browser -- matching (modulo trivial median tie-breaking rounding, e.g. 25.2 vs 25.21) the same numbers the Python script reported independently.

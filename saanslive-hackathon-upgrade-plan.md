# SaanSLive → ChatGPT Codex India Hackathon 2026

Plan + paste-ready prompts. No code below is meant to be run by me — every code block is a prompt for you to hand to Codex or Kiro.

---

## 1. Track & positioning

**Primary track: Theme 8 — AI for Societal Good.** SaanSLive is already a real-time PM2.5/AQI monitoring + 6h forecasting system across 53 stations / 20 cities, with hotspot prioritization and health advisories — that's civic/public-health tech, not a stretch fit. Air pollution is one of the highest-leverage "real problem" stories available: the Lancet Countdown 2025 report attributes <cite index="6-1">around 1.72 million deaths a year in India to PM2.5 pollution, roughly 70% of the global air-pollution death toll</cite>. That's a strong one-line hook for the "Impact & Problem Fit" (20%) section of your project description doc — use it, don't bury it.

**Secondary signal (mention in the doc, don't pick as the track):** the work below also touches Theme 2 (UX for Agentic Applications — you already have a tool-call badge on the chatbot; Phase 1 extends it into a full agent activity log) and Theme 5 (Building Evals — Phase 2). Judges don't score secondary themes directly, but "Creativity & Originality" (10%) rewards a submission that isn't a single-theme box-tick.

**Reality check on the Codex requirement:** the guide's evaluation matrix gives "Use of Codex" its own 15% line and Technical Execution (50%) explicitly asks "how much of it Codex genuinely built." You're right that judges can't fingerprint which agent wrote which line — but the viability gate ("repository matches what was demoed") and the request for visible commit history means the safer play is the same as the honest play: actually run these phases through Codex/Kiro from here forward, and keep a session log like your existing `kiro.md` for it. That gets you real material for that 15%, not just a claim.

---

## 2. Scope given the deadline

Submission deadline is **August 3** — about 11 days out. Four phases below, ordered by leverage. Do them one at a time; come back with what broke or what Codex produced before starting the next one.

| Phase | What | Hits |
|---|---|---|
| **1 — required** | Civic AQI Alert Agent (flagship, demoable) | Technical Execution, Impact, Use of Codex, Creativity |
| **4 — required** | Docs + demo script + submission doc prep | Completeness, Use of Codex (evidence) |
| **3 — do if time** | Vernacular (Hindi/Tamil/Bengali) advisories | Impact, Creativity |
| **2 — stretch** | Automated forecast eval / self-review harness | Technical Execution, Use of Codex |

If you only have time for one thing, do Phase 1. It's the only phase that gives judges something to *watch happen* in the demo video, which is what "Completeness & Demo Quality" and "viability gate" actually check.

---

## 3. Phase 1 — Civic AQI Alert Agent (do this first)

**Why this one:** your chatbot is already agentic in a narrow sense — it plans tool calls, executes them against Supabase, and never invents numbers. But it's reactive (only runs when a user types something) and its reasoning is invisible (the `ToolCallBadge` just shows tool *names*, not *why*). This phase turns it into a proactive, multi-step agent with a visible plan → decide → act → self-review loop, and gives you a live "Run Agent Now" button for the demo video.

Paste this into Codex:

```
You're working in the SaanSLive repo (Next.js 16 / React 19 / TypeScript frontend
in frontend/saanslive, Supabase Postgres backend, migrations in supabase/migrations/).
Follow existing conventions: lib/aqi.ts is the single source of truth for AQI
band/category mapping, lib/data.ts is the data layer for read queries, lib/chatTools.ts
shows the established pattern for Supabase-backed tool functions, lib/generateAdvisory.ts
+ app/api/advisory/route.ts show the established pattern for the NVIDIA NIM LLM
cascade with a template fallback (never hang or fabricate data if the LLM is
unavailable).

Build a "Civic AQI Alert Agent": a proactive, multi-step agent (not just a chatbot
reply) that plans, decides, acts, and reviews its own past output. Specifically:

1. New Supabase migration (supabase/migrations/<timestamp>_create_agent_runs.sql,
   follow the naming/style of existing migrations) creating an `agent_runs` table:
   id uuid pk, created_at timestamptz default now(), trigger text
   ('manual'|'scheduled'), reasoning_steps jsonb (ordered array of
   {step, description, data}), flagged_stations jsonb (array of
   {station_id, city, station_name, current_aqi, forecast_aqi, alert_level, reason}),
   advisories jsonb ({station_id: advisory_text}), self_review jsonb (nullable —
   filled by the NEXT run, evaluating THIS run's flagged stations against what
   actually happened). Enable RLS: public read via anon key (same pattern as
   stations/readings/forecasts), writes restricted to service_role.

2. New module lib/agent/aqiAlertAgent.ts implementing a plan-act-observe loop as an
   explicit sequence of logged steps, not a single opaque function call:
   - PLAN: pull the current hotspot ranking (reuse getHotspotRanking from
     lib/data.ts) and latest 6h forecasts for the top N stations.
   - DECIDE: flag a station when current AQI category is "Unhealthy for Sensitive
     Groups" or worse, OR the forecast shows a worsening trend past a threshold.
     Call the NVIDIA NIM cascade (reuse the pattern from generateAdvisory.ts) to
     produce a one-sentence plain-language reason per flagged station, grounded
     only in the real numbers just pulled — same "never invent a number" rule as
     the chatbot.
   - ACT: generate a short health advisory per flagged station (reuse/extend
     generateAdvisory.ts rather than duplicating its LLM-call logic).
   - SELF-REVIEW: look up the agent's own most recent prior run. For each station
     it flagged then, check the current real reading — did AQI in fact stay
     elevated/worsen (confirmed) or drop back down (false alarm)? Compute a simple
     accuracy summary and store it in that PRIOR row's self_review column (not
     this run's).
   - LOG: write the full run, including every step above, to agent_runs.
   Every step's `data` field should hold the real numbers it used — this is what
   gets rendered as the reasoning trace in the UI, so don't summarize it away.

3. New route app/api/agent/run/route.ts (POST) that runs the agent and returns the
   full run record. Must be safe to call both from a UI button (for live demo) and
   from a scheduled job.

4. New GitHub Actions workflow (.github/workflows/agent.yml, mirror the structure
   of ingest.yml) that calls this route on a cron a couple hours after each
   ingestion cycle, so forecasts exist before the agent runs.

5. New component components/AgentActivityLog.tsx: a timeline of the last ~10 runs,
   each expandable to show its reasoning_steps in order, flagged_stations, the
   advisories generated, and (once available) the self_review verdict on its own
   prior call. Include a "Run Agent Now" button that calls the new API route and
   prepends the fresh run to the list — this is the centerpiece of the demo video.

6. Add this as a fourth section/tab on app/dashboard/page.tsx, following the exact
   tab pattern already used for Overview / Hotspot Prioritization / Compare Cities.

7. Add one new chatbot tool, get_recent_alerts, to lib/chatTools.ts (same schema +
   implementation + runChatTool dispatch pattern as the existing four tools) so a
   user can ask the chatbot "any alerts right now?" and get a real answer.

Keep every new piece consistent with the existing honesty constraints in this repo:
no fabricated numbers, explicit "no data" states instead of guesses, and every
Supabase write behind RLS. Show me a plan before writing code, then implement
section by section.
```

---

## 4. Phase 4 — Docs, session log, demo script (do this right after Phase 1)

**Why now, not last:** the evaluation guide explicitly checks "code quality, architecture, and how much of it Codex genuinely built," and the viability gate checks the repo against the demo. Documenting the build *as you go* is what actually earns that, not a last-minute writeup.

```
In the SaanSLive repo, do three things:

1. Update README.md: extend the "Repository Structure" and "Architecture Overview"
   sections to include agent_runs, lib/agent/aqiAlertAgent.ts,
   components/AgentActivityLog.tsx, and .github/workflows/agent.yml, in the same
   style as the existing entries.

2. Create codex.md at the repo root, mirroring the format of the existing kiro.md
   (chronological, session-by-session, plan → build → verify → evidence). Log the
   Civic AQI Alert Agent build from this hackathon phase specifically: what was
   planned, what was built, what was tested (include actual pass/fail checks like
   kiro.md already does — e.g. "triggered a manual run, confirmed agent_runs row
   written with N reasoning steps and M flagged stations"), and any bugs found and
   fixed. This is the evidence trail for the "Use of Codex" criterion.

3. Draft a shot-by-shot script for a 3-minute demo video (this is a submission
   requirement, max 3 minutes) covering: (a) the problem in one sentence with the
   pollution-death stat, (b) the live dashboard — map, forecast chart, hotspot
   ranking, (c) clicking "Run Agent Now" and the activity log populating with
   visible reasoning steps in real time, (d) asking the chatbot a live question and
   showing the tool-call badge, (e) the self-review verdict from a prior agent run.
   Keep narration tight — this is a demo, not a pitch.
```

If you'd rather I draft the actual **Project Description Google Doc** content (track, problem statement, technical stack, how the agent works) or the demo video **narration script** directly instead of a prompt for Codex, say so — that's text, not code, and I'm glad to just write it here.

---

## 5. Phase 3 — Vernacular advisories (if time allows)

**Why it matters for scoring:** air pollution hits hardest in exactly the regions least served by an English-only dashboard. This is a genuine Impact argument, not a token localization feature, and it's a light lift on top of Phase 1 since the advisory generation path already exists.

```
In the SaanSLive repo, add target-language support to the advisory pipeline:

1. Extend lib/generateAdvisory.ts and app/api/advisory/route.ts to accept a
   target_language param (en/hi/ta/bn). When calling the NVIDIA NIM cascade,
   instruct the model to respond in that language. The template fallback (used
   when the LLM is unreachable) needs an actual translated string per language,
   not a runtime translation of the English template — write those out directly,
   don't cascade-translate a fallback path.

2. Apply the same target_language param to the alert advisories generated inside
   lib/agent/aqiAlertAgent.ts (Phase 1) and to the chatbot's SYSTEM_PROMPT in
   app/api/chat/route.ts, so a language choice is respected everywhere, not just
   one panel.

3. lib/localPreferences.ts already stores per-device onboarding preferences —
   add a language field there, and a small selector in OnboardingModal.tsx (or a
   persistent toggle in the header) to set it. Default to English.

Keep the "never invent a number" rule intact in every language — translation
changes wording, not the underlying data source.
```

---

## 6. Phase 2 — Forecast eval / self-review harness (stretch)

**Why it's lower priority:** it's real engineering value (turns the honesty-first "we report our model's real performance" ethos from a README table into an automated, ongoing process) but it's invisible in a 3-minute demo unless you specifically show the output. Only do this if Phase 1 and 4 are solid with days to spare.

```
In the SaanSLive repo (model/ directory, Python), build an automated forecast
evaluation step:

1. New script model/eval_agent.py: for every row in `forecasts` whose forecast_at
   timestamp has now passed, find the actual reading in `readings` closest to that
   timestamp. Compute the model's absolute error and the persistence-baseline's
   absolute error (baseline = the AQI at the time the forecast was made, unchanged)
   for the same window. Write each comparison to a new `model_evals` table (new
   Supabase migration): station_id, forecast_at, predicted_aqi, actual_aqi,
   baseline_predicted_aqi, model_abs_error, baseline_abs_error, model_beat_baseline
   bool, evaluated_at. Skip rows already evaluated (idempotent, same ON CONFLICT
   pattern as the ingestion scripts).

2. After each batch, print (and optionally write to a model_health.md file) a
   per-city rolling summary: median model error, median baseline error, and a flag
   for any city where the model has underperformed baseline for the last 5+
   consecutive evals — a "retrain candidate" list, extending the honesty already
   in train.py's per-city reporting.

3. Wire this as a new step in the ingestion GitHub Actions workflow (or a new
   scheduled workflow), running after predict.py on each cycle, fault-isolated
   the same way run_ingestion.py's steps already are.

4. Optionally surface the latest model_evals summary as a small read-only panel
   (RLS public-read, same as other sensor tables) — e.g. on the /about page.
```

---

## Submission checklist (non-code, don't lose points here)

- Deployed link stays up and credential-free through evaluation
- GitHub repo public, commit history visible and matching the demo
- Demo video ≤ 3 minutes
- Project Description Google Doc, link-accessible, kept live through evaluation — organizers may check version history
- Submit through BlockseBlock, and don't forget the final **"Final Submit"** click — per the guide, skipping it leaves you stuck in drafts

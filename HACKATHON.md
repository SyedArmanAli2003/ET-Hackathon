# SaanSLive - ChatGPT Codex India Hackathon 2026

## Track

**AI for Societal Good** - preventive, hyperlocal air-quality planning for people making everyday outdoor decisions in Indian cities.

## Problem

Air-quality dashboards usually answer *what is the AQI now?* That is too late for a parent deciding when to do a school run, a delivery worker planning a shift, or someone choosing when to exercise. General city-wide alerts also fail to show whether the prediction is fresh, where it came from, or whether a model meaningfully improves on simply assuming the AQI will not change.

## Solution

SaanSLive combines live OpenAQ station readings, weather enrichment, and per-city ML forecasts to help people plan ahead. It tracks 53 stations across 20 Indian cities and shows:

- a live station map and 6-hour AQI forecast;
- a personalized air action plan for a commute, outdoor workout, school run, or delivery shift;
- a transparent data panel showing reading/model freshness and forecast RMSE against a persistence baseline;
- a proactive Civic AQI Alert Agent that visibly plans, decides, alerts, and self-reviews against the next real observation;
- an auditable hotspot ranking and city comparison, both calculated from real readings;
- a tool-calling assistant that queries the same live data layer rather than inventing AQI values.

The action plan is intentionally deterministic: it compares the user-selected activity with the actual forecast, applies an explicitly stated sensitivity adjustment when the user selects a vulnerability flag, and always labels older forecast data as a snapshot. It is a planning aid, not medical advice.

## End-to-end architecture

```text
OpenAQ + Open-Meteo
        |
GitHub Actions ingestion (every 5 hours)
        |
Supabase Postgres (RLS; public reads, pipeline-only writes)
        |
XGBoost / LightGBM evaluation + 6-hour forecasts
        |
Next.js dashboard -> forecast, action plan, transparency, hotspot, comparison, chatbot
```

## Why it is credible

- The interface distinguishes missing data from a failed request and never fabricates a forecast.
- Hotspot scores expose their AQI and weekly-trend components instead of presenting an opaque score.
- Forecast quality is compared with a "no change" persistence baseline; the dashboard shows the stored RMSE values.
- The air action plan exposes its threshold and sensitivity adjustment in the interface.
- Preference data remains local to the visitor's browser; no account is required.

## Three-minute demo flow

1. **0:00-0:20 - Problem and promise.** Open the landing page: SaanSLive helps people plan outdoor time before air quality changes.
2. **0:20-0:50 - Live, hyperlocal context.** Open Dashboard, select a city/station (or allow location access), and point out the current AQI and forecast.
3. **0:50-1:35 - The differentiator.** In *Personal air action plan*, switch between Commute, Outdoor workout, School run, and Delivery. Show that the recommendation, best available window, and threshold explanation change from the same real forecast.
4. **1:35-1:55 - Trust, not black-box AI.** Show *Forecast transparency*: latest sensor time, model-run time, forecast count, and model RMSE versus the persistence baseline.
5. **1:55-2:25 - Agentic centerpiece.** Open *Civic Alert Agent*, click **Run Agent Now**, and expand the resulting trace: plan, published threshold decision, alerts, and prior-run self-review.
6. **2:25-2:40 - Public-health operations view.** Open Hotspot Prioritization and explain its transparent AQI + seven-day trend score.
7. **2:40-2:52 - Grounded AI.** Ask the assistant whether there are alerts; point out the visible live-data tool badge and the agent-backed answer.
8. **2:52-3:00 - Codex evidence.** Show the public repository's commit history, this guide, and `report.md` / `openai-codex.md` as the engineering and agentic-work record.

## Submission checklist

- [ ] Deployed link is public and opens without credentials.
- [ ] Public GitHub repository has the current commit history.
- [ ] Demo video is at most three minutes and follows the sequence above.
- [ ] Copy this document into a publicly shared Google Doc for the mandatory project description.
- [ ] In BlockseBlock, choose **AI for Societal Good**, provide all links, toggle both notes, and use **Final Submit** only after the live link has been checked again.

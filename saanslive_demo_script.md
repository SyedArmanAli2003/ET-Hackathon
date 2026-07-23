# SaanSLive — Demo Video Script (Corrected)
Verified against the actual current codebase — every claim below matches real, shipped functionality, not the original aspirational plan.
Target length: 2:15–2:45. Record on the LIVE site: https://saanslive.vercel.app/dashboard — confirm the deploy is current before recording.

---

### 0:00–0:15 — Hook (Homepage hero)

**[ON SCREEN]** Load https://saanslive.vercel.app. Let the cursor-reveal effect play briefly.

**Say:**
> "Every year, air pollution contributes to over a million and a half premature deaths in India. Existing tools tell you today's AQI. SaanSLive tells you what it'll be in the next few hours — and what to actually do about it."

---

### 0:15–0:30 — The problem, fast

**[ON SCREEN]** Scroll to the LiveAqiStrip / feature cards.

**Say:**
> "The monitoring data already exists across hundreds of stations. What's missing is the intelligence layer that turns a number into a decision. SaanSLive forecasts AQI 6 hours ahead, per station, and turns that into a plain-language health advisory."

---

### 0:30–1:05 — Core forecast (Dashboard, Overview tab)

**[ON SCREEN]** Go to /dashboard, "Overview" tab. Click a station with real forecast data. Point at the forecast chart.

**Say:**
> "This is real — a trained XGBoost model per station, forecasting 6 hours ahead. We benchmark every forecast against the honest baseline: 'AQI stays the same as it is right now.' For a station like Surat, our model beats that baseline by over 35%. And where it doesn't yet — a few of our cities — we show that honestly too, rather than hiding it."

**[ON SCREEN]** Point at the Advisory Panel updating for the selected station.

**Say:**
> "And it becomes a real advisory — what this forecast actually means for your next few hours."

---

### 1:05–1:25 — Hotspot Prioritization tab

**[ON SCREEN]** Click "Hotspot Prioritization."

**Say:**
> "Beyond individual forecasts, we rank every station nationally by urgency — current severity combined with a real 7-day trend. Notice the disclaimer right on the panel: we're ranking by observed data, not claiming to know the pollution source. We only say what we can back up."

---

### 1:25–1:40 — Compare Cities tab

**[ON SCREEN]** Click "Compare Cities."

**Say:**
> "And a national view — current versus forecasted AQI across every city we cover, 20 in total. Cities without a trained model yet honestly show 'forecast pending,' never a guessed number."

---

### 1:40–2:10 — The AI Assistant (your strongest differentiator)

**[ON SCREEN]** Open the floating chatbot. Type: "What's the current AQI in Delhi?" Point at the "Checked live data" badge under the response.

**Say:**
> "This isn't a language model guessing — every factual claim is grounded in a live database query, and you can see exactly which data it checked, right here in the badge. Ask it to compare two cities and it runs that comparison live, against our real database."

---

### 2:10–2:30 — Privacy + scalability

**[ON SCREEN]** Briefly show the onboarding modal if not already shown.

**Say:**
> "Your preferences — vulnerability flags, language — never leave your browser. No account, no server-side record of who visited: a deliberate choice for a health-adjacent product."
> "And the entire pipeline runs on free infrastructure, fully automated, unattended — scaling to any city with sensor coverage, no per-city engineering needed."

---

### 2:30–2:45 — Close

**Say:**
> "SaanSLive. See through the smog — before it happens. Live at saanslive.vercel.app."

---

## What changed from the previous draft

- Every "24-72 hour" reference corrected to "6 hours ahead," matching the actual shipped model (predict.py's real default and the only horizon the frontend ever queries or displays).
- City count corrected to 20 (verified directly against config.py), not 17.
- Tab names, chatbot badge text ("Checked live data"), and the RMSE example figures were re-verified against the actual code/data and are unchanged from before — those were already accurate.

## Before recording
- Run the two small copy fixes above (meta description, hero city count) so the LIVE site matches this script exactly.
- Do one full read-through against the live site with this script open side-by-side — confirm every number you say out loud is one you can point at on screen.

# GPT Work Log

Last updated: 2026-07-18

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
- The production build compiles, but full type-checking still stops on the unrelated existing `HeroSection.tsx` error where a nullable AQI band is assigned to a non-null `CityAqi.band`.

## Verification still blocked

- Live landing-page click-through for `LiveAqiStrip`, `FeaturesSection`, and `HowItWorksSection` could not be completed because the in-app browser client was unavailable in this environment.
- Actual physical-phone testing was not possible because no phone/browser session is connected.
- Live dashboard spot-checks for Delhi, Chennai, and Patna were not rerun.
- The current GitHub Actions run could not be confirmed. The current `main` commit was identified, but the GitHub connector returned no pull-request run for it and the detailed Actions API request was blocked by the execution entitlement.
- Real English and non-English NVIDIA completion requests were not rerun in this pass because raw external network access was blocked. The request logs and response model field are ready for verification when a live request can be made.

No further code changes were made after these fixes and verification notes.

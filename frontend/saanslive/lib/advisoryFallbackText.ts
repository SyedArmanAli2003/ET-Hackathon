/**
 * lib/advisoryFallbackText.ts — Static, hand-written translations for
 * AdvisoryPanel's deterministic template (the sentence shown when the
 * NVIDIA NIM cascade in app/api/advisory/route.ts is unreachable, still
 * loading, or returns nothing).
 *
 * WHY THIS FILE EXISTS
 * ---------------------
 * The hackathon upgrade plan (saanslive-hackathon-upgrade-plan.md, Phase 3)
 * is explicit: "The template fallback ... needs an actual translated string
 * per language, not a runtime translation of the English template — write
 * those out directly, don't cascade-translate a fallback path." Before this
 * file existed, AdvisoryPanel's fallback sentence was English-only even
 * when preferredLanguage was "hi"/"ta"/"bn"/"mr" — a Hindi-preferring user
 * who hit a moment where the LLM cascade failed would silently see English.
 *
 * This mirrors lib/agent/advisoryText.ts's approach for the Civic AQI Alert
 * Agent: hand-written strings per language, not a live translation call,
 * because a *fallback* path must not itself depend on an external service.
 *
 * WHAT STAYS UNTRANSLATED
 * ------------------------
 * The AQI numeric value, the station name, and the formatted time label are
 * never translated — same "translate the wording, never the data" rule
 * used everywhere else in this app (chat system prompt, agent advisory
 * text). Only the category label, the guidance clause, and the sentence
 * structure around them change per language.
 *
 * Language codes match the app-wide onboarding picker exactly (en/hi/ta/bn/mr)
 * — see lib/localPreferences.ts and components/OnboardingModal.tsx.
 */

// ── AQI category band labels (must match lib/aqi.ts's SeverityBand.label
//    values exactly, used as the lookup key) ────────────────────────────────
const AQI_BAND_LABEL_TRANSLATIONS: Record<string, Record<string, string>> = {
    Good: {
        hi: "अच्छा",
        ta: "நல்லது",
        bn: "ভালো",
        mr: "चांगली",
    },
    Moderate: {
        hi: "मध्यम",
        ta: "மிதமான",
        bn: "মাঝারি",
        mr: "मध्यम",
    },
    "Unhealthy for Sensitive Groups": {
        hi: "संवेदनशील समूहों के लिए अस्वस्थ",
        ta: "பாதிக்கப்படக்கூடிய குழுக்களுக்கு தீங்கு விளைவிக்கும்",
        bn: "সংবেদনশীল গোষ্ঠীর জন্য অস্বাস্থ্যকর",
        mr: "संवेदनशील गटांसाठी अस्वास्थ्यकर",
    },
    Unhealthy: {
        hi: "अस्वस्थ",
        ta: "ஆரோக்கியமற்றது",
        bn: "অস্বাস্থ্যকর",
        mr: "अस्वास्थ्यकर",
    },
    "Very Unhealthy": {
        hi: "बहुत अस्वस्थ",
        ta: "மிகவும் ஆரோக்கியமற்றது",
        bn: "খুব অস্বাস্থ্যকর",
        mr: "अत्यंत अस्वास्थ्यकर",
    },
    Hazardous: {
        hi: "खतरनाक",
        ta: "அபாயகரமான",
        bn: "বিপজ্জনক",
        mr: "घातक",
    },
};

/** Translate an AQI band label (e.g. "Unhealthy"). Falls back to the English label if untranslated. */
export function translateAqiBandLabel(englishLabel: string, languageCode: string): string {
    if (languageCode === "en") return englishLabel;
    return AQI_BAND_LABEL_TRANSLATIONS[englishLabel]?.[languageCode] ?? englishLabel;
}

// ── Vulnerability-flag labels (must match AdvisoryPanel's FLAG_LABELS keys) ─
const FLAG_LABEL_TRANSLATIONS: Record<string, Record<string, string>> = {
    children: {
        hi: "बच्चों",
        ta: "குழந்தைகளுக்கு",
        bn: "শিশুদের",
        mr: "लहान मुलांसाठी",
    },
    elderly: {
        hi: "बुज़ुर्गों",
        ta: "முதியவர்களுக்கு",
        bn: "বয়স্কদের",
        mr: "वृद्धांसाठी",
    },
    asthma: {
        hi: "अस्थमा या सांस की समस्याओं वाले लोगों",
        ta: "ஆஸ்துமா அல்லது சுவாசப் பிரச்சினைகள் உள்ளவர்களுக்கு",
        bn: "হাঁপানি বা শ্বাসকষ্টের সমস্যাযুক্ত ব্যক্তিদের",
        mr: "दम्याचा किंवा श्वसनाच्या समस्या असलेल्या लोकांसाठी",
    },
};

// Language-specific "and" word for joining multiple flag labels.
const AND_WORD: Record<string, string> = {
    hi: "और",
    ta: "மற்றும்",
    bn: "এবং",
    mr: "आणि",
};

// "limit outdoor activity for {joined}" — {joined} is substituted in.
const GUIDANCE_FOR_FLAGS_TEMPLATE: Record<string, string> = {
    hi: "{joined} के लिए बाहरी गतिविधि सीमित करें",
    ta: "{joined} வெளிப்புற செயல்பாட்டைக் கட்டுப்படுத்துங்கள்",
    bn: "{joined} এর জন্য বাইরের কার্যকলাপ সীমিত করুন",
    mr: "{joined} घराबाहेरील क्रियाकलाप मर्यादित करा",
};

// "consider limiting prolonged outdoor exertion" — used when no flags are set.
const GENERIC_GUIDANCE: Record<string, string> = {
    hi: "लंबे समय तक बाहरी शारीरिक मेहनत सीमित करने पर विचार करें",
    ta: "நீண்ட நேர வெளிப்புற உடல் உழைப்பைக் கட்டுப்படுத்துவதைக் கருத்தில் கொள்ளுங்கள்",
    bn: "দীর্ঘ সময় ধরে বাইরের শারীরিক পরিশ্রম সীমিত করার কথা বিবেচনা করুন",
    mr: "दीर्घकाळ घराबाहेरील शारीरिक श्रम मर्यादित करण्याचा विचार करा",
};

/**
 * Language-aware equivalent of AdvisoryPanel's buildGuidanceClause(), for
 * non-English languages only -- AdvisoryPanel.tsx keeps its own English
 * copy for the "en" path and never calls this function in that case.
 * Same input contract (a list of known vulnerability flag keys).
 */
export function translateGuidanceClause(
    flags: string[] | undefined,
    languageCode: string
): string {
    const known = (flags ?? []).filter((f) => FLAG_LABEL_TRANSLATIONS[f]);

    if (known.length === 0) {
        return GENERIC_GUIDANCE[languageCode] ?? "consider limiting prolonged outdoor exertion";
    }

    const labels = known.map((f) => FLAG_LABEL_TRANSLATIONS[f][languageCode] ?? f);
    const and = AND_WORD[languageCode] ?? "and";
    const joined =
        labels.length === 1
            ? labels[0]
            : `${labels.slice(0, -1).join(", ")} ${and} ${labels[labels.length - 1]}`;

    const template = GUIDANCE_FOR_FLAGS_TEMPLATE[languageCode];
    return template ? template.replace("{joined}", joined) : `limit outdoor activity for ${joined}`;
}

// ── Full sentence templates ──────────────────────────────────────────────
// {categoryValue}/{station}/{time}/{guidance} are placeholder tokens.
// {categoryValue} stands in for the combined "'<category>' (<value>)" bold
// unit -- the English JSX already bolds category+value together as one
// span, so the template keeps that grouping instead of splitting it
// further. Kept as plain strings (not JSX) so AdvisoryPanel.tsx can parse
// the tokens and re-insert the same bold/colored spans it already renders
// for the English path -- see renderFallbackAdvisorySentence() below.
const SENTENCE_TEMPLATES: Record<string, string> = {
    hi: "AQI के {time} तक {station} के पास {categoryValue} तक पहुंचने की उम्मीद है — {guidance}।",
    ta: "{station} அருகில் {time} க்குள் AQI {categoryValue} ஐ அடையும் என எதிர்பார்க்கப்படுகிறது — {guidance}.",
    bn: "{station} এর কাছে {time} নাগাদ AQI {categoryValue} এ পৌঁছাবে বলে আশা করা হচ্ছে — {guidance}।",
    mr: "{station} जवळ {time} पर्यंत AQI {categoryValue} पर्यंत पोहोचण्याची अपेक्षा आहे — {guidance}.",
};

export type FallbackSentenceSegment =
    | { type: "text"; text: string }
    | { type: "categoryValue" }
    | { type: "station" }
    | { type: "time" }
    | { type: "guidance" };

const SEGMENT_TOKEN_PATTERN = /\{categoryValue\}|\{station\}|\{time\}|\{guidance\}/g;

/**
 * Parse a language's sentence template into an ordered list of segments
 * (plain text vs. named placeholder), so the caller can render each
 * placeholder as the same bold/colored span it already uses for English,
 * without needing per-language JSX. Returns null for "en" (or any language
 * without a template) so the caller renders its existing English JSX
 * unchanged.
 */
export function parseFallbackAdvisorySentence(languageCode: string): FallbackSentenceSegment[] | null {
    const template = SENTENCE_TEMPLATES[languageCode];
    if (!template) return null;

    const segments: FallbackSentenceSegment[] = [];
    let lastIndex = 0;

    for (const match of template.matchAll(SEGMENT_TOKEN_PATTERN)) {
        const index = match.index ?? 0;
        if (index > lastIndex) {
            segments.push({ type: "text", text: template.slice(lastIndex, index) });
        }
        const token = match[0];
        if (token === "{categoryValue}") segments.push({ type: "categoryValue" });
        else if (token === "{station}") segments.push({ type: "station" });
        else if (token === "{time}") segments.push({ type: "time" });
        else if (token === "{guidance}") segments.push({ type: "guidance" });
        lastIndex = index + token.length;
    }
    if (lastIndex < template.length) {
        segments.push({ type: "text", text: template.slice(lastIndex) });
    }

    return segments;
}

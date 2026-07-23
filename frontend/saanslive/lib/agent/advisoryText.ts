/**
 * lib/agent/advisoryText.ts — Static, hand-written per-language advisory
 * strings for the Civic AQI Alert Agent.
 *
 * The agent (aqiAlertAgent.ts) is deliberately deterministic -- no LLM call
 * in its decide/act loop, so its output is instant, free, and never subject
 * to a model outage on a scheduled job. That means it can't ask an LLM to
 * translate its advisory the way AdvisoryPanel's polish layer does.
 *
 * Instead, each of the 3 fixed alert levels has a real, hand-written string
 * per supported language below -- NOT a runtime/cascade translation of the
 * English fallback. This mirrors the same rule the hackathon plan set for
 * the advisory template fallback: "write those out directly, don't
 * cascade-translate a fallback path."
 *
 * Stored `agent_runs.advisories` rows always contain the English text (see
 * advisoryFor() in aqiAlertAgent.ts) -- that's the objective, storage-layer
 * record. This table is what the UI (AgentActivityLog.tsx) uses to display
 * the SAME alert level in the viewer's own preferred language, so a
 * language choice is respected here too, not just in AdvisoryPanel.
 *
 * Language codes match the app-wide onboarding picker exactly (en/hi/ta/bn/mr)
 * -- see lib/localPreferences.ts and components/OnboardingModal.tsx.
 */

import type { AlertLevel } from "./types";

export const AGENT_ADVISORY_TEXT: Record<AlertLevel, Record<string, string>> = {
    critical: {
        en: "Avoid prolonged outdoor activity where possible and follow local public-health guidance for sensitive groups.",
        hi: "जहाँ संभव हो, लंबे समय तक बाहरी गतिविधियों से बचें और संवेदनशील समूहों के लिए स्थानीय सार्वजनिक स्वास्थ्य मार्गदर्शन का पालन करें।",
        ta: "முடிந்தவரை நீண்ட நேர வெளிப்புற செயல்பாடுகளைத் தவிர்க்கவும், பாதிக்கப்படக்கூடிய குழுக்களுக்கான உள்ளூர் பொது சுகாதார வழிகாட்டுதலைப் பின்பற்றவும்.",
        bn: "যেখানে সম্ভব দীর্ঘ সময় ধরে বাইরের কার্যকলাপ এড়িয়ে চলুন এবং সংবেদনশীল গোষ্ঠীর জন্য স্থানীয় জনস্বাস্থ্য নির্দেশিকা অনুসরণ করুন।",
        mr: "शक्य असल्यास दीर्घकाळ घराबाहेरील क्रियाकलाप टाळा आणि संवेदनशील गटांसाठी स्थानिक सार्वजनिक आरोग्य मार्गदर्शनाचे पालन करा.",
    },
    high: {
        en: "Reduce prolonged outdoor exertion, especially for children, older adults, and people with respiratory conditions.",
        hi: "लंबे समय तक बाहरी शारीरिक मेहनत कम करें, खासकर बच्चों, बुजुर्गों और श्वास संबंधी समस्याओं वाले लोगों के लिए।",
        ta: "குழந்தைகள், முதியவர்கள் மற்றும் சுவாச பிரச்சினைகள் உள்ளவர்களுக்கு குறிப்பாக, நீண்ட நேர வெளிப்புற உடல் உழைப்பைக் குறைக்கவும்.",
        bn: "দীর্ঘ সময় ধরে বাইরের শারীরিক পরিশ্রম কমান, বিশেষত শিশু, বয়স্ক এবং শ্বাসকষ্টের সমস্যাযুক্ত ব্যক্তিদের জন্য।",
        mr: "विशेषतः लहान मुले, वृद्ध आणि श्वसनाचा त्रास असलेल्या लोकांसाठी, दीर्घकाळ घराबाहेरील शारीरिक श्रम कमी करा.",
    },
    elevated: {
        en: "Sensitive groups should limit prolonged outdoor exertion and check conditions again before heading out.",
        hi: "संवेदनशील समूहों को लंबे समय तक बाहरी मेहनत सीमित करनी चाहिए और बाहर जाने से पहले स्थिति की फिर से जांच करनी चाहिए।",
        ta: "பாதிக்கப்படக்கூடிய குழுக்கள் நீண்ட நேர வெளிப்புற உழைப்பைக் கட்டுப்படுத்தி, வெளியே செல்வதற்கு முன் நிலைமையை மீண்டும் சரிபார்க்க வேண்டும்.",
        bn: "সংবেদনশীল গোষ্ঠীর দীর্ঘ সময় ধরে বাইরের পরিশ্রম সীমিত করা উচিত এবং বাইরে যাওয়ার আগে পরিস্থিতি আবার পরীক্ষা করা উচিত।",
        mr: "संवेदनशील गटांनी दीर्घकाळ घराबाहेरील श्रम मर्यादित ठेवावेत आणि बाहेर जाण्यापूर्वी परिस्थिती पुन्हा तपासावी.",
    },
};

/**
 * Return the advisory text for an alert level in the given language.
 * Falls back to English if the language code isn't one of the hand-written
 * translations above -- never a blank string, never a runtime translation.
 */
export function getAgentAdvisoryText(level: AlertLevel, languageCode: string): string {
    const byLanguage = AGENT_ADVISORY_TEXT[level];
    return byLanguage[languageCode] ?? byLanguage.en;
}

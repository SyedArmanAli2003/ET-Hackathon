import Link from "next/link";

export const metadata = {
    title: "About — SaanSLive",
    description:
        "SaanSLive is a hyperlocal air quality forecasting app that predicts AQI 1-24h ahead using real sensor data, weather data, and gradient-boosted ML models.",
};

const TECH_STACK: { category: string; items: string[] }[] = [
    {
        category: "Frontend",
        items: ["Next.js 16 (App Router)", "React 19", "TypeScript", "Tailwind CSS", "Recharts", "React-Leaflet"],
    },
    {
        category: "Backend & Data",
        items: ["Supabase (Postgres, RLS)", "Python ingestion pipeline (pandas, SQLAlchemy)", "OpenAQ API v3 (PM2.5 readings)", "Open-Meteo API (weather)"],
    },
    {
        category: "Privacy",
        items: ["No account or sign-in required", "Preferences stored locally in your browser only"],
    },
    {
        category: "Machine Learning",
        items: ["XGBoost / LightGBM regressors", "Persistence baseline for model evaluation", "Feature engineering: AQI lags, rolling windows, weather, calendar effects"],
    },
    {
        category: "Automation",
        items: ["GitHub Actions (scheduled ingestion every 5h)"],
    },
];

export default function AboutPage() {
    return (
        <div className="min-h-screen bg-black text-white">
            <div className="max-w-3xl mx-auto px-6 py-16">
                <Link
                    href="/"
                    className="text-white/60 hover:text-white text-sm transition-colors"
                >
                    ← Back home
                </Link>

                <h1 className="text-4xl font-semibold mt-6 mb-4">About SaanSLive</h1>

                <p className="text-white/80 leading-relaxed mb-6">
                    SaanSLive turns hourly air quality monitoring data into 1&ndash;24 hour
                    AQI forecasts, so people can plan their day before the air quality
                    changes. It combines real PM2.5 sensor readings, weather data, and a
                    gradient-boosted machine learning model &mdash; benchmarked against a
                    simple persistence baseline to make sure every forecast actually adds
                    value over &quot;assume nothing changes&quot;.
                </p>

                <p className="text-white/80 leading-relaxed mb-10">
                    The project currently tracks monitoring stations across major Indian
                    cities, ingesting live data from OpenAQ and Open-Meteo on a recurring
                    schedule, and serving forecasts through a Supabase-backed API.
                </p>

                <h2 className="text-2xl font-semibold mb-4">Tech stack</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">
                    {TECH_STACK.map((group) => (
                        <div
                            key={group.category}
                            className="bg-white/5 border border-white/10 rounded-xl p-4"
                        >
                            <div className="text-white/60 text-xs uppercase tracking-wide mb-2">
                                {group.category}
                            </div>
                            <ul className="text-white/90 text-sm space-y-1">
                                {group.items.map((item) => (
                                    <li key={item}>{item}</li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>

                <h2 className="text-2xl font-semibold mb-4">Team</h2>
                <p className="text-white/70 leading-relaxed mb-10">
                    Built as a hackathon project.
                </p>

                <Link
                    href="/dashboard"
                    className="inline-block bg-[#e8702a] hover:bg-[#d2611f] text-white text-sm font-medium px-6 py-3 rounded-full transition-colors"
                >
                    View the forecast dashboard
                </Link>
            </div>
        </div>
    );
}

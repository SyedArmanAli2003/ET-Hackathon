import type { Forecast, Reading, Station } from "../lib/data";

type ForecastTrustPanelProps = {
    station: Station | null;
    currentReading: Reading | null;
    forecasts: Forecast[];
    loading?: boolean;
};

function ageLabel(iso: string | null) {
    if (!iso) return "Unavailable";
    const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
    if (ageMinutes < 60) return `${ageMinutes} min ago`;
    if (ageMinutes < 48 * 60) return `${Math.round(ageMinutes / 60)}h ago`;
    return `${Math.round(ageMinutes / (24 * 60))}d ago`;
}

function freshnessClass(iso: string | null) {
    if (!iso) return "text-white/40";
    const ageHours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
    if (ageHours <= 6) return "text-emerald-300";
    if (ageHours <= 18) return "text-amber-200";
    return "text-orange-200";
}

export default function ForecastTrustPanel({
    station,
    currentReading,
    forecasts,
    loading = false,
}: ForecastTrustPanelProps) {
    const newestForecast = forecasts.reduce<Forecast | null>(
        (newest, forecast) => !newest || new Date(forecast.created_at) > new Date(newest.created_at) ? forecast : newest,
        null
    );
    const validationForecast = forecasts.find(
        (forecast) => forecast.model_rmse != null && forecast.baseline_rmse != null && forecast.baseline_rmse > 0
    ) ?? null;
    const improvement = validationForecast
        ? ((validationForecast.baseline_rmse! - validationForecast.model_rmse!) / validationForecast.baseline_rmse!) * 100
        : null;

    if (loading) {
        return (
            <section className="bg-black/60 border border-white/10 rounded-2xl p-5 animate-pulse">
                <div className="h-5 w-36 rounded bg-white/10" />
                <div className="mt-4 grid grid-cols-2 gap-3">
                    <div className="h-16 rounded-xl bg-white/5" />
                    <div className="h-16 rounded-xl bg-white/5" />
                </div>
            </section>
        );
    }

    return (
        <section className="bg-black/60 border border-white/10 rounded-2xl p-5">
            <p className="text-[11px] uppercase tracking-[0.16em] text-cyan-200/80 font-semibold">Forecast transparency</p>
            <h2 className="mt-1 text-white font-semibold text-lg">Know what the plan uses</h2>
            <p className="mt-1 text-white/50 text-xs">
                {station ? `Live data checks for ${station.city}` : "Select a station to see data quality."}
            </p>

            <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-white/10 bg-white/[0.035] px-3 py-3">
                    <p className="text-[10px] uppercase tracking-widest text-white/40">Latest sensor</p>
                    <p className={`mt-1 text-sm font-medium ${freshnessClass(currentReading?.timestamp ?? null)}`} title={currentReading?.timestamp}>
                        {ageLabel(currentReading?.timestamp ?? null)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-white/35">
                        {currentReading ? `AQI ${Math.round(currentReading.aqi)}` : "No reading"}
                    </p>
                </div>
                <div className="rounded-xl border border-white/10 bg-white/[0.035] px-3 py-3">
                    <p className="text-[10px] uppercase tracking-widest text-white/40">Model run</p>
                    <p className={`mt-1 text-sm font-medium ${freshnessClass(newestForecast?.created_at ?? null)}`} title={newestForecast?.created_at}>
                        {ageLabel(newestForecast?.created_at ?? null)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-white/35">
                        {newestForecast ? `${newestForecast.model_version} · ${forecasts.length} points` : "Forecast pending"}
                    </p>
                </div>
            </div>

            <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.025] px-3 py-3">
                <p className="text-[10px] uppercase tracking-widest text-white/40">Validation against “no change” baseline</p>
                {validationForecast ? (
                    <p className="mt-1.5 text-sm leading-relaxed text-white/80">
                        Model RMSE {validationForecast.model_rmse!.toFixed(1)} vs. baseline {validationForecast.baseline_rmse!.toFixed(1)}
                        {improvement != null ? (
                            <span className={improvement >= 0 ? "text-emerald-300" : "text-orange-200"}>
                                {` · ${improvement >= 0 ? `${Math.abs(improvement).toFixed(0)}% lower error` : `${Math.abs(improvement).toFixed(0)}% higher error`}`}
                            </span>
                        ) : null}
                    </p>
                ) : (
                    <p className="mt-1.5 text-sm text-white/50">Validation metrics are not available for this forecast yet.</p>
                )}
                <p className="mt-1.5 text-[11px] leading-relaxed text-white/35">
                    The app surfaces missing or older data rather than presenting it as a fresh prediction.
                </p>
            </div>
        </section>
    );
}

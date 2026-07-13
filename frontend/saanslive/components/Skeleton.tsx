/**
 * Skeleton.tsx — Minimal reusable loading placeholder.
 *
 * Used by StationMap, ForecastChart, and AdvisoryPanel while their
 * respective Supabase queries are in flight, to avoid a flash of
 * empty/undefined content on first load.
 */

export function Skeleton({
    className = "",
    style,
}: {
    className?: string;
    style?: React.CSSProperties;
}) {
    return (
        <div
            className={`animate-pulse bg-white/10 rounded-lg ${className}`}
            style={style}
        />
    );
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
    return (
        <div className="space-y-2">
            {Array.from({ length: lines }).map((_, i) => (
                <Skeleton key={i} className={`h-4 ${i === lines - 1 ? "w-2/3" : "w-full"}`} />
            ))}
        </div>
    );
}

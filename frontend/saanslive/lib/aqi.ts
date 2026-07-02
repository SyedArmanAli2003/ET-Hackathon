export type SeverityBand = {
    min: number;
    max: number; // inclusive upper bound, or Infinity
    label: string;
    color: string;
    areaColor: string; // Used for charts
};

export const AQI_SEVERITY_BANDS: SeverityBand[] = [
    { min: 0, max: 50, label: "Good", color: "#2e7d32", areaColor: "rgba(46,125,50,0.12)" }, // green
    { min: 51, max: 100, label: "Moderate", color: "#f2c94c", areaColor: "rgba(242,201,76,0.16)" }, // yellow
    {
        min: 101,
        max: 150,
        label: "Unhealthy for Sensitive Groups",
        color: "#f2994a",
        areaColor: "rgba(242,153,74,0.18)"
    }, // orange
    { min: 151, max: 200, label: "Unhealthy", color: "#eb5757", areaColor: "rgba(235,87,87,0.18)" }, // red
    { min: 201, max: 300, label: "Very Unhealthy", color: "#9b51e0", areaColor: "rgba(155,81,224,0.18)" }, // purple
    { min: 301, max: Infinity, label: "Hazardous", color: "#6b1b24", areaColor: "rgba(107,27,36,0.18)" }, // maroon
];

export function getAqiBand(aqi: number): SeverityBand {
    return (
        AQI_SEVERITY_BANDS.find((b) => aqi >= b.min && aqi <= b.max) ??
        AQI_SEVERITY_BANDS[AQI_SEVERITY_BANDS.length - 1]
    );
}

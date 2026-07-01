import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SaanSLive — AI Air Quality Forecasting",
  description:
    "Hyperlocal 24–72h AQI forecasts powered by machine learning. Plan your day before the air quality changes.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

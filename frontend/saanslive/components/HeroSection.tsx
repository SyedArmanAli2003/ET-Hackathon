"use client";

import { useEffect, useRef, useState } from "react";
import { Menu, X, Wind, Brain, Bell, MapPin, ArrowRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getStations, getCurrentReading, type Station } from "../lib/data";
import { getAqiBand, type SeverityBand } from "../lib/aqi";

// ─────────────────────────────────────────────────────────────────────────────
// Asset image paths
// ─────────────────────────────────────────────────────────────────────────────
const BASE_IMAGE = "/smoggy_skyline.png";
const REVEAL_IMAGE = "/clear_skyline.png";
const SPOTLIGHT_R = 320;

// ─────────────────────────────────────────────────────────────────────────────
// RevealLayer — canvas-mask spotlight
// ─────────────────────────────────────────────────────────────────────────────
// PERF FIX (both issues below were the real source of the lag):
//   1. The old version drew a radial gradient onto a hidden <canvas> and
//      called canvas.toDataURL() every frame to build a CSS mask --
//      toDataURL() synchronously base64-encodes the whole canvas buffer,
//      one of the most expensive DOM operations available, run 60x/sec.
//   2. Cursor position was React state (setCursorPos), so every mousemove
//      tick re-rendered the ENTIRE HeroSection tree -- including
//      FeaturesSection, HowItWorksSection, CtaSection, Footer, and
//      LiveAqiStrip, none of which are memoized -- 60 times per second,
//      for a purely visual effect that never needed React reconciliation.
// Fix: RevealLayer now takes refs, not props, and the parent writes
// directly to the DOM inside the RAF loop via imperative style updates.
// No React state, no re-renders, no canvas encoding -- just GPU-composited
// CSS (mask-image position + transform), which is what this kind of
// pointer-follow effect should cost.
function RevealLayer({
  image,
  revealRef,
}: {
  image: string;
  revealRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      ref={revealRef}
      className="absolute inset-0 bg-center bg-cover bg-no-repeat z-30 pointer-events-none brightness-110 saturate-110"
      style={{
        backgroundImage: `url(${image})`,
        maskImage: `radial-gradient(circle ${SPOTLIGHT_R}px at -999px -999px, rgba(255,255,255,1) 0%, rgba(255,255,255,1) 35%, rgba(255,255,255,0.7) 60%, rgba(255,255,255,0.2) 80%, rgba(255,255,255,0) 100%)`,
        WebkitMaskImage: `radial-gradient(circle ${SPOTLIGHT_R}px at -999px -999px, rgba(255,255,255,1) 0%, rgba(255,255,255,1) 35%, rgba(255,255,255,0.7) 60%, rgba(255,255,255,0.2) 80%, rgba(255,255,255,0) 100%)`,
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Logo
// ─────────────────────────────────────────────────────────────────────────────
function LogoMark() {
  return (
    <svg width={26} height={26} viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="128" cy="128" r="52" fill="#ffffff" fillOpacity="0.9" />
      <circle cx="128" cy="128" r="36" fill="#e8702a" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <rect key={deg} x="124" y="14" width="8" height="28" rx="4" fill="#ffffff" fillOpacity="0.8" transform={`rotate(${deg} 128 128)`} />
      ))}
      <rect x="32" y="170" width="80" height="6" rx="3" fill="#ffffff" fillOpacity="0.4" />
      <rect x="48" y="184" width="60" height="5" rx="2.5" fill="#ffffff" fillOpacity="0.25" />
      <rect x="144" y="170" width="80" height="6" rx="3" fill="#ffffff" fillOpacity="0.4" />
      <rect x="148" y="184" width="60" height="5" rx="2.5" fill="#ffffff" fillOpacity="0.25" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Nav
// ─────────────────────────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { label: "Home", href: "/" },
  { label: "Dashboard", href: "/dashboard" },
  { label: "About", href: "/about" },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Live AQI cards — shown in a dedicated strip BELOW the hero
// ─────────────────────────────────────────────────────────────────────────────
// `band` is genuinely nullable: getAqiBand() itself never returns null, but
// this strip only calls it when a station actually has a current reading
// (aqi !== null). A city with no reading at all has no band to show, and
// the UI below already renders a "No data" fallback for that case -- the
// type must reflect that possibility instead of lying about it.
type CityAqi = { city: string; aqi: number | null; band: SeverityBand | null };

function LiveAqiStrip() {
  const [data, setData] = useState<CityAqi[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function fetch() {
      try {
        const s = await getStations();
        const topCities = ["Delhi", "Mumbai", "Bengaluru", "Chennai", "Kolkata"];
        const targets: Station[] = [];
        for (const city of topCities) {
          const st = s.find((st) => st.city === city);
          if (st) targets.push(st);
        }
        const results = await Promise.all(
          targets.map(async (st) => {
            const r = await getCurrentReading(st.id);
            const aqi = r?.aqi ?? null;
            return { city: st.city, aqi, band: aqi !== null ? getAqiBand(aqi) : null };
          })
        );
        if (!cancelled) setData(results);
      } catch { /* silently ignore */ }
    }
    fetch();
    return () => { cancelled = true; };
  }, []);

  if (data.length === 0) return null;

  return (
    <div className="w-full bg-[#0a0a0a] border-b border-white/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="text-white/60 text-xs font-semibold uppercase tracking-widest">Live air quality right now</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {data.map((item, i) => (
            <Link href="/dashboard" key={item.city}>
              <div
                className="group bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-2xl p-4 transition-all duration-300 cursor-pointer"
                style={{ animationDelay: `${i * 0.1}s` }}
              >
                <div className="text-white/50 text-[10px] font-bold uppercase tracking-widest mb-2">{item.city}</div>
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl font-bold text-white tracking-tighter leading-none">
                    {item.aqi !== null ? Math.round(item.aqi) : "—"}
                  </span>
                  {item.aqi !== null && <span className="text-[10px] font-semibold text-white/40">AQI</span>}
                </div>
                {item.band ? (
                  <div className="mt-2 flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: item.band.color, boxShadow: `0 0 6px ${item.band.color}` }} />
                    <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: item.band.color }}>
                      {item.band.label}
                    </span>
                  </div>
                ) : (
                  <div className="mt-2 text-white/30 text-[10px]">No data</div>
                )}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Features section
// ─────────────────────────────────────────────────────────────────────────────
const FEATURES = [
  {
    icon: Brain,
    title: "AI-Powered Forecasts",
    desc: "XGBoost models trained on real sensor data predict AQI up to 6 hours ahead. Re-trained automatically on every ingestion run.",
    color: "#e8702a",
  },
  {
    icon: MapPin,
    title: "Hyperlocal Coverage",
    desc: "29 active monitoring stations across 17 Indian cities. View color-coded AQI markers on an interactive map and click any to drill in.",
    color: "#3b82f6",
  },
  {
    icon: Wind,
    title: "Real-Time Ingestion",
    desc: "Data flows automatically from OpenAQ every 5 hours via a fault-isolated GitHub Actions pipeline — no manual intervention needed.",
    color: "#10b981",
  },
  {
    icon: Bell,
    title: "Personalized Advisories",
    desc: "Tell us if your household includes children, elderly, or people with asthma. Health guidance adapts to your actual vulnerabilities.",
    color: "#8b5cf6",
  },
];

function FeaturesSection() {
  return (
    <section className="w-full bg-[#050505] py-20 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-4 py-1.5 mb-4">
            <span className="text-white/60 text-xs font-semibold uppercase tracking-widest">What we do</span>
          </div>
          <h2 className="text-white text-3xl sm:text-4xl font-bold tracking-tight">
            Know the air before you step outside
          </h2>
          <p className="mt-4 text-white/50 text-sm sm:text-base max-w-xl mx-auto leading-relaxed">
            SaanSLive combines real sensor data, machine learning, and personalized health context into one clear, actionable dashboard.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="group bg-white/[0.03] hover:bg-white/[0.06] border border-white/10 hover:border-white/20 rounded-2xl p-6 transition-all duration-300"
            >
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
                style={{ backgroundColor: `${f.color}22`, border: `1px solid ${f.color}44` }}
              >
                <f.icon size={18} style={{ color: f.color }} />
              </div>
              <h3 className="text-white font-semibold text-base mb-2">{f.title}</h3>
              <p className="text-white/50 text-sm leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// How it works section
// ─────────────────────────────────────────────────────────────────────────────
const STEPS = [
  { num: "01", title: "Sensors collect PM2.5", desc: "Ground-level CPCB-grade sensors across India report hourly PM2.5 readings to OpenAQ." },
  { num: "02", title: "Pipeline ingests & enriches", desc: "Our GitHub Actions pipeline fetches readings, pairs them with weather data from Open-Meteo, and stores everything in Supabase." },
  { num: "03", title: "AI model predicts", desc: "An XGBoost model uses the enriched feature vector to predict AQI 6 hours ahead and writes it to the forecasts table." },
  { num: "04", title: "You see the future", desc: "The dashboard serves live data directly from Supabase — no caching lag, always the freshest reading and forecast available." },
];

function HowItWorksSection() {
  return (
    <section className="w-full bg-[#0a0a0a] border-t border-white/5 py-20 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-14">
          <div className="inline-flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-4 py-1.5 mb-4">
            <span className="text-white/60 text-xs font-semibold uppercase tracking-widest">The pipeline</span>
          </div>
          <h2 className="text-white text-3xl sm:text-4xl font-bold tracking-tight">How SaanSLive works</h2>
          <p className="mt-4 text-white/50 text-sm sm:text-base max-w-xl mx-auto leading-relaxed">
            From raw sensor readings to a personalized forecast — automated, fault-tolerant, and end-to-end.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {STEPS.map((step, i) => (
            <div key={step.num} className="relative">
              {i < STEPS.length - 1 && (
                <div className="hidden lg:block absolute top-6 left-[calc(100%+1px)] w-full h-px bg-gradient-to-r from-white/20 to-transparent z-10 pointer-events-none" />
              )}
              <div className="bg-white/[0.03] border border-white/10 rounded-2xl p-6 h-full">
                <div className="text-[#e8702a] text-xs font-bold uppercase tracking-widest mb-3">{step.num}</div>
                <h3 className="text-white font-semibold text-base mb-2">{step.title}</h3>
                <p className="text-white/50 text-sm leading-relaxed">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Final CTA section
// ─────────────────────────────────────────────────────────────────────────────
function CtaSection() {
  return (
    <section className="w-full bg-[#050505] border-t border-white/5 py-20 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto text-center">
        <h2 className="text-white text-3xl sm:text-5xl font-bold tracking-tight leading-tight">
          Breathe smarter.<br />
          <span className="text-[#e8702a]">Start now.</span>
        </h2>
        <p className="mt-6 text-white/50 text-sm sm:text-base max-w-lg mx-auto leading-relaxed">
          Check the live air quality index and 6-hour forecast for 17 Indian cities. Free, real-time, and built for everyone.
        </p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 bg-[#e8702a] hover:bg-[#d2611f] text-white font-semibold px-8 py-3.5 rounded-full transition-all hover:scale-[1.03] hover:shadow-xl hover:shadow-[#e8702a]/30 active:scale-95"
          >
            View Live Dashboard
            <ArrowRight size={16} />
          </Link>
          <Link
            href="/about"
            className="text-white/60 hover:text-white text-sm font-medium transition-colors px-6 py-3.5"
          >
            Learn more about the project →
          </Link>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer
// ─────────────────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer className="w-full bg-black border-t border-white/5 py-8 px-4 sm:px-6">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <LogoMark />
          <span className="text-white/80 text-sm font-semibold">SaanSLive</span>
        </div>
        <p className="text-white/30 text-xs">
          Data from OpenAQ · Forecasts by XGBoost · Built for ET Hackathon 2026
        </p>
        <div className="flex items-center gap-4">
          <Link href="/dashboard" className="text-white/40 hover:text-white/80 text-xs transition-colors">Dashboard</Link>
          <Link href="/about" className="text-white/40 hover:text-white/80 text-xs transition-colors">About</Link>
        </div>
      </div>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main HeroSection export
// ─────────────────────────────────────────────────────────────────────────────
export default function HeroSection() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mouseRef = useRef({ x: -999, y: -999 });
  const smoothRef = useRef({ x: -999, y: -999 });
  const rafRef = useRef<number | null>(null);
  const pathname = usePathname();

  // DOM refs the RAF loop writes to directly -- no React state, no
  // re-renders. See the PERF FIX note on RevealLayer above for why.
  const revealRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => { mouseRef.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener("mousemove", onMove);

    const loop = () => {
      smoothRef.current.x += (mouseRef.current.x - smoothRef.current.x) * 0.1;
      smoothRef.current.y += (mouseRef.current.y - smoothRef.current.y) * 0.1;
      const x = smoothRef.current.x;
      const y = smoothRef.current.y;

      if (revealRef.current) {
        const mask = `radial-gradient(circle ${SPOTLIGHT_R}px at ${x}px ${y}px, rgba(255,255,255,1) 0%, rgba(255,255,255,1) 35%, rgba(255,255,255,0.7) 60%, rgba(255,255,255,0.2) 80%, rgba(255,255,255,0) 100%)`;
        revealRef.current.style.maskImage = mask;
        revealRef.current.style.webkitMaskImage = mask;
      }
      if (glowRef.current) {
        glowRef.current.style.transform = `translate3d(${x - SPOTLIGHT_R}px, ${y - SPOTLIGHT_R}px, 0)`;
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#050505] tracking-[-0.02em]" style={{ fontFamily: "'Inter', sans-serif" }}>

      {/* ── Navigation ── */}
      <nav className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-between p-4 sm:p-5">
        <div className="flex items-center gap-2.5">
          <LogoMark />
          <span className="text-white text-xl font-semibold">SaanSLive</span>
        </div>

        <div className="hidden md:flex absolute left-1/2 -translate-x-1/2 bg-white/10 backdrop-blur-xl border border-white/20 rounded-full px-2 py-1.5 items-center gap-1">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.label}
                href={item.href}
                className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-200 ${active ? "bg-white/20 text-white shadow-sm" : "text-white/70 hover:bg-white/10 hover:text-white"}`}
              >
                {item.label}
              </Link>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="hidden md:block bg-white text-gray-900 text-sm font-semibold px-5 py-2 rounded-full hover:bg-gray-100 transition-colors">
            Get Started
          </Link>
          <button className="md:hidden text-white p-1" onClick={() => setMobileMenuOpen((v) => !v)} aria-label="Toggle menu">
            {mobileMenuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div className="fixed inset-x-0 top-16 z-[99] bg-black/90 backdrop-blur-xl border-t border-white/10 px-5 py-4 flex flex-col gap-1 md:hidden">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className="text-sm font-medium py-2.5 text-white/80 hover:text-white border-b border-white/10 last:border-0 transition-colors"
              onClick={() => setMobileMenuOpen(false)}
            >
              {item.label}
            </Link>
          ))}
          <Link href="/dashboard" className="mt-3 text-center bg-[#e8702a] text-white text-sm font-semibold px-6 py-3 rounded-full block">
            Get Started
          </Link>
        </div>
      )}

      {/* ── Hero ── */}
      <section className="relative w-full overflow-hidden bg-black" style={{ height: "100dvh" }}>
        {/* Base smoggy image — natural-looking darkness, not crushed */}
        <div
          className="absolute inset-0 z-10 bg-center bg-cover bg-no-repeat hero-zoom brightness-75 saturate-75"
          style={{ backgroundImage: `url(${BASE_IMAGE})` }}
        />

        {/* Cursor-revealed clear sky */}
        <RevealLayer image={REVEAL_IMAGE} revealRef={revealRef} />

        {/* Subtle vignette — darkens edges, not center */}
        <div
          className="absolute inset-0 z-35 pointer-events-none"
          style={{ background: "radial-gradient(ellipse at center, transparent 30%, rgba(0,0,0,0.55) 100%)" }}
        />

        {/* Orange glow that follows cursor.
            PERF FIX: was positioned with left/top (recalculated every RAF
            tick via mousemove) and driven by React state, forcing both a
            layout reflow AND a full component re-render every frame.
            translate3d is GPU-composited, and this div is now updated
            directly via ref inside the RAF loop -- no React re-render at
            all. The gradient already has a soft falloff built in, so the
            separate blur() filter (an expensive per-frame paint op at this
            size) was removed as redundant. */}
        <div
          ref={glowRef}
          className="absolute z-40 pointer-events-none rounded-full opacity-30 will-change-transform"
          style={{
            width: SPOTLIGHT_R * 2,
            height: SPOTLIGHT_R * 2,
            left: 0,
            top: 0,
            transform: `translate3d(${-SPOTLIGHT_R}px, ${-SPOTLIGHT_R}px, 0)`,
            background: "radial-gradient(circle, rgba(232,112,42,0.55) 0%, rgba(232,112,42,0.15) 45%, transparent 75%)",
            mixBlendMode: "screen",
          }}
        />

        {/* Hero text — centred */}
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center text-center px-5 pointer-events-none">
          {/* Badge */}
          <div className="hero-anim hero-fade inline-flex items-center gap-2 bg-white/10 backdrop-blur-md border border-white/20 rounded-full px-4 py-1.5 mb-6" style={{ animationDelay: "0.1s" }}>
            <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            <span className="text-white/80 text-xs font-semibold uppercase tracking-widest">Live air quality forecasting</span>
          </div>

          <h1 className="text-white leading-[0.95]">
            <span className="block font-playfair italic font-normal text-5xl sm:text-7xl md:text-8xl hero-anim hero-reveal" style={{ letterSpacing: "-0.04em", animationDelay: "0.25s" }}>
              See through
            </span>
            <span className="block font-bold text-5xl sm:text-7xl md:text-8xl -mt-1 hero-anim hero-reveal" style={{ letterSpacing: "-0.06em", animationDelay: "0.42s" }}>
              the smog.
            </span>
          </h1>

          <p className="mt-6 text-white/60 text-sm sm:text-base max-w-sm leading-relaxed hero-anim hero-fade" style={{ animationDelay: "0.6s" }}>
            AI-powered AQI forecasts for 17 Indian cities — personalized to your household.
          </p>

          <p className="mt-2 text-white/35 text-xs hero-anim hero-fade" style={{ animationDelay: "0.7s" }}>
            Move your cursor to reveal what the air could look like.
          </p>

          <div className="mt-8 flex flex-col sm:flex-row items-center gap-3 pointer-events-auto hero-anim hero-fade" style={{ animationDelay: "0.85s" }}>
            <Link
              href="/dashboard"
              className="flex items-center gap-2 bg-[#e8702a] hover:bg-[#d2611f] text-white text-sm font-semibold px-7 py-3 rounded-full transition-all hover:scale-[1.03] hover:shadow-xl hover:shadow-[#e8702a]/30 active:scale-95"
            >
              View Live Dashboard
              <ArrowRight size={15} />
            </Link>
            <Link href="/about" className="text-white/60 hover:text-white text-sm font-medium transition-colors px-4 py-3">
              How it works →
            </Link>
          </div>
        </div>

        {/* Scroll hint */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-1 hero-anim hero-fade" style={{ animationDelay: "1.2s" }}>
          <div className="text-white/30 text-[10px] uppercase tracking-widest">Scroll</div>
          <div className="w-px h-6 bg-gradient-to-b from-white/30 to-transparent animate-pulse" />
        </div>
      </section>

      {/* ── Below-the-fold sections ── */}
      <LiveAqiStrip />
      <FeaturesSection />
      <HowItWorksSection />
      <CtaSection />
      <Footer />
    </div>
  );
}

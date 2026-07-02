"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Menu, X } from "lucide-react";
import Link from "next/link";

// ─────────────────────────────────────────────────────────────────────────────
// Asset image paths — drop your own paths/URLs here
// ─────────────────────────────────────────────────────────────────────────────
const BASE_IMAGE = "/smoggy_skyline.png";   // hazy / smoggy version
const REVEAL_IMAGE = "/clear_skyline.png";    // clear blue-sky version

// Spotlight radius in pixels
const SPOTLIGHT_R = 260;

// ─────────────────────────────────────────────────────────────────────────────
// RevealLayer — draws a canvas mask and applies it to the clear-sky image
// ─────────────────────────────────────────────────────────────────────────────
function RevealLayer({
  image,
  cursorX,
  cursorY,
}: {
  image: string;
  cursorX: number;
  cursorY: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const revealRef = useRef<HTMLDivElement>(null);

  // Size canvas to window on mount + resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Redraw mask on every render
  useEffect(() => {
    const canvas = canvasRef.current;
    const reveal = revealRef.current;
    if (!canvas || !reveal) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Build a radial gradient that fades from opaque centre → transparent edge
    const grad = ctx.createRadialGradient(
      cursorX, cursorY, 0,
      cursorX, cursorY, SPOTLIGHT_R,
    );
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.4, "rgba(255,255,255,1)");
    grad.addColorStop(0.6, "rgba(255,255,255,0.75)");
    grad.addColorStop(0.75, "rgba(255,255,255,0.4)");
    grad.addColorStop(0.88, "rgba(255,255,255,0.12)");
    grad.addColorStop(1, "rgba(255,255,255,0)");

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cursorX, cursorY, SPOTLIGHT_R, 0, Math.PI * 2);
    ctx.fill();

    // Apply canvas as CSS mask on the reveal div
    const dataUrl = canvas.toDataURL();
    reveal.style.maskImage = `url(${dataUrl})`;
    reveal.style.webkitMaskImage = `url(${dataUrl})`;
    reveal.style.maskSize = "100% 100%";
    reveal.style.webkitMaskSize = "100% 100%";
  });

  return (
    <>
      {/* Hidden canvas used only to generate the mask data URL */}
      <canvas
        ref={canvasRef}
        style={{ display: "none" }}
        className="absolute inset-0 pointer-events-none"
      />

      {/* Clear-sky image, masked by the canvas spotlight */}
      <div
        ref={revealRef}
        className="absolute inset-0 bg-center bg-cover bg-no-repeat z-30 pointer-events-none"
        style={{ backgroundImage: `url(${image})` }}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Nav logo SVG
// ─────────────────────────────────────────────────────────────────────────────
function LogoMark() {
  return (
    <svg
      width={26}
      height={26}
      viewBox="0 0 256 256"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Abstract air-quality / sun-through-haze mark */}
      <circle cx="128" cy="128" r="52" fill="#ffffff" fillOpacity="0.9" />
      <circle cx="128" cy="128" r="36" fill="#e8702a" />
      {/* Rays */}
      {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
        <rect
          key={deg}
          x="124"
          y="14"
          width="8"
          height="28"
          rx="4"
          fill="#ffffff"
          fillOpacity="0.8"
          transform={`rotate(${deg} 128 128)`}
        />
      ))}
      {/* Haze streaks */}
      <rect x="32" y="170" width="80" height="6" rx="3" fill="#ffffff" fillOpacity="0.4" />
      <rect x="48" y="184" width="60" height="5" rx="2.5" fill="#ffffff" fillOpacity="0.25" />
      <rect x="144" y="170" width="80" height="6" rx="3" fill="#ffffff" fillOpacity="0.4" />
      <rect x="148" y="184" width="60" height="5" rx="2.5" fill="#ffffff" fillOpacity="0.25" />
    </svg>
  );
}

/* Main HeroSection component */
// ─────────────────────────────────────────────────────────────────────────────
export default function HeroSection() {
  const [cursorPos, setCursorPos] = useState({ x: -999, y: -999 });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mouseRef = useRef({ x: -999, y: -999 });
  const smoothRef = useRef({ x: -999, y: -999 });
  const rafRef = useRef<number | null>(null);

  // Smoothed cursor tracking with RAF
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("mousemove", onMove);

    const loop = () => {
      smoothRef.current.x += (mouseRef.current.x - smoothRef.current.x) * 0.1;
      smoothRef.current.y += (mouseRef.current.y - smoothRef.current.y) * 0.1;
      setCursorPos({ x: smoothRef.current.x, y: smoothRef.current.y });
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener("mousemove", onMove);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div
      className="min-h-screen bg-white tracking-[-0.02em]"
      style={{ fontFamily: "'Inter', sans-serif" }}
    >
      {/* ── Navigation ──────────────────────────────────────────────────────── */}
      <nav className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-between p-4 sm:p-5">
        {/* Left: logo + wordmark */}
        <div className="flex items-center gap-2.5">
          <LogoMark />
          <span className="text-white text-2xl font-playfair italic">
            SaanSLive
          </span>
        </div>

        {/* Center pill — desktop only */}
        <div className="hidden md:flex absolute left-1/2 -translate-x-1/2 bg-white/20 backdrop-blur-md border border-white/30 rounded-full px-2 py-2 items-center gap-1">
          {(["Forecast", "Map", "Health Advisory", "About"] as const).map((item) => (
            <button
              key={item}
              className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${item === "Forecast"
                ? "bg-white/30 text-white"
                : "text-white/80 hover:bg-white/20 hover:text-white"
                }`}
            >
              {item}
            </button>
          ))}
        </div>

        {/* Right: desktop CTA + mobile menu toggle */}
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="hidden md:block bg-white text-gray-900 text-sm font-semibold px-6 py-2.5 rounded-full hover:bg-gray-100 transition-colors">
            Get Started
          </Link>
          <button
            className="md:hidden text-white p-1"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </nav>

      {/* Mobile menu */}
      {mobileMenuOpen && (
        <div className="fixed inset-x-0 top-16 z-[99] bg-black/80 backdrop-blur-md border-t border-white/10 px-5 py-4 flex flex-col gap-2 md:hidden">
          {["Forecast", "Map", "Health Advisory", "About"].map((item) => (
            <button
              key={item}
              className="text-white/90 text-sm font-medium py-2.5 text-left border-b border-white/10 last:border-0 hover:text-white transition-colors"
              onClick={() => setMobileMenuOpen(false)}
            >
              {item}
            </button>
          ))}
          <Link href="/dashboard" className="mt-2 text-center bg-[#e8702a] text-white text-sm font-semibold px-6 py-3 rounded-full w-full block">
            Get Started
          </Link>
        </div>
      )}

      {/* ── Hero Section ────────────────────────────────────────────────────── */}
      <section
        className="relative w-full overflow-hidden h-screen bg-black"
        style={{ height: "100dvh" }}
      >
        {/* Layer 1 (z-10): base smoggy image */}
        <div
          className="absolute inset-0 z-10 bg-center bg-cover bg-no-repeat hero-zoom"
          style={{ backgroundImage: `url(${BASE_IMAGE})` }}
        />

        {/* Layer 2 (z-30): cursor-revealed clear-sky image */}
        <RevealLayer
          image={REVEAL_IMAGE}
          cursorX={cursorPos.x}
          cursorY={cursorPos.y}
        />

        {/* Subtle dark overlay for text legibility */}
        <div className="absolute inset-0 z-40 bg-black/30 pointer-events-none" />

        {/* Layer 3 (z-50): main heading */}
        <div className="absolute top-[14%] left-0 right-0 z-50 flex flex-col items-center text-center px-5 pointer-events-none">
          <h1 className="text-white leading-[0.95]">
            <span
              className="block font-playfair italic font-normal text-5xl sm:text-7xl md:text-8xl hero-anim hero-reveal"
              style={{ letterSpacing: "-0.05em", animationDelay: "0.25s" }}
            >
              See through
            </span>
            <span
              className="block font-normal text-5xl sm:text-7xl md:text-8xl -mt-1 hero-anim hero-reveal"
              style={{ letterSpacing: "-0.08em", animationDelay: "0.42s" }}
            >
              the smog.
            </span>
          </h1>

          {/* Sub-hint */}
          <p
            className="mt-6 text-white/60 text-sm font-light hero-anim hero-fade"
            style={{ animationDelay: "0.65s" }}
          >
            Move your cursor to reveal what the air could look like.
          </p>
        </div>

        {/* Layer 4 (z-50): bottom-left paragraph */}
        <div
          className="hidden sm:block absolute bottom-14 left-10 md:left-14 z-50 max-w-[260px] hero-anim hero-fade"
          style={{ animationDelay: "0.7s" }}
        >
          <p className="text-sm text-white/80 leading-relaxed">
            Every hour of monitoring data becomes a 24–72 hour forecast, so you can
            plan your day before the air quality changes.
          </p>
        </div>

        {/* Layer 5 (z-50): bottom-right block */}
        <div
          className="absolute bottom-10 sm:bottom-24 left-5 right-5 sm:left-auto sm:right-10 md:right-14 z-50 max-w-full sm:max-w-[260px] flex flex-col items-start gap-4 sm:gap-5 hero-anim hero-fade"
          style={{ animationDelay: "0.85s" }}
        >
          <p className="text-xs sm:text-sm text-white/80 leading-relaxed">
            Hyperlocal predictions and personalized health advisories for
            families, elderly residents, and anyone who needs to know what&apos;s
            coming.
          </p>
          <Link href="/dashboard" className="bg-[#e8702a] hover:bg-[#d2611f] text-white text-sm font-medium px-7 py-3 rounded-full transition-all hover:scale-[1.03] active:scale-95 hover:shadow-lg hover:shadow-[#e8702a]/30">
            View Forecast
          </Link>
        </div>
      </section>
    </div>
  );
}

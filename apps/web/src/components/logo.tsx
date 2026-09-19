"use client";

// ============================================
// DENGARKAN — Official Logo Component
// "dengar" (white) + "kan." (neon green #39FF14)
// ============================================

import React from "react";

interface LogoProps {
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function Logo({ className = "", size = "md" }: LogoProps) {
  const heights = {
    sm: "h-6",
    md: "h-8",
    lg: "h-12",
  };

  return (
    <div className={`inline-flex items-center select-none ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.png"
        alt="dengarkan."
        className={`${heights[size]} w-auto object-contain`}
        onError={(e) => {
          // If image fails, fallback to typography
          (e.currentTarget as HTMLElement).style.display = "none";
          const fallback = (e.currentTarget.nextElementSibling as HTMLElement);
          if (fallback) fallback.style.display = "flex";
        }}
      />
      <div className="hidden items-center font-extrabold tracking-tight text-xl">
        <span className="text-white">dengar</span>
        <span className="text-[#39FF14]">kan.</span>
      </div>
    </div>
  );
}

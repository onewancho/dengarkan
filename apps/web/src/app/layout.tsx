import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/features/auth/provider";
import { ToastProvider } from "@/features/ui/toast";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Dengarkan — Putar Musik & Podcast YouTube-mu tanpa batas",
  description:
    "Aplikasi audio YouTube sederhana, cepat, ringan, dan nyaman digunakan satu tangan. Putar musik dan podcast tanpa video bloat.",
  manifest: undefined, // Explicitly no manifest — NOT a standalone PWA
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="id" className={`${inter.variable} bg-black text-white`}>
      <body className="antialiased bg-black text-white min-h-dvh">
        <AuthProvider>
          <ToastProvider>
            {children}
          </ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}

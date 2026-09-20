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
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              if (typeof window !== 'undefined' && location.protocol === 'http:' && location.hostname !== 'localhost' && !/^(\\d{1,3}\\.){3}\\d{1,3}$/.test(location.hostname)) {
                location.replace('https://' + location.host + location.pathname + location.search + location.hash);
              }
            `,
          }}
        />
      </head>
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

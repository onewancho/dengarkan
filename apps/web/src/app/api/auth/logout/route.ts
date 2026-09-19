// ============================================
// DENGARKAN — Next.js Route Handler: Logout
//
// Guarantees session_token deletion directly on
// the Next.js origin server (192.168.1.74:3000)
// and notifies Fastify backend.
// ============================================

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export async function POST() {
  const cookieStore = await cookies();
  const token = cookieStore.get("session_token")?.value;

  // 1. Invalidate session in Fastify backend (non-fatal if backend down)
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  if (token) {
    try {
      await fetch(`${apiUrl}/api/auth/logout`, {
        method: "POST",
        headers: {
          Cookie: `session_token=${token}`,
        },
      });
    } catch {
      // Backend error is non-fatal; we must still clear the client cookie
    }
  }

  // 2. Clear cookie directly on the Next.js origin
  const response = NextResponse.json({ message: "Logged out successfully" });

  response.cookies.set("session_token", "", {
    path: "/",
    maxAge: 0,
    expires: new Date(0),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}

// ============================================
// DENGARKAN — Root Redirector (/)
// Server-side redirect to /app if session exists, else /login.
// Zero client-side waiting or hydration delay.
// ============================================

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function RootPage() {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("session_token");

  if (sessionToken?.value) {
    redirect("/app");
  } else {
    redirect("/login");
  }
}

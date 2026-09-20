// ============================================
// DENGARKAN — Root Redirector (/)
// Server-side redirect to /app if session exists, else /login.
// Zero client-side waiting or hydration delay.
// ============================================

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const headerList = await headers();
  const host = headerList.get("host") || "";
  const proto = headerList.get("x-forwarded-proto");

  const isLocalOrIp =
    host.includes("localhost") ||
    host.includes("127.0.0.1") ||
    /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(host);

  // If accessed via plain HTTP on a public domain, redirect to HTTPS
  if (!isLocalOrIp && proto === "http") {
    redirect(`https://${host}/`);
  }

  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("session_token");

  if (sessionToken?.value) {
    redirect("/app");
  } else {
    redirect("/login");
  }

  return null;
}


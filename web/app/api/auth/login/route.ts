import { NextResponse } from "next/server";
import { findUserByUsername } from "@/lib/auth-model";
import { verifyPassword } from "@/lib/password";
import { createAuthSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// Simple in-memory rate limiter for login (per IP). Resets on server restart,
// which is acceptable for a single-kiosk local dashboard.
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

function getIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0].trim();
    if (first) return first;
  }
  return "local";
}

export async function POST(req: Request) {
  const ip = getIp(req);
  const now = Date.now();
  const rec = attempts.get(ip);
  if (rec && rec.resetAt > now && rec.count >= MAX_ATTEMPTS) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again shortly." },
      { status: 429, headers: { ...NO_CACHE, "Retry-After": String(Math.ceil((rec.resetAt - now) / 1000)) } }
    );
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400, headers: NO_CACHE });
  }

  const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) {
    return NextResponse.json({ error: "Username and password are required." }, { status: 400, headers: NO_CACHE });
  }

  const user = await findUserByUsername(username);
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;

  // Register attempt (rate limiting) regardless of success to prevent brute force.
  if (rec && rec.resetAt > now) {
    rec.count += 1;
  } else {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  }

  if (!user || !valid) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401, headers: NO_CACHE });
  }

  await createAuthSession({ _id: user._id, username: user.username, role: user.role });

  return NextResponse.json(
    { ok: true, user: { _id: user._id, username: user.username, role: user.role } },
    { headers: NO_CACHE }
  );
}

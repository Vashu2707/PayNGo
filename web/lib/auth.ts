import { cookies } from "next/headers";
import crypto from "crypto";
import {
  createSession,
  findSessionByTokenHash,
  deleteSession,
  type User,
} from "./auth-model";

const SESSION_COOKIE = "payngo_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_COOKIE_NAME = SESSION_COOKIE;

/**
 * Session store. The cookie holds a 256-bit random token; only its SHA-256 hash
 * is persisted in MongoDB. This means a database leak does not expose usable
 * session tokens (defence in depth beyond httpOnly + TLS).
 */

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export async function getSessionUser(): Promise<Omit<User, "passwordHash"> | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await findSessionByTokenHash(hashToken(token));
  if (!session) return null;
  return { _id: session.userId, username: session.username, role: session.role, createdAt: new Date(0) };
}

export async function createAuthSession(
  user: { _id: string; username: string; role: string }
): Promise<void> {
  const token = generateToken();
  await createSession(user, token, hashToken(token), SESSION_TTL_MS);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function destroyAuthSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await deleteSession(hashToken(token));
    store.delete(SESSION_COOKIE);
  }
}

export async function requireAuth(): Promise<Omit<User, "passwordHash">> {
  const user = await getSessionUser();
  if (!user) {
    throw new Error("Not authenticated");
  }
  return user;
}

/** Reads session from a Request (server-side route protection). */
export async function getSessionFromRequest(req: Request) {
  const cookieHeader = req.headers.get("cookie") ?? "";
  const cookiesArr = cookieHeader.split(";").map((c) => c.trim());
  const found = cookiesArr.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!found) return null;
  const token = found.slice(SESSION_COOKIE_NAME.length + 1);
  if (!token) return null;
  const session = await findSessionByTokenHash(hashToken(token));
  return session;
}

export { SESSION_COOKIE, SESSION_COOKIE_NAME, SESSION_TTL_MS };

import { NextResponse, type NextRequest } from "next/server";

const PROTECTED_PREFIXES = ["/dashboard", "/checkout"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Skip API routes here — they do their own auth checks (some, like the
  // webhook, deliberately use signature auth instead of a session cookie).
  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const isProtected = PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (!isProtected) {
    return NextResponse.next();
  }

  const sessionCookie = req.cookies.get("payngo_session")?.value;
  if (!sessionCookie) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Lightweight presence check only; the authoritative validation happens in
  // the page/api by hitting MongoDB. This avoids a DB call on every request.
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/checkout/:path*"],
};

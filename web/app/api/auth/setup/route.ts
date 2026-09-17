import { NextResponse } from "next/server";
import { UserModel, createUser } from "@/lib/auth-model";
import { connectToDatabase } from "@/lib/mongodb";
import { hashPassword } from "@/lib/password";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/**
 * First-run setup: creates the owner account.
 * This is ONLY allowed when the users collection is empty (no account exists),
 * which means once the owner is created, this endpoint is permanently locked.
 * This prevents unauthenticated account creation.
 */
export async function POST(req: Request) {
  await connectToDatabase();
  const userCount = await UserModel.countDocuments();
  if (userCount > 0) {
    return NextResponse.json(
      { error: "Setup already complete. Accounts are managed from the dashboard." },
      { status: 403, headers: NO_CACHE }
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

  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
    return NextResponse.json(
      { error: "Username must be 3-32 chars (letters, numbers, ., _, -)." },
      { status: 400, headers: NO_CACHE }
    );
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400, headers: NO_CACHE });
  }

  const passwordHash = await hashPassword(password);
  const user = await createUser(username, passwordHash, "owner");

  return NextResponse.json(
    { ok: true, user: { _id: user._id, username: user.username, role: user.role } },
    { status: 201, headers: NO_CACHE }
  );
}

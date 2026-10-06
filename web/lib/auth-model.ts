import mongoose, { Schema, model, models, type InferSchemaType, type Model } from "mongoose";
import { connectToDatabase } from "./mongodb";

const userSchema = new Schema(
  {
    username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 32 },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["owner"], default: "owner" },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "users" }
);

export interface User {
  _id: string;
  username: string;
  passwordHash: string;
  role: "owner";
  createdAt: Date;
}

type UserDoc = InferSchemaType<typeof userSchema>;
const userModelCtor = models.User as Model<UserDoc> | undefined;
const UserModel: Model<UserDoc> = userModelCtor ?? model<UserDoc>("User", userSchema);

/** Session record persisted in MongoDB, keyed by a cryptographically-random token. */
const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    username: { type: String, required: true },
    role: { type: String, enum: ["owner"], required: true },
    expiresAt: { type: Date, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "sessions" }
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

type SessionDoc = InferSchemaType<typeof sessionSchema>;
const sessionModelCtor = models.Session as Model<SessionDoc> | undefined;
const SessionModel: Model<SessionDoc> =
  sessionModelCtor ?? model<SessionDoc>("Session", sessionSchema);

export async function createUser(username: string, passwordHash: string, role: User["role"] = "owner"): Promise<User> {
  await connectToDatabase();
  const doc = await UserModel.create({ username, passwordHash, role });
  return {
    _id: String(doc._id),
    username: doc.username,
    passwordHash: doc.passwordHash,
    role: doc.role,
    createdAt: doc.createdAt,
  };
}

export async function findUserByUsername(username: string): Promise<User | null> {
  await connectToDatabase();
  const doc = await UserModel.findOne({ username }).lean();
  if (!doc) return null;
  return {
    _id: String(doc._id),
    username: doc.username,
    passwordHash: doc.passwordHash,
    role: doc.role,
    createdAt: doc.createdAt,
  };
}

export async function createSession(
  user: { _id: string; username: string; role: string },
  token: string,
  tokenHash: string,
  ttlMs: number
): Promise<void> {
  await connectToDatabase();
  await SessionModel.create({
    tokenHash,
    userId: user._id,
    username: user.username,
    role: user.role,
    expiresAt: new Date(Date.now() + ttlMs),
  });
}

export async function findSessionByTokenHash(tokenHash: string) {
  await connectToDatabase();
  const doc = await SessionModel.findOne({ tokenHash }).lean();
  if (!doc) return null;
  if (doc.expiresAt && new Date(doc.expiresAt).getTime() < Date.now()) {
    await SessionModel.deleteOne({ tokenHash });
    return null;
  }
  return {
    userId: String(doc.userId),
    username: doc.username,
    role: doc.role,
    expiresAt: doc.expiresAt,
  };
}

export async function deleteSession(tokenHash: string): Promise<void> {
  await connectToDatabase();
  await SessionModel.deleteOne({ tokenHash });
}

export async function deleteAllSessionsForUser(userId: string): Promise<void> {
  await connectToDatabase();
  await SessionModel.deleteMany({ userId });
}

export { UserModel };

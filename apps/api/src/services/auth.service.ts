import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env";
import { HttpError } from "../lib/http";
import { prisma } from "../lib/prisma";

let googleClient: OAuth2Client | null = null;
function getGoogleClient(): OAuth2Client {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new HttpError(400, "Google sign-in is not configured on this server");
  }
  googleClient ??= new OAuth2Client(env.GOOGLE_CLIENT_ID);
  return googleClient;
}

export async function signup(input: { name: string; email: string; password: string }) {
  const existing = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (existing) {
    throw new HttpError(409, "Email is already registered");
  }

  const passwordHash = await bcrypt.hash(input.password, 12);
  const user = await prisma.user.create({
    data: {
      name: input.name,
      email: input.email.toLowerCase(),
      passwordHash,
      walletCredits: 30
    }
  });

  return withToken(user);
}

export async function login(input: { email: string; password: string }) {
  const user = await prisma.user.findUnique({ where: { email: input.email.toLowerCase() } });
  if (!user) {
    throw new HttpError(401, "Invalid email or password");
  }

  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) {
    throw new HttpError(401, "Invalid email or password");
  }

  return withToken(user);
}

export async function googleLogin(input: { credential: string }) {
  const client = getGoogleClient();
  const audience = env.GOOGLE_CLIENT_ID as string; // getGoogleClient() guarantees this is set
  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken: input.credential, audience });
    payload = ticket.getPayload();
  } catch {
    throw new HttpError(401, "Could not verify Google sign-in");
  }
  if (!payload?.email || !payload.email_verified) {
    throw new HttpError(401, "Google account email is not available or unverified");
  }

  const email = payload.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return withToken(existing);
  }

  // First Google sign-in: create the account. No password is set, so a random unusable
  // hash is stored (password login stays disabled until the user resets it) — this avoids
  // a schema migration to make passwordHash nullable.
  const passwordHash = await bcrypt.hash(`google:${randomBytes(24).toString("hex")}`, 12);
  const user = await prisma.user.create({
    data: {
      name: payload.name || email.split("@")[0] || "Creator",
      email,
      passwordHash,
      walletCredits: 30
    }
  });
  return withToken(user);
}

function withToken(user: { id: string; name: string; email: string; walletCredits: number }) {
  const token = jwt.sign({ sub: user.id, email: user.email }, env.JWT_SECRET, { expiresIn: "7d" });
  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      walletCredits: user.walletCredits
    }
  };
}

import { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://reelforge:reelforge@localhost:5432/reelforge?schema=public";

declare global {
  // eslint-disable-next-line no-var
  var __reelforgePrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__reelforgePrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__reelforgePrisma = prisma;
}

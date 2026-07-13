import { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://kimera:kimera@localhost:5432/kimera?schema=public";

declare global {
  // eslint-disable-next-line no-var
  var __kimeraPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__kimeraPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__kimeraPrisma = prisma;
}

import { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://orreris:orreris@localhost:5432/orreris?schema=public";

declare global {
  // eslint-disable-next-line no-var
  var __orrerisPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__orrerisPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__orrerisPrisma = prisma;
}

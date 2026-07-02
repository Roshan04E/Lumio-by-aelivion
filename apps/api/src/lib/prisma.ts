import { PrismaClient } from "@prisma/client";

process.env.DATABASE_URL ??= "postgresql://lumio:lumio@localhost:5432/lumio?schema=public";

declare global {
  // eslint-disable-next-line no-var
  var __lumioPrisma: PrismaClient | undefined;
}

export const prisma = globalThis.__lumioPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__lumioPrisma = prisma;
}

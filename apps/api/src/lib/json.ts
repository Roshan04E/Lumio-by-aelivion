import type { Prisma } from "@prisma/client";

export function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function fromJson<T>(value: unknown): T {
  return value as T;
}

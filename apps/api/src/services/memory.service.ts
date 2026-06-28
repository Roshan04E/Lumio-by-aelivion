import { prisma } from "../lib/prisma";
import { asJson } from "../lib/json";

/**
 * Phase 11 — AI Memory OS persistence. Stores small, reusable signals (a "fact"
 * per row), tiered by `scope`. Re-observing a fact compounds its confidence and
 * refreshes recency, so a habit the creator repeats becomes a strong default and
 * a one-off stays weak. Never stores raw prompts — only distilled values.
 */

export type MemoryScope = "creator" | "project" | "style";

export interface MemoryFactInput {
  scope: MemoryScope;
  projectId?: string | null | undefined;
  key: string;
  value: unknown;
  confidence?: number | undefined;
  source?: "inferred" | "explicit" | undefined;
}

export interface MemoryFactRecord {
  id: string;
  scope: string;
  projectId: string | null;
  key: string;
  value: unknown;
  confidence: number;
  source: string;
  lastUsedAt: string;
  updatedAt: string;
}

function serialize(row: {
  id: string;
  scope: string;
  projectId: string;
  key: string;
  value: unknown;
  confidence: number;
  source: string;
  lastUsedAt: Date;
  updatedAt: Date;
}): MemoryFactRecord {
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.projectId || null,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    source: row.source,
    lastUsedAt: row.lastUsedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Creator facts plus (optionally) the active project's facts. */
export async function listFacts(userId: string, projectId?: string): Promise<MemoryFactRecord[]> {
  const rows = await prisma.memoryFact.findMany({
    where: {
      userId,
      OR: [{ scope: "creator" }, { scope: "style" }, ...(projectId ? [{ scope: "project", projectId }] : [])]
    },
    orderBy: [{ confidence: "desc" }, { lastUsedAt: "desc" }]
  });
  return rows.map(serialize);
}

/**
 * Upsert a batch with the confidence merge: a re-observed fact climbs toward 1
 * (`+ (1 - c) * 0.3`); an explicit user statement pins it to ≥ 0.9. New facts
 * start at their requested confidence (default 0.5).
 */
export async function upsertFacts(userId: string, facts: MemoryFactInput[]): Promise<MemoryFactRecord[]> {
  const out: MemoryFactRecord[] = [];
  for (const fact of facts) {
    const projectId = fact.scope === "project" ? fact.projectId ?? "" : "";
    const explicit = fact.source === "explicit";
    const existing = await prisma.memoryFact.findUnique({
      where: { userId_scope_projectId_key: { userId, scope: fact.scope, projectId, key: fact.key } }
    });

    const baseConfidence = fact.confidence ?? 0.5;
    const nextConfidence = existing
      ? explicit
        ? Math.max(0.9, existing.confidence)
        : Math.min(1, existing.confidence + (1 - existing.confidence) * 0.3)
      : explicit
        ? Math.max(0.9, baseConfidence)
        : baseConfidence;

    const row = await prisma.memoryFact.upsert({
      where: { userId_scope_projectId_key: { userId, scope: fact.scope, projectId, key: fact.key } },
      create: {
        userId,
        scope: fact.scope,
        projectId,
        key: fact.key,
        value: asJson(fact.value),
        confidence: nextConfidence,
        source: explicit ? "explicit" : "inferred"
      },
      update: {
        value: asJson(fact.value),
        confidence: nextConfidence,
        lastUsedAt: new Date(),
        ...(explicit ? { source: "explicit" } : {})
      }
    });
    out.push(serialize(row));
  }
  return out;
}

/** Delete one fact (Memory Panel "forget"); scoped to the owner. */
export async function deleteFact(userId: string, id: string): Promise<boolean> {
  const result = await prisma.memoryFact.deleteMany({ where: { id, userId } });
  return result.count > 0;
}

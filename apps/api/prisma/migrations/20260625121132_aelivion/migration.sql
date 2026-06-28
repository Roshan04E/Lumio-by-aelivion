-- CreateTable
CREATE TABLE "MemoryFact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT '',
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "source" TEXT NOT NULL DEFAULT 'inferred',
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemoryFact_userId_scope_idx" ON "MemoryFact"("userId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryFact_userId_scope_projectId_key_key" ON "MemoryFact"("userId", "scope", "projectId", "key");

-- AddForeignKey
ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "WalletTransaction" ADD COLUMN     "action" TEXT,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "providerCost" DOUBLE PRECISION,
ADD COLUMN     "shadow" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "unit" TEXT,
ADD COLUMN     "units" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "WalletTransaction_userId_createdAt_idx" ON "WalletTransaction"("userId", "createdAt");

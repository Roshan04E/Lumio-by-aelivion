-- CreateTable
CREATE TABLE "PluginPackage" (
    "id" TEXT NOT NULL,
    "manifestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT,
    "authorName" TEXT,
    "licenseType" TEXT,
    "tags" JSONB NOT NULL,
    "category" TEXT,
    "thumbnail" TEXT,
    "preview" TEXT,
    "packageUrl" TEXT,
    "manifest" JSONB NOT NULL,
    "packageJson" JSONB,
    "compatibility" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PluginPackage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PluginPackage_manifestId_key" ON "PluginPackage"("manifestId");

-- CreateIndex
CREATE INDEX "PluginPackage_kind_active_published_idx" ON "PluginPackage"("kind", "active", "published");

-- CreateIndex
CREATE INDEX "PluginPackage_updatedAt_idx" ON "PluginPackage"("updatedAt");

-- AddForeignKey
ALTER TABLE "PluginPackage" ADD CONSTRAINT "PluginPackage_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

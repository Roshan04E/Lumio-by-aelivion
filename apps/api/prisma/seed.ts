import bcrypt from "bcryptjs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parsePluginManifest, templateDefinitions, toolDefinitions } from "@kimera-by-aelivion/shared";
import { prisma } from "../src/lib/prisma";
import { asJson } from "../src/lib/json";

async function main() {
  const passwordHash = await bcrypt.hash("password123", 12);

  const demoUser = await prisma.user.upsert({
    where: { email: "demo@aelivion.studio" },
    update: {
      name: "Demo Creator",
      walletCredits: 120
    },
    create: {
      name: "Demo Creator",
      email: "demo@aelivion.studio",
      passwordHash,
      walletCredits: 120
    }
  });

  await prisma.walletTransaction.upsert({
    where: { id: "seed_demo_wallet_credit" },
    update: {},
    create: {
      id: "seed_demo_wallet_credit",
      userId: demoUser.id,
      type: "credit",
      credits: 120,
      reason: "Seed demo balance"
    }
  });

  for (const template of templateDefinitions) {
    await prisma.template.upsert({
      where: { slug: template.slug },
      update: {
        name: template.name,
        category: template.category,
        description: template.description,
        previewUrl: template.previewUrl,
        thumbnailUrl: template.thumbnailUrl,
        durationSeconds: template.durationSeconds,
        requiredModules: asJson(template.requiredModules),
        editableFields: asJson(template.editableFields),
        templateGraph: asJson(template.templateGraph),
        active: template.active
      },
      create: {
        id: template.id,
        name: template.name,
        slug: template.slug,
        category: template.category,
        description: template.description,
        previewUrl: template.previewUrl,
        thumbnailUrl: template.thumbnailUrl,
        durationSeconds: template.durationSeconds,
        requiredModules: asJson(template.requiredModules),
        editableFields: asJson(template.editableFields),
        templateGraph: asJson(template.templateGraph),
        active: template.active
      }
    });
  }

  for (const tool of toolDefinitions) {
    await prisma.tool.upsert({
      where: { slug: tool.slug },
      update: {
        name: tool.name,
        description: tool.description,
        moduleType: tool.moduleType,
        steps: asJson(tool.steps),
        creditCost: tool.creditCost,
        bestFor: tool.bestFor,
        active: true
      },
      create: {
        id: tool.id,
        name: tool.name,
        slug: tool.slug,
        description: tool.description,
        moduleType: tool.moduleType,
        steps: asJson(tool.steps),
        creditCost: tool.creditCost,
        bestFor: tool.bestFor,
        active: true
      }
    });
  }

  const pluginManifestDirCandidates = [
    path.resolve(process.cwd(), "examples/plugin-manifests"),
    path.resolve(process.cwd(), "../../examples/plugin-manifests")
  ];
  const pluginManifestDir = pluginManifestDirCandidates.find((candidate) => existsSync(candidate)) ?? pluginManifestDirCandidates[0]!;
  for (const fileName of ["soft-bloom.effect.json", "warm-cinema.look.json"]) {
    const manifest = parsePluginManifest(JSON.parse(readFileSync(path.join(pluginManifestDir, fileName), "utf8")));
    await prisma.pluginPackage.upsert({
      where: { manifestId: manifest.id },
      update: {
        kind: manifest.kind,
        schemaVersion: manifest.schemaVersion,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? null,
        authorName: manifest.author?.name ?? null,
        licenseType: manifest.license?.type ?? null,
        tags: asJson(manifest.tags),
        category: manifest.category ?? null,
        thumbnail: manifest.thumbnail ?? null,
        preview: manifest.preview ?? null,
        manifest: asJson(manifest),
        compatibility: asJson(manifest.compatibility),
        active: true,
        published: true,
        createdById: demoUser.id
      },
      create: {
        manifestId: manifest.id,
        kind: manifest.kind,
        schemaVersion: manifest.schemaVersion,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description ?? null,
        authorName: manifest.author?.name ?? null,
        licenseType: manifest.license?.type ?? null,
        tags: asJson(manifest.tags),
        category: manifest.category ?? null,
        thumbnail: manifest.thumbnail ?? null,
        preview: manifest.preview ?? null,
        manifest: asJson(manifest),
        compatibility: asJson(manifest.compatibility),
        active: true,
        published: true,
        createdById: demoUser.id
      }
    });
  }

  console.log("Seed complete: 1 demo user, 8 templates, 5 tools, 2 plugin packages");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import bcrypt from "bcryptjs";
import { templateDefinitions, toolDefinitions } from "@reelforge/shared";
import { prisma } from "../src/lib/prisma";
import { asJson } from "../src/lib/json";

async function main() {
  const passwordHash = await bcrypt.hash("password123", 12);

  const demoUser = await prisma.user.upsert({
    where: { email: "demo@reelforge.studio" },
    update: {
      name: "Demo Creator",
      walletCredits: 120
    },
    create: {
      name: "Demo Creator",
      email: "demo@reelforge.studio",
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

  console.log("Seed complete: 1 demo user, 8 templates, 5 tools");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

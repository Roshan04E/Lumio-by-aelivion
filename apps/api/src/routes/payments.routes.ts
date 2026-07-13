import { Router } from "express";
import { createOrderSchema, verifyPaymentSchema, walletPacks } from "@kimera-by-aelivion/shared";
import { asyncHandler, ok, validateBody } from "../lib/http";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { createMockOrder, verifyMockPayment } from "../services/payment.service";

export const paymentsRouter = Router();

paymentsRouter.get(
  "/packs",
  asyncHandler(async (_req, res) => ok(res, "Credit packs", { packs: walletPacks }))
);

paymentsRouter.post(
  "/create-order",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const input = validateBody(createOrderSchema, req.body);
    const order = await createMockOrder({ ...input, userId: req.user.id });
    return ok(res, "Mock order created", order, 201);
  })
);

paymentsRouter.post(
  "/verify",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const input = validateBody(verifyPaymentSchema, req.body);
    const payment = await verifyMockPayment({
      userId: req.user.id,
      paymentId: input.paymentId,
      providerPaymentId: input.providerPaymentId ?? "mock_provider_payment"
    });
    return ok(res, "Payment verified", { payment });
  })
);

/**
 * Phase 0 shadow-billing readout — MONETIZATION_STRATEGY.md §4. Recent `type:"usage"` rows +
 * per-action aggregates for the account/checkout "usage this month (free during beta)" panel.
 * Read-only telemetry: never returns/implies a debit against walletCredits.
 */
paymentsRouter.get(
  "/usage",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rows = await prisma.walletTransaction.findMany({
      where: { userId: req.user.id, type: "usage", createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: 200
    });

    const totalShadowCredits = rows.reduce((sum, row) => sum + row.credits, 0);
    const byAction = new Map<string, { action: string; units: number; credits: number; count: number }>();
    for (const row of rows) {
      const action = row.action ?? "unknown";
      const entry = byAction.get(action) ?? { action, units: 0, credits: 0, count: 0 };
      entry.units += row.units ?? 0;
      entry.credits += row.credits;
      entry.count += 1;
      byAction.set(action, entry);
    }

    return ok(res, "Usage this period (free during beta)", {
      rows,
      totalShadowCredits,
      byAction: [...byAction.values()].sort((a, b) => b.credits - a.credits),
      periodStart: since.toISOString()
    });
  })
);

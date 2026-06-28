import { Router } from "express";
import { createOrderSchema, verifyPaymentSchema, walletPacks } from "@reelforge/shared";
import { asyncHandler, ok, validateBody } from "../lib/http";
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

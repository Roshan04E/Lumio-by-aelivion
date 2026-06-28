import { walletPacks } from "@reelforge/shared";
import { HttpError } from "../lib/http";
import { prisma } from "../lib/prisma";

export async function createMockOrder(input: {
  packId: "starter" | "creator" | "growth";
  userId: string;
  projectId?: string | undefined;
}) {
  const pack = walletPacks.find((item) => item.id === input.packId);
  if (!pack) {
    throw new HttpError(404, "Credit pack not found");
  }

  const payment = await prisma.payment.create({
    data: {
      userId: input.userId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      amount: pack.priceInr,
      credits: pack.credits,
      provider: "mock",
      providerOrderId: `order_mock_${Date.now()}`,
      status: "created"
    }
  });

  return {
    payment,
    pack,
    checkout: {
      provider: "mock",
      message: "Use verify endpoint to complete this local test payment."
    }
  };
}

export async function verifyMockPayment(input: { userId: string; paymentId: string; providerPaymentId: string }) {
  const payment = await prisma.payment.findFirst({
    where: { id: input.paymentId, userId: input.userId }
  });

  if (!payment) {
    throw new HttpError(404, "Payment not found");
  }

  if (payment.status === "paid") {
    return payment;
  }

  const result = await prisma.$transaction(async (tx) => {
    const paid = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "paid",
        providerPaymentId: input.providerPaymentId
      }
    });

    await tx.user.update({
      where: { id: input.userId },
      data: { walletCredits: { increment: payment.credits } }
    });

    await tx.walletTransaction.create({
      data: {
        userId: input.userId,
        type: "credit",
        credits: payment.credits,
        reason: `Purchased ${payment.credits} credits`
      }
    });

    return paid;
  });

  return result;
}

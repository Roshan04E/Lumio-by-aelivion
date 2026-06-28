import { Router } from "express";
import { googleAuthSchema, loginSchema, signupSchema } from "@reelforge/shared";
import { asyncHandler, ok, validateBody } from "../lib/http";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { googleLogin, login, signup } from "../services/auth.service";
import { prisma } from "../lib/prisma";

export const authRouter = Router();

authRouter.post(
  "/signup",
  asyncHandler(async (req, res) => {
    const input = validateBody(signupSchema, req.body);
    const data = await signup(input);
    return ok(res, "Signed up", data, 201);
  })
);

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const input = validateBody(loginSchema, req.body);
    const data = await login(input);
    return ok(res, "Logged in", data);
  })
);

authRouter.post(
  "/google",
  asyncHandler(async (req, res) => {
    const input = validateBody(googleAuthSchema, req.body);
    const data = await googleLogin(input);
    return ok(res, "Logged in with Google", data);
  })
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler<AuthRequest>(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, email: true, walletCredits: true, createdAt: true }
    });
    return ok(res, "Current user", { user });
  })
);

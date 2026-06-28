import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { HttpError } from "../lib/http";
import { prisma } from "../lib/prisma";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthRequest extends Request {
  user: AuthUser;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

    if (!token) {
      throw new HttpError(401, "Authentication required");
    }

    const payload = jwt.verify(token, env.JWT_SECRET) as { sub: string };
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true }
    });

    if (!user) {
      throw new HttpError(401, "User not found");
    }

    (req as AuthRequest).user = user;
    next();
  } catch (error) {
    next(error instanceof HttpError ? error : new HttpError(401, "Invalid or expired token"));
  }
}

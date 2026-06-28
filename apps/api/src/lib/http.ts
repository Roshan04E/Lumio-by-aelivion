import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";

export class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function ok<T>(res: Response, message: string, data: T, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data
  });
}

export function asyncHandler<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req as T, res, next)).catch(next);
  };
}

export function validateBody<T>(schema: ZodSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues.at(0);
    throw new HttpError(400, issue?.message ?? "Invalid request body");
  }
  return parsed.data;
}

export function getParam(req: Request, key: string): string {
  const value = req.params[key];
  if (!value || Array.isArray(value)) {
    throw new HttpError(400, `Missing route parameter: ${key}`);
  }
  return value;
}

import type { MiddlewareHandler } from "hono";
import { getPrismaClient } from "@attendance/db";
import type { AppEnv } from "../types";

export const prismaMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const prisma = getPrismaClient({ DB: c.env.DB });
  c.set("prisma", prisma);
  await next();
};

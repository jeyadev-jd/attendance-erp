import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Role } from "@attendance/db";
import type { AppEnv } from "../types";

export const roleGuard = (...allowed: Role[]): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const user = c.get("user");
    if (!allowed.includes(user.role)) {
      throw new HTTPException(403, { message: "Insufficient role for this action" });
    }
    await next();
  };
};

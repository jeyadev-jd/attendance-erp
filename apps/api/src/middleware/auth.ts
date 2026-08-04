import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { verifyJwt } from "../lib/jwt";
import type { AppEnv, JwtPayload } from "../types";

export const jwtMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Missing or malformed Authorization header" });
  }
  const token = authHeader.slice("Bearer ".length);
  const payload = await verifyJwt<JwtPayload>(token, c.env.JWT_SECRET);
  if (!payload) {
    throw new HTTPException(401, { message: "Invalid or expired token" });
  }
  c.set("user", payload);
  await next();
};

/** Blocks all routes except password-change until the user completes first-login setup. */
export const requirePasswordChanged: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (user.mustChangePassword) {
    throw new HTTPException(403, { message: "Password change required before continuing" });
  }
  await next();
};

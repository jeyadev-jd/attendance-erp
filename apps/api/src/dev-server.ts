// Local-only entrypoint: runs the Hono app on plain Node instead of wrangler/workerd,
// since workerd's sandbox has no raw TCP and can't run the `pg` driver used for local Postgres.
// Use `npm run dev -w apps/api` (wrangler) once back on the Neon adapter for prod-like testing.
import "dotenv/config";
import { serve } from "@hono/node-server";
import app from "./index";

const env = {
  DATABASE_URL: process.env.DATABASE_URL!,
  JWT_SECRET: process.env.JWT_SECRET!,
  JWT_EXPIRY_SECONDS: process.env.JWT_EXPIRY_SECONDS!,
  SMTP_HOST: process.env.SMTP_HOST!,
  SMTP_PORT: process.env.SMTP_PORT!,
  SMTP_USER: process.env.SMTP_USER!,
  SMTP_PASS: process.env.SMTP_PASS!,
  OTP_TTL_MINUTES: process.env.OTP_TTL_MINUTES!,
  TEMP_STUDENT_PASSWORD: process.env.TEMP_STUDENT_PASSWORD!,
};

serve(
  {
    fetch: (request) => app.fetch(request, env as never),
    port: 8787,
  },
  (info) => console.log(`Local dev API (Node, no workerd) on http://localhost:${info.port}`)
);

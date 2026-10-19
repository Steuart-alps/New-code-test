import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";

const PgSession = connectPgSimple(session);

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set.");
}

export const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: "sessions",
    createTableIfMissing: false,
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // Sessions expire after 30 minutes of inactivity (Steuart, 2026-10-19:
  // more secure, and long enough to scan documents for upload). `rolling:
  // true` refreshes the expiry on every request, so active users stay signed
  // in, and the web app keeps the session alive while an upload is running;
  // after 30 idle minutes the session is gone and the next API call returns
  // 401, which the web client turns into an automatic redirect to the login page.
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 30, // 30 minutes of inactivity
    sameSite: "lax",
  },
});

declare module "express-session" {
  interface SessionData {
    userId: number;
    csrfToken?: string;
    // The department a Manager with several is working in (see loadUser).
    activeDepartmentId?: number;
  }
}

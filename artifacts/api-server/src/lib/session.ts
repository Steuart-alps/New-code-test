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
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    sameSite: process.env.NODE_ENV === "production" ? "strict" : "lax",
  },
});

declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}

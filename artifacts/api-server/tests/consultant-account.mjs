// Sign-up makes the person their business's Owner (client_admin). Suites that
// need a consultant (an adviser who looks after several businesses) sign up
// as usual and then promote that account here, linking it to its own
// business the way consultant-created businesses are linked.
import { execFileSync } from "node:child_process";

export function promoteToConsultant(email) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required to make a test consultant");
  execFileSync("psql", [databaseUrl, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", `email=${email}`], {
    input: `
      UPDATE users SET role = 'consultant' WHERE lower(email) = lower(:'email');
      INSERT INTO consultant_clients (user_id, client_id)
        SELECT id, client_id FROM users
        WHERE lower(email) = lower(:'email') AND client_id IS NOT NULL
        ON CONFLICT DO NOTHING;
    `,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });
}

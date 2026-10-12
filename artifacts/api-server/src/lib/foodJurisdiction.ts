import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type Executor = Pick<typeof db, "execute">;

/**
 * KitchenTrack jurisdiction used when no food_jurisdiction setting is saved:
 * the nation in the Compliance Hub profile when it is Scotland, otherwise
 * England/Wales (also for Northern Ireland and multi-nation profiles, which
 * have no KitchenTrack jurisdiction of their own yet).
 */
export async function defaultFoodJurisdiction(
  clientId: number,
  executor: Executor = db,
): Promise<"scotland" | "england_wales"> {
  const result = await executor.execute(sql`SELECT nation FROM compliance_profiles WHERE client_id = ${clientId} LIMIT 1`);
  const nation = (result.rows as Array<{ nation: string | null }>)[0]?.nation;
  return nation === "scotland" ? "scotland" : "england_wales";
}

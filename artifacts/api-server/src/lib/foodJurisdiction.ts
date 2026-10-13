import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type Executor = Pick<typeof db, "execute">;

/**
 * KitchenTrack jurisdiction used when no food_jurisdiction setting is saved:
 * the nation in the Compliance Hub profile when it is Scotland or Northern
 * Ireland, otherwise England/Wales (also for multi-nation profiles).
 */
export async function defaultFoodJurisdiction(
  clientId: number,
  executor: Executor = db,
): Promise<"scotland" | "england_wales" | "northern_ireland"> {
  const result = await executor.execute(sql`SELECT nation FROM compliance_profiles WHERE client_id = ${clientId} LIMIT 1`);
  const nation = (result.rows as Array<{ nation: string | null }>)[0]?.nation;
  if (nation === "scotland" || nation === "northern_ireland") return nation;
  return "england_wales";
}

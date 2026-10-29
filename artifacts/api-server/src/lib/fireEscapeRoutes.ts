/**
 * Each site's escape routes, e.g. "Final fire exit door route 1" or "Escape
 * stairway 2". Managers list them once; every escape route sign-off and night
 * fire walk then ticks each route clear, obstructed or blocked, so a walk
 * can't leave one out. The list is kept in app_settings under
 * `site.<id>.fire_escape_routes`. Before routes were set per site there was
 * one business-wide list (`fire_escape_routes`): a site with no list of its
 * own still uses that one ("shared").
 */
import { db } from "@workspace/db";
import { appSettingsTable } from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

export const ESCAPE_ROUTES_KEY = "fire_escape_routes";

export interface EscapeRoute {
  name: string;
  location: string | null;
}

export const escapeRouteListSchema = z.array(z.object({
  name: z.string().trim().min(1, "Give each route a name").max(200),
  location: z.string().trim().max(200).nullable().optional().transform(value => value || null),
}).strict()).max(100, "A site can have up to 100 escape routes");

export function siteEscapeRoutesKey(siteId: number | null): string {
  return siteId == null ? ESCAPE_ROUTES_KEY : `site.${siteId}.${ESCAPE_ROUTES_KEY}`;
}

function parseRoutes(value: string | null | undefined): EscapeRoute[] | null {
  if (value == null) return null;
  if (!value.trim()) return [];
  try {
    const raw = JSON.parse(value);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((route: unknown) => {
      const name = typeof (route as { name?: unknown })?.name === "string" ? (route as { name: string }).name.trim() : "";
      const location = (route as { location?: unknown })?.location;
      return name ? [{ name, location: typeof location === "string" && location.trim() ? location.trim() : null }] : [];
    });
  } catch {
    return [];
  }
}

/** The site's routes, or the business-wide list when the site has none of its own. */
export async function loadEscapeRoutes(clientId: number, siteId: number | null): Promise<{ routes: EscapeRoute[]; shared: boolean }> {
  const keys = [...new Set([siteEscapeRoutesKey(siteId), ESCAPE_ROUTES_KEY])];
  const rows = await db.select({ key: appSettingsTable.key, value: appSettingsTable.value }).from(appSettingsTable)
    .where(and(eq(appSettingsTable.clientId, clientId), inArray(appSettingsTable.key, keys)));
  const own = parseRoutes(rows.find(row => row.key === siteEscapeRoutesKey(siteId))?.value);
  if (own) return { routes: own, shared: false };
  const shared = parseRoutes(rows.find(row => row.key === ESCAPE_ROUTES_KEY)?.value) ?? [];
  return { routes: shared, shared: shared.length > 0 };
}

export async function saveEscapeRoutes(clientId: number, siteId: number | null, routes: EscapeRoute[]): Promise<void> {
  const key = siteEscapeRoutesKey(siteId);
  const value = JSON.stringify(routes);
  await db.insert(appSettingsTable).values({ clientId, key, value })
    .onConflictDoUpdate({ target: [appSettingsTable.clientId, appSettingsTable.key], set: { value, updatedAt: new Date() } });
}

/** Two routes may not share a name (ignoring case), or a walk couldn't tell them apart. */
export function duplicateRouteName(routes: EscapeRoute[]): string | null {
  const seen = new Set<string>();
  for (const route of routes) {
    const key = route.name.toLowerCase();
    if (seen.has(key)) return route.name;
    seen.add(key);
  }
  return null;
}

export const ROUTE_STATUSES = ["clear", "obstructed", "blocked"] as const;

/** A fire walk's notes: each route's answer plus free notes (the web form's JSON). */
const walkNotesSchema = z.object({
  _type: z.literal("fire_walk"),
  routes: z.array(z.object({
    name: z.string(),
    status: z.enum(ROUTE_STATUSES),
    note: z.string().max(1000).optional().default(""),
  }).passthrough()).max(100),
  freeNotes: z.string().max(5000).optional().default(""),
}).passthrough();

export type WalkNotes = z.infer<typeof walkNotesSchema>;

export function parseWalkNotes(notes: string | null | undefined): WalkNotes | null {
  if (!notes) return null;
  try {
    const parsed = walkNotesSchema.safeParse(JSON.parse(notes));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Checks a fire walk's answers against the routes it must cover: every route
 * answered once and no others. Returns the walk's notes, or an error. A walk
 * with nothing to cover (no routes listed) may still list routes or none.
 */
export function checkWalkRoutes(notes: string | null | undefined, required: string[]): { walk: WalkNotes | null } | { error: string } {
  const walk = parseWalkNotes(notes);
  if (!required.length) return { walk };
  if (!walk) return { error: "Mark each escape route clear, obstructed or blocked" };
  const answered = walk.routes.map(route => route.name.trim().toLowerCase());
  const wanted = required.map(name => name.trim().toLowerCase());
  const missing = required.filter((name, index) => !answered.includes(wanted[index]));
  if (missing.length) return { error: `Mark every escape route: ${missing.join(", ")} not answered` };
  if (answered.length !== wanted.length || answered.some(name => !wanted.includes(name))) {
    return { error: "Only the site's listed escape routes can be signed off. A manager can change the list in the Template." };
  }
  return { walk };
}

/** Any route not clear makes the walk a fail. */
export function walkFound(walk: WalkNotes | null): boolean {
  return Boolean(walk?.routes.some(route => route.status !== "clear"));
}

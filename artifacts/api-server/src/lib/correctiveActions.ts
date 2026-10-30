import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { parseWalkNotes } from "./fireEscapeRoutes";
import { FIRE_LABELS, LEGIONELLA_LABELS, POOL_LABELS, TUB_LABELS } from "./checkReminders";
import { moduleFor } from "./dailyChecklistItems";
import { kitchenWeeklyNeedsAttention } from "@workspace/api-zod/kitchen-weekly";
import type { SignedRouteMatch } from "./recordSignatures";
import { legionellaBreachForNewCheck } from "../routes/legionella";
import { hotTubBreachForNewCheck } from "../routes/hot-tub";

/**
 * A fail on any track must say what was done about it. When a recorded check
 * is saved from the web app with something failed, and the form has not
 * already said what was done, the save is answered 428
 * CORRECTIVE_ACTION_REQUIRED with the list of what failed. The app asks for a
 * corrective action against each one, then sends the same save again with the
 * answers in the X-Corrective-Actions header (middleware/correctiveActionGate.ts).
 *
 * Once the record is saved, each answer goes on the open action the fail
 * raised on its track (the database triggers and the checklist routes already
 * raise one), as the remedial action taken. Where the track raised none, one
 * is opened. The failed observation itself is never changed.
 *
 * Only the saves that are signed (lib/recordSignatures.ts) are asked, at the
 * moment they are signed: a draft is asked when it is submitted. KitchenTrack's
 * diary (food safety) and CoSHH checks already ask on their own forms.
 */

export const CORRECTIVE_ACTIONS_HEADER = "x-corrective-actions";
export const CORRECTIVE_ACTION_REQUIRED_CODE = "CORRECTIVE_ACTION_REQUIRED";
export const CORRECTIVE_ACTION_MIN_LENGTH = 3;
export const CORRECTIVE_ACTION_MAX_LENGTH = 1000;

export type Failure = {
  /** Stable within one save; the answer is sent back under this key. */
  key: string;
  /** What failed, in words the person recognises. */
  label: string;
  /** The source_kind of the track action this fail raises or should raise. */
  sourceKind: string;
  /** What the form already said was done, if anything: then nothing is asked. */
  given?: string | null;
  /** The form already raised its own action for this (nothing is asked or recorded). */
  answered?: boolean;
};

type Rule = {
  method: "POST" | "PUT";
  path: RegExp;
  /** Track action module, for an action this opens itself. */
  module: string | ((body: Record<string, unknown>, stored: Record<string, unknown> | null, path: string) => string);
  failures: (body: Record<string, unknown>, ctx: { clientId: number; stored: Record<string, unknown> | null; path: string }) => Promise<Failure[]> | Failure[];
  /**
   * The record the track's own action hangs off, when it is not the saved
   * record (a bike hire's check). Read from the save's JSON response.
   */
  actionRecordId?: (response: any) => unknown;
  /** Drafts submitted by PUT may not resend every answer: read the stored row. */
  readsStored?: boolean;
};

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const humanise = (key: string) => {
  const words = key.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
const failedIf = (condition: boolean, failure: Failure): Failure[] => (condition ? [failure] : []);

/** Checklist items answered Fail, each with its own action (lib/dailyChecklistItems.ts). */
function failedItems(items: unknown, prefix: string, labelKey: "label" | "question"): Failure[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item, index) => {
    if (!item || typeof item !== "object" || (item as Record<string, unknown>).result !== "fail") return [];
    const label = text((item as Record<string, unknown>)[labelKey]) || `Item ${index + 1}`;
    return [{ key: `item:${index}`, label, sourceKind: `${prefix}:${index}` }];
  });
}

function failedTicks(source: Record<string, unknown>, labels: Record<string, string>, sourceKind: string): Failure[] {
  return Object.entries(labels).flatMap(([field, label]) =>
    failedIf(source[field] === false || source[field] === "fail", { key: field, label, sourceKind }));
}

const BIKE_ITEMS: Record<string, string> = {
  brakesFront: "Front brake", brakesRear: "Rear brake", tyreFront: "Front tyre", tyreRear: "Rear tyre",
  chainGears: "Chain and gears", lightsFront: "Front light", lightsRear: "Rear light", frame: "Frame",
  saddleSeatpost: "Saddle and seat post", handlebars: "Handlebars", pedals: "Pedals", helmetProvided: "Helmet",
};

function bikeCheckFailures(check: unknown, sourceKind: string): Failure[] {
  if (!check || typeof check !== "object") return [];
  const c = check as Record<string, unknown>;
  const items = Object.entries(BIKE_ITEMS).flatMap(([field, label]) =>
    failedIf(c[field] === "fail", { key: field, label, sourceKind }));
  if (items.length) return items;
  return failedIf(c.overallResult === "fail", { key: "overall", label: "Bike check failed", sourceKind });
}

const SWIM_FIRST_AID: Record<string, string> = {
  aedOk: "Defibrillator (AED)", firstAidKitOk: "First aid kit", rescuePoleOk: "Rescue pole",
  throwBagOk: "Throw bag", spineBoardOk: "Spinal board", ringBuoyOk: "Ring buoy", oxygenKitOk: "Oxygen kit",
};

const GREEN_PRE_USE_TICKS: Record<string, string> = {
  fluidLevelsOk: "Fluid levels", tyresOk: "Tyres", bladesOk: "Blades", guardsOk: "Guards",
  controlsOk: "Controls", lightsOk: "Lights", cleanlinessOk: "Cleanliness",
};

const ROOM_TICKS: Record<string, string> = { clean: "Room clean", tidy: "Room tidy", toStandard: "Room to standard" };

function probeFailures(body: Record<string, unknown>): Failure[] {
  const sourceKind = "kitchen_probe_checks";
  const probes = Array.isArray(body.probes) ? body.probes as Record<string, unknown>[] : [];
  const found = probes.flatMap((probe, index) => {
    const name = text(probe?.name) || `Probe ${index + 1}`;
    return [
      ...failedIf(probe?.accurateIce === false, { key: `probe:${index}:ice`, label: `${name}: iced water reading`, sourceKind }),
      ...failedIf(probe?.accurateBoiling === false, { key: `probe:${index}:boiling`, label: `${name}: boiling water reading`, sourceKind }),
    ];
  });
  if (found.length) return found;
  return failedIf(body.overallResult === "fail", { key: "overall", label: "Probe check failed", sourceKind });
}

function weeklyFailures(body: Record<string, unknown>): Failure[] {
  const sourceKind = "kitchen_weekly_records";
  const checks = body.checks && typeof body.checks === "object" ? body.checks as Record<string, unknown> : {};
  const deviations = Array.isArray(body.deviations) ? body.deviations as Record<string, unknown>[] : [];
  // The review's own "deviations and actions" table already says what was done.
  const given = deviations.map(d => text(d?.action)).filter(Boolean).join("; ") || null;
  return Object.entries(checks)
    .filter(([key, answer]) => kitchenWeeklyNeedsAttention(key, answer))
    .map(([key]) => ({ key, label: humanise(key), sourceKind, given }));
}

async function legionellaFailures(body: Record<string, unknown>, clientId: number): Promise<Failure[]> {
  const sourceKind = "legionella_checks";
  const label = LEGIONELLA_LABELS[text(body.checkType)] ?? humanise(text(body.checkType) || "check");
  const where = text(body.location);
  const breach = await legionellaBreachForNewCheck(clientId, body) as { temperature: number; limits: { min?: number; max?: number } } | null;
  if (breach) {
    const limit = [breach.limits.min != null ? `at least ${breach.limits.min}°C` : null, breach.limits.max != null ? `no more than ${breach.limits.max}°C` : null].filter(Boolean).join(" and ");
    return [{ key: "check", label: `${label}${where ? ` at ${where}` : ""}: ${breach.temperature}°C (should be ${limit})`, sourceKind }];
  }
  return failedIf(body.result === "fail", { key: "check", label: `${label}${where ? ` at ${where}` : ""} failed`, sourceKind });
}

async function hotTubFailures(body: Record<string, unknown>, clientId: number): Promise<Failure[]> {
  const sourceKind = "hot_tub_checks";
  const breach = await hotTubBreachForNewCheck(clientId, body);
  if (breach) {
    const names: Record<string, string> = { ph: "pH", sanitiser: "Sanitiser", temperature: "Water temperature" };
    return Object.entries(breach).map(([key, value]) => {
      const range = [value.range?.min != null ? `${value.range.min}` : null, value.range?.max != null ? `${value.range.max}` : null];
      const should = range[0] && range[1] ? `${range[0]} to ${range[1]}` : range[1] ? `no more than ${range[1]}` : `at least ${range[0]}`;
      return { key, label: `${names[key] ?? humanise(key)}: ${value.observed} (should be ${should})`, sourceKind };
    });
  }
  const label = TUB_LABELS[text(body.checkType)] ?? humanise(text(body.checkType) || "check");
  return failedIf(body.result === "fail", { key: "check", label: `${label} failed`, sourceKind });
}

function fireFailures(body: Record<string, unknown>): Failure[] {
  const sourceKind = "fire_safety_checks";
  const label = FIRE_LABELS[text(body.checkType)] ?? humanise(text(body.checkType) || "check");
  const walk = parseWalkNotes(typeof body.notes === "string" ? body.notes : null);
  const routes = (walk?.routes ?? []).filter(route => route.status !== "clear");
  if (routes.length) {
    return routes.map((route, index) => ({
      key: `route:${index}`, label: `Escape route ${route.name}: ${route.status}`, sourceKind,
    }));
  }
  // The alarm panel form has its own "Actions taken" box.
  let given: string | null = null;
  try {
    const notes = typeof body.notes === "string" ? JSON.parse(body.notes) : null;
    if (notes?._type === "alarm_panel") given = text(notes.actionsTaken) || null;
  } catch {
    // Plain-text notes.
  }
  return failedIf(body.result === "fail", { key: "check", label: `${label} failed`, sourceKind, given });
}

/**
 * Every signed save that can record a fail. The paths match
 * SIGNED_RECORD_ROUTES; the rule applies only when that save is being signed.
 */
const RULES: readonly Rule[] = [
  { method: "POST", path: /^\/fire-safety$/, module: "fire", failures: fireFailures },
  { method: "POST", path: /^\/legionella$/, module: "legionella", failures: (body, { clientId }) => legionellaFailures(body, clientId) },
  { method: "POST", path: /^\/hot-tub$/, module: "hot_tub", failures: (body, { clientId }) => hotTubFailures(body, clientId) },
  {
    method: "POST", path: /^\/pool-track$/, module: "pool",
    failures: (body) => failedIf(body.result === "fail", {
      key: "check", label: `${POOL_LABELS[text(body.checkType)] ?? "Pool check"} failed`,
      sourceKind: "pool_checks", given: text(body.actionsTaken) || null,
    }),
  },
  {
    method: "POST", path: /^\/tree-track$/, module: "tree",
    failures: (body) => failedIf(body.result === "fail", {
      key: "check", label: `${humanise(text(body.checkType) || "tree inspection")}${text(body.treeRef) ? ` (${text(body.treeRef)})` : ""} failed`,
      sourceKind: "tree_inspections",
    }),
  },
  {
    method: "POST", path: /^\/premises-track$/, module: "premises",
    // A hazard found with no action required or taken. An "action required"
    // already raises its own action (raise_track_action_for_finding).
    failures: (body) => failedIf(!!text(body.hazardDetails), {
      key: "hazard", label: `Hazard found${text(body.area) ? ` in ${text(body.area)}` : ""}: ${text(body.hazardDetails).slice(0, 200)}`,
      sourceKind: "premises_inspections", given: text(body.actionTaken) || null, answered: !!text(body.actionRequired),
    }),
  },
  { method: "POST", path: /^\/room-track\/checks$/, module: "room", failures: (body) => failedTicks(body, ROOM_TICKS, "room_track_checks") },
  {
    method: "POST", path: /^\/pat-track\/tests$/, module: "pat",
    failures: (body) => [
      ...failedIf(body.visualInspection === "fail", { key: "visual", label: "Visual inspection failed", sourceKind: "pat_tests" }),
      ...failedIf(body.result === "fail" && body.visualInspection !== "fail", { key: "test", label: "PAT test failed", sourceKind: "pat_tests" }),
    ],
  },
  {
    method: "POST", path: /^\/bike-track\/hires$/, module: "bike",
    failures: (body) => bikeCheckFailures(body.preHireCheck, "bike_checks"),
    actionRecordId: (response) => response?.preCheck?.id,
  },
  {
    method: "POST", path: /^\/bike-track\/hires\/\d+\/return$/, module: "bike",
    failures: (body) => bikeCheckFailures(body.postReturnCheck, "bike_checks"),
    actionRecordId: (response) => response?.postCheck?.id,
  },
  {
    method: "POST", path: /^\/green-track\/pre-use-checks$/, module: "green",
    failures: (body) => {
      const sourceKind = "green_pre_use_checks";
      if (Array.isArray(body.checklistItems)) {
        return (body.checklistItems as Record<string, unknown>[]).flatMap((item, index) =>
          failedIf(item?.status === "fail", { key: `item:${index}`, label: text(item?.label) || `Item ${index + 1}`, sourceKind }));
      }
      return failedTicks(body, GREEN_PRE_USE_TICKS, sourceKind);
    },
  },
  {
    method: "POST", path: /^\/green-track\/puwer-inspections$/, module: "green",
    failures: (body) => failedIf(body.safeToOperate === false, {
      key: "unsafe", label: `Machine not safe to operate${text(body.defectsFound) ? `: ${text(body.defectsFound).slice(0, 200)}` : ""}`,
      sourceKind: "green_puwer_inspections",
    }),
  },
  {
    method: "POST", path: /^\/green-track\/shed-checks$/, module: "green",
    failures: (body) => failedItems(body.items, "daily_checklist_item", "label"),
  },
  {
    method: "PUT", path: /^\/green-track\/shed-checks\/\d+$/, module: "green", readsStored: true,
    failures: (body, { stored }) => failedItems(body.items ?? stored?.items, "daily_checklist_item", "label"),
  },
  {
    method: "POST", path: /^\/swim-track\/sessions$/, module: "swim",
    failures: (body) => [
      ...failedIf(body.preSessionResult === "fail", { key: "pre", label: "Pre-session check failed", sourceKind: "swim_sessions" }),
      ...failedIf(body.poolClosed === true, { key: "closed", label: "Pool closed", sourceKind: "swim_sessions" }),
    ],
  },
  {
    method: "POST", path: /^\/swim-track\/surveillance$/, module: "swim",
    failures: (body) => failedIf(body.scanCompleted === false, { key: "scan", label: "Pool scan not completed", sourceKind: "swim_surveillance_checks" }),
  },
  { method: "POST", path: /^\/swim-track\/first-aid$/, module: "swim", failures: (body) => failedTicks(body, SWIM_FIRST_AID, "swim_first_aid_checks") },
  { method: "POST", path: /^\/kitchen-weekly\/weekly$/, module: "kitchen", failures: weeklyFailures },
  {
    method: "PUT", path: /^\/kitchen-weekly\/weekly\/\d+$/, module: "kitchen", readsStored: true,
    failures: (body, { stored }) => weeklyFailures({
      checks: body.checks ?? stored?.checks, deviations: body.deviations ?? stored?.deviations,
    }),
  },
  { method: "POST", path: /^\/kitchen-weekly\/probe$/, module: "kitchen", failures: probeFailures },
  {
    method: "PUT", path: /^\/kitchen-weekly\/probe\/\d+$/, module: "kitchen", readsStored: true,
    failures: (body, { stored }) => probeFailures({
      probes: body.probes ?? stored?.probes, overallResult: body.overallResult ?? stored?.overall_result,
    }),
  },
  ...(["daily-track-am", "daily-track-pm"] as const).flatMap((track): Rule[] => {
    const module = (body: Record<string, unknown>, stored: Record<string, unknown> | null) => {
      const type = text(body.checklistType) || text(stored?.checklist_type);
      return type ? moduleFor(type) : track === "daily-track-am" ? "daily_am" : "daily_pm";
    };
    return [
      { method: "POST", path: new RegExp(`^/${track}$`), module, failures: (body) => failedItems(body.items, "daily_checklist_item", "label") },
      {
        method: "PUT", path: new RegExp(`^/${track}/\\d+$`), module, readsStored: true,
        failures: (body, { stored }) => failedItems(body.items ?? stored?.items, "daily_checklist_item", "label"),
      },
    ];
  }),
  {
    method: "POST", path: /^\/daily-checklists\/\d+\/[^/]+\/(?:am|pm)$/,
    module: (_body, _stored, path) => (path.endsWith("/pm") ? "daily_pm" : "daily_am"),
    failures: (body) => failedItems(body.answers, "mobile_checklist_item", "question"),
  },
];

export type CorrectiveCheck = {
  rule: Rule;
  module: string;
  failures: Failure[];
  /** The failures the form did not already answer: these are asked about. */
  asked: Failure[];
};

/**
 * What failed in this signed save, or null when nothing did (or the route
 * records no pass/fail). `match` is the save's SIGNED_RECORD_ROUTES entry.
 */
export async function correctiveCheckFor(
  method: string, path: string, match: SignedRouteMatch, body: unknown, clientId: number,
): Promise<CorrectiveCheck | null> {
  const rule = RULES.find(candidate => candidate.method === method && candidate.path.test(path));
  if (!rule) return null;
  const fields = body && typeof body === "object" ? body as Record<string, unknown> : {};
  let stored: Record<string, unknown> | null = null;
  if (rule.readsStored && match.pathId !== null) {
    const result = await db.execute(sql`
      SELECT * FROM ${sql.raw(`"${match.route.table}"`)} AS record
      WHERE record.id = ${match.pathId} AND record.client_id = ${clientId}
    `);
    stored = ((result.rows ?? [])[0] as Record<string, unknown> | undefined) ?? null;
  }
  const failures = await rule.failures(fields, { clientId, stored, path });
  if (!failures.length) return null;
  return {
    rule, module: typeof rule.module === "function" ? rule.module(fields, stored, path) : rule.module, failures,
    asked: failures.filter(failure => !failure.given && !failure.answered),
  };
}

/**
 * The answers sent with a save: a URI-encoded JSON object of failure key to
 * text. Returns only well-formed answers; anything else counts as unanswered.
 */
export function parseCorrectiveAnswers(header: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const answers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const answer = typeof value === "string" ? value.trim() : "";
      if (answer.length >= CORRECTIVE_ACTION_MIN_LENGTH && answer.length <= CORRECTIVE_ACTION_MAX_LENGTH) answers[key] = answer;
    }
    return answers;
  } catch {
    return {};
  }
}

/** The failures still without a usable answer. */
export function unansweredFailures(check: CorrectiveCheck, answers: Record<string, string>): Failure[] {
  return check.asked.filter(failure => !answers[failure.key]);
}

/**
 * After the save: puts each corrective action on the track action its fail
 * raised (same source), or opens one where the track raised none. Runs in one
 * transaction; returns how many actions were updated or opened.
 */
export async function recordCorrectiveActions(opts: {
  check: CorrectiveCheck; match: SignedRouteMatch; recordId: number; actionRecordId: number;
  clientId: number; userId: number; userName: string; answers: Record<string, string>;
}): Promise<number> {
  const { check, match, recordId, actionRecordId, clientId, userId, userName, answers } = opts;
  const groups = new Map<string, { failure: Failure; answer: string }[]>();
  for (const failure of check.failures) {
    const answer = failure.answered ? "" : answers[failure.key] ?? failure.given ?? "";
    if (!answer) continue;
    const list = groups.get(failure.sourceKind) ?? [];
    list.push({ failure, answer });
    groups.set(failure.sourceKind, list);
  }
  if (!groups.size) return 0;
  const table = sql.raw(`"${match.route.table}"`);
  const site = sql.raw(match.route.site);
  return db.transaction(async tx => {
    let count = 0;
    for (const [sourceKind, entries] of groups) {
      // One fail: the answer on its own. Several on one action: each named.
      const remedial = entries.length === 1 && check.failures.filter(f => f.sourceKind === sourceKind).length === 1
        ? entries[0].answer
        : entries.map(entry => `${entry.failure.label}: ${entry.answer}`).join("\n");
      const note = `Corrective action recorded by ${userName} when the check was saved:\n${remedial}`;
      const existing = ((await tx.execute(sql`
        SELECT id, remedial_action, instruction FROM track_actions
        WHERE client_id = ${clientId} AND source_kind = ${sourceKind} AND source_record_id = ${actionRecordId}
        ORDER BY id LIMIT 1 FOR UPDATE
      `)).rows ?? [])[0] as { id: number; remedial_action: string | null; instruction: string | null } | undefined;
      let actionId: number;
      if (existing) {
        // A replayed save must not add the same words twice.
        if ((existing.instruction ?? "").includes(note)) continue;
        await tx.execute(sql`
          UPDATE track_actions SET
            remedial_action = CASE WHEN nullif(trim(coalesce(remedial_action, '')), '') IS NULL
              THEN ${remedial}::text ELSE remedial_action || E'\n' || ${remedial}::text END,
            instruction = concat_ws(E'\n\n', nullif(instruction, ''), ${note}::text),
            updated_at = now()
          WHERE id = ${existing.id} AND client_id = ${clientId}
        `);
        actionId = existing.id;
      } else {
        const title = entries.length === 1 ? `Failed check: ${entries[0].failure.label}` : `Failed check: ${entries.length} items`;
        const inserted = ((await tx.execute(sql`
          INSERT INTO track_actions (
            client_id, site_id, module, source_kind, source_record_id, title, instruction,
            provenance, severity, status, due_date, remedial_action, created_by
          ) VALUES (
            ${clientId},
            (SELECT ${site} FROM ${table} AS record WHERE record.id = ${recordId} AND record.client_id = ${clientId}),
            ${check.module}, ${sourceKind}, ${actionRecordId}, ${title.slice(0, 500)},
            ${`${check.failures.filter(f => f.sourceKind === sourceKind).map(f => `Failed: ${f.label}`).join("\n")}\n\n${note}`},
            'product_default', 'action_required', 'open',
            ((now() AT TIME ZONE 'Europe/London')::date + 1), ${remedial}, ${userId}
          )
          ON CONFLICT ("client_id", "module", "source_kind", "source_record_id")
            WHERE "source_kind" IS NOT NULL AND "source_record_id" IS NOT NULL
          DO NOTHING
          RETURNING id
        `)).rows ?? [])[0] as { id: number } | undefined;
        if (!inserted) continue;
        actionId = inserted.id;
      }
      await tx.execute(sql`
        INSERT INTO audit_events (client_id, actor_id, entity_type, entity_id, action, metadata)
        VALUES (${clientId}, ${userId}, 'track_action', ${actionId}, 'corrective_action_recorded',
          ${JSON.stringify({ recordType: match.route.recordType, recordId, failures: entries.map(e => e.failure.label), remedial })}::jsonb)
      `);
      count += 1;
    }
    return count;
  });
}

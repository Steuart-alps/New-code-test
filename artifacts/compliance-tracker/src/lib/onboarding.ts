// Shared labels and helpers for the setup wizard (/setup) and staff tasks (/tasks).
import { apiFetch, getApiErrorMessage } from "@/lib/api";

export const BUSINESS_TYPE_OPTIONS = [
  { value: "hotel_accommodation", label: "Hotel / Accommodation" },
  { value: "holiday_park_campsite", label: "Holiday Park / Campsite" },
  { value: "leisure_sports_centre", label: "Leisure / Sports Centre" },
  { value: "restaurant_cafe_pub", label: "Restaurant / Café / Pub" },
  { value: "care_home_healthcare", label: "Care Home / Healthcare" },
  { value: "nursery_school", label: "Nursery / School" },
  { value: "offices_commercial", label: "Offices / Commercial" },
  { value: "retail", label: "Retail" },
  { value: "pest_control", label: "Pest Control" },
  { value: "golf_club", label: "Golf Club" },
  { value: "other", label: "Other" },
] as const;

export const NATION_OPTIONS = [
  { value: "england", label: "England" },
  { value: "wales", label: "Wales" },
  { value: "scotland", label: "Scotland" },
  { value: "northern_ireland", label: "Northern Ireland" },
  { value: "multi_nation", label: "More than one nation" },
] as const;

/** Module keys (service keys, plus "compliance" for compliance checks). */
export const MODULE_INFO: Record<string, { label: string; href: string; hint: string }> = {
  compliance: { label: "Compliance Checks", href: "/external", hint: "Servicing, inspections and certificates" },
  firetrack: { label: "FireTrack", href: "/fire-safety", hint: "Fire alarm tests, drills and fire safety checks" },
  kitchentrack: { label: "KitchenTrack", href: "/kitchen", hint: "Food safety temperatures and kitchen checks" },
  legionellatrack: { label: "LegionellaTrack", href: "/legionella", hint: "Water temperatures and flushing" },
  doctrack: { label: "DocTrack", href: "/doc-track", hint: "Policies, risk assessments and staff sign-off" },
  fixtrack: { label: "FixTrack", href: "/fix-track", hint: "Repairs and maintenance jobs" },
  traintrack: { label: "TrainTrack", href: "/train-track", hint: "Staff training records" },
  hottubtrack: { label: "TubTrack", href: "/hot-tub", hint: "Hot tub water tests" },
  treetrack: { label: "TreeTrack", href: "/tree-track", hint: "Tree inspections" },
  biketrack: { label: "BikeTrack", href: "/bike-track", hint: "Bike hire and servicing" },
  aquatrack: { label: "AquaTrack", href: "/aqua-track", hint: "Pool water tests" },
  greentrack: { label: "GreenTrack", href: "/green-track", hint: "Grounds equipment" },
  incidenttrack: { label: "IncidentTrack", href: "/incidents", hint: "Accidents, incidents and RIDDOR" },
  pattrack: { label: "PATtrack", href: "/pat-track", hint: "Portable appliance testing" },
  pesttrack: { label: "PestTrack", href: "/pest-track", hint: "Pest control visits and sightings" },
  premisestrack: { label: "PremisesTrack", href: "/premises-track", hint: "Premises inspections" },
  roomtrack: { label: "RoomTrack", href: "/room-track", hint: "Room checks" },
  coshhtrack: { label: "COSHHTrack", href: "/coshh-track", hint: "COSHH assessments and extraction tests" },
  dailytrack_am: { label: "DailyTrack AM", href: "/daily-track-am", hint: "Opening checklist" },
  dailytrack_pm: { label: "DailyTrack PM", href: "/daily-track-pm", hint: "Closing checklist" },
};

/** Modules suggested first for each business type (only offered if available). */
export const RECOMMENDED_MODULES: Record<string, string[]> = {
  restaurant_cafe_pub: ["kitchentrack", "dailytrack_am", "dailytrack_pm", "firetrack", "legionellatrack", "pesttrack", "incidenttrack"],
  hotel_accommodation: ["firetrack", "legionellatrack", "kitchentrack", "roomtrack", "dailytrack_am", "pesttrack", "incidenttrack"],
  holiday_park_campsite: ["firetrack", "legionellatrack", "premisestrack", "aquatrack", "hottubtrack", "pesttrack", "incidenttrack"],
  leisure_sports_centre: ["aquatrack", "firetrack", "legionellatrack", "premisestrack", "incidenttrack"],
  care_home_healthcare: ["firetrack", "legionellatrack", "kitchentrack", "incidenttrack", "traintrack", "doctrack"],
  nursery_school: ["firetrack", "kitchentrack", "premisestrack", "incidenttrack", "doctrack"],
  offices_commercial: ["firetrack", "pattrack", "incidenttrack", "doctrack"],
  retail: ["firetrack", "pattrack", "premisestrack", "incidenttrack"],
  pest_control: ["pesttrack", "doctrack", "traintrack"],
  golf_club: ["firetrack", "legionellatrack", "kitchentrack", "premisestrack", "treetrack", "incidenttrack", "greentrack"],
  other: ["firetrack", "incidenttrack", "doctrack"],
};

/**
 * Department names pre-ticked in setup for each business type; the owner
 * removes or adds names before saving. No type: the hospitality set.
 */
export const DEPARTMENT_SUGGESTIONS: Record<string, string[]> = {
  hotel_accommodation: ["Front of house", "Housekeeping", "Kitchen", "Maintenance"],
  holiday_park_campsite: ["Front of house", "Housekeeping", "Grounds", "Leisure", "Maintenance"],
  leisure_sports_centre: ["Front of house", "Pool", "Gym", "Maintenance"],
  restaurant_cafe_pub: ["Front of house", "Kitchen", "Bar", "Cellar"],
  care_home_healthcare: ["Care", "Kitchen", "Housekeeping", "Maintenance"],
  nursery_school: ["Teaching", "Kitchen", "Caretaking", "Office"],
  offices_commercial: ["Office", "Facilities", "Front of house"],
  retail: ["Shop floor", "Stockroom", "Office"],
  pest_control: ["Field team", "Office"],
  golf_club: ["Greenkeeping", "Clubhouse", "Kitchen", "Bar", "Pro shop", "Maintenance"],
  other: ["Front of house", "Housekeeping", "Maintenance"],
};

/** Order for choosing the module whose record form to open first. */
export const FIRST_RECORD_PRIORITY = [
  "dailytrack_am", "kitchentrack", "firetrack", "legionellatrack", "aquatrack", "hottubtrack", "premisestrack",
  "roomtrack", "pattrack", "pesttrack", "incidenttrack", "fixtrack", "traintrack", "doctrack",
  "treetrack", "biketrack", "greentrack", "coshhtrack", "dailytrack_pm",
];

export function moduleLabel(key: string | null | undefined): string | null {
  return key ? MODULE_INFO[key]?.label ?? key : null;
}

/** "12 Oct 2026" from a YYYY-MM-DD day (no time zone shift). */
export function formatDay(day: string | null | undefined): string {
  if (!day) return "";
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

/** Today's date on this device as YYYY-MM-DD. */
export function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * JSON request through apiFetch (session cookie + CSRF). Consultants act on
 * the business picked in the client switcher, so its id is sent explicitly.
 */
export async function onboardingRequest<T>(path: string, clientId: number | null, init?: RequestInit): Promise<T> {
  const url = clientId ? `${path}${path.includes("?") ? "&" : "?"}clientId=${clientId}` : path;
  const res = await apiFetch(url, init);
  if (!res.ok) throw new Error(await getApiErrorMessage(res, `Request failed (${res.status})`));
  return res.json() as Promise<T>;
}

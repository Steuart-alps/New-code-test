/**
 * The tracks (modules) a business can assign an owner to and receive in-app
 * reminders for. Keys match track_actions.module (routes/track-actions.ts),
 * plus "compliance" for the compliance-check register (gas, EICR, LOLER...).
 */
import type { ServiceKey } from "./services";

export interface TrackModule {
  key: string;
  label: string;
  /** Entitlement: the business needs any one of these services. */
  services: ServiceKey[];
  /** Web page for the track. */
  path: string;
  /** Mobile push route hint (artifacts/mobile lib/notificationRoutes.ts). */
  mobileRoute: string;
}

export const TRACK_MODULES: readonly TrackModule[] = [
  { key: "daily_am", label: "DailyTrack AM", services: ["dailytrack_am", "kitchentrack", "premisestrack"], path: "/daily-track-am", mobileRoute: "/checks/daily" },
  { key: "daily_pm", label: "DailyTrack PM", services: ["dailytrack_pm", "kitchentrack", "premisestrack"], path: "/daily-track-pm", mobileRoute: "/checks/daily" },
  { key: "kitchen", label: "KitchenTrack", services: ["kitchentrack"], path: "/kitchen", mobileRoute: "/checks/kitchen" },
  { key: "fire", label: "FireTrack", services: ["firetrack"], path: "/fire-safety", mobileRoute: "/checks/fire" },
  { key: "legionella", label: "LegionellaTrack", services: ["legionellatrack"], path: "/legionella", mobileRoute: "/checks/water" },
  { key: "pool", label: "AquaTrack (water tests)", services: ["aquatrack", "pooltrack"], path: "/aqua-track", mobileRoute: "/checks/aqua" },
  { key: "swim", label: "AquaTrack (sessions & safety)", services: ["aquatrack", "swimtrack"], path: "/aqua-track", mobileRoute: "/checks/aqua" },
  { key: "hot_tub", label: "TubTrack", services: ["hottubtrack"], path: "/hot-tub", mobileRoute: "/checks/hot-tub" },
  { key: "pat", label: "PATtrack", services: ["pattrack"], path: "/pat-track", mobileRoute: "/checks/pat" },
  { key: "pest", label: "PestTrack", services: ["pesttrack"], path: "/pest-track", mobileRoute: "/(tabs)" },
  { key: "fix", label: "FixTrack", services: ["fixtrack"], path: "/fix-track", mobileRoute: "/fix-track" },
  { key: "premises", label: "PremisesTrack", services: ["premisestrack"], path: "/premises-track", mobileRoute: "/(tabs)" },
  { key: "room", label: "RoomTrack", services: ["roomtrack"], path: "/room-track", mobileRoute: "/(tabs)" },
  { key: "doc", label: "DocTrack", services: ["doctrack", "safetrack"], path: "/doc-track", mobileRoute: "/doc-track" },
  { key: "safe", label: "SafeTrack", services: ["safetrack", "doctrack"], path: "/doc-track", mobileRoute: "/doc-track" },
  { key: "train", label: "TrainTrack", services: ["traintrack"], path: "/train-track", mobileRoute: "/train-track" },
  { key: "tree", label: "TreeTrack", services: ["treetrack"], path: "/tree-track", mobileRoute: "/(tabs)" },
  { key: "bike", label: "BikeTrack", services: ["biketrack"], path: "/bike-track", mobileRoute: "/(tabs)" },
  { key: "green", label: "GreenTrack", services: ["greentrack"], path: "/green-track", mobileRoute: "/checks/green" },
  { key: "coshh", label: "COSHHTrack", services: ["coshhtrack"], path: "/coshh-track", mobileRoute: "/(tabs)" },
  { key: "incident", label: "IncidentTrack", services: ["incidenttrack"], path: "/incidents", mobileRoute: "/checks/incident" },
  { key: "compliance", label: "Compliance checks", services: ["core"], path: "/external", mobileRoute: "/(tabs)" },
];

export const TRACK_MODULE_KEYS = TRACK_MODULES.map((module) => module.key);

const byKey = new Map(TRACK_MODULES.map((module) => [module.key, module]));

export function getTrackModule(key: string): TrackModule | undefined {
  return byKey.get(key);
}

export function isTrackModuleKey(key: unknown): key is string {
  return typeof key === "string" && byKey.has(key);
}

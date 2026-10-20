import type { LucideIcon } from "lucide-react";
import { AlertOctagon, Beaker, Bike, BookOpen, Bug, Building2, CheckCircle2, Droplets, Flame, Leaf, PlugZap, ShieldCheck, Sunrise, Sunset, TreePine, UtensilsCrossed, Waves, Wrench } from "lucide-react";

/**
 * Add-on modules offered at checkout (trial-ended page and Settings). Keys match
 * the server's service catalogue; `comingSoon` modules are shown but cannot be
 * bought (the server refuses them too). SwimTrack is AquaTrack's legacy key and
 * is not offered separately.
 */
export interface CheckoutAddon {
  key: string;
  label: string;
  desc: string;
  icon: LucideIcon;
  iconColor: string;
  comingSoon?: boolean;
}

/**
 * A picked module is always shown in green, whatever its own colour: a red or
 * orange border on a chosen module reads as a fault.
 */
export const SELECTED_MODULE_CARD = "border-green-600 bg-green-50";
export const SELECTED_MODULE_CHECKBOX = "border-green-600 bg-green-600";
export const SELECTED_MODULE_TICK = "text-green-600";

/** Per-site monthly prices in pounds; the bundle price is the per-site cap. */
export const CORE_PRICE_GBP = 10;
export const ADDON_PRICE_GBP = 10;
export const BUNDLE_CAP_GBP = 50;

/** Per-site monthly total for a selection, never above the bundle cap. */
export function checkoutPerSiteTotal(addonCount: number, bundle: boolean): number {
  if (bundle) return BUNDLE_CAP_GBP;
  return Math.min(BUNDLE_CAP_GBP, CORE_PRICE_GBP + addonCount * ADDON_PRICE_GBP);
}

export const CHECKOUT_ADDONS: CheckoutAddon[] = [
  {
    key: "firetrack",
    label: "FireTrack",
    desc: "Fire safety logbook",
    icon: Flame,
    iconColor: "text-orange-600",
  },
  {
    key: "kitchentrack",
    label: "KitchenTrack",
    desc: "Food safety diary",
    icon: UtensilsCrossed,
    iconColor: "text-amber-600",
  },
  {
    key: "legionellatrack",
    label: "LegionellaTrack",
    desc: "Water safety logbook (L8/HSG274)",
    icon: Droplets,
    iconColor: "text-sky-600",
  },
  {
    key: "fixtrack",
    label: "FixTrack",
    desc: "Maintenance issue reporting",
    icon: Wrench,
    iconColor: "text-orange-700",
  },
  {
    key: "premisestrack",
    label: "PremisesTrack",
    desc: "Premises safety logbook",
    icon: Building2,
    iconColor: "text-violet-700",
  },
  {
    key: "safetrack",
    label: "SafeTrack",
    desc: "Risk assessments, SOPs & staff handbook acknowledgements",
    icon: ShieldCheck,
    iconColor: "text-blue-700",
  },
  {
    key: "doctrack",
    label: "DocTrack",
    desc: "H&S document library with staff sign-off & annual acknowledgements",
    icon: CheckCircle2,
    iconColor: "text-indigo-700",
  },
  {
    key: "traintrack",
    label: "TrainTrack",
    desc: "Staff training & cert expiry",
    icon: BookOpen,
    iconColor: "text-emerald-700",
  },
  {
    key: "hottubtrack",
    label: "TubTrack",
    desc: "Hot tub & spa pool maintenance (HSG282)",
    icon: Waves,
    iconColor: "text-cyan-600",
  },
  {
    key: "treetrack",
    label: "TreeTrack",
    desc: "Tree inspection logbook (BS 3998)",
    icon: TreePine,
    iconColor: "text-green-700",
  },
  {
    key: "incidenttrack",
    label: "IncidentTrack",
    desc: "Accident & incident log with RIDDOR reporting",
    icon: AlertOctagon,
    iconColor: "text-rose-700",
  },
  {
    key: "biketrack",
    label: "BikeTrack",
    desc: "Bike hire service & maintenance records",
    icon: Bike,
    iconColor: "text-lime-700",
  },
  {
    key: "aquatrack",
    label: "AquaTrack",
    desc: "Pool water quality, sessions, surveillance, first-aid & incidents",
    icon: Waves,
    iconColor: "text-blue-600",
  },
  {
    key: "greentrack",
    label: "GreenTrack",
    desc: "Grounds & landscaping maintenance records",
    comingSoon: true,
    icon: Leaf,
    iconColor: "text-green-600",
  },
  {
    key: "pattrack",
    label: "PATtrack",
    desc: "Portable appliance testing records",
    icon: PlugZap,
    iconColor: "text-yellow-600",
  },
  {
    key: "pesttrack",
    label: "PestTrack",
    desc: "Pest control monitoring & treatment log",
    icon: Bug,
    iconColor: "text-stone-700",
  },
  {
    key: "coshhtrack",
    label: "COSHHTrack",
    desc: "COSHH assessments, LEV tests, health checks & briefings",
    icon: Beaker,
    iconColor: "text-orange-700",
  },
  {
    key: "dailytrack_am",
    label: "DailyTrack AM",
    desc: "Opening checks & morning checklists",
    icon: Sunrise,
    iconColor: "text-amber-500",
  },
  {
    key: "dailytrack_pm",
    label: "DailyTrack PM",
    desc: "Closing checks & evening checklists",
    icon: Sunset,
    iconColor: "text-orange-500",
  },
];


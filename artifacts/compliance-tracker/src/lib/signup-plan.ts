export const SIGNUP_SERVICE_KEYS = [
  "firetrack",
  "kitchentrack",
  "legionellatrack",
  "fixtrack",
  "safetrack",
  "doctrack",
  "premisestrack",
  "traintrack",
  "hottubtrack",
  "treetrack",
  "pattrack",
  "pesttrack",
] as const;

const signupServiceKeys = new Set<string>(SIGNUP_SERVICE_KEYS);

export function parseSignupPlan(location: string): {
  bundle: boolean;
  services: string[];
} {
  const query = location.startsWith("?")
    ? location.slice(1)
    : location.includes("?") ? location.slice(location.indexOf("?") + 1) : location;
  const params = new URLSearchParams(query);
  const bundle = params.get("bundle") === "true";
  const services = Array.from(new Set(
    (params.get("modules") ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter((key) => signupServiceKeys.has(key)),
  ));

  return { bundle, services };
}

export function buildSignupPath(selected: string[], bundle: boolean): string {
  const addons = selected.filter((key) => key !== "core");
  const params = new URLSearchParams();
  if (addons.length > 0) params.set("modules", addons.join(","));
  if (bundle) params.set("bundle", "true");
  const query = params.toString();
  return `/signup${query ? `?${query}` : ""}`;
}

export function registrationPlanFields(plan: ReturnType<typeof parseSignupPlan>):
  { bundle: true } | { services: string[] } | Record<string, never> {
  if (plan.bundle) return { bundle: true };
  if (plan.services.length > 0) return { services: plan.services };
  return {};
}
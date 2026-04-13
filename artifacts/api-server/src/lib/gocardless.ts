import gocardless from "gocardless-nodejs";
import { Environments } from "gocardless-nodejs/constants";

export const GC_PLANS = {
  starter: { amount: 4900, name: "Starter Plan", intervalUnit: "monthly" as const },
  professional: { amount: 9900, name: "Professional Plan", intervalUnit: "monthly" as const },
  enterprise: { amount: 24900, name: "Enterprise Plan", intervalUnit: "monthly" as const },
} as const;

export type GcPlanSlug = keyof typeof GC_PLANS;

export function getGcClient() {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error("GOCARDLESS_ACCESS_TOKEN is not configured.");
  const env = process.env.GOCARDLESS_ENVIRONMENT === "live" ? Environments.Live : Environments.Sandbox;
  return gocardless(token, env);
}

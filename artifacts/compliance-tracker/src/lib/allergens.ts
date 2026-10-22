import { format } from "date-fns";

// KitchenTrack allergen records, ingredients, menus and charts
// (API: /api/registers/allergens, /allergen-ingredients, /allergen-menus,
// /allergen-charts).

// The 14 allergens in Schedule 1 of the Food Information Regulations 2014
// (retained Regulation (EU) 1169/2011, Annex II). Keys match the API.
export const ALLERGENS = [
  { key: "celery", label: "Celery", short: "Celery" },
  { key: "gluten", label: "Cereals containing gluten", short: "Gluten" },
  { key: "crustaceans", label: "Crustaceans", short: "Crustaceans" },
  { key: "eggs", label: "Eggs", short: "Eggs" },
  { key: "fish", label: "Fish", short: "Fish" },
  { key: "lupin", label: "Lupin", short: "Lupin" },
  { key: "milk", label: "Milk", short: "Milk" },
  { key: "molluscs", label: "Molluscs", short: "Molluscs" },
  { key: "mustard", label: "Mustard", short: "Mustard" },
  { key: "tree_nuts", label: "Tree nuts", short: "Tree nuts" },
  { key: "peanuts", label: "Peanuts", short: "Peanuts" },
  { key: "sesame", label: "Sesame", short: "Sesame" },
  { key: "soya", label: "Soya", short: "Soya" },
  { key: "sulphites", label: "Sulphur dioxide / sulphites (over 10 mg/kg or litre)", short: "Sulphites" },
] as const;

export const ALLERGEN_LABEL: Record<string, string> = Object.fromEntries(ALLERGENS.map((a) => [a.key, a.label]));
export const ALLERGEN_SHORT: Record<string, string> = Object.fromEntries(ALLERGENS.map((a) => [a.key, a.short]));

export interface RecipeLine {
  ingredientId: number;
  name: string;
  quantity: number | null;
  unit: string | null;
}

export interface AllergenItem {
  id: number;
  siteId: number | null;
  name: string;
  description: string | null;
  allergens: string[];
  mayContain: string[];
  ingredients: RecipeLine[];
  menuIds: number[];
  ppds: boolean;
  lastReviewedAt: string | null;
  reviewedBy: string | null;
  updatedAt: string;
}

export interface AllergenIngredient {
  id: number;
  siteId: number | null;
  name: string;
  supplier: string | null;
  productCode: string | null;
  contains: string[];
  mayContain: string[];
  notes: string | null;
  lastCheckedAt: string | null;
  checkedBy: string | null;
  usedIn: { id: number; name: string; siteId: number | null }[];
}

export interface AllergenMenu {
  id: number;
  siteId: number | null;
  name: string;
}

export interface ChartSignoff {
  id: number;
  checkedByName: string;
  createdAt: string;
  note: string | null;
  dishCount: number;
}

export interface AllergenChart {
  siteId: number;
  siteName: string;
  menuId: number | null;
  menuName: string | null;
  dishCount: number;
  lastSignoff: ChartSignoff | null;
  changedSinceCheck: boolean;
}

export const DISHES_PATH = "/registers/allergens";
export const INGREDIENTS_PATH = "/registers/allergen-ingredients";
export const MENUS_PATH = "/registers/allergen-menus";
export const CHARTS_PATH = "/registers/allergen-charts";

/** Regulated order, de-duplicated. */
export function orderAllergens(keys: Iterable<string>): string[] {
  const chosen = new Set(keys);
  return ALLERGENS.map((a) => a.key).filter((key) => chosen.has(key));
}

/** A dish's sets from its ingredients, as the API works them out. */
export function combineIngredients(ingredients: Pick<AllergenIngredient, "contains" | "mayContain">[]) {
  const contains = orderAllergens(ingredients.flatMap((i) => i.contains));
  const mayContain = orderAllergens(ingredients.flatMap((i) => i.mayContain)).filter((key) => !contains.includes(key));
  return { contains, mayContain };
}

export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key));
}

export function chartTitle(chart: Pick<AllergenChart, "siteName" | "menuName">): string {
  return chart.menuName ? `${chart.siteName}: ${chart.menuName}` : `${chart.siteName}: all dishes`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export interface PrintableChart {
  title: string;
  items: AllergenItem[];
  /** null when the chart has no sign-off record (for example a filtered print). */
  status: Pick<AllergenChart, "lastSignoff" | "changedSinceCheck"> | null;
}

function signoffHtml(status: PrintableChart["status"]): string {
  if (!status?.lastSignoff) {
    return `<div class="check warn">NOT YET CHECKED. Check every dish against the current recipes and ingredient labels, then sign it off before you use it.</div>`;
  }
  const when = format(new Date(status.lastSignoff.createdAt), "d MMM yyyy");
  if (status.changedSinceCheck) {
    return `<div class="check warn">CHANGED SINCE LAST CHECKED (last checked by ${escapeHtml(status.lastSignoff.checkedByName)} on ${escapeHtml(when)}). Check it again before you use it.</div>`;
  }
  return `<div class="check">Checked by <strong>${escapeHtml(status.lastSignoff.checkedByName)}</strong> on <strong>${escapeHtml(when)}</strong> against the current recipes and ingredient labels.</div>`;
}

/** Printable front-of-house allergen chart: dishes down the side, the 14 allergens across. */
export function renderChartHtml(charts: PrintableChart[], businessName: string): string {
  const head = ALLERGENS.map((a) => `<th class="allergen"><span>${escapeHtml(a.short)}</span></th>`).join("");
  const sections = charts.map(({ title, items, status }) => {
    const rows = items.map((item) => {
      const cells = ALLERGENS.map((a) => {
        if (item.allergens.includes(a.key)) return `<td class="yes" aria-label="Contains ${escapeHtml(a.label)}">&#10004;</td>`;
        if ((item.mayContain ?? []).includes(a.key)) return `<td class="may" aria-label="May contain ${escapeHtml(a.label)}">M</td>`;
        return `<td></td>`;
      }).join("");
      const ppds = item.ppds ? `<div class="ppds">Prepacked for direct sale: see full ingredients label</div>` : "";
      return `<tr><td class="dish"><strong>${escapeHtml(item.name)}</strong>${item.description ? `<div class="desc">${escapeHtml(item.description)}</div>` : ""}${ppds}</td>${cells}</tr>`;
    }).join("");
    return `<section><h2>${escapeHtml(title)}</h2>${signoffHtml(status)}<table><thead><tr><th class="dish">Dish / product</th>${head}</tr></thead><tbody>${rows}</tbody></table></section>`;
  }).join("");
  const business = businessName ? escapeHtml(businessName) : "This business";
  return `<!doctype html><html><head><title>Allergen information</title>
    <style>
      @page{size:A4 landscape;margin:10mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;color:#172033;margin:0;font-size:10pt}
      h1{font-size:18pt;margin:0 0 2px}h2{font-size:12pt;margin:14px 0 4px}.sub{margin:0 0 8px;color:#52606d}
      table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #7b8794;padding:4px;text-align:center;vertical-align:middle}
      th.dish,td.dish{text-align:left;width:24%}th.allergen{height:96px;vertical-align:bottom;font-size:8.5pt;padding:2px}
      th.allergen span{writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap}
      td.yes{font-weight:bold;font-size:12pt;background:#fde2e1;color:#8a1c1c}td.may{font-weight:bold;background:#fff4d6;color:#8a4b00}
      .desc{font-size:8pt;color:#52606d}.ppds{font-size:8pt;color:#8a4b00;margin-top:2px}
      .notice{border:2px solid #172033;padding:8px;margin:10px 0;font-weight:bold}
      .check{border:1px solid #2f7d4f;background:#eaf6ee;padding:5px 8px;margin:0 0 6px;font-size:9pt}
      .check.warn{border:2px solid #8a1c1c;background:#fde2e1;font-weight:bold}
      .foot{margin-top:10px;font-size:8pt;color:#52606d}tr{break-inside:avoid}section{break-inside:auto}
      @media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
    </style></head><body>
    <h1>Allergen information${businessName ? ` &ndash; ${escapeHtml(businessName)}` : ""}</h1>
    <p class="sub">&#10004; = contains this allergen as an ingredient. M = may contain traces (supplier's warning).</p>
    <div class="notice">If you have a food allergy or intolerance, please speak to a member of staff before you order.</div>
    ${sections}
    <p class="foot">Printed ${escapeHtml(format(new Date(), "d MMM yyyy"))}. ${business} prepared this chart from its own recipes and its suppliers' ingredient information and is responsible for it. Recipes and suppliers can change: check this sheet is current.</p>
    </body></html>`;
}

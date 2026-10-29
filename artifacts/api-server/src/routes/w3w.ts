import { Router } from "express";
import { requireAuth, getClientId } from "../middleware/requireAuth";
import { getAiPlan } from "../lib/aiAllowance";

const router = Router();

/**
 * Automatic three words are part of the AI add-on (free to the business:
 * ALPS pays what3words for one shared account). Other businesses save the
 * GPS spot and type the words from the free what3words app.
 */
async function includesWhat3Words(clientId: number) {
  return (await getAiPlan(clientId)).kind !== "none";
}

// what3words' paid plans are a monthly number of lookups shared by every
// business, so one business can't use them all up.
const DAILY_LIMIT = Math.max(1, Number(process.env.W3W_DAILY_LIMIT_PER_BUSINESS) || 50);
const lookupsToday = new Map<number, { day: string; count: number }>();
function takeLookup(clientId: number): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const used = lookupsToday.get(clientId);
  const count = used?.day === day ? used.count : 0;
  if (count >= DAILY_LIMIT) return false;
  lookupsToday.set(clientId, { day, count: count + 1 });
  return true;
}

/**
 * GET /api/w3w/convert?lat=51.5074&lng=-0.1278
 *
 * Server-side proxy for the What3Words convert-to-3wa endpoint.
 * Keeps the API key off the client; returns { words, nearestPlace, country, map }.
 * 503 when no key is set; 403 W3W_NEEDS_AI for a business without the AI add-on.
 */
router.get("/w3w/convert", requireAuth, async (req, res) => {
  const { lat, lng } = req.query as { lat?: string; lng?: string };

  if (!lat || !lng || isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) {
    return res.status(400).json({ error: "lat and lng query params are required" });
  }

  const apiKey = process.env.W3W_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "What3Words is not configured" });
  }

  const clientId = getClientId(req);
  if (!clientId) return res.status(400).json({ error: "No client context" });
  if (!(await includesWhat3Words(clientId))) {
    return res.status(403).json({ error: "Automatic what3words comes with the AI add-on", code: "W3W_NEEDS_AI" });
  }
  if (!takeLookup(clientId)) {
    return res.status(429).json({ error: "Daily what3words lookups used up; type the three words instead" });
  }

  const url =
    `https://api.what3words.com/v3/convert-to-3wa` +
    `?coordinates=${encodeURIComponent(lat)},${encodeURIComponent(lng)}` +
    `&language=en` +
    `&format=json` +
    `&key=${encodeURIComponent(apiKey)}`;

  let upstream: Response;
  let body: any;
  try {
    upstream = await fetch(url);
    body = await upstream.json();
  } catch {
    return res.status(502).json({ error: "W3W API unavailable" });
  }

  if (!upstream.ok || body.error) {
    const msg = body.error?.message ?? "W3W API error";
    return res.status(502).json({ error: msg });
  }

  res.json({
    words: body.words as string,               // e.g. "filled.count.soap"
    nearestPlace: body.nearestPlace as string,
    country: body.country as string,
    map: body.map as string,
  });
});

export default router;

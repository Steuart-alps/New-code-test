import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth";

const router = Router();

/**
 * GET /api/w3w/convert?lat=51.5074&lng=-0.1278
 *
 * Server-side proxy for the What3Words convert-to-3wa endpoint.
 * Keeps the API key off the client; returns { words, nearestPlace, country, map }.
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

  const url =
    `https://api.what3words.com/v3/convert-to-3wa` +
    `?coordinates=${encodeURIComponent(lat)},${encodeURIComponent(lng)}` +
    `&language=en` +
    `&format=json` +
    `&key=${apiKey}`;

  const upstream = await fetch(url);
  const body = await upstream.json() as any;

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

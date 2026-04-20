/**
 * Local HTTP server for the MTG search UI.
 *
 * Routes:
 *   GET /              → serves public/index.html
 *   GET /api/search    → runs a search query, returns JSON
 *   GET /api/keywords  → returns all keyword abilities + ability words for the picker UI
 *
 * Start with:  bun run ui
 * Then open:   http://localhost:3001
 */

import { getDb } from "./db";
import { buildQuery, type SearchOptions, ABILITY_WORDS } from "./query";
import { join } from "path";

const PORT = 3001;
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

// ── URL params → SearchOptions ───────────────────────────────────────────────

function paramsToOptions(p: URLSearchParams): SearchOptions {
  const splitComma = (key: string) =>
    (p.get(key) ?? "").split(",").map(s => s.trim()).filter(Boolean);

  return {
    name:          p.get("name")          || undefined,
    oracle:        p.get("oracle")        || undefined,
    text:          p.get("text")          || undefined,
    type:          p.get("type")          || undefined,
    colorsAny:     p.get("colors-any")    || undefined,
    colorsAll:     p.get("colors-all")    || undefined,
    colorsNot:     p.get("colors-not")    || undefined,
    ciAny:         p.get("ci-any")        || undefined,
    ciAll:         p.get("ci-all")        || undefined,
    ciNot:         p.get("ci-not")        || undefined,
    keyword:       splitComma("keyword"),
    keywordAny:    splitComma("keyword-any"),  // new: OR logic
    keywordNot:    splitComma("keyword-not"),
    cmc:           p.get("cmc")           || undefined,
    cmcMin:        p.get("cmc-min")       || undefined,
    cmcMax:        p.get("cmc-max")       || undefined,
    rarity:        p.get("rarity")        || undefined,
    format:        p.get("format")        || undefined,
    layout:        p.get("layout")        || undefined,
    powerMin:      p.get("power-min")     || undefined,
    toughnessMin:  p.get("toughness-min") || undefined,
    mainType:      p.get("main-type")    || undefined,
    legendary:     p.get("legendary") === "true",
    owned:         p.get("owned") === "true",
    unique:        p.get("unique") === "true",
    offset:        p.get("offset")        || "0",
    limit:         p.get("limit")         || "50",
    sort1:         p.get("sort1")         || undefined,
    sort1Dir:      p.get("sort1-dir")     || undefined,
    sort2:         p.get("sort2")         || undefined,
    sort2Dir:      p.get("sort2-dir")     || undefined,
    sort3:         p.get("sort3")         || undefined,
    sort3Dir:      p.get("sort3-dir")     || undefined,
  };
}

// ── Server ───────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,

  async fetch(req) {
    const url = new URL(req.url);

    // ── /api/stats ───────────────────────────────────────────────────────
    // Returns inventory totals without being capped by the search limit.
    if (url.pathname === "/api/stats") {
      const db = getDb();
      const row = db.prepare(`
        SELECT
          COUNT(DISTINCT c.name) AS unique_names,
          COALESCE(SUM(inv.quantity), 0) AS total_quantity
        FROM inventory inv
        JOIN cards c ON c.id = inv.scryfall_id
        WHERE inv.quantity > 0
      `).get() as { unique_names: number; total_quantity: number };
      return Response.json({
        uniqueNames: row.unique_names,
        totalQuantity: row.total_quantity,
      });
    }

    // ── /api/keywords ────────────────────────────────────────────────────
    // Returns two lists for the keyword picker UI:
    //   keywords     — pulled live from card_keywords table (what's actually in the DB)
    //   abilityWords — hardcoded list from query.ts; routed to oracle_text LIKE at query time
    if (url.pathname === "/api/keywords") {
      const db = getDb();
      const rows = db
        .prepare("SELECT DISTINCT keyword FROM card_keywords ORDER BY keyword")
        .all() as { keyword: string }[];

      return Response.json({
        keywords: rows.map(r => r.keyword),
        abilityWords: [...ABILITY_WORDS].sort(),
      });
    }

    // ── /api/search ──────────────────────────────────────────────────────
    if (url.pathname === "/api/search") {
      const db = getDb();
      const opts = paramsToOptions(url.searchParams);

      try {
        const { sql, params } = buildQuery(opts);
        const rows = db.prepare(sql).all(...params);
        return Response.json({
          count: rows.length,
          results: rows,
          _debug: { sql: sql.trim(), params },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: message }, { status: 400 });
      }
    }

    // ── Static files ──────────────────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(PUBLIC_DIR, "index.html")));
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\nMTG search UI ready → http://localhost:${PORT}\n`);

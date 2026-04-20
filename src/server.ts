/**
 * Local HTTP server for the MTG search UI.
 *
 * Routes:
 *   GET /                  → serves public/index.html
 *   GET /api/search        → runs a search query, returns JSON
 *   GET /api/keywords      → returns all keyword abilities + ability words for the picker UI
 *   GET /api/stats         → returns inventory totals (unique names + total quantity)
 *   GET /api/image         → proxy/cache a Scryfall card image (?id=&size=small|normal&save=0|1)
 *   GET /api/cache-stats   → returns image cache file counts and byte totals
 *   POST /api/cache-clear  → deletes cached images ({ size: "small"|"normal"|"all" })
 *
 * Start with:  bun run ui
 * Then open:   http://localhost:3001
 */

import { getDb } from "./db";
import { buildQuery, type SearchOptions, ABILITY_WORDS } from "./query";
import { join } from "path";
import { mkdirSync, readdirSync, statSync, rmSync, existsSync } from "fs";

const PORT = 3001;
const PUBLIC_DIR   = join(import.meta.dir, "..", "public");
const CACHE_DIR    = join(import.meta.dir, "..", "image_cache");
const CACHE_SMALL  = join(CACHE_DIR, "small");
const CACHE_NORMAL = join(CACHE_DIR, "normal");

// Ensure cache directories exist on startup
mkdirSync(CACHE_SMALL,  { recursive: true });
mkdirSync(CACHE_NORMAL, { recursive: true });

// ── Image cache helpers ───────────────────────────────────────────────────────

function cachePath(size: string, id: string): string {
  return join(size === "small" ? CACHE_SMALL : CACHE_NORMAL, `${id}.jpg`);
}

function scryfallUrl(size: string, id: string): string {
  // Scryfall URL pattern: /front/{first_char}/{second_char}/{uuid}.jpg
  return `https://cards.scryfall.io/${size}/front/${id[0]}/${id[1]}/${id}.jpg`;
}

function dirStats(dir: string): { count: number; bytes: number } {
  if (!existsSync(dir)) return { count: 0, bytes: 0 };
  const files = readdirSync(dir);
  let bytes = 0;
  for (const f of files) {
    try { bytes += statSync(join(dir, f)).size; } catch { /* skip */ }
  }
  return { count: files.length, bytes };
}

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
    keywordAny:    splitComma("keyword-any"),
    keywordNot:    splitComma("keyword-not"),
    cmc:           p.get("cmc")           || undefined,
    cmcMin:        p.get("cmc-min")       || undefined,
    cmcMax:        p.get("cmc-max")       || undefined,
    rarity:        p.get("rarity")        || undefined,
    format:        p.get("format")        || undefined,
    layout:        p.get("layout")        || undefined,
    powerMin:      p.get("power-min")     || undefined,
    toughnessMin:  p.get("toughness-min") || undefined,
    mainType:      p.get("main-type")     || undefined,
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

    // ── /api/image ───────────────────────────────────────────────────────
    // Proxy + optional cache for Scryfall card images.
    // ?id=<scryfall-uuid>  &size=small|normal  &save=0|1
    if (url.pathname === "/api/image") {
      const id   = url.searchParams.get("id")   ?? "";
      const size = url.searchParams.get("size")  ?? "small";
      const save = url.searchParams.get("save")  === "1";

      // Whitelist size to prevent path traversal
      if (size !== "small" && size !== "normal") {
        return new Response("Invalid size", { status: 400 });
      }
      // Validate id looks like a UUID (hex + dashes only)
      if (!/^[0-9a-f-]{30,40}$/.test(id)) {
        return new Response("Invalid id", { status: 400 });
      }

      const local = cachePath(size, id);

      // Serve from cache if present
      if (existsSync(local)) {
        return new Response(Bun.file(local), {
          headers: { "Content-Type": "image/jpeg", "X-Cache": "HIT" },
        });
      }

      // Fetch from Scryfall
      let remote: Response;
      try {
        remote = await fetch(scryfallUrl(size, id));
      } catch {
        return new Response("Upstream fetch failed", { status: 502 });
      }
      if (!remote.ok) {
        return new Response("Image not found upstream", { status: remote.status });
      }

      const bytes = await remote.arrayBuffer();

      if (save) {
        await Bun.write(local, bytes);
      }

      return new Response(bytes, {
        headers: { "Content-Type": "image/jpeg", "X-Cache": "MISS" },
      });
    }

    // ── /api/cache-stats ─────────────────────────────────────────────────
    if (url.pathname === "/api/cache-stats") {
      const sm = dirStats(CACHE_SMALL);
      const nm = dirStats(CACHE_NORMAL);
      return Response.json({
        smallCount:  sm.count,
        smallBytes:  sm.bytes,
        normalCount: nm.count,
        normalBytes: nm.bytes,
        totalBytes:  sm.bytes + nm.bytes,
      });
    }

    // ── /api/cache-clear ─────────────────────────────────────────────────
    if (url.pathname === "/api/cache-clear" && req.method === "POST") {
      let body: { size?: string } = {};
      try { body = await req.json() as { size?: string }; } catch (_) { /* default to all */ }
      const which = body.size ?? "all";

      const clear = (dir: string) => {
        if (!existsSync(dir)) return;
        for (const f of readdirSync(dir)) {
          rmSync(join(dir, f), { force: true });
        }
      };

      if (which === "small" || which === "all") clear(CACHE_SMALL);
      if (which === "normal" || which === "all") clear(CACHE_NORMAL);

      // Return updated stats
      const sm = dirStats(CACHE_SMALL);
      const nm = dirStats(CACHE_NORMAL);
      return Response.json({
        smallCount:  sm.count,
        smallBytes:  sm.bytes,
        normalCount: nm.count,
        normalBytes: nm.bytes,
        totalBytes:  sm.bytes + nm.bytes,
      });
    }

    // ── Static files ──────────────────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(PUBLIC_DIR, "index.html")));
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\nMTG search UI ready → http://localhost:${PORT}\n`);

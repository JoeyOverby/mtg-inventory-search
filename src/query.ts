/**
 * Pure query builder — no DB connection, no side effects.
 * Imported by both the CLI (search.ts) and the HTTP server (server.ts)
 * so the search logic lives in exactly one place.
 */

import { colorsToBits, parseColorArg } from "./db";

// ── Ability words ───────────────────────────────────────────────────────────
//
// Ability words are NOT keyword abilities. The MTG Comprehensive Rules define
// them as formatting labels with no rules meaning — they're printed to help
// players recognize patterns, but the actual rule lives in the clause after
// the em-dash (e.g. "Landfall — Whenever a land enters under your control…").
//
// Because they're not in the keywords array, we can't query them via the
// card_keywords table. Instead we do an oracle_text LIKE match.
// This set is exported so the server can send it to the UI for the picker.
export const ABILITY_WORDS = new Set([
  "Adamant", "Addendum", "Battalion", "Bloodrush", "Channel", "Chroma",
  "Cohort", "Constellation", "Converge", "Council's dilemma",
  "Delirium", "Domain", "Fateful hour", "Ferocious", "Formidable",
  "Grandeur", "Hellbent", "Heroic", "Imprint", "Inspired",
  "Join forces", "Kinship", "Landfall", "Lieutenant", "Magecraft",
  "Metalcraft", "Morbid", "Parley", "Radiance", "Raid", "Rally",
  "Revolt", "Spell mastery", "Strive", "Sweep", "Tempting offer",
  "Threshold", "Undergrowth", "Will of the council",
]);

// ── SearchOptions ────────────────────────────────────────────────────────────

export interface SearchOptions {
  name?: string;
  text?: string;       // FTS5 query: phrases, AND/OR/NOT, prefix*
  type?: string;
  colorsAny?: string;  // comma-separated color letters, e.g. "R,W"
  colorsAll?: string;
  colorsNot?: string;
  ciAny?: string;      // color identity variants (Commander)
  ciAll?: string;
  ciNot?: string;
  keyword: string[];    // ALL must be present (AND)
  keywordAny: string[]; // AT LEAST ONE must be present (OR)
  keywordNot: string[]; // NONE must be present
  cmc?: string;
  cmcMin?: string;
  cmcMax?: string;
  rarity?: string;
  format?: string;   // checks legalities_json, e.g. "commander"
  layout?: string;   // "normal" | "token" | "transform" | "split" | ...
  powerMin?: string;
  toughnessMin?: string;
  owned?: boolean;
  limit: string;
}

// ── Query builder ────────────────────────────────────────────────────────────

/**
 * Builds a parameterized SELECT from a SearchOptions object.
 * All active filters are joined with AND at the top level.
 *
 * Keywords vs ability words are handled transparently:
 *   - True keyword (Flying, Haste, etc.) → EXISTS on card_keywords table
 *   - Ability word (Landfall, Morbid, etc.) → oracle_text LIKE '%word%'
 *
 * Returns { sql, params } ready for:
 *   db.prepare(sql).all(...params)
 */
export function buildQuery(opts: SearchOptions): {
  sql: string;
  params: (string | number)[];
} {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  // ── Full-text search ─────────────────────────────────────────────────────
  // FTS5 content table spans name, type_line, and oracle_text.
  // Supports: "exact phrase"  AND/OR/NOT  goblin*
  if (opts.text) {
    conditions.push(
      "c.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)"
    );
    params.push(opts.text);
  }

  // ── Text filters ─────────────────────────────────────────────────────────
  if (opts.name) {
    conditions.push("c.name LIKE ? COLLATE NOCASE");
    params.push(`%${opts.name}%`);
  }

  if (opts.type) {
    conditions.push("c.type_line LIKE ? COLLATE NOCASE");
    params.push(`%${opts.type}%`);
  }

  // ── Color filters (bitmask) ──────────────────────────────────────────────
  // W=1 U=2 B=4 R=8 G=16 C=32
  //   ANY of R,W  →  (color_bits & 9) != 0
  //   ALL of R,W  →  (color_bits & 9) = 9
  //   NOT G       →  (color_bits & 16) = 0
  if (opts.colorsAny) {
    const mask = colorsToBits(parseColorArg(opts.colorsAny));
    if (mask) { conditions.push("(c.color_bits & ?) != 0"); params.push(mask); }
  }
  if (opts.colorsAll) {
    const mask = colorsToBits(parseColorArg(opts.colorsAll));
    if (mask) { conditions.push("(c.color_bits & ?) = ?"); params.push(mask, mask); }
  }
  if (opts.colorsNot) {
    const mask = colorsToBits(parseColorArg(opts.colorsNot));
    if (mask) { conditions.push("(c.color_bits & ?) = 0"); params.push(mask); }
  }

  if (opts.ciAny) {
    const mask = colorsToBits(parseColorArg(opts.ciAny));
    if (mask) { conditions.push("(c.color_identity_bits & ?) != 0"); params.push(mask); }
  }
  if (opts.ciAll) {
    const mask = colorsToBits(parseColorArg(opts.ciAll));
    if (mask) { conditions.push("(c.color_identity_bits & ?) = ?"); params.push(mask, mask); }
  }
  if (opts.ciNot) {
    const mask = colorsToBits(parseColorArg(opts.ciNot));
    if (mask) { conditions.push("(c.color_identity_bits & ?) = 0"); params.push(mask); }
  }

  // ── Keywords / ability words ─────────────────────────────────────────────
  //
  // True keywords live in card_keywords (one row per keyword per card).
  // Ability words live in oracle_text — routed to LIKE automatically.
  // The caller doesn't need to know or care which is which.

  function kwCondition(kw: string): { cond: string; param: string } {
    if (ABILITY_WORDS.has(kw)) {
      // Ability word: search oracle text. The word always appears before an em-dash
      // (e.g. "Landfall — ...") so a simple LIKE is reliable and fast enough.
      return { cond: "c.oracle_text LIKE ? COLLATE NOCASE", param: `%${kw}%` };
    }
    return {
      cond: "EXISTS (SELECT 1 FROM card_keywords ck WHERE ck.card_id = c.id AND ck.keyword = ? COLLATE NOCASE)",
      param: kw,
    };
  }

  // AND: card must match every selected keyword/ability-word
  for (const kw of opts.keyword) {
    const { cond, param } = kwCondition(kw);
    conditions.push(cond);
    params.push(param);
  }

  // ANY: card must match at least one — wrap all in a single OR clause
  if (opts.keywordAny.length > 0) {
    const orParts: string[] = [];
    for (const kw of opts.keywordAny) {
      const { cond, param } = kwCondition(kw);
      orParts.push(cond);
      params.push(param);
    }
    conditions.push(`(${orParts.join(" OR ")})`);
  }

  // NOT: card must match none
  for (const kw of opts.keywordNot) {
    if (ABILITY_WORDS.has(kw)) {
      conditions.push("c.oracle_text NOT LIKE ? COLLATE NOCASE");
      params.push(`%${kw}%`);
    } else {
      conditions.push(
        "NOT EXISTS (SELECT 1 FROM card_keywords ck WHERE ck.card_id = c.id AND ck.keyword = ? COLLATE NOCASE)"
      );
      params.push(kw);
    }
  }

  // ── CMC ──────────────────────────────────────────────────────────────────
  if (opts.cmc !== undefined && opts.cmc !== "") {
    conditions.push("c.cmc = ?"); params.push(parseFloat(opts.cmc));
  }
  if (opts.cmcMin !== undefined && opts.cmcMin !== "") {
    conditions.push("c.cmc >= ?"); params.push(parseFloat(opts.cmcMin));
  }
  if (opts.cmcMax !== undefined && opts.cmcMax !== "") {
    conditions.push("c.cmc <= ?"); params.push(parseFloat(opts.cmcMax));
  }

  // ── Other filters ─────────────────────────────────────────────────────────
  if (opts.rarity) {
    conditions.push("c.rarity = ?");
    params.push(opts.rarity.toLowerCase());
  }

  // legalities_json is {"commander":"legal","modern":"not_legal",...}
  if (opts.format) {
    conditions.push("json_extract(c.legalities_json, '$.' || ?) = 'legal'");
    params.push(opts.format.toLowerCase());
  }

  if (opts.layout) {
    conditions.push("c.layout = ?");
    params.push(opts.layout.toLowerCase());
  }

  // CAST: cards with "*" or "X" power silently become 0
  if (opts.powerMin !== undefined && opts.powerMin !== "") {
    conditions.push("CAST(c.power AS INTEGER) >= ?");
    params.push(parseInt(opts.powerMin));
  }
  if (opts.toughnessMin !== undefined && opts.toughnessMin !== "") {
    conditions.push("CAST(c.toughness AS INTEGER) >= ?");
    params.push(parseInt(opts.toughnessMin));
  }

  // ── Owned ─────────────────────────────────────────────────────────────────
  if (opts.owned) {
    conditions.push(
      "EXISTS (SELECT 1 FROM inventory inv WHERE inv.scryfall_id = c.id AND inv.quantity > 0)"
    );
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  const where = conditions.length
    ? `WHERE ${conditions.join("\n    AND ")}`
    : "";

  const limit = Math.max(1, Math.min(parseInt(opts.limit) || 100, 500));
  params.push(limit);

  const sql = `
    SELECT
      c.name, c.set_code, c.collector_number,
      c.mana_cost, c.cmc, c.type_line, c.oracle_text,
      c.power, c.toughness, c.rarity, c.layout,
      c.colors_json, c.color_identity_json, c.keywords_json,
      c.price_usd, c.image_normal,
      inv.quantity, inv.condition AS inv_condition
    FROM cards c
    LEFT JOIN inventory inv ON inv.scryfall_id = c.id
    ${where}
    ORDER BY c.name, c.released_at DESC
    LIMIT ?
  `;

  return { sql, params };
}

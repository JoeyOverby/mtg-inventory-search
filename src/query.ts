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
  oracle?: string;     // oracle_text LIKE substring match (simple, reliable)
  text?: string;       // FTS5 query: phrases, AND/OR/NOT, prefix* (CLI / advanced)
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
  mainType?: string;  // structured type dropdown: Creature, Land, Artifact, etc.
  legendary?: boolean; // filter for the Legendary supertype
  owned?: boolean;
  unique?: boolean;  // collapse printings: one row per card name, list owned sets
  offset?: string;   // pagination: number of rows to skip (default 0)
  limit: string;
  sort1?: string; sort1Dir?: string;
  sort2?: string; sort2Dir?: string;
  sort3?: string; sort3Dir?: string;
}

// ── Sort expressions ────────────────────────────────────────────────────────
// Each key maps to SQL expressions for normal mode and GROUP BY (unique) mode.
// Unique mode must use aggregate functions because of GROUP BY c.name.

const RARITY_CASE = `CASE c.rarity WHEN 'common' THEN 1 WHEN 'uncommon' THEN 2 WHEN 'rare' THEN 3 WHEN 'mythic' THEN 4 ELSE 0 END`;

const SORT_EXPRS: Record<string, { normal: string; unique: string }> = {
  name:      { normal: "c.name",                                               unique: "c.name" },
  cmc:       { normal: "c.cmc",                                                unique: "MIN(c.cmc)" },
  type:      { normal: "c.type_line",                                          unique: "MIN(c.type_line)" },
  color:     { normal: "c.color_bits",                                         unique: "MIN(c.color_bits)" },
  rarity:    { normal: RARITY_CASE,                                            unique: `MIN(${RARITY_CASE})` },
  set:       { normal: "c.released_at",                                        unique: "MAX(c.released_at)" },
  price:     { normal: "CAST(COALESCE(c.price_usd,'0') AS REAL)",              unique: "CAST(COALESCE(MAX(c.price_usd),'0') AS REAL)" },
  quantity:  { normal: "COALESCE(inv.quantity,0)",                             unique: "SUM(CASE WHEN inv.quantity > 0 THEN inv.quantity ELSE 0 END)" },
  power:     { normal: "CAST(COALESCE(c.power,'0') AS INTEGER)",               unique: "CAST(COALESCE(MIN(c.power),'0') AS INTEGER)" },
  toughness: { normal: "CAST(COALESCE(c.toughness,'0') AS INTEGER)",           unique: "CAST(COALESCE(MIN(c.toughness),'0') AS INTEGER)" },
};

function buildOrderBy(
  sorts: Array<{ key?: string; dir?: string }>,
  isUnique: boolean,
): string {
  const parts: string[] = [];
  for (const { key, dir } of sorts) {
    if (!key || !SORT_EXPRS[key]) continue;
    const expr = isUnique ? SORT_EXPRS[key].unique : SORT_EXPRS[key].normal;
    parts.push(`${expr} ${dir === "desc" ? "DESC" : "ASC"}`);
  }
  if (!parts.length) {
    return isUnique
      ? "ORDER BY c.name ASC"
      : "ORDER BY c.name ASC, c.released_at DESC";
  }
  return `ORDER BY ${parts.join(", ")}`;
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

  // ── Oracle text substring search (LIKE) ──────────────────────────────────
  // Simple case-insensitive substring match on oracle_text.
  // "goblin creature token" matches "Goblin creature tokens." reliably.
  if (opts.oracle) {
    const oracleClean = opts.oracle.replace(/^["']+|["']+$/g, "").trim();
    if (oracleClean) {
      conditions.push("c.oracle_text LIKE ? COLLATE NOCASE");
      params.push(`%${oracleClean}%`);
    }
  }

  // ── Full-text search (FTS5) ───────────────────────────────────────────────
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

  // ── Card type / supertype ────────────────────────────────────────────────
  // mainType is a structured pick (Creature, Land, etc.) — same LIKE logic as
  // the free-form `type` filter but kept separate so both can be active at once.
  if (opts.mainType) {
    conditions.push("c.type_line LIKE ? COLLATE NOCASE");
    params.push(`%${opts.mainType}%`);
  }

  if (opts.legendary) {
    conditions.push("c.type_line LIKE '%Legendary%' COLLATE NOCASE");
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

  const limit  = Math.max(1, Math.min(parseInt(opts.limit) || 50, 1000));
  const offset = Math.max(0, parseInt(opts.offset || "0") || 0);
  params.push(limit, offset);

  const userSorts = [
    { key: opts.sort1, dir: opts.sort1Dir },
    { key: opts.sort2, dir: opts.sort2Dir },
    { key: opts.sort3, dir: opts.sort3Dir },
  ];

  let sql: string;

  if (opts.unique) {
    const orderBy = buildOrderBy(userSorts, true);
    sql = `
      SELECT
        c.name,
        NULL                                         AS set_code,
        NULL                                         AS collector_number,
        MIN(c.mana_cost)                             AS mana_cost,
        MIN(c.cmc)                                   AS cmc,
        MIN(c.type_line)                             AS type_line,
        MIN(c.oracle_text)                           AS oracle_text,
        MIN(c.power)                                 AS power,
        MIN(c.toughness)                             AS toughness,
        MIN(c.rarity)                                AS rarity,
        MIN(c.layout)                                AS layout,
        MIN(c.colors_json)                           AS colors_json,
        MIN(c.color_identity_json)                   AS color_identity_json,
        MIN(c.keywords_json)                         AS keywords_json,
        MAX(c.price_usd)                             AS price_usd,
        COALESCE(
          MIN(CASE WHEN inv.quantity > 0 THEN c.image_normal ELSE NULL END),
          MIN(c.image_normal)
        )                                            AS image_normal,
        COALESCE('[' || GROUP_CONCAT(
          CASE WHEN inv.quantity > 0
               THEN json_object(
                 'label', UPPER(c.set_code) || ' ×' || inv.quantity
                          || ' (' || COALESCE(inv.condition, '?') || ')',
                 'img', COALESCE(c.image_normal, '')
               )
               ELSE NULL END,
          ','
        ) || ']', '[]')                              AS owned_sets_json,
        SUM(CASE WHEN inv.quantity > 0 THEN inv.quantity ELSE 0 END) AS quantity,
        NULL                                         AS inv_condition
      FROM cards c
      LEFT JOIN inventory inv ON inv.scryfall_id = c.id
      ${where}
      GROUP BY c.name
      ${orderBy}
      LIMIT ? OFFSET ?
    `;
  } else {
    const orderBy = buildOrderBy(userSorts, false);
    sql = `
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
      ${orderBy}
      LIMIT ? OFFSET ?
    `;
  }

  return { sql, params };
}

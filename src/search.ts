/**
 * CLI search tool.
 * The query logic lives in query.ts and is shared with server.ts.
 * This file only handles CLI argument parsing and terminal output formatting.
 *
 * Usage:
 *   bun run search -- [flags]
 *   bun run search -- --help
 */

import { Command } from "commander";
import { getDb } from "./db";
import { buildQuery, type SearchOptions } from "./query";

// ── Terminal output ─────────────────────────────────────────────────────────

const RARITY_CHAR: Record<string, string> = {
  common: "C", uncommon: "U", rare: "R", mythic: "M",
};

function formatCard(row: Record<string, unknown>): string {
  const colors = (JSON.parse(row.colors_json as string || "[]") as string[]).join("") || "—";
  const keywords = JSON.parse(row.keywords_json as string || "[]") as string[];
  const pt = row.power ? ` (${row.power}/${row.toughness})` : "";
  const rarity = RARITY_CHAR[row.rarity as string] ?? "?";
  const set = `${String(row.set_code).toUpperCase()} #${row.collector_number}`;

  const lines: (string | null)[] = [
    `\n── ${row.name}  [${set}] (${rarity})`,
    `   ${row.mana_cost || "(no cost)"}  CMC ${row.cmc}  Colors: ${colors}${pt}`,
    `   ${row.type_line}`,
  ];

  if (row.oracle_text) {
    // Condense newlines so multi-paragraph text stays on one visual block
    const text = (row.oracle_text as string).replace(/\n/g, " / ");
    lines.push(`   "${text}"`);
  }

  if (keywords.length) {
    lines.push(`   Keywords: ${keywords.join(", ")}`);
  }

  if (row.price_usd) lines.push(`   $${row.price_usd} USD`);

  if (row.quantity != null) {
    lines.push(`   ★ Owned: ${row.quantity}x  (${row.inv_condition})`);
  }

  return lines.filter(Boolean).join("\n");
}

// ── CLI definition ──────────────────────────────────────────────────────────

const program = new Command();

program
  .name("mtg search")
  .description("Search your MTG card collection from the terminal")
  .option("--name <text>",         "card name contains (case-insensitive)")
  .option("--text <fts>",          [
    "oracle/type/name FTS5 query. Supports:",
    "  phrases:   \"goblin token\"",
    '  boolean:   "goblin token" OR "goblin creature token"',
    "  prefix:    goblin*",
    "  negation:  flying NOT trample",
  ].join("\n"))
  .option("--type <text>",         "type line contains  e.g. Goblin, Creature")
  .option("--colors-any <colors>", "has ANY of these colors  e.g. R,W")
  .option("--colors-all <colors>", "has ALL of these colors  e.g. R,W,U")
  .option("--colors-not <colors>", "excludes these colors    e.g. G,B")
  .option("--ci-any <colors>",     "color identity has ANY of  (Commander-style)")
  .option("--ci-all <colors>",     "color identity has ALL of")
  .option("--ci-not <colors>",     "color identity excludes")
  .option("--keyword <kw>",
    "has keyword/ability-word — repeatable, ALL must be present (AND)\n  e.g. --keyword Flying --keyword Landfall",
    (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--keyword-any <kw>",
    "has keyword/ability-word — repeatable, AT LEAST ONE must be present (OR)\n  e.g. --keyword-any Flying --keyword-any Haste",
    (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--keyword-not <kw>",
    "lacks keyword/ability-word — repeatable",
    (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option("--cmc <n>",             "exact converted mana cost")
  .option("--cmc-min <n>",         "minimum CMC")
  .option("--cmc-max <n>",         "maximum CMC")
  .option("--rarity <r>",          "common | uncommon | rare | mythic")
  .option("--format <f>",          "legal in format  e.g. commander, modern")
  .option("--layout <l>",          "normal | token | transform | split | ...")
  .option("--power-min <n>",       "power >= n  (numeric cards only)")
  .option("--toughness-min <n>",   "toughness >= n")
  .option("--owned",               "only show cards in your inventory")
  .option("--limit <n>",           "max results (default 50, capped at 500)", "50")
  .action((opts: SearchOptions) => {
    const db = getDb();
    const { sql, params } = buildQuery(opts);

    let rows: Record<string, unknown>[];
    try {
      rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    } catch (err) {
      // Most common cause: malformed FTS query (unbalanced quotes, etc.)
      console.error("Query error:", (err as Error).message);
      console.error(
        "If using --text, wrap FTS phrases in quotes: --text '\"goblin token\"'"
      );
      process.exit(1);
    }

    if (!rows.length) {
      console.log("No cards found matching those filters.");
      return;
    }

    rows.forEach(row => console.log(formatCard(row)));

    const limitN = parseInt(opts.limit) || 50;
    const extra =
      rows.length === limitN
        ? `  (hit limit — use --limit N to see more)`
        : "";
    console.log(`\n${rows.length} result(s)${extra}`);
  });

program.parse();

import { getDb, initSchema, colorsToBits } from "./db";
import { readdirSync } from "fs";
import { join } from "path";

interface ScryfallCard {
  id: string;
  oracle_id?: string;
  name: string;
  set: string;
  collector_number: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  rarity?: string;
  layout?: string;
  released_at?: string;
  colors?: string[];
  color_identity?: string[];
  keywords?: string[];
  legalities?: Record<string, string>;
  image_uris?: { normal?: string };
  prices?: { usd?: string | null };
  card_faces?: Array<{
    oracle_text?: string;
    mana_cost?: string;
  }>;
}

function findScryfallFile(): string {
  const dir = join(import.meta.dir, "..", "allCards");
  const files = readdirSync(dir)
    .filter(f => f.startsWith("default-cards") && f.endsWith(".json"))
    .sort()
    .reverse();
  if (!files.length) throw new Error("No default-cards-*.json found in allCards/");
  return join(dir, files[0]);
}

async function main() {
  const db = getDb();
  initSchema(db);

  const filePath = findScryfallFile();
  console.log(`Reading ${filePath} (~500MB, takes 15-30s)...`);

  const cards: ScryfallCard[] = await Bun.file(filePath).json();
  console.log(`Parsed ${cards.length.toLocaleString()} cards. Writing to SQLite...`);

  db.exec("DELETE FROM card_keywords");
  db.exec("DELETE FROM cards");

  const insertCard = db.prepare(`
    INSERT INTO cards (
      id, oracle_id, name, set_code, collector_number,
      mana_cost, cmc, type_line, oracle_text,
      power, toughness, rarity, layout, released_at,
      color_bits, color_identity_bits,
      colors_json, color_identity_json, keywords_json, legalities_json,
      image_normal, price_usd
    ) VALUES (
      $id, $oracle_id, $name, $set_code, $collector_number,
      $mana_cost, $cmc, $type_line, $oracle_text,
      $power, $toughness, $rarity, $layout, $released_at,
      $color_bits, $color_identity_bits,
      $colors_json, $color_identity_json, $keywords_json, $legalities_json,
      $image_normal, $price_usd
    )
  `);

  const insertKeyword = db.prepare(`
    INSERT OR IGNORE INTO card_keywords (card_id, keyword) VALUES ($card_id, $keyword)
  `);

  const BATCH_SIZE = 1000;
  let processed = 0;

  const importBatch = db.transaction((batch: ScryfallCard[]) => {
    for (const card of batch) {
      const colors = card.colors ?? [];
      const colorIdentity = card.color_identity ?? [];
      const keywords = card.keywords ?? [];

      // Double-faced cards store oracle_text and mana_cost inside card_faces
      const oracleText =
        card.oracle_text ??
        card.card_faces?.map(f => f.oracle_text ?? "").join("\n//\n") ??
        "";
      const manaCost =
        card.mana_cost ?? card.card_faces?.[0]?.mana_cost ?? "";

      insertCard.run({
        $id: card.id,
        $oracle_id: card.oracle_id ?? null,
        $name: card.name,
        $set_code: card.set,
        $collector_number: card.collector_number,
        $mana_cost: manaCost,
        $cmc: card.cmc ?? 0,
        $type_line: card.type_line ?? "",
        $oracle_text: oracleText,
        $power: card.power ?? null,
        $toughness: card.toughness ?? null,
        $rarity: card.rarity ?? "",
        $layout: card.layout ?? "normal",
        $released_at: card.released_at ?? "",
        $color_bits: colorsToBits(colors),
        $color_identity_bits: colorsToBits(colorIdentity),
        $colors_json: JSON.stringify(colors),
        $color_identity_json: JSON.stringify(colorIdentity),
        $keywords_json: JSON.stringify(keywords),
        $legalities_json: JSON.stringify(card.legalities ?? {}),
        $image_normal: card.image_uris?.normal ?? null,
        $price_usd: card.prices?.usd ?? null,
      });

      for (const kw of keywords) {
        insertKeyword.run({ $card_id: card.id, $keyword: kw });
      }
    }
  });

  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    importBatch(cards.slice(i, i + BATCH_SIZE));
    processed = Math.min(i + BATCH_SIZE, cards.length);
    process.stdout.write(`\r  ${processed.toLocaleString()} / ${cards.length.toLocaleString()}`);
  }

  console.log("\nRebuilding full-text search index...");
  db.exec("INSERT INTO cards_fts(cards_fts) VALUES('rebuild')");
  console.log(`Done. ${processed.toLocaleString()} cards imported into mtg.db`);
}

main().catch(err => { console.error(err); process.exit(1); });

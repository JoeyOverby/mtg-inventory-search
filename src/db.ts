import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "..", "mtg.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec("PRAGMA journal_mode = WAL");
    _db.exec("PRAGMA synchronous = NORMAL");
    _db.exec("PRAGMA foreign_keys = ON");
    _db.exec("PRAGMA cache_size = -32000");
  }
  return _db;
}

// W=1, U=2, B=4, R=8, G=16, C=32
export const COLOR_BITS: Record<string, number> = {
  W: 1, U: 2, B: 4, R: 8, G: 16, C: 32,
};

export function colorsToBits(colors: string[]): number {
  return colors.reduce((acc, c) => acc | (COLOR_BITS[c.toUpperCase()] ?? 0), 0);
}

export function parseColorArg(arg: string): string[] {
  return arg
    .toUpperCase()
    .split(",")
    .map(s => s.trim())
    .filter(s => s in COLOR_BITS);
}

export function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cards (
      id                   TEXT PRIMARY KEY,
      oracle_id            TEXT,
      name                 TEXT NOT NULL,
      set_code             TEXT NOT NULL,
      collector_number     TEXT NOT NULL,
      mana_cost            TEXT NOT NULL DEFAULT '',
      cmc                  REAL NOT NULL DEFAULT 0,
      type_line            TEXT NOT NULL DEFAULT '',
      oracle_text          TEXT NOT NULL DEFAULT '',
      power                TEXT,
      toughness            TEXT,
      rarity               TEXT NOT NULL DEFAULT '',
      layout               TEXT NOT NULL DEFAULT 'normal',
      released_at          TEXT NOT NULL DEFAULT '',
      color_bits           INTEGER NOT NULL DEFAULT 0,
      color_identity_bits  INTEGER NOT NULL DEFAULT 0,
      colors_json          TEXT NOT NULL DEFAULT '[]',
      color_identity_json  TEXT NOT NULL DEFAULT '[]',
      keywords_json        TEXT NOT NULL DEFAULT '[]',
      legalities_json      TEXT NOT NULL DEFAULT '{}',
      image_normal         TEXT,
      price_usd            TEXT
    );

    CREATE TABLE IF NOT EXISTS card_keywords (
      card_id  TEXT NOT NULL REFERENCES cards(id),
      keyword  TEXT NOT NULL,
      PRIMARY KEY (card_id, keyword)
    );

    -- FTS5 content table: index lives here, text is read from cards on search
    CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
      name,
      type_line,
      oracle_text,
      content=cards,
      content_rowid=rowid
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      card_name        TEXT NOT NULL,
      set_code         TEXT NOT NULL,
      collector_number TEXT NOT NULL,
      quantity         INTEGER NOT NULL DEFAULT 1,
      trade_quantity   INTEGER NOT NULL DEFAULT 0,
      condition        TEXT,
      printing         TEXT,
      language         TEXT,
      price_bought     REAL,
      date_bought      TEXT,
      price_low        REAL,
      price_mid        REAL,
      price_market     REAL,
      scryfall_id      TEXT REFERENCES cards(id)
    );

    CREATE INDEX IF NOT EXISTS idx_cards_set_num    ON cards(set_code, collector_number);
    CREATE INDEX IF NOT EXISTS idx_cards_name       ON cards(name);
    CREATE INDEX IF NOT EXISTS idx_cards_color      ON cards(color_bits);
    CREATE INDEX IF NOT EXISTS idx_cards_ci         ON cards(color_identity_bits);
    CREATE INDEX IF NOT EXISTS idx_cards_cmc        ON cards(cmc);
    CREATE INDEX IF NOT EXISTS idx_keywords_kw      ON card_keywords(keyword);
    CREATE INDEX IF NOT EXISTS idx_inventory_sid    ON inventory(scryfall_id);
  `);
}

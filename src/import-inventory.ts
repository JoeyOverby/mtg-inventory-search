import { getDb, initSchema } from "./db";
import { readdirSync, readFileSync } from "fs";
import { join, basename } from "path";
import Papa from "papaparse";

function findLatestInventory(): string {
  const dir = join(import.meta.dir, "..", "inventory");
  const files = readdirSync(dir)
    .filter(f => f.endsWith(".csv"))
    .sort()
    .reverse();
  if (!files.length) throw new Error("No CSV found in inventory/");
  return join(dir, files[0]);
}

function main() {
  const db = getDb();
  initSchema(db);

  const csvPath = findLatestInventory();
  console.log(`Importing ${basename(csvPath)}...`);

  let raw = readFileSync(csvPath, "utf-8");
  // Strip the Excel "sep=," metadata line that Manabox/Deckbox exports add
  if (raw.startsWith('"sep=') || raw.startsWith("sep=")) {
    raw = raw.slice(raw.indexOf("\n") + 1);
  }

  const { data, errors } = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
  });

  if (errors.length) {
    console.warn(`CSV parse warnings: ${errors.length} row(s) skipped`);
  }

  db.exec("DELETE FROM inventory");

  const insert = db.prepare(`
    INSERT INTO inventory (
      card_name, set_code, collector_number,
      quantity, trade_quantity, condition, printing, language,
      price_bought, date_bought, price_low, price_mid, price_market,
      scryfall_id
    ) VALUES (
      $card_name, $set_code, $collector_number,
      $quantity, $trade_quantity, $condition, $printing, $language,
      $price_bought, $date_bought, $price_low, $price_mid, $price_market,
      (SELECT id FROM cards WHERE set_code = $set_code AND collector_number = $collector_number LIMIT 1)
    )
  `);

  const checkCard = db.prepare(
    "SELECT id FROM cards WHERE set_code = ? AND collector_number = ? LIMIT 1"
  );

  let matched = 0;
  const unmatched: string[] = [];

  const importAll = db.transaction(() => {
    for (const row of data) {
      const setCode = (row["Set Code"] ?? "").toLowerCase().trim();
      const collectorNum = (row["Card Number"] ?? "").trim();

      const found = checkCard.get(setCode, collectorNum) as { id: string } | null;
      if (found) matched++;
      else unmatched.push(`${row["Card Name"]} (${setCode.toUpperCase()} #${collectorNum})`);

      insert.run({
        $card_name: row["Card Name"] ?? "",
        $set_code: setCode,
        $collector_number: collectorNum,
        $quantity: parseInt(row["Quantity"]) || 1,
        $trade_quantity: parseInt(row["Trade Quantity"]) || 0,
        $condition: row["Condition"] || null,
        $printing: row["Printing"] || null,
        $language: row["Language"] || null,
        $price_bought: parseFloat(row["Price Bought"]) || null,
        $date_bought: row["Date Bought"] || null,
        $price_low: parseFloat(row["LOW"]) || null,
        $price_mid: parseFloat(row["MID"]) || null,
        $price_market: parseFloat(row["MARKET"]) || null,
      });
    }
  });

  importAll();

  console.log(`Imported ${data.length} rows.`);
  console.log(`  Matched to Scryfall DB: ${matched} / ${data.length}`);

  if (unmatched.length) {
    console.log(`  Unmatched (${unmatched.length}) — saved but won't appear in --owned searches:`);
    unmatched.slice(0, 10).forEach(u => console.log(`    - ${u}`));
    if (unmatched.length > 10) {
      console.log(`    ... and ${unmatched.length - 10} more`);
    }
  }
}

main();

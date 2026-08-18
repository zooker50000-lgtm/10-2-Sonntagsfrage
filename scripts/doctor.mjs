#!/usr/bin/env node
/**
 * Prüft die Voraussetzungen auf dem Mac, ohne dass ein MCP-Client dazwischen
 * steht — der schnellste Weg, ein Rechte- oder Build-Problem einzugrenzen.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const check = (label, ok, detail = "") =>
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);

console.log("apple-notes-mcp doctor\n");

check("Betriebssystem ist macOS", process.platform === "darwin", `erkannt: ${process.platform}`);

const major = Number(process.versions.node.split(".")[0]);
check("Node ≥ 18", major >= 18, `v${process.versions.node}`);

const built = existsSync(join(root, "dist", "index.js")) && existsSync(join(root, "dist", "jxa", "notes.js"));
check("Build vorhanden (dist/)", built, built ? "" : "`npm run build` ausführen");

if (process.platform !== "darwin") {
  console.log("\nApple Notes ist nur auf macOS verfügbar — hier endet der Test.");
  process.exit(built ? 0 : 1);
}

const { runJxa, NotesError } = await import(join(root, "dist", "jxa.js"));

try {
  const status = await runJxa("ping");
  check("Apple Notes erreichbar", true, `${status.noteCount} Notizen in ${status.folderCount} Ordnern`);
  console.log(`   Accounts: ${status.accounts.filter(Boolean).join(", ") || "-"}`);
  console.log("\nAlles bereit. Server starten mit: npm start");
} catch (error) {
  check("Apple Notes erreichbar", false, error instanceof NotesError ? error.message : String(error));
  if (error instanceof NotesError && error.hint) console.log(`   → ${error.hint}`);
  process.exit(1);
}

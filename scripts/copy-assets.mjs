// tsc ignoriert .js-Dateien unter src/ — das JXA-Skript muss von Hand
// nach dist/ wandern, sonst findet der Runner es zur Laufzeit nicht.
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "dist", "jxa");

await mkdir(target, { recursive: true });
await cp(join(root, "src", "jxa"), target, { recursive: true });

console.log("JXA-Skript nach dist/jxa kopiert.");

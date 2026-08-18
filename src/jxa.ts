import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));

/** Nach dem Build liegt das Skript in dist/jxa, im ts-node-Betrieb in src/jxa. */
const SCRIPT_PATH = [join(here, "jxa", "notes.js"), join(here, "..", "src", "jxa", "notes.js")].find(
  (candidate) => existsSync(candidate),
);

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export class NotesError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "NotesError";
  }
}

type JxaResponse<T> = { ok: true; data: T } | { ok: false; error: string; message: string };

/**
 * macOS meldet fehlende Automatisierungsrechte nur als nackte Fehlernummer.
 * Ohne Uebersetzung landet der Nutzer bei "execution error: -1743".
 */
function translateOsascriptFailure(stderr: string): NotesError {
  const text = stderr.trim();

  if (text.includes("-1743") || text.includes("Not authorized")) {
    return new NotesError(
      "macOS erlaubt diesem Prozess keine Steuerung von Apple Notes.",
      "not_authorized",
      'Systemeinstellungen → Datenschutz & Sicherheit → Automatisierung: den Eintrag für Terminal bzw. Claude aufklappen und "Notizen" aktivieren. Danach den MCP-Server neu starten.',
    );
  }

  if (text.includes("-600") || text.includes("Application isn't running")) {
    return new NotesError("Apple Notes konnte nicht gestartet werden.", "notes_unavailable", "Notes.app einmal manuell öffnen und den Aufruf wiederholen.");
  }

  if (text.includes("-1728")) {
    return new NotesError("Das angeforderte Objekt existiert in Apple Notes nicht (mehr).", "not_found");
  }

  return new NotesError(text || "osascript ist ohne Meldung fehlgeschlagen.", "osascript_failed");
}

export async function runJxa<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
  if (process.platform !== "darwin") {
    throw new NotesError(
      `Apple Notes gibt es nur auf macOS — dieser Prozess läuft auf "${process.platform}".`,
      "unsupported_platform",
      "Den MCP-Server auf dem Mac starten und Claude von dort aus verbinden.",
    );
  }

  if (!SCRIPT_PATH) {
    throw new NotesError(
      "Das JXA-Skript notes.js wurde nicht gefunden.",
      "script_missing",
      "`npm run build` ausführen — der Build kopiert src/jxa nach dist/jxa.",
    );
  }

  const argument = JSON.stringify({ op, ...params });

  let stdout: string;
  try {
    const result = await execFileAsync("osascript", ["-l", "JavaScript", SCRIPT_PATH, argument], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };

    if (failure.killed) {
      throw new NotesError(
        `Apple Notes hat nicht innerhalb von ${TIMEOUT_MS / 1000}s geantwortet.`,
        "timeout",
        "Bei sehr großen Bibliotheken hilft es, die Anfrage mit `folder` einzugrenzen.",
      );
    }
    if (failure.code === "ENOENT") {
      throw new NotesError("osascript wurde nicht gefunden.", "osascript_missing");
    }
    throw translateOsascriptFailure(failure.stderr ?? failure.message ?? "");
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new NotesError("Apple Notes hat eine leere Antwort geliefert.", "empty_response");
  }

  let payload: JxaResponse<T>;
  try {
    payload = JSON.parse(trimmed) as JxaResponse<T>;
  } catch {
    throw new NotesError(`Antwort von Apple Notes war kein JSON: ${trimmed.slice(0, 400)}`, "bad_response");
  }

  if (!payload.ok) {
    throw new NotesError(payload.message, payload.error);
  }
  return payload.data;
}

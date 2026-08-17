#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { NotesError } from "./jxa.js";
import * as notes from "./notes.js";
import type { FolderInfo, NoteDetail, NoteSummary } from "./notes.js";

const VERSION = "0.1.0";

const formatEnum = z.enum(["markdown", "text", "html"]);

const folderArg = z
  .string()
  .describe('Ordnername oder Pfad, z. B. "Notizen" oder "iCloud/Projekte/2026". Leer = Standardordner.');

const accountArg = z.string().describe('Account-Name, z. B. "iCloud". Nur nötig bei mehreren Accounts.');

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

/**
 * Fehler werden als Tool-Ergebnis zurückgegeben, nicht geworfen: das Modell
 * soll den Hinweis (fehlende Automatisierungsrechte, falscher Ordner) lesen und
 * darauf reagieren können, statt nur ein abgebrochenes Tool zu sehen.
 */
async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof NotesError) {
      const hint = error.hint ? `\n\nSo lässt es sich beheben: ${error.hint}` : "";
      return { content: [{ type: "text", text: `Fehler (${error.code}): ${error.message}${hint}` }], isError: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Unerwarteter Fehler: ${message}` }], isError: true };
  }
}

function formatSummary(note: NoteSummary): string {
  const parts = [`• ${note.title}`, `  id: ${note.id}`];
  const meta = [note.folder ? `Ordner: ${note.folder}` : null, note.modified ? `geändert: ${note.modified}` : null]
    .filter(Boolean)
    .join(" | ");
  if (meta) parts.push(`  ${meta}`);
  if (note.locked) parts.push("  🔒 passwortgeschützt");
  if (note.snippet) parts.push(`  ${note.snippet}`);
  return parts.join("\n");
}

function formatList(items: NoteSummary[], header: string): string {
  if (!items.length) return `${header}\n(keine Treffer)`;
  return `${header}\n\n${items.map(formatSummary).join("\n\n")}`;
}

function formatDetail(note: NoteDetail): string {
  const head = [
    `Titel: ${note.title}`,
    `ID: ${note.id}`,
    `Ordner: ${note.folder ?? "-"}`,
    `Erstellt: ${note.created ?? "-"}`,
    `Geändert: ${note.modified ?? "-"}`,
  ].join("\n");
  const extra = note.note ? `\n\n${note.note}` : "";
  const html = note.html ? `\n\n--- HTML ---\n${note.html}` : "";
  return `${head}\n\n--- Inhalt ---\n${note.text || "(leer)"}${extra}${html}`;
}

function formatFolders(folders: FolderInfo[]): string {
  if (!folders.length) return "Keine Ordner gefunden.";
  const byAccount = new Map<string, FolderInfo[]>();
  for (const folder of folders) {
    const bucket = byAccount.get(folder.account) ?? [];
    bucket.push(folder);
    byAccount.set(folder.account, bucket);
  }
  const blocks: string[] = [];
  for (const [account, list] of byAccount) {
    const rows = list
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((folder) => `  ${folder.path} (${folder.noteCount} Notizen)`);
    blocks.push(`Account ${account}:\n${rows.join("\n")}`);
  }
  return blocks.join("\n\n");
}

const server = new McpServer({ name: "apple-notes", version: VERSION });

server.registerTool(
  "notes_status",
  {
    title: "Verbindung prüfen",
    description:
      "Prüft, ob Apple Notes erreichbar ist, und liefert Accounts sowie Anzahl von Ordnern und Notizen. Gut als erster Aufruf, um Rechteprobleme zu erkennen.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () =>
    guard(async () => {
      const status = await notes.ping();
      return text(
        [
          "Apple Notes ist erreichbar.",
          `Notes-Version: ${status.version ?? "unbekannt"}`,
          `Accounts: ${status.accounts.filter(Boolean).join(", ") || "-"}`,
          `Ordner: ${status.folderCount}`,
          `Notizen: ${status.noteCount}`,
        ].join("\n"),
      );
    }),
);

server.registerTool(
  "list_folders",
  {
    title: "Ordner auflisten",
    description: "Listet alle Ordner aller Notes-Accounts inklusive Unterordner-Pfaden und Notizanzahl.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () =>
    guard(async () => {
      const { folders } = await notes.listFolders();
      return text(formatFolders(folders));
    }),
);

server.registerTool(
  "list_notes",
  {
    title: "Notizen auflisten",
    description:
      "Listet Notizen, zuletzt geänderte zuerst. Ohne `folder` werden alle Ordner durchsucht. Liefert IDs, die für read_note, update_note und delete_note gebraucht werden.",
    inputSchema: {
      folder: folderArg.optional(),
      account: accountArg.optional(),
      limit: z.number().int().min(1).max(100).default(25).describe("Maximale Anzahl Notizen."),
      offset: z.number().int().min(0).default(0).describe("Für Blättern durch längere Listen."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ folder, account, limit, offset }) =>
    guard(async () => {
      const result = await notes.listNotes({ folder, account, limit, offset });
      const shown = `${result.offset + 1}–${result.offset + result.notes.length} von ${result.total}`;
      const scope = folder ? ` in "${folder}"` : "";
      return text(formatList(result.notes, `Notizen${scope} (${shown}):`));
    }),
);

server.registerTool(
  "search_notes",
  {
    title: "Notizen durchsuchen",
    description:
      "Volltextsuche über Titel und Inhalt der Notizen. Für gezielte Suchen deutlich schneller als list_notes.",
    inputSchema: {
      query: z.string().min(1).describe("Suchbegriff."),
      folder: folderArg.optional(),
      account: accountArg.optional(),
      searchBody: z.boolean().default(true).describe("false = nur Titel durchsuchen."),
      limit: z.number().int().min(1).max(100).default(20).describe("Maximale Anzahl Treffer."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query, folder, account, searchBody, limit }) =>
    guard(async () => {
      const result = await notes.searchNotes({ query, folder, account, searchBody, limit });
      return text(formatList(result.notes, `${result.count} Treffer für "${result.query}":`));
    }),
);

server.registerTool(
  "read_note",
  {
    title: "Notiz lesen",
    description: "Liest eine Notiz vollständig als Text. Die ID stammt aus list_notes oder search_notes.",
    inputSchema: {
      id: z.string().min(1).describe("Notiz-ID (x-coredata://…)."),
      includeHtml: z.boolean().default(false).describe("Zusätzlich das rohe HTML der Notiz zurückgeben."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id, includeHtml }) =>
    guard(async () => {
      const note = await notes.readNote({ id, includeHtml });
      return text(formatDetail(note));
    }),
);

server.registerTool(
  "create_note",
  {
    title: "Notiz anlegen",
    description:
      "Legt eine neue Notiz an. `body` wird standardmäßig als Markdown interpretiert und in Notes-HTML übersetzt (Überschriften, Listen, fett/kursiv, Links, Code).",
    inputSchema: {
      title: z.string().min(1).describe("Titel — erscheint als Überschrift und in der Notizliste."),
      body: z.string().default("").describe("Inhalt der Notiz."),
      format: formatEnum.default("markdown").describe("Wie `body` interpretiert wird."),
      folder: folderArg.optional(),
      account: accountArg.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ title, body, format, folder, account }) =>
    guard(async () => {
      const note = await notes.createNote({ title, body, format, folder, account });
      return text(`Notiz angelegt.\n\n${formatDetail(note)}`);
    }),
);

server.registerTool(
  "update_note",
  {
    title: "Notiz bearbeiten",
    description:
      "Ändert eine bestehende Notiz. mode=append hängt an (Standard), prepend stellt voran, replace ersetzt den kompletten Inhalt — bei replace geht der bisherige Text verloren, also vorher read_note aufrufen.",
    inputSchema: {
      id: z.string().min(1).describe("Notiz-ID."),
      body: z.string().describe("Neuer bzw. anzuhängender Inhalt."),
      format: formatEnum.default("markdown").describe("Wie `body` interpretiert wird."),
      mode: z.enum(["append", "prepend", "replace"]).default("append").describe("Wie der Inhalt eingefügt wird."),
      title: z
        .string()
        .optional()
        .describe("Nur bei mode=replace: setzt zugleich die Titelüberschrift neu."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ id, body, format, mode, title }) =>
    guard(async () => {
      const note = await notes.updateNote({ id, body, format, mode, title });
      return text(`Notiz aktualisiert (${mode}).\n\n${formatDetail(note)}`);
    }),
);

server.registerTool(
  "delete_note",
  {
    title: "Notiz löschen",
    description:
      'Verschiebt eine Notiz nach "Zuletzt gelöscht" (dort ca. 30 Tage wiederherstellbar). Erfordert confirm=true — vorher die Notiz lesen und beim Nutzer rückfragen.',
    inputSchema: {
      id: z.string().min(1).describe("Notiz-ID."),
      confirm: z.literal(true).describe("Muss ausdrücklich true sein, nachdem der Nutzer zugestimmt hat."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ id }) =>
    guard(async () => {
      const result = await notes.deleteNote({ id });
      return text(`Gelöscht: "${result.deleted.title}" (${result.deleted.folder ?? "-"}).\n${result.hint}`);
    }),
);

server.registerTool(
  "create_folder",
  {
    title: "Ordner anlegen",
    description: "Legt einen neuen Ordner an, optional als Unterordner eines bestehenden Ordners.",
    inputSchema: {
      name: z.string().min(1).describe("Name des neuen Ordners."),
      parent: z.string().optional().describe("Übergeordneter Ordner. Leer = oberste Ebene des Accounts."),
      account: accountArg.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ name, parent, account }) =>
    guard(async () => {
      const folder = await notes.createFolder({ name, parent, account });
      return text(`Ordner "${folder.name}" angelegt unter "${folder.parent ?? "-"}".`);
    }),
);

server.registerTool(
  "open_note",
  {
    title: "Notiz in Notes öffnen",
    description: "Bringt Notes.app in den Vordergrund und zeigt die Notiz an — nützlich zum manuellen Weiterarbeiten.",
    inputSchema: {
      id: z.string().min(1).describe("Notiz-ID."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ id }) =>
    guard(async () => {
      const result = await notes.openNote({ id });
      return text(`"${result.opened.title}" wurde in Apple Notes geöffnet.`);
    }),
);

async function main(): Promise<void> {
  // stdout gehört dem MCP-Protokoll — jede Diagnose muss nach stderr.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`apple-notes-mcp ${VERSION} läuft (stdio).`);
}

main().catch((error) => {
  console.error("apple-notes-mcp konnte nicht starten:", error);
  process.exit(1);
});

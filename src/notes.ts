import { runJxa } from "./jxa.js";
import { bodyToHtml, withTitleHeading, type BodyFormat } from "./markdown.js";

export interface NoteSummary {
  id: string;
  title: string;
  folder: string | null;
  created: string | null;
  modified: string | null;
  locked: boolean;
  shared: boolean;
  snippet: string;
}

export interface NoteDetail extends NoteSummary {
  text: string;
  html?: string;
  note?: string;
}

export interface FolderInfo {
  id: string;
  name: string;
  path: string;
  account: string;
  noteCount: number;
}

/** Bewusst ein Type-Alias: nur der ist zu `Record<string, unknown>` zuweisbar. */
export type Scope = {
  folder?: string;
  account?: string;
};

export const ping = () =>
  runJxa<{ running: boolean; version: string | null; accounts: string[]; folderCount: number; noteCount: number }>(
    "ping",
  );

export const listFolders = () => runJxa<{ folders: FolderInfo[] }>("list_folders");

export const listNotes = (params: Scope & { limit?: number; offset?: number }) =>
  runJxa<{ total: number; offset: number; notes: NoteSummary[] }>("list_notes", params);

export const searchNotes = (params: Scope & { query: string; limit?: number; searchBody?: boolean }) =>
  runJxa<{ query: string; strategy: string; count: number; notes: NoteSummary[] }>("search_notes", params);

export const readNote = (params: { id: string; includeHtml?: boolean }) =>
  runJxa<NoteDetail>("read_note", params);

export const createNote = (params: Scope & { title: string; body: string; format: BodyFormat }) => {
  const html = withTitleHeading(params.title, bodyToHtml(params.body, params.format));
  return runJxa<NoteDetail>("create_note", {
    title: params.title,
    html,
    folder: params.folder,
    account: params.account,
  });
};

export const updateNote = (params: {
  id: string;
  body: string;
  format: BodyFormat;
  mode: "replace" | "append" | "prepend";
  title?: string;
}) => {
  let html = bodyToHtml(params.body, params.format);
  if (params.mode === "replace" && params.title) {
    html = withTitleHeading(params.title, html);
  }
  return runJxa<NoteDetail>("update_note", { id: params.id, html, mode: params.mode });
};

export const deleteNote = (params: { id: string }) =>
  runJxa<{ deleted: NoteSummary; hint: string }>("delete_note", params);

export const createFolder = (params: { name: string; parent?: string; account?: string }) =>
  runJxa<{ id: string | null; name: string; parent: string | null }>("create_folder", params);

export const openNote = (params: { id: string }) =>
  runJxa<{ opened: NoteSummary }>("open_note", params);

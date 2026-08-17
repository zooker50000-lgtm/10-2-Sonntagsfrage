/**
 * Claude ⇄ Apple Notes — Relay
 *
 * Ein Cloudflare Worker, der zwei Seiten bedient, die sich nie direkt
 * erreichen können:
 *
 *   Claude (aus Anthropics Cloud)  →  /mcp          MCP über Streamable HTTP
 *   iPad-Kurzbefehl                →  /device/*     holt Aufträge, liefert Notizen
 *
 * Warum diese Bauweise: Claude ruft Connectors aus der Cloud auf und kann ein
 * iPad nicht erreichen; iPadOS wiederum lässt keinen Serverprozess zu. Der
 * Relay ist der gemeinsame Treffpunkt. Lesende Anfragen beantwortet er aus dem
 * letzten Snapshot, den das iPad hochgeladen hat; schreibende legt er in eine
 * Warteschlange, die das iPad beim nächsten Sync abarbeitet.
 *
 * Bewusst eine einzige Datei ohne Abhängigkeiten: sie wird in den
 * Cloudflare-Dashboard-Editor eingefügt, ohne Build und ohne Kommandozeile.
 *
 * Bindings, die dieser Worker erwartet:
 *   KV-Namespace  NOTES        (Snapshot, Warteschlange, OAuth-Zustand)
 *   Secret        SETUP_CODE   frei gewählter Code; schützt Claude-Anmeldung und iPad
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL = "2025-06-18";

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365;
const CODE_TTL_SECONDS = 600;
// Aufträge, die ein abgebrochener Sync in Bearbeitung stehen ließ, gelten nach
// dieser Zeit als verloren und wandern zurück in die Warteschlange.
const INFLIGHT_RECLAIM_MS = 10 * 60 * 1000;
const MAX_LOG_ENTRIES = 20;

// ---------------------------------------------------------------------------
// Speicher (Workers KV)
// ---------------------------------------------------------------------------

const KEY = {
  snapshot: "snapshot",
  jobs: "jobs",
  inflight: "inflight",
  log: "log",
  lastRaw: "lastraw",
  version: "2026-08-17c",
  client: (id) => `oauth:client:${id}`,
  code: (code) => `oauth:code:${code}`,
  token: (token) => `oauth:token:${token}`,
};

async function readJson(env, key, fallback) {
  const raw = await env.NOTES.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const writeJson = (env, key, value, options) =>
  env.NOTES.put(key, JSON.stringify(value), options);

async function appendLog(env, message) {
  const log = await readJson(env, KEY.log, []);
  log.unshift({ at: new Date().toISOString(), message });
  await writeJson(env, KEY.log, log.slice(0, MAX_LOG_ENTRIES));
}

const emptySnapshot = () => ({ syncedAt: null, notes: [], truncated: false });

// ---------------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------------

const randomId = (bytes = 24) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

function base64url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64url(input) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return base64url(digest);
}

/** Zeitkonstanter Vergleich — verhindert, dass sich der Setup-Code erraten lässt. */
function safeEqual(a, b) {
  const left = new TextEncoder().encode(String(a ?? ""));
  const right = new TextEncoder().encode(String(b ?? ""));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS, ...headers },
  });

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

// ---------------------------------------------------------------------------
// OAuth 2.1 — bewusst minimal
//
// Claudes Verbindungsassistent erwartet OAuth-Metadaten; gegen Server ganz ohne
// Authentifizierung bricht der Flow ab. Deshalb hier das Nötigste: Dynamic
// Client Registration, ein Autorisierungsformular, das nach dem Setup-Code
// fragt, und PKCE. Das ist zugleich der Zugriffsschutz — ohne ihn läge die
// Notizsammlung unter einer rate-baren URL offen.
// ---------------------------------------------------------------------------

function authServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["notes"],
  };
}

async function handleRegister(request, env, origin) {
  const body = await request.json().catch(() => ({}));
  const clientId = randomId(16);
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];

  await writeJson(env, KEY.client(clientId), {
    redirect_uris: redirectUris,
    name: body.client_name ?? "Claude",
    createdAt: new Date().toISOString(),
  });

  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      client_name: body.client_name ?? "Claude",
    },
    201,
  );
}

function authorizePage(params, error) {
  const hidden = Object.entries(params)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`)
    .join("");

  return html(`<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notizen-Relay verbinden</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0;
         min-height: 100vh; display: grid; place-items: center; padding: 24px;
         background: #f4f2ed; color: #1f1c15; }
  @media (prefers-color-scheme: dark) { body { background: #16140f; color: #efe9dc; } }
  form { width: min(100%, 380px); display: grid; gap: 14px; }
  h1 { font-size: 1.35rem; margin: 0; letter-spacing: -0.02em; }
  p { margin: 0; opacity: 0.75; line-height: 1.5; font-size: 0.95rem; }
  input[type=text] { font-size: 17px; padding: 13px 14px; border-radius: 11px;
                     border: 1px solid #c6bfae; background: #fffefb; color: inherit; }
  @media (prefers-color-scheme: dark) { input[type=text] { background: #201d16; border-color: #4c4531; } }
  button { font-size: 17px; font-weight: 600; padding: 13px; border: 0; border-radius: 11px;
           background: #b06f14; color: #fff; }
  .error { color: #a3311b; font-weight: 500; }
</style></head>
<body><form method="POST">
  <h1>Notizen-Relay verbinden</h1>
  <p>Gib den Setup-Code ein, den du beim Einrichten des Relays vergeben hast.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  ${hidden}
  <input type="text" name="setup_code" placeholder="Setup-Code" autocomplete="off"
         autocapitalize="off" autocorrect="off" spellcheck="false" required>
  <button type="submit">Verbinden</button>
</form></body></html>`);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function handleAuthorize(request, env) {
  const url = new URL(request.url);
  const carried = {
    client_id: url.searchParams.get("client_id") ?? "",
    redirect_uri: url.searchParams.get("redirect_uri") ?? "",
    state: url.searchParams.get("state") ?? "",
    code_challenge: url.searchParams.get("code_challenge") ?? "",
    code_challenge_method: url.searchParams.get("code_challenge_method") ?? "",
    resource: url.searchParams.get("resource") ?? "",
  };

  if (request.method === "GET") return authorizePage(carried, null);

  const form = await request.formData();
  const fields = {};
  for (const [key, value] of form.entries()) fields[key] = String(value);

  if (!safeEqual(fields.setup_code, env.SETUP_CODE)) {
    delete fields.setup_code;
    return authorizePage(fields, "Falscher Setup-Code.");
  }

  const redirectUri = fields.redirect_uri;
  if (!redirectUri) return html("<p>redirect_uri fehlt.</p>", 400);

  const code = randomId(24);
  await writeJson(
    env,
    KEY.code(code),
    {
      clientId: fields.client_id,
      redirectUri,
      codeChallenge: fields.code_challenge || null,
      method: fields.code_challenge_method || null,
    },
    { expirationTtl: CODE_TTL_SECONDS },
  );

  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (fields.state) target.searchParams.set("state", fields.state);
  return Response.redirect(target.toString(), 302);
}

async function handleToken(request, env) {
  const form = await request.formData().catch(() => null);
  if (!form) return json({ error: "invalid_request" }, 400);

  const grantType = form.get("grant_type");
  if (grantType !== "authorization_code") return json({ error: "unsupported_grant_type" }, 400);

  const code = String(form.get("code") ?? "");
  const stored = await readJson(env, KEY.code(code), null);
  if (!stored) return json({ error: "invalid_grant" }, 400);

  await env.NOTES.delete(KEY.code(code));

  if (stored.codeChallenge) {
    const verifier = String(form.get("code_verifier") ?? "");
    const computed =
      stored.method === "plain" ? verifier : await sha256Base64url(verifier);
    if (computed !== stored.codeChallenge) return json({ error: "invalid_grant" }, 400);
  }

  const token = randomId(32);
  await writeJson(
    env,
    KEY.token(token),
    { clientId: stored.clientId, issuedAt: new Date().toISOString() },
    { expirationTtl: TOKEN_TTL_SECONDS },
  );
  await appendLog(env, "Claude wurde verbunden.");

  return json({
    access_token: token,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    scope: "notes",
  });
}

async function requireBearer(request, env, origin) {
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (token && (await env.NOTES.get(KEY.token(token)))) return null;

  return json({ error: "unauthorized" }, 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  });
}

// ---------------------------------------------------------------------------
// Snapshot: das, was das iPad zuletzt hochgeladen hat
// ---------------------------------------------------------------------------

/**
 * Das iPad liefert einen Textblock statt JSON — verschachteltes JSON in
 * Kurzbefehlen zusammenzubauen ist mühsam und fehleranfällig, ein Textblock
 * mit Trennmarken dagegen ist eine einzige "Text kombinieren"-Aktion.
 */
function parseSnapshot(raw) {
  const text = String(raw);
  return text.includes("###INDEX###") ? parseIndexSnapshot(text) : parseBlockSnapshot(text);
}

/**
 * Kurzform ohne Notizinhalte, dafür ohne Schleife im Kurzbefehl.
 *
 * Fügt man in Kurzbefehlen eine Liste in eine Text-Aktion ein, rendert sie
 * zeilenweise. Drei solche Einfügungen — Ordner, Titel, Änderungsdatum — liefern
 * drei gleich lange Blöcke, die sich hier über den Index wieder zusammenführen
 * lassen. Das spart auf dem iPad vier Aktionen und die gesamte
 * Variablen-Verdrahtung, kostet aber die Notiztexte: die sind mehrzeilig und
 * würden die Zeilenzuordnung zerstören.
 */
function parseIndexSnapshot(raw) {
  const section = (name) => {
    const match = raw.match(new RegExp(`###${name}###\\r?\\n([\\s\\S]*?)(?=\\r?\\n###|$)`));
    if (!match) return [];
    return match[1].split(/\r?\n/).map((line) => line.trim());
  };

  const folders = section("F");
  const titles = section("T");
  const modified = section("M");

  return titles
    .map((title, index) => ({
      folder: folders[index] ?? "",
      title,
      modified: modified[index] ?? "",
      text: "",
    }))
    .filter((note) => note.title);
}

function parseBlockSnapshot(raw) {
  const notes = [];
  for (const block of String(raw).split("###NOTE###")) {
    if (!block.trim()) continue;

    const lines = block.split(/\r?\n/);
    const note = { folder: "", title: "", modified: "", text: "" };
    const bodyLines = [];
    let inBody = false;

    for (const line of lines) {
      if (inBody) {
        bodyLines.push(line);
        continue;
      }
      if (line.startsWith("F:")) note.folder = line.slice(2).trim();
      else if (line.startsWith("T:")) note.title = line.slice(2).trim();
      else if (line.startsWith("M:")) note.modified = line.slice(2).trim();
      else if (line.startsWith("B:")) inBody = true;
    }

    note.text = bodyLines.join("\n").trim();
    if (note.title || note.text) notes.push(note);
  }
  return notes;
}

const snapshotAge = (snapshot) =>
  snapshot.syncedAt ? `Stand: ${snapshot.syncedAt}` : "Es wurde noch nie synchronisiert.";

// ---------------------------------------------------------------------------
// Warteschlange
// ---------------------------------------------------------------------------

async function enqueue(env, job) {
  const jobs = await readJson(env, KEY.jobs, []);
  const entry = { id: randomId(8), createdAt: new Date().toISOString(), ...job };
  jobs.push(entry);
  await writeJson(env, KEY.jobs, jobs);
  return entry;
}

/**
 * Liefert nur die noch nicht ausgegebenen Aufträge und merkt sie sich als "in
 * Bearbeitung". Zweimaliges Abholen ohne zwischenzeitlichen Push darf weder
 * dieselben Aufträge erneut ausliefern — das legte Notizen doppelt an — noch
 * die Merkliste überschreiben, denn nur sie holt einen abgebrochenen Sync
 * wieder ein.
 */
async function pullJobs(env) {
  const inflight = await readJson(env, KEY.inflight, null);
  let queued = await readJson(env, KEY.jobs, []);
  let carried = inflight?.jobs ?? [];
  let since = inflight?.at ?? null;

  const stalled = carried.length && since && Date.now() - new Date(since).getTime() > INFLIGHT_RECLAIM_MS;
  if (stalled) {
    queued = [...carried, ...queued];
    carried = [];
    since = null;
    await appendLog(env, `${queued.length} unerledigte Aufträge erneut zugestellt.`);
  }

  await writeJson(env, KEY.jobs, []);
  await writeJson(env, KEY.inflight, {
    at: since ?? new Date().toISOString(),
    jobs: [...carried, ...queued],
  });
  return queued;
}

// ---------------------------------------------------------------------------
// MCP-Werkzeuge
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "sync_status",
    title: "Sync-Status",
    description:
      "Zeigt, wann das iPad zuletzt synchronisiert hat, wie viele Notizen im Snapshot liegen und wie viele Aufträge noch warten. Bei Zweifeln am Aktualitätsstand zuerst aufrufen.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "notes_overview",
    title: "Überblick",
    description:
      "Listet alle Ordner mit Notizanzahl aus dem letzten Snapshot. Guter erster Aufruf, um die Struktur der Sammlung zu verstehen.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_notes",
    title: "Notizen auflisten",
    description:
      "Listet Titel aus dem letzten Snapshot, optional auf einen Ordner eingegrenzt. Liefert keine vollständigen Inhalte — dafür read_note verwenden.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Ordnername, exakt wie in notes_overview." },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    },
  },
  {
    name: "search_notes",
    title: "Notizen durchsuchen",
    description: "Durchsucht Titel und Inhalte des letzten Snapshots nach einem Begriff.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Suchbegriff." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["query"],
    },
  },
  {
    name: "read_note",
    title: "Notiz lesen",
    description:
      "Gibt den vollständigen Text einer Notiz aus dem letzten Snapshot zurück. Der Titel muss nicht exakt stimmen — es genügt ein eindeutiger Teil.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", description: "Titel oder Teil davon." } },
      required: ["title"],
    },
  },
  {
    name: "create_note",
    title: "Notiz anlegen",
    description:
      "Reiht das Anlegen einer neuen Notiz ein. Sie entsteht erst beim nächsten Sync des iPads — das dem Nutzer gegenüber auch so sagen. Die erste Zeile wird von Apple Notes als Titel verwendet; Markdown wird nicht dargestellt, daher Klartext schreiben.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Titelzeile der Notiz." },
        text: { type: "string", description: "Inhalt als Klartext, ohne Markdown." },
      },
      required: ["title", "text"],
    },
  },
  {
    name: "append_to_note",
    title: "An Notiz anhängen",
    description:
      "Reiht das Anhängen von Text an eine bestehende Notiz ein; wird beim nächsten Sync ausgeführt. Der Titel muss eine Notiz eindeutig treffen — vorher mit list_notes oder search_notes absichern.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Titel der Zielnotiz." },
        text: { type: "string", description: "Anzuhängender Klartext." },
      },
      required: ["title", "text"],
    },
  },
];

const asText = (body) => ({ content: [{ type: "text", text: body }] });
const asError = (body) => ({ content: [{ type: "text", text: body }], isError: true });

async function callTool(env, name, args = {}) {
  const snapshot = await readJson(env, KEY.snapshot, emptySnapshot());

  const needSnapshot = () =>
    !snapshot.syncedAt
      ? asError(
          "Es liegt noch kein Snapshot vor. Auf dem iPad einmal den Kurzbefehl „Claude-Sync“ ausführen — danach sind die Notizen hier lesbar.",
        )
      : null;

  switch (name) {
    case "sync_status": {
      const jobs = await readJson(env, KEY.jobs, []);
      const inflight = await readJson(env, KEY.inflight, null);
      const log = await readJson(env, KEY.log, []);
      const lastRaw = await readJson(env, KEY.lastRaw, null);

      const diagnose = lastRaw
        ? [
            "",
            `Zuletzt empfangen (${lastRaw.bytes} Zeichen, ${lastRaw.at}):`,
            "---",
            lastRaw.preview || "(leer)",
            "---",
          ]
        : [];

      return asText(
        [
          `Relay-Version: ${KEY.version}`,
          snapshotAge(snapshot),
          `Notizen im Snapshot: ${snapshot.notes.length}${snapshot.truncated ? " (gekürzt)" : ""}`,
          `Wartende Aufträge: ${jobs.length}`,
          `In Bearbeitung: ${inflight?.jobs?.length ?? 0}`,
          "",
          "Letzte Ereignisse:",
          ...(log.length ? log.map((entry) => `  ${entry.at} — ${entry.message}`) : ["  (keine)"]),
          ...diagnose,
        ].join("\n"),
      );
    }

    case "notes_overview": {
      const missing = needSnapshot();
      if (missing) return missing;

      const counts = new Map();
      for (const note of snapshot.notes) {
        const folder = note.folder || "(ohne Ordner)";
        counts.set(folder, (counts.get(folder) ?? 0) + 1);
      }
      const rows = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([folder, count]) => `  ${folder}: ${count}`);
      return asText([`${snapshotAge(snapshot)}`, `Ordner:`, ...rows].join("\n"));
    }

    case "list_notes": {
      const missing = needSnapshot();
      if (missing) return missing;

      const limit = args.limit ?? 50;
      const wanted = args.folder?.toLowerCase();
      const rows = snapshot.notes
        .filter((note) => !wanted || (note.folder || "").toLowerCase() === wanted)
        .slice(0, limit)
        .map((note) => `  ${note.folder || "-"} | ${note.title}`);

      if (!rows.length) {
        return asText(`Keine Notizen gefunden${args.folder ? ` im Ordner "${args.folder}"` : ""}.`);
      }
      return asText([`${rows.length} Notizen (${snapshotAge(snapshot)}):`, ...rows].join("\n"));
    }

    case "search_notes": {
      const missing = needSnapshot();
      if (missing) return missing;

      const needle = String(args.query ?? "").toLowerCase();
      if (!needle) return asError("Es wurde kein Suchbegriff übergeben.");

      const hits = snapshot.notes
        .filter(
          (note) =>
            note.title.toLowerCase().includes(needle) || note.text.toLowerCase().includes(needle),
        )
        .slice(0, args.limit ?? 10);

      if (!hits.length) return asText(`Keine Treffer für "${args.query}". ${snapshotAge(snapshot)}`);

      return asText(
        [
          `${hits.length} Treffer für "${args.query}" (${snapshotAge(snapshot)}):`,
          ...hits.map((note) => {
            const preview = note.text.replace(/\s+/g, " ").slice(0, 200);
            return `\n• ${note.title} — Ordner: ${note.folder || "-"}\n  ${preview}`;
          }),
        ].join("\n"),
      );
    }

    case "read_note": {
      const missing = needSnapshot();
      if (missing) return missing;

      const wanted = String(args.title ?? "").toLowerCase();
      const matches = snapshot.notes.filter((note) => note.title.toLowerCase().includes(wanted));

      if (!matches.length) return asError(`Keine Notiz mit "${args.title}" im Titel. ${snapshotAge(snapshot)}`);
      if (matches.length > 1) {
        return asText(
          [
            `"${args.title}" trifft ${matches.length} Notizen — bitte genauer angeben:`,
            ...matches.map((note) => `  ${note.title} (${note.folder || "-"})`),
          ].join("\n"),
        );
      }

      const note = matches[0];
      if (!note.text) {
        return asText(
          `"${note.title}" liegt nur als Titel im Snapshot — der Sync überträgt Inhalte nur für die zuletzt geänderten Notizen. Auf dem iPad das Limit erhöhen oder die Notiz kurz öffnen und neu synchronisieren.`,
        );
      }
      return asText(
        `Titel: ${note.title}\nOrdner: ${note.folder || "-"}\nGeändert: ${note.modified || "-"}\n\n${note.text}`,
      );
    }

    case "create_note": {
      const title = String(args.title ?? "").trim();
      const text = String(args.text ?? "");
      if (!title) return asError("Es wurde kein Titel übergeben.");

      await enqueue(env, { op: "create", title, text });
      await appendLog(env, `Notiz "${title}" eingereiht.`);
      return asText(
        `„${title}“ ist eingereiht und wird beim nächsten Sync des iPads angelegt. Bis dahin existiert die Notiz noch nicht.`,
      );
    }

    case "append_to_note": {
      const title = String(args.title ?? "").trim();
      const text = String(args.text ?? "");
      if (!title) return asError("Es wurde kein Titel der Zielnotiz übergeben.");
      if (!text) return asError("Es wurde kein Text zum Anhängen übergeben.");

      await enqueue(env, { op: "append", title, text });
      await appendLog(env, `Ergänzung für "${title}" eingereiht.`);
      return asText(
        `Der Text ist eingereiht und wird beim nächsten Sync an „${title}“ angehängt.`,
      );
    }

    default:
      return asError(`Unbekanntes Werkzeug: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// MCP über Streamable HTTP
// ---------------------------------------------------------------------------

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleRpc(message, env) {
  const { id, method, params } = message;

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "apple-notes-relay", version: "1.0.0" },
        instructions:
          "Lesende Werkzeuge antworten aus dem letzten Snapshot des iPads, schreibende reihen sich in eine Warteschlange ein und werden beim nächsten Sync ausgeführt. Bei Fragen zur Aktualität sync_status aufrufen.",
      });
    }

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const name = params?.name;
      if (!TOOLS.some((tool) => tool.name === name)) {
        return rpcError(id, -32602, `Unbekanntes Werkzeug: ${name}`);
      }
      try {
        return rpcResult(id, await callTool(env, name, params?.arguments ?? {}));
      } catch (error) {
        return rpcResult(id, asError(`Relay-Fehler: ${error?.message ?? error}`));
      }
    }

    case "resources/list":
      return rpcResult(id, { resources: [] });

    case "prompts/list":
      return rpcResult(id, { prompts: [] });

    default:
      return rpcError(id, -32601, `Unbekannte Methode: ${method}`);
  }
}

async function handleMcp(request, env, origin) {
  if (request.method === "GET" || request.method === "DELETE") {
    // Der Relay eröffnet keine serverseitigen Streams; beides ist zulässig.
    return new Response(null, { status: 405, headers: { ...CORS, Allow: "POST" } });
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const unauthorized = await requireBearer(request, env, origin);
  if (unauthorized) return unauthorized;

  const payload = await request.json().catch(() => null);
  if (!payload) return json(rpcError(null, -32700, "Ungültiges JSON"), 400);

  // Benachrichtigungen tragen keine id und werden nur quittiert.
  const messages = Array.isArray(payload) ? payload : [payload];
  const answers = [];
  for (const message of messages) {
    if (message?.id === undefined || message?.id === null) continue;
    answers.push(await handleRpc(message, env));
  }

  if (!answers.length) return new Response(null, { status: 202, headers: CORS });
  return json(Array.isArray(payload) ? answers : answers[0]);
}

// ---------------------------------------------------------------------------
// Geräte-Endpunkte für den iPad-Kurzbefehl
// ---------------------------------------------------------------------------

function deviceAuthorized(request, env) {
  const url = new URL(request.url);
  const header = request.headers.get("X-Device-Token") ?? url.searchParams.get("token") ?? "";
  return safeEqual(header, env.SETUP_CODE);
}

async function handleDevicePull(request, env) {
  if (!deviceAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

  const jobs = await pullJobs(env);
  // Vorsortiert nach Art, und für neue Notizen ist der fertige Inhalt schon
  // zusammengesetzt: so kommt der Kurzbefehl ohne Verzweigungen und ohne
  // Textbau aus, die beide auf dem iPad mühsam zu klicken wären. Die erste
  // Zeile ist der Titel — genau so leitet Apple Notes den Notiznamen ab.
  return json({
    creates: jobs
      .filter((job) => job.op === "create")
      .map((job) => ({ content: `${job.title}\n\n${job.text}`.trim() })),
    appends: jobs.filter((job) => job.op === "append").map(({ title, text }) => ({ title, text })),
    count: jobs.length,
  });
}

async function handleDevicePush(request, env) {
  if (!deviceAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

  const raw = await request.text();
  const notes = parseSnapshot(raw);

  // Diagnose: Liefert der Kurzbefehl 0 Notizen, ist ohne den Rohtext nicht zu
  // unterscheiden, ob das iPad nichts geschickt hat oder das Format nicht passt.
  await writeJson(env, KEY.lastRaw, {
    at: new Date().toISOString(),
    bytes: raw.length,
    preview: raw.slice(0, 600),
  });
  const inflight = await readJson(env, KEY.inflight, null);
  const done = inflight?.jobs?.length ?? 0;

  await writeJson(env, KEY.snapshot, {
    syncedAt: new Date().toISOString(),
    notes,
    truncated: notes.length >= 200,
  });
  await writeJson(env, KEY.inflight, { at: new Date().toISOString(), jobs: [] });
  await appendLog(
    env,
    `Sync: ${notes.length} Notizen empfangen${done ? `, ${done} Aufträge erledigt` : ""}.`,
  );

  return json({ ok: true, notes: notes.length, jobsCompleted: done });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = url.origin;

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (!env.SETUP_CODE) {
      return json(
        { error: "setup_incomplete", message: "Das Secret SETUP_CODE fehlt in den Worker-Einstellungen." },
        500,
      );
    }

    switch (url.pathname) {
      case "/":
        return html(
          `<!doctype html><meta charset="utf-8"><title>Notizen-Relay</title>
           <body style="font-family:-apple-system,system-ui,sans-serif;padding:32px;line-height:1.6">
           <h1>Notizen-Relay läuft</h1>
           <p>Diese Adresse als Custom Connector in Claude eintragen:</p>
           <p><code>${escapeHtml(origin)}/mcp</code></p></body>`,
        );

      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["notes"],
        });

      case "/.well-known/oauth-authorization-server":
      case "/.well-known/openid-configuration":
        return json(authServerMetadata(origin));

      case "/register":
        return request.method === "POST"
          ? handleRegister(request, env, origin)
          : new Response("Method Not Allowed", { status: 405 });

      case "/authorize":
        return handleAuthorize(request, env);

      case "/token":
        return request.method === "POST"
          ? handleToken(request, env)
          : new Response("Method Not Allowed", { status: 405 });

      case "/mcp":
        return handleMcp(request, env, origin);

      case "/device/pull":
        return handleDevicePull(request, env);

      case "/device/push":
        return request.method === "POST"
          ? handleDevicePush(request, env)
          : new Response("Method Not Allowed", { status: 405 });

      default:
        return json({ error: "not_found" }, 404);
    }
  },
};

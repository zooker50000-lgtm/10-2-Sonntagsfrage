/**
 * Fährt den Worker gegen ein KV im Arbeitsspeicher — ohne Cloudflare-Konto und
 * ohne Deploy. Geprüft wird die Kette, die beim Verbinden wirklich durchlaufen
 * wird: OAuth-Registrierung, Autorisierung mit PKCE, Token, MCP-Handshake,
 * Werkzeugaufrufe und der Austausch mit dem iPad-Kurzbefehl.
 */
import assert from "node:assert/strict";
import test from "node:test";

import worker from "../worker.js";

const ORIGIN = "https://relay.example.workers.dev";
const SETUP_CODE = "geheim-1234";

function makeEnv() {
  const store = new Map();
  return {
    SETUP_CODE,
    NOTES: {
      async get(key) {
        const entry = store.get(key);
        if (!entry) return null;
        if (entry.expires && Date.now() > entry.expires) {
          store.delete(key);
          return null;
        }
        return entry.value;
      },
      async put(key, value, options) {
        store.set(key, {
          value,
          expires: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null,
        });
      },
      async delete(key) {
        store.delete(key);
      },
    },
  };
}

const call = (env, path, init = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, init), env);

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

/** Führt den kompletten OAuth-Flow durch und liefert ein Bearer-Token. */
async function connect(env) {
  const registered = await (
    await call(env, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      }),
    })
  ).json();

  const verifier = "verifier-" + "x".repeat(50);
  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );

  const authorized = await call(
    env,
    `/authorize?client_id=${registered.client_id}` +
      `&redirect_uri=${encodeURIComponent("https://claude.ai/api/mcp/auth_callback")}` +
      `&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        setup_code: SETUP_CODE,
        client_id: registered.client_id,
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        state: "xyz",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      redirect: "manual",
    },
  );

  assert.equal(authorized.status, 302, "Autorisierung muss zurück zu Claude leiten");
  const location = new URL(authorized.headers.get("Location"));
  assert.equal(location.searchParams.get("state"), "xyz", "state muss erhalten bleiben");

  const token = await (
    await call(env, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: location.searchParams.get("code"),
        code_verifier: verifier,
        client_id: registered.client_id,
      }),
    })
  ).json();

  assert.equal(token.token_type, "Bearer");
  return token.access_token;
}

const rpc = async (env, accessToken, method, params) => {
  const response = await call(env, "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return response.json();
};

const tool = (env, accessToken, name, args = {}) =>
  rpc(env, accessToken, "tools/call", { name, arguments: args });

const SNAPSHOT = `###NOTE###
F: Projekte
T: Sonntagsfrage Auswertung
M: 2026-08-17 10:00
B:
Ergebnis der Umfrage vom Sonntag.
Rücklauf lag bei 62 Prozent.
###NOTE###
F: Privat
T: Einkaufsliste
M: 2026-08-16 18:30
B:
Milch
Brot
`;

const pushSnapshot = (env, body = SNAPSHOT) =>
  call(env, "/device/push", {
    method: "POST",
    headers: { "X-Device-Token": SETUP_CODE },
    body,
  });

// ---------------------------------------------------------------------------

test("Metadaten verweisen auf den Autorisierungsserver", async () => {
  const env = makeEnv();
  const resource = await (await call(env, "/.well-known/oauth-protected-resource")).json();
  assert.equal(resource.resource, `${ORIGIN}/mcp`);

  const server = await (await call(env, "/.well-known/oauth-authorization-server")).json();
  assert.equal(server.registration_endpoint, `${ORIGIN}/register`);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
});

test("MCP ohne Token wird abgewiesen und nennt die Metadaten-URL", async () => {
  const env = makeEnv();
  const response = await call(env, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("WWW-Authenticate"), /oauth-protected-resource/);
});

test("Falscher Setup-Code führt nicht zur Weiterleitung", async () => {
  const env = makeEnv();
  const response = await call(env, "/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      setup_code: "falsch",
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    }),
    redirect: "manual",
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Falscher Setup-Code/);
});

test("PKCE: falscher Verifier liefert kein Token", async () => {
  const env = makeEnv();
  const registered = await (
    await call(env, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    })
  ).json();

  const challenge = base64url(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode("richtiger-verifier")),
  );

  const authorized = await call(env, "/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      setup_code: SETUP_CODE,
      client_id: registered.client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
    redirect: "manual",
  });

  const code = new URL(authorized.headers.get("Location")).searchParams.get("code");
  const response = await call(env, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: "falscher-verifier",
    }),
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_grant");
});

test("Ein Autorisierungscode lässt sich nur einmal einlösen", async () => {
  const env = makeEnv();
  const registered = await (
    await call(env, "/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
    })
  ).json();

  const authorized = await call(env, "/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      setup_code: SETUP_CODE,
      client_id: registered.client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    }),
    redirect: "manual",
  });
  const code = new URL(authorized.headers.get("Location")).searchParams.get("code");

  const exchange = () =>
    call(env, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code }),
    });

  assert.equal((await exchange()).status, 200);
  assert.equal((await exchange()).status, 400, "Wiederverwendung muss scheitern");
});

test("Handshake und Werkzeugliste", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);

  const init = await rpc(env, accessToken, "initialize", { protocolVersion: "2025-06-18" });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "apple-notes-relay");

  const list = await rpc(env, accessToken, "tools/list");
  const names = list.result.tools.map((entry) => entry.name);
  assert.deepEqual(names, [
    "sync_status",
    "notes_overview",
    "list_notes",
    "search_notes",
    "read_note",
    "create_note",
    "append_to_note",
  ]);
  for (const entry of list.result.tools) {
    assert.equal(entry.inputSchema.type, "object", `${entry.name} braucht ein Objekt-Schema`);
  }
});

test("Ohne Snapshot wird zum Sync aufgefordert statt Leere gemeldet", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);
  const result = await tool(env, accessToken, "notes_overview");
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /Claude-Sync/);
});

test("Snapshot vom iPad wird geparst und durchsuchbar", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);

  const pushed = await (await pushSnapshot(env)).json();
  assert.deepEqual(pushed, { ok: true, notes: 2, jobsCompleted: 0 });

  const overview = await tool(env, accessToken, "notes_overview");
  assert.match(overview.result.content[0].text, /Projekte: 1/);
  assert.match(overview.result.content[0].text, /Privat: 1/);

  const search = await tool(env, accessToken, "search_notes", { query: "Rücklauf" });
  assert.match(search.result.content[0].text, /Sonntagsfrage Auswertung/);

  const read = await tool(env, accessToken, "read_note", { title: "Einkaufs" });
  assert.match(read.result.content[0].text, /Milch\nBrot/);

  const listed = await tool(env, accessToken, "list_notes", { folder: "Projekte" });
  assert.match(listed.result.content[0].text, /Sonntagsfrage Auswertung/);
  assert.doesNotMatch(listed.result.content[0].text, /Einkaufsliste/);
});

test("Kurzform ohne Schleife wird über den Index zusammengeführt", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);

  const pushed = await (
    await pushSnapshot(
      env,
      `###INDEX###
###F###
Projekte
Privat
###T###
Sonntagsfrage Auswertung
Einkaufsliste
###M###
2026-08-17 10:00
2026-08-16 18:30
`,
    )
  ).json();
  assert.equal(pushed.notes, 2);

  const overview = await tool(env, accessToken, "notes_overview");
  assert.match(overview.result.content[0].text, /Projekte: 1/);

  const listed = await tool(env, accessToken, "list_notes", { folder: "Privat" });
  assert.match(listed.result.content[0].text, /Einkaufsliste/);
  assert.doesNotMatch(listed.result.content[0].text, /Sonntagsfrage/);

  // Ohne Inhalte muss read_note erklären, warum nichts da ist.
  const read = await tool(env, accessToken, "read_note", { title: "Einkaufsliste" });
  assert.match(read.result.content[0].text, /nur als Titel/);
});

test("Kurzform verträgt ungleich lange Blöcke", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);
  await pushSnapshot(env, `###INDEX###\n###F###\nA\n###T###\nEins\nZwei\n###M###\n\n`);

  const listed = await tool(env, accessToken, "list_notes");
  assert.match(listed.result.content[0].text, /Eins/);
  assert.match(listed.result.content[0].text, /Zwei/);
});

test("Inhalte werden nachgereicht und dem Index zugeordnet", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);

  await pushSnapshot(
    env,
    `###INDEX###\n###F###\nChemie\nGeografie\n###T###\nSäuren und Basen\nPlattentektonik\n`,
  );

  const bodies = await (
    await call(env, "/device/bodies", {
      method: "POST",
      headers: { "X-Device-Token": SETUP_CODE },
      body:
        "Säuren und Basen\npH-Wert unter 7 ist sauer.\nIndikatoren zeigen das an." +
        "@@@NOTIZ@@@" +
        "Plattentektonik\nDie Erdkruste besteht aus Platten.",
    })
  ).json();

  assert.equal(bodies.ok, true);
  assert.equal(bodies.withText, 2);
  assert.equal(bodies.warnung, undefined);

  const read = await tool(env, accessToken, "read_note", { title: "Säuren" });
  assert.match(read.result.content[0].text, /pH-Wert unter 7/);

  // Jetzt trägt die Volltextsuche wirklich, nicht nur die Titelsuche.
  const found = await tool(env, accessToken, "search_notes", { query: "Erdkruste" });
  assert.match(found.result.content[0].text, /Plattentektonik/);
});

test("Verrutschte Zuordnung der Inhalte wird gemeldet", async () => {
  const env = makeEnv();
  await connect(env);
  await pushSnapshot(env, `###INDEX###\n###F###\nA\nB\n###T###\nEins\nZwei\n`);

  const result = await (
    await call(env, "/device/bodies", {
      method: "POST",
      headers: { "X-Device-Token": SETUP_CODE },
      body: "nur ein Text",
    })
  ).json();

  assert.match(result.warnung, /verrutscht/);
});

test("Inhalte ohne Index werden abgelehnt statt still verworfen", async () => {
  const env = makeEnv();
  const response = await call(env, "/device/bodies", {
    method: "POST",
    headers: { "X-Device-Token": SETUP_CODE },
    body: "irgendwas",
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "kein_index");
});

test("Eine Notiz ohne Titel verschiebt die Zuordnung nicht", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);

  // Mittlere Notiz ohne Titel — früher fiel sie raus und alles danach verrutschte.
  await pushSnapshot(env, `###INDEX###\n###F###\nA\nA\nA\n###T###\nEins\n\nDrei\n`);

  const listed = await tool(env, accessToken, "list_notes");
  assert.match(listed.result.content[0].text, /\(ohne Titel\)/);

  await call(env, "/device/bodies", {
    method: "POST",
    headers: { "X-Device-Token": SETUP_CODE },
    body: ["Text eins", "Text zwei", "Text drei"].join("@@@NOTIZ@@@"),
  });

  const read = await tool(env, accessToken, "read_note", { title: "Drei" });
  assert.match(read.result.content[0].text, /Text drei/);
});

test("Mehrdeutiger Titel wird zur Rückfrage statt zur Verwechslung", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);
  await pushSnapshot(
    env,
    `###NOTE###\nF: A\nT: Plan Woche 1\nB:\nx\n###NOTE###\nF: A\nT: Plan Woche 2\nB:\ny\n`,
  );

  const read = await tool(env, accessToken, "read_note", { title: "Plan" });
  assert.match(read.result.content[0].text, /trifft 2 Notizen/);
});

test("Schreiben landet in der Warteschlange und erreicht das iPad", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);
  await pushSnapshot(env);

  const created = await tool(env, accessToken, "create_note", {
    title: "Wochenplan",
    text: "Montag: Auswertung",
    folder: "Projekte",
  });
  assert.match(created.result.content[0].text, /nächsten Sync/);

  await tool(env, accessToken, "append_to_note", {
    title: "Einkaufsliste",
    text: "Butter",
  });

  const status = await tool(env, accessToken, "sync_status");
  assert.match(status.result.content[0].text, /Wartende Aufträge: 2/);

  const pulled = await (
    await call(env, "/device/pull", { headers: { "X-Device-Token": SETUP_CODE } })
  ).json();
  assert.equal(pulled.count, 2);
  assert.deepEqual(pulled.creates, [{ content: "Wochenplan\n\nMontag: Auswertung" }]);
  assert.deepEqual(pulled.appends, [{ title: "Einkaufsliste", text: "Butter" }]);

  // Zweimaliges Abholen darf denselben Auftrag nicht doppelt ausliefern.
  const again = await (
    await call(env, "/device/pull", { headers: { "X-Device-Token": SETUP_CODE } })
  ).json();
  assert.equal(again.count, 0);

  const confirmed = await (await pushSnapshot(env)).json();
  assert.equal(confirmed.jobsCompleted, 2);
});

test("Ein abgebrochener Sync bekommt seine Aufträge später erneut", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);
  await pushSnapshot(env);
  await tool(env, accessToken, "create_note", { title: "Verloren?", text: "nein", folder: "Projekte" });

  // Abholen, dann bricht der Kurzbefehl ab — es folgt kein Push.
  const first = await (
    await call(env, "/device/pull", { headers: { "X-Device-Token": SETUP_CODE } })
  ).json();
  assert.equal(first.count, 1);

  // Die Merkliste künstlich altern lassen, statt elf Minuten zu warten.
  const stalled = JSON.parse(await env.NOTES.get("inflight"));
  stalled.at = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  await env.NOTES.put("inflight", JSON.stringify(stalled));

  const retry = await (
    await call(env, "/device/pull", { headers: { "X-Device-Token": SETUP_CODE } })
  ).json();
  assert.equal(retry.count, 1, "Der Auftrag muss erneut zugestellt werden");
  assert.match(retry.creates[0].content, /^Verloren\?/);
});

test("Vereinfachter Endpunkt liefert nur fertige Notiztexte", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);
  await pushSnapshot(env);

  await tool(env, accessToken, "create_note", {
    title: "Wochenplan",
    text: "Montag: Auswertung",
    folder: "Projekte",
  });
  await tool(env, accessToken, "append_to_note", { title: "Einkaufsliste", text: "Butter" });

  const creates = await (
    await call(env, "/device/creates", { headers: { "X-Device-Token": SETUP_CODE } })
  ).json();

  // Blanke Liste fertiger Texte — kein Objekt, keine Verschachtelung.
  assert.deepEqual(creates, ["Wochenplan\n\nMontag: Auswertung"]);

  // Der Anhänge-Auftrag darf dabei nicht verloren gehen.
  const status = await tool(env, accessToken, "sync_status");
  assert.match(status.result.content[0].text, /Wartende Aufträge: 1/);

  const pending = await (
    await call(env, "/device/pull", { headers: { "X-Device-Token": SETUP_CODE } })
  ).json();
  assert.deepEqual(pending.appends, [{ title: "Einkaufsliste", text: "Butter" }]);
});

test("Geräte-Endpunkte weisen einen falschen Token ab", async () => {
  const env = makeEnv();
  const pull = await call(env, "/device/pull", { headers: { "X-Device-Token": "falsch" } });
  assert.equal(pull.status, 401);

  const push = await call(env, "/device/push", {
    method: "POST",
    headers: { "X-Device-Token": "falsch" },
    body: SNAPSHOT,
  });
  assert.equal(push.status, 401);
});

test("Benachrichtigungen ohne id werden quittiert, nicht beantwortet", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);
  const response = await call(env, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(response.status, 202);
});

test("Fehlendes SETUP_CODE-Secret meldet sich verständlich", async () => {
  const response = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST" }), {
    NOTES: makeEnv().NOTES,
  });
  assert.equal(response.status, 500);
  assert.match((await response.json()).message, /SETUP_CODE/);
});

test("Geteiltes PDF wird wie eine Notiz lesbar", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);

  const stored = await (
    await call(env, "/device/pdf?name=Arbeitsblatt%20S%C3%A4uren.pdf", {
      method: "POST",
      headers: { "X-Device-Token": SETUP_CODE },
      body: "Aufgabe 1: Bestimme den pH-Wert von Essigsäure.\nAufgabe 2: Nenne drei Indikatoren.",
    })
  ).json();

  assert.equal(stored.ok, true);
  assert.equal(stored.dokumenteGesamt, 1);

  // Ohne Notiz-Snapshot muss das PDF trotzdem auffindbar sein.
  const found = await tool(env, accessToken, "search_notes", { query: "Indikatoren" });
  assert.match(found.result.content[0].text, /Arbeitsblatt Säuren\.pdf/);

  const read = await tool(env, accessToken, "read_note", { title: "Arbeitsblatt" });
  assert.match(read.result.content[0].text, /pH-Wert von Essigsäure/);

  const overview = await tool(env, accessToken, "notes_overview");
  assert.match(overview.result.content[0].text, /PDF: 1/);
});

test("Dasselbe PDF erneut geteilt ersetzt die alte Fassung", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);

  const send = (body) =>
    call(env, "/device/pdf?name=Skript.pdf", {
      method: "POST",
      headers: { "X-Device-Token": SETUP_CODE },
      body,
    });

  await send("alte Fassung");
  const second = await (await send("neue Fassung")).json();
  assert.equal(second.dokumenteGesamt, 1, "Es darf kein Duplikat entstehen");

  const read = await tool(env, accessToken, "read_note", { title: "Skript" });
  assert.match(read.result.content[0].text, /neue Fassung/);
  assert.doesNotMatch(read.result.content[0].text, /alte Fassung/);
});

test("Ein Bild-PDF ohne Textebene wird deutlich abgewiesen", async () => {
  const env = makeEnv();
  const response = await call(env, "/device/pdf?name=Scan.pdf", {
    method: "POST",
    headers: { "X-Device-Token": SETUP_CODE },
    body: "   ",
  });

  assert.equal(response.status, 422);
  assert.match((await response.json()).message, /direkt in den Chat/);
});

test("PDFs überleben einen neuen Notiz-Sync", async () => {
  const env = makeEnv();
  const accessToken = await connect(env);

  await call(env, "/device/pdf?name=Merkblatt.pdf", {
    method: "POST",
    headers: { "X-Device-Token": SETUP_CODE },
    body: "Wichtig für die Klassenarbeit.",
  });

  // Der Snapshot wird bei jedem Sync komplett ersetzt — die Dokumente nicht.
  await pushSnapshot(env);

  const read = await tool(env, accessToken, "read_note", { title: "Merkblatt" });
  assert.match(read.result.content[0].text, /Klassenarbeit/);
});

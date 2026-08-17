# Notizen-Relay einrichten (nur iPad, kein Mac)

Der Relay ist ein Cloudflare Worker — **eine einzige Datei**, die du im Browser
einfügst. Kein Terminal, kein Build, keine Installation.

## Was der Relay tut

```
Claude (Cloud)  ──MCP──▶  Relay  ◀──HTTPS──  iPad-Kurzbefehl  ──▶  Apple Notes
```

Claude erreicht dein iPad nicht — Connectors werden aus Anthropics Cloud
aufgerufen. Und iPadOS lässt keinen Serverprozess zu. Der Relay ist der
Treffpunkt dazwischen:

- **Lesen** beantwortet der Relay sofort aus dem letzten **Snapshot**, den dein
  iPad hochgeladen hat.
- **Schreiben** legt er in eine **Warteschlange**, die dein iPad beim nächsten
  Sync abarbeitet.

Daraus folgt die wichtigste Eigenschaft dieses Aufbaus: **Claude sieht deine
Notizen mit dem Stand des letzten Syncs**, nicht live. Das Werkzeug
`sync_status` sagt jederzeit, wie alt dieser Stand ist.

## Kosten

Cloudflares Free-Tier reicht: 100 000 Worker-Anfragen und 100 000 KV-Lesevorgänge
pro Tag. Ein persönlicher Notizabgleich liegt um Größenordnungen darunter.

---

## Schritt 1 — Cloudflare-Konto

[dash.cloudflare.com](https://dash.cloudflare.com) im Safari öffnen und
registrieren. Keine Kreditkarte nötig, keine eigene Domain.

## Schritt 2 — Worker anlegen

1. **Compute (Workers)** → **Create application** → **Start with Hello World!**
2. Namen vergeben, z. B. `notizen-relay` → **Deploy**
3. **Edit code** öffnen, den gesamten Inhalt löschen und
   [`worker.js`](worker.js) vollständig einfügen → **Deploy**

> Auf dem iPad ist der Code-Editor bequemer, wenn du Safari querformat nutzt.
> Zum Einfügen: in GitHub bei `worker.js` auf **Raw**, alles markieren, kopieren.

## Schritt 3 — Speicher verbinden

Der Worker braucht einen KV-Namespace für Snapshot und Warteschlange.

1. Im Dashboard: **Storage & Databases** → **KV** → **Create instance**,
   Name z. B. `notizen`
2. Zurück zum Worker → **Settings** → **Bindings** → **Add** → **KV namespace**
   - **Variable name:** `NOTES` — genau so, der Worker sucht nach diesem Namen
   - **KV namespace:** `notizen`
3. **Deploy**

## Schritt 4 — Setup-Code setzen

Dieser Code schützt gleich zwei Dinge: die Anmeldung von Claude und den Zugang
deines iPads. Ohne ihn läge deine Notizsammlung offen im Netz.

1. Worker → **Settings** → **Variables and Secrets** → **Add**
2. Typ **Secret**, Name **`SETUP_CODE`**
3. Wert: etwas Langes und Zufälliges, z. B. `korb-lampe-tiger-47-blau`
4. **Deploy**

Notiere dir den Code — du brauchst ihn gleich zweimal.

## Schritt 5 — Läuft es?

Rufe `https://notizen-relay.<dein-name>.workers.dev/` im Safari auf. Es muss
**„Notizen-Relay läuft"** erscheinen, zusammen mit der Adresse für Claude.

Wenn stattdessen ein Hinweis auf `SETUP_CODE` kommt, fehlt das Secret aus
Schritt 4. Wenn ein Fehler zu `NOTES` erscheint, stimmt der Variablenname der
KV-Bindung aus Schritt 3 nicht.

## Schritt 6 — Connector in Claude eintragen

Custom Connectors lassen sich **nur auf claude.ai im Browser** hinzufügen, nicht
in der iPad-App. Danach synchronisiert Claude sie automatisch auf alle Geräte.

1. In Safari [claude.ai](https://claude.ai) öffnen. Falls die mobile Ansicht
   erscheint: **aA** in der Adressleiste → **Desktop-Website anfordern**
2. **Einstellungen** → **Connectors** → **Add custom connector**
3. URL: `https://notizen-relay.<dein-name>.workers.dev/mcp`
4. **Connect** → es öffnet sich ein Formular → **Setup-Code eingeben** →
   **Verbinden**

Danach steht der Connector auch in der iPad-App bereit.

## Schritt 7 — Sync-Kurzbefehl auf dem iPad

Fehlt noch die Seite, die tatsächlich an Apple Notes reicht:
**[../docs/ipad-relay-shortcut.md](../docs/ipad-relay-shortcut.md)**

Vor dem ersten Sync kann Claude nichts lesen und antwortet mit einem Hinweis
darauf — das ist kein Fehler.

---

## Werkzeuge, die Claude bekommt

| Werkzeug | Wirkung |
| --- | --- |
| `sync_status` | Wie alt ist der Stand, wie viele Aufträge warten |
| `notes_overview` | Alle Ordner mit Notizanzahl |
| `list_notes` | Titel auflisten, optional nach Ordner |
| `search_notes` | Volltextsuche im Snapshot |
| `read_note` | Eine Notiz vollständig lesen |
| `create_note` | Neue Notiz einreihen (beim nächsten Sync) |
| `append_to_note` | Text an bestehende Notiz einreihen |

## Sicherheit

- Der Zugang hängt vollständig am `SETUP_CODE`. Wer ihn kennt, kann deine
  Notizen lesen und schreiben — behandle ihn wie ein Passwort.
- Der Relay implementiert OAuth mit PKCE. Autorisierungscodes gelten 10 Minuten
  und **nur einmal**; der Setup-Code wird zeitkonstant verglichen, damit er sich
  nicht Zeichen für Zeichen erraten lässt.
- **Deine Notizinhalte liegen im Snapshot bei Cloudflare.** Das ist der Preis
  dieser Bauweise. Wenn dir das zu weit geht, überträgt der Sync-Kurzbefehl auf
  Wunsch nur Titel und Ordner statt vollständiger Texte — Claude kann dann
  suchen und einordnen, aber keine Inhalte lesen.
- Setup-Code wechseln: Secret im Dashboard ändern und in Claude neu verbinden.

## Tests

Die Logik des Workers lässt sich ohne Cloudflare-Konto prüfen — sie läuft gegen
ein KV im Arbeitsspeicher:

```bash
node --test "relay/test/*.test.mjs"
```

Abgedeckt sind der OAuth-Flow inklusive PKCE und Code-Wiederverwendung, der
MCP-Handshake, alle Werkzeuge sowie der Austausch mit dem iPad — einschließlich
des Falls, dass ein Sync mittendrin abbricht.

## Grenzen

- **Kein Live-Zugriff.** Claude liest den Stand des letzten Syncs.
- **Schreiben wirkt verzögert** — erst beim nächsten Sync.
- **Kein Löschen und kein Überschreiben.** Bewusst weggelassen: Ein
  zeitversetzter Auftrag, der auf einen veralteten Stand trifft, kann sonst die
  falsche Notiz treffen. Anlegen und Anhängen sind in diesem Punkt harmlos.
- **Der Snapshot ist begrenzt** auf die zuletzt geänderten Notizen (Standard
  100). Ältere erscheinen nicht.

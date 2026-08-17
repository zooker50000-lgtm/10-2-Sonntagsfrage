# apple-notes-mcp

Ein Connector zwischen Claude und **Apple Notes**: ein MCP-Server, der Claude
Notizen lesen, durchsuchen, anlegen, bearbeiten und löschen lässt.

Die Anbindung läuft über JXA (JavaScript for Automation) direkt gegen
`Notes.app` — keine Cloud, kein API-Key, keine Daten verlassen den Mac.

## Welcher Weg passt zu dir?

| Dein Gerät | Weg | Anleitung |
| --- | --- | --- |
| **Mac** | MCP-Server aus diesem Repo — Claude liest und schreibt selbstständig | weiter unten |
| **Nur iPad / iPhone** | Kurzbefehle-Brücke über die Zwischenablage | **[docs/ipad-shortcuts.md](docs/ipad-shortcuts.md)** |

> **Der MCP-Server braucht zwingend einen Mac.** iPadOS und iOS kennen kein
> AppleScript/JXA und lassen keinen Prozess zu, der auf eine fremde App
> zugreift. Auf dem iPad ist die Kurzbefehle-App die einzige Schnittstelle zu
> Apple Notes — dafür kommt sie fast an den Funktionsumfang hier heran.
> In einer Linux-Umgebung (z. B. Claude Code im Web) meldet jedes Tool sauber
> `unsupported_platform`.

## Voraussetzungen

- macOS mit eingerichteter Notes.app
- Node.js ≥ 18

## Installation

```bash
git clone https://github.com/zooker50000-lgtm/10-2-Sonntagsfrage.git
cd 10-2-Sonntagsfrage
npm install          # baut über den prepare-Hook direkt nach dist/
npm run doctor       # prüft macOS, Build und Zugriff auf Notes.app
```

`npm run doctor` sollte am Ende `Alles bereit` melden. Beim allerersten Aufruf
fragt macOS, ob das Terminal Notizen steuern darf — das muss man erlauben.

Falls man zu schnell auf „Nicht erlauben" geklickt hat:

> Systemeinstellungen → Datenschutz & Sicherheit → Automatisierung → den
> Eintrag für Terminal bzw. Claude aufklappen → **Notizen** aktivieren.

Danach den MCP-Server neu starten.

## In Claude einbinden

### Claude Code

```bash
claude mcp add apple-notes -- node /ABSOLUTER/PFAD/ZU/10-2-Sonntagsfrage/dist/index.js
```

### Claude Desktop

In `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "apple-notes": {
      "command": "node",
      "args": ["/ABSOLUTER/PFAD/ZU/10-2-Sonntagsfrage/dist/index.js"]
    }
  }
}
```

Claude Desktop danach komplett beenden und neu starten. Der Pfad muss absolut
sein — relative Pfade findet der Client nicht.

## Was Claude damit kann

| Tool | Zweck |
| --- | --- |
| `notes_status` | Verbindung prüfen, Accounts und Bestandszahlen anzeigen |
| `list_folders` | Alle Ordner samt Unterordner-Pfaden und Notizanzahl |
| `list_notes` | Notizen auflisten, zuletzt geänderte zuerst, mit Blättern |
| `search_notes` | Volltextsuche über Titel und Inhalt |
| `read_note` | Eine Notiz vollständig lesen (optional als rohes HTML) |
| `create_note` | Neue Notiz aus Markdown anlegen |
| `update_note` | Inhalt anhängen, voranstellen oder ersetzen |
| `delete_note` | Notiz nach „Zuletzt gelöscht" verschieben (braucht `confirm: true`) |
| `create_folder` | Ordner oder Unterordner anlegen |
| `open_note` | Notiz in Notes.app im Vordergrund öffnen |

Beispiele für Sätze, die damit funktionieren:

- „Was steht in meinen Notizen zur Sonntagsfrage?"
- „Leg im Ordner *Projekte* eine Notiz *Wochenplan* mit einer Checkliste an."
- „Häng an die Notiz *Einkaufsliste* noch Milch und Brot an."
- „Such alle Notizen, in denen *Umfrage* vorkommt, und fass sie zusammen."

## Formatierung

`create_note` und `update_note` nehmen standardmäßig **Markdown** entgegen und
übersetzen es in das HTML-Fragment, das Notes speichert: Überschriften (`#`
bis `###`), Aufzählungen, nummerierte Listen, `**fett**`, `*kursiv*`,
`` `code` ``, Links, Zitate, Trennlinien und Codeblöcke.

Zwei Eigenheiten von Apple Notes, die der Server abfängt:

- **Der Titel kommt aus der ersten Zeile**, nicht aus der `name`-Property.
  Deshalb wird der übergebene Titel automatisch als `<h1>` vorangestellt.
- **Echte Checklisten** lassen sich über die Skripting-Schnittstelle nicht
  setzen. `- [ ]` und `- [x]` werden darum als `☐`/`☑` gerendert — sichtbar,
  aber nicht anklickbar.

Wer die volle Kontrolle braucht, setzt `format: "html"` und übergibt das
Fragment direkt.

## Sicherheit und Grenzen

- **Löschen ist abgesichert:** `delete_note` verlangt ausdrücklich
  `confirm: true` und verschiebt die Notiz nur nach „Zuletzt gelöscht", wo sie
  rund 30 Tage wiederherstellbar bleibt.
- **Passwortgeschützte Notizen** werden als gesperrt markiert; ihr Inhalt wird
  weder gelesen noch verändert.
- **Nutzertext wird escaped**, bevor er ins HTML wandert — außer bei
  `format: "html"`, wo der Aufrufer selbst verantwortlich ist.
- Der Server hat vollen Lese- und Schreibzugriff auf alle lokalen Notizen.
  Wer das eingrenzen will, arbeitet mit einem eigenen Notes-Account.

## Entwicklung

```bash
npm run build      # TypeScript kompilieren + JXA-Skript nach dist/ kopieren
npm test           # Tests des Markdown-Konverters
npm run typecheck  # Nur Typprüfung
npm run doctor     # Umgebung und Notes-Zugriff prüfen (nur macOS)
```

### Aufbau

```
src/index.ts       MCP-Server: Tool-Definitionen, Schemas, Ausgabeformat
src/notes.ts       Typisierte API über die JXA-Brücke
src/jxa.ts         Startet osascript, übersetzt macOS-Fehlercodes in Klartext
src/markdown.ts    Markdown → Notes-HTML
src/jxa/notes.js   JXA-Skript, das in Notes.app ausgeführt wird
```

Der Datenfluss ist immer derselbe: Claude ruft ein Tool auf → `src/notes.ts`
baut die Parameter → `src/jxa.ts` startet
`osascript -l JavaScript src/jxa/notes.js '<json>'` → das Skript spricht mit
Notes.app und gibt eine JSON-Zeile zurück.

`src/jxa/notes.js` ist bewusst in ES5 gehalten: `osascript` führt es in
JavaScriptCore ohne Modulunterstützung aus, und die Apple-Event-Bridge kommt
mit modernen Iterables nicht zurecht. Eigenschaften werden dort außerdem
gebündelt abgefragt (ein Apple Event für alle Titel statt einer pro Notiz) —
bei großen Bibliotheken ist das der Unterschied zwischen sofort und zehn
Sekunden.

## Lizenz

MIT

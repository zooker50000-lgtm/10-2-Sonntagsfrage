# Der Sync-Kurzbefehl „Claude-Sync"

Ein einziger Kurzbefehl auf dem iPad hält beide Richtungen am Laufen: Er holt
Claudes Aufträge ab, führt sie in Apple Notes aus, und lädt danach den aktuellen
Stand deiner Notizen zum Relay hoch.

**Voraussetzung:** Der Relay läuft bereits — siehe
[../relay/README.md](../relay/README.md). Du brauchst die Worker-Adresse und
deinen Setup-Code.

Trage beides einmal hier ein, dann kannst du es unten stumpf abschreiben:

- Adresse: `https://notizen-relay.____.workers.dev`
- Setup-Code: `____`

> **Zu den Aktionsnamen:** Die deutsche Kurzbefehle-App übersetzt sie, und die
> Bezeichnungen wechseln zwischen iPadOS-Versionen. Unten steht jeweils
> **deutsch** und *englisch* — mit dem englischen Namen findest du die Aktion
> notfalls über die Suche im Aktionen-Katalog.

---

## Vorbereitung

Lege in Apple Notes einen Ordner **„Claude"** an. Dort landet alles, was Claude
neu anlegt.

Dann in der Kurzbefehle-App auf **+**, den Kurzbefehl **„Claude-Sync"** nennen
und die folgenden Aktionen in dieser Reihenfolge einsetzen.

---

## Teil A — Claudes Aufträge holen

### 1. Inhalte von URL abrufen · *Get Contents of URL*

- URL: `https://.../device/pull`
- Methode: **GET**
- **Header** hinzufügen:
  - Schlüssel `X-Device-Token`
  - Wert: dein Setup-Code

### 2. Wörterbuchwert abrufen · *Get Dictionary Value*

- Schlüssel: `creates`
- Aus: Ergebnis von Schritt 1

### 3. Mit jedem Objekt wiederholen · *Repeat with Each*

Eingabe: Ergebnis aus Schritt 2. **Darin:**

- **Wörterbuchwert abrufen** — Schlüssel `content`, aus dem Wiederholungsobjekt
- **Notiz erstellen** (*Create Note*)
  - Inhalt: das eben geholte `content`
  - **Ordner: Claude**

> Der Relay liefert Titel und Text bereits zusammengesetzt in `content`, mit dem
> Titel als erster Zeile. Genau daraus leitet Apple Notes den Notiznamen ab —
> deshalb muss der Kurzbefehl hier nichts zusammenbauen.

### 4. Wörterbuchwert abrufen · *Get Dictionary Value*

- Schlüssel: `appends`
- Aus: Ergebnis von **Schritt 1**

### 5. Mit jedem Objekt wiederholen · *Repeat with Each*

Eingabe: Ergebnis aus Schritt 4. **Darin:**

- **Wörterbuchwert abrufen** — Schlüssel `title`
- **Notizen suchen** (*Find Notes*)
  - Filter: **Name enthält** → der eben geholte `title`
  - Limit: **1**
- **Wörterbuchwert abrufen** — Schlüssel `text`
- **An Notiz anhängen** (*Append to Note*)
  - **Notiz:** Ergebnis von *Notizen suchen*
  - **Text:** der eben geholte `text`

> *An Notiz anhängen* erwartet eine **Notiz-Referenz**, keinen Titel als Text —
> darum steht *Notizen suchen* zwingend davor. Das ist die häufigste
> Stolperstelle beim Bauen.

---

## Teil B — Aktuellen Stand hochladen

### 6. Notizen suchen · *Find Notes*

- Sortieren nach **Zuletzt geändert**, absteigend
- Limit: **50** zum Einstieg (später auf 100 erhöhen, wenn alles läuft)

### 7. Variable festlegen · *Set Variable*

- Name: `Snapshot`, Wert leer lassen

### 8. Mit jedem Objekt wiederholen · *Repeat with Each*

Eingabe: Ergebnis aus Schritt 6. **Darin** eine **Zu Variable hinzufügen**-Aktion
(*Add to Variable*) auf `Snapshot`, deren Wert eine **Text**-Aktion mit genau
diesem Aufbau ist:

```
###NOTE###
F: ⟨Ordner⟩
T: ⟨Name⟩
M: ⟨Zuletzt geändert⟩
B:
⟨Text⟩
```

**Die ⟨spitzen Klammern⟩ tippst du nicht ab.** Tippe auf die Variablenleiste über
der Tastatur, wähle das Wiederholungsobjekt, tippe die eingefügte Variable dann
**erneut an** und stelle die Eigenschaft um — auf *Ordner*, *Name*,
*Zuletzt geändert* bzw. *Text*.

Die Marken `###NOTE###`, `F:`, `T:`, `M:` und `B:` müssen exakt so stehen; der
Relay zerlegt den Text daran.

### 9. Text kombinieren · *Combine Text*

- Eingabe: `Snapshot`
- Trennzeichen: **Neue Zeile**

### 10. Inhalte von URL abrufen · *Get Contents of URL*

- URL: `https://.../device/push`
- Methode: **POST**
- Header: `X-Device-Token` → dein Setup-Code
- **Anfragetext: Datei** (*Request Body: File*) → Ergebnis aus Schritt 9

> Nicht „JSON" wählen. Der Relay erwartet hier reinen Text — verschachteltes
> JSON in Kurzbefehlen zusammenzuklicken wäre deutlich mühsamer.

### 11. Mitteilung anzeigen · *Show Notification*

- Text: Ergebnis aus Schritt 10 — dann siehst du direkt, wie viele Notizen
  übertragen und wie viele Aufträge erledigt wurden.

---

## Erster Lauf

Kurzbefehl starten. Beim ersten Mal fragt iPadOS nach Erlaubnis für Notizen und
für den Netzwerkzugriff — beides erlauben.

Die Mitteilung sollte etwa so aussehen:

```
{"ok":true,"notes":50,"jobsCompleted":0}
```

Danach in Claude fragen: *„Wie ist der Sync-Status meiner Notizen?"* — Claude
sollte Zeitpunkt und Anzahl nennen.

---

## Automatisch synchronisieren

Damit du nicht daran denken musst:

**Beim Öffnen von Claude** (die nützlichste Variante — der Stand ist frisch,
genau wenn du ihn brauchst):

1. Kurzbefehle → **Automation** → **+** → **App**
2. App: **Claude**, Auslöser: **Wird geöffnet**
3. Aktion: **Kurzbefehl ausführen** → `Claude-Sync`
4. **Sofort ausführen** einschalten, **Vor dem Ausführen fragen** ausschalten

**Zusätzlich zeitgesteuert**, damit Claudes Aufträge auch dann ankommen, wenn du
die App länger nicht öffnest: dieselbe Automation mit Auslöser **Tageszeit**,
z. B. stündlich zwischen 8 und 22 Uhr.

Ein Tipp für den Alltag: Wenn Claude dir sagt „ist eingereiht", genügt ein Start
des Kurzbefehls, damit es sofort passiert.

---

## Stolpersteine, die in der Praxis auftraten

Diese Punkte stammen aus einer echten Einrichtung auf iPadOS und kosten sonst
jeweils eine Viertelstunde:

- **„Diese Aktion versucht, N Notizen-Objekte zu teilen. Dies ist nicht
  erlaubt."** — iPadOS blockt Kurzbefehle, die viele Objekte auf einmal
  verarbeiten. Abhilfe: Einstellungen → Apps → Kurzbefehle → Erweitert →
  **„Große Datenmengen teilen erlauben"** einschalten. Bei fünf Notizen taucht
  die Meldung nie auf, bei hundert sofort.
- **Zwei fast gleich benannte Aktionen.** „Inhalte **der Webseite** von URL
  abrufen" liest Webseitentext aus und hat keine Methode/Header. Gebraucht wird
  „Inhalte von URL abrufen" (grünes Icon). Der Unterschied ist genau das Wort
  „Webseite".
- **Das Anfügen der Variablen ist reihenfolgeabhängig.** Wer erst alle Marken
  tippt und danach die Variablen einfügt, bekommt beide Variablen am Ende
  untereinander. Strikt von oben nach unten arbeiten: Marke, Variable, Marke,
  Variable.
- **Ein Änderungsdatum gibt es nicht.** Die Eigenschaften einer Notiz-Variable
  sind Notiz, Name, Zusammenfassung, Text, Ordner, Angepinnt und Tags — kein
  Datum. Der `###M###`-Abschnitt entfällt deshalb ersatzlos, der Relay kommt
  ohne ihn zurecht.
- **Die Variablenleiste erscheint nur bei Fokus im Textfeld.** Tippt man
  zwischendurch woanders hin, fügt der Knopf nichts mehr ein. Der verlässlichere
  Weg ist „Variable auswählen" ganz unten links.
- **`sync_status` zeigt die Relay-Version und den Anfang des zuletzt
  empfangenen Textes.** Wenn 0 Notizen ankommen, steht dort sofort, ob das iPad
  nichts geschickt hat, das Format nicht passt oder der Worker veraltet ist.

## Wenn etwas klemmt

| Beobachtung | Ursache |
| --- | --- |
| `401` in der Mitteilung | Setup-Code im Header stimmt nicht mit dem Worker-Secret überein |
| Claude sagt „noch kein Snapshot" | Teil B lief nie durch — Schritt 10 prüfen |
| Notizen kommen leer an | In Schritt 8 fehlt die Eigenschaft *Text*; die Variable erneut antippen und umstellen |
| Neue Notizen doppelt | Der Kurzbefehl lief zweimal ohne abgeschlossenen Teil B — Teil B muss immer mitlaufen |
| Anhängen trifft die falsche Notiz | *Notizen suchen* filtert auf **Name enthält**; bei ähnlichen Titeln Claude bitten, den vollen Titel zu verwenden |
| Nichts passiert, keine Fehlermeldung | Netzwerkzugriff wurde beim ersten Lauf verweigert — Einstellungen → Kurzbefehle |

## Nur Titel statt Inhalte übertragen

Wenn du nicht möchtest, dass deine Notiztexte bei Cloudflare liegen: In Schritt 8
die Zeile mit ⟨Text⟩ weglassen, `B:` aber stehen lassen. Claude kann dann Titel
und Ordner sehen, suchen und schreiben — aber keine Inhalte lesen.

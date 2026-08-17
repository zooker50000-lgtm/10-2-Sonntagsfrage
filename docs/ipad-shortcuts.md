# Claude ⇄ Apple Notes auf dem iPad

Diese Anleitung baut die Brücke ohne Server, ohne Hosting und ohne Mac — nur mit
der **Kurzbefehle**-App, die auf jedem iPad vorinstalliert ist.

## Warum nicht der MCP-Server aus diesem Repo?

Der MCP-Server im Hauptverzeichnis steuert Apple Notes über AppleScript/JXA. Das
gibt es auf iPadOS nicht, und iPadOS lässt auch keinen Hintergrundprozess zu, der
auf eine fremde App zugreift. Auf dem iPad ist **Kurzbefehle die einzige
Schnittstelle zu Apple Notes** — sie kann dafür aber fast alles, was der Server
auf dem Mac kann.

Der zweite Grund ist die Bauweise von Claude selbst: Remote-Connectors werden aus
Anthropics Cloud aufgerufen, nicht von deinem Gerät. Ein Connector könnte dein
iPad also gar nicht erreichen. Deshalb ist hier **die Zwischenablage der
Transportweg** — und du der Auslöser.

## Das Prinzip

```
Lesen:     Apple Notes → Kurzbefehl → Zwischenablage → in Claude einfügen
Schreiben: Claude → kopieren → Kurzbefehl → Apple Notes
```

Fünf Kurzbefehle decken alles ab:

| Kurzbefehl | Richtung | Zweck |
| --- | --- | --- |
| 1. Notiz an Claude | lesen | Eine Notiz auswählen und ihren Text kopieren |
| 2. Notiz-Index an Claude | lesen | Ordnerstruktur + alle Titel als Übersicht |
| 3. Notizsuche an Claude | lesen | Volltextsuche, Treffer gesammelt kopieren |
| 4. Claude → neue Notiz | schreiben | Kopierten Text als neue Notiz anlegen |
| 5. Claude → anhängen | ändern | Kopierten Text an eine bestehende Notiz hängen |

> **Zu den Aktionsnamen:** Die deutsche Kurzbefehle-App übersetzt Aktionsnamen,
> und die Bezeichnungen ändern sich zwischen iPadOS-Versionen gelegentlich.
> Unten steht jeweils **deutsch (englisch)** — mit dem englischen Namen findest
> du die Aktion notfalls über die Suchleiste im Aktionen-Katalog.

---

## Vorbereitung

Lege in Apple Notes einen Ordner **„Claude"** an. Er dient als Eingang für alles,
was Claude schreibt — so landet nichts versehentlich zwischen deinen eigenen
Notizen.

Öffne dann die **Kurzbefehle**-App → **+** oben rechts für jeden neuen Kurzbefehl.

---

## 1. Notiz an Claude

Wählt eine Notiz aus einer Liste und legt ihren Inhalt in die Zwischenablage.

**Aktionen in dieser Reihenfolge:**

1. **Notizen suchen** (*Find Notes*)
   - Sortieren nach: **Zuletzt geändert**, Reihenfolge **absteigend**
   - Limit: **25** Notizen
   - *Kein Filter* — dann erscheinen alle Notizen, zuletzt bearbeitete zuerst
2. **Aus Liste auswählen** (*Choose from List*)
   - Eingabe: das Ergebnis von Schritt 1
   - Titel: `Welche Notiz?`
3. **Text** (*Text*)
   - Inhalt (die Werte in spitzen Klammern als Magic Variable einsetzen, siehe
     Hinweis unten):

     ```
     Notiz: <Name>
     Ordner: <Ordner>
     Geändert: <Zuletzt geändert>

     <Text>
     ```
4. **In die Zwischenablage kopieren** (*Copy to Clipboard*)
5. **Mitteilung anzeigen** (*Show Notification*) — Text: `Kopiert – in Claude einfügen`

**Magic Variables einsetzen:** Tippe im Text-Feld auf die Variablenleiste über der
Tastatur und wähle das Ergebnis von *Aus Liste auswählen*. Tippe die eingefügte
Variable danach **erneut an** — dann kannst du die Eigenschaft umstellen
(*Name*, *Text*/*Body*, *Ordner*, *Zuletzt geändert*). So bekommst du aus einer
Notiz-Variable die vier Felder oben.

**Nutzung:** Kurzbefehl starten → Notiz wählen → zu Claude wechseln → einfügen.

---

## 2. Notiz-Index an Claude

Gibt Claude den Überblick über deine **Ordnerstruktur** und alle Notiztitel — ohne
die kompletten Inhalte. Damit kann Claude gezielt sagen, welche Notiz es braucht.

1. **Notizen suchen** (*Find Notes*)
   - Sortieren nach: **Zuletzt geändert**, absteigend
   - Limit: **200** (bei sehr vielen Notizen niedriger ansetzen)
2. **Variable festlegen** (*Set Variable*) — Name: `Index`, Wert: leer lassen
3. **Mit jedem Objekt wiederholen** (*Repeat with Each*), Eingabe: Ergebnis aus 1
   - darin: **Zu Variable hinzufügen** (*Add to Variable*) → Variable `Index`
   - Wert: eine **Text**-Aktion mit `<Ordner> | <Name>`
     (beide als Eigenschaft der Wiederholungs-Variable, siehe Hinweis oben)
4. **Text kombinieren** (*Combine Text*) — Eingabe `Index`, Trennzeichen: **Neue Zeile**
5. **In die Zwischenablage kopieren** (*Copy to Clipboard*)

Ergebnis (in Claude einfügen):

```
Projekte | Sonntagsfrage Auswertung
Projekte | Fragebogen Entwurf
Privat | Einkaufsliste
```

Warum diese Umwegkonstruktion: Kurzbefehle hat **keine Aktion, die Ordner direkt
auflistet**. Der Ordnername ist aber eine Eigenschaft jeder Notiz — also leitet
man die Struktur aus den Notizen ab. Das ist zugleich der Grund, warum es diesen
Kurzbefehl überhaupt braucht.

---

## 3. Notizsuche an Claude

1. **Nach Eingabe fragen** (*Ask for Input*) — Typ **Text**, Frage: `Wonach suchen?`
2. **Notizen suchen** (*Find Notes*)
   - Filter: **Text enthält** (*Body contains*) → als Wert die **Eingabe** aus Schritt 1
   - Limit: **10**
3. **Variable festlegen** — Name `Treffer`, leer
4. **Mit jedem Objekt wiederholen** über das Ergebnis aus 2:
   - **Zu Variable hinzufügen** → `Treffer`, Wert: **Text**-Aktion mit

     ```
     ### <Name> (<Ordner>)
     <Text>
     ```
5. **Text kombinieren** — Trennzeichen: **Neue Zeile**
6. **In die Zwischenablage kopieren**

Wenn der Filterwert sich nicht auf die Eingabe setzen lässt: auf das Filterfeld
tippen und die Variable aus der Leiste über der Tastatur wählen — Filterwerte
akzeptieren Variablen, die Ordner-Auswahl dagegen nicht.

---

## 4. Claude → neue Notiz

1. **Zwischenablage abrufen** (*Get Clipboard*)
2. **Notiz erstellen** (*Create Note*)
   - Inhalt: Ergebnis aus Schritt 1
   - **Ordner: Claude** (das Feld antippen und den Ordner wählen)
3. **Notiz anzeigen** (*Show Note*) — Eingabe: die erstellte Notiz

**Nutzung:** In Claude die Antwort kopieren → Kurzbefehl starten → fertig.

Der **Titel entsteht aus der ersten Zeile** des Inhalts. Bitte Claude also, den
Text mit einer sauberen Titelzeile beginnen zu lassen — sonst heißt die Notiz wie
der erste Halbsatz. Markdown wird von Apple Notes **nicht** gerendert: `**fett**`
bleibt als Sternchen stehen. Sag Claude für diesen Weg am besten „ohne Markdown,
nur Klartext mit Bindestrich-Listen".

---

## 5. Claude → an Notiz anhängen

1. **Zwischenablage abrufen** (*Get Clipboard*)
2. **Notizen suchen** (*Find Notes*) — sortiert nach **Zuletzt geändert**, Limit **25**
3. **Aus Liste auswählen** (*Choose from List*) — Titel: `An welche Notiz anhängen?`
4. **An Notiz anhängen** (*Append to Note*)
   - **Notiz:** das Ergebnis aus Schritt 3 (Magic Variable)
   - **Text:** das Ergebnis aus Schritt 1
5. **Mitteilung anzeigen** — `Angehängt`

Der Reihenfolge in Schritt 2–4 liegt eine Eigenheit zugrunde: *An Notiz anhängen*
erwartet eine **Notiz-Referenz**, keinen Titel als Text. Ohne vorheriges
*Notizen suchen* findet die Aktion das Ziel nicht.

---

## Schneller Zugriff auf dem iPad

Damit die Kurzbefehle im Alltag nicht stören, lohnt sich mindestens eine dieser
Optionen:

- **Home-Bildschirm:** im Kurzbefehl auf ⓘ → *Zum Home-Bildschirm hinzufügen*
- **Kontrollzentrum:** Einstellungen → Kontrollzentrum → *Kurzbefehle* hinzufügen
- **Tastaturkürzel** (mit Magic Keyboard): in der Kurzbefehle-App auf ⓘ →
  *Tastaturkurzbefehl* — der schnellste Weg, wenn Claude im Split View liegt
- **Split View:** Claude links, Kurzbefehle rechts — dann ist Kopieren und
  Einfügen ein Fingertipp ohne App-Wechsel

---

## Was dieser Weg nicht kann

Ehrlich vorab, damit nichts überrascht:

- **Claude arbeitet nicht von allein.** Jeder Austausch braucht deinen Tipp.
  Automatisches Lesen im Hintergrund ist auf iPadOS ohne gehosteten Relay nicht
  möglich — das wäre der zweite Weg aus der Auswahl.
- **Kein Ersetzen von Notizinhalten.** Kurzbefehle kann anhängen und erstellen,
  aber den Text einer bestehenden Notiz nicht überschreiben. Workaround: neue
  Notiz anlegen und die alte löschen.
- **Kein Markdown-Rendering** in Apple Notes über diesen Weg.
- **Passwortgeschützte Notizen** liefern über *Notizen suchen* keinen Inhalt.
- **Lange Notizen** können die Zwischenablage und das Claude-Kontext­fenster
  sprengen — dafür ist Kurzbefehl 2 (Index) gedacht: erst Struktur zeigen, dann
  gezielt eine Notiz holen.

## Wenn du später doch mehr willst

Sobald ein Mac dazukommt, ist der MCP-Server im Hauptverzeichnis dieses Repos
der bequemere Weg: Claude liest und schreibt dann ohne dein Zutun. Die
Kurzbefehle können daneben bestehen bleiben.

Der Mittelweg ohne Mac wäre ein gehosteter Relay-Server plus ein Kurzbefehl, der
regelmäßig Aufträge abholt. Das kostet Einrichtung und ein Hosting-Konto — sag
Bescheid, wenn es so weit ist.

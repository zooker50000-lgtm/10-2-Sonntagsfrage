/**
 * Testet den Markdown→Notes-HTML-Konverter gegen die kompilierte dist/.
 * Alles andere im Projekt braucht eine laufende Notes.app und ist damit nur
 * auf einem Mac prüfbar — dafür gibt es `npm run doctor`.
 */
import assert from "node:assert/strict";
import test from "node:test";

const { bodyToHtml, withTitleHeading, escapeHtml } = await import("../dist/markdown.js");

test("Überschriften werden zu h1–h3", () => {
  assert.equal(bodyToHtml("# Titel", "markdown"), "<h1>Titel</h1>");
  assert.equal(bodyToHtml("### Klein", "markdown"), "<h3>Klein</h3>");
});

test("Aufzählungen werden zu einer einzigen Liste zusammengefasst", () => {
  assert.equal(bodyToHtml("- eins\n- zwei", "markdown"), "<ul><li>eins</li><li>zwei</li></ul>");
});

test("Nummerierte Listen nutzen ol", () => {
  assert.equal(bodyToHtml("1. eins\n2. zwei", "markdown"), "<ol><li>eins</li><li>zwei</li></ol>");
});

test("Wechsel der Listenart schließt die vorherige Liste", () => {
  assert.equal(bodyToHtml("- a\n1. b", "markdown"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
});

test("Checkboxen werden zu Unicode-Kästchen", () => {
  assert.equal(bodyToHtml("- [ ] offen\n- [x] fertig", "markdown"), "<ul><li>☐ offen</li><li>☑ fertig</li></ul>");
});

test("Inline-Auszeichnungen und Links", () => {
  assert.equal(bodyToHtml("**fett** und *kursiv*", "markdown"), "<div><b>fett</b> und <i>kursiv</i></div>");
  assert.equal(bodyToHtml("`code`", "markdown"), "<div><code>code</code></div>");
  assert.equal(
    bodyToHtml("[Anthropic](https://anthropic.com)", "markdown"),
    '<div><a href="https://anthropic.com">Anthropic</a></div>',
  );
});

test("Codeblöcke bleiben unformatiert", () => {
  assert.equal(bodyToHtml("```\n<b>roh</b>\n```", "markdown"), "<pre><code>&lt;b&gt;roh&lt;/b&gt;<br></code></pre>");
});

test("Ein offener Codeblock wird am Ende geschlossen", () => {
  assert.match(bodyToHtml("```\nabc", "markdown"), /<\/code><\/pre>$/);
});

test("HTML im Nutzertext wird escaped, nicht interpretiert", () => {
  assert.equal(bodyToHtml("<script>alert(1)</script>", "text"), "<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>");
  assert.equal(escapeHtml('a & b < c > d "e"'), "a &amp; b &lt; c &gt; d &quot;e&quot;");
});

test("format=html reicht den Inhalt unverändert durch", () => {
  assert.equal(bodyToHtml("<div>roh</div>", "html"), "<div>roh</div>");
});

test("Leerzeilen werden zu Absatzabständen", () => {
  assert.equal(bodyToHtml("a\n\nb", "text"), "<div>a</div><div><br></div><div>b</div>");
});

test("Leerer Inhalt bleibt leer", () => {
  assert.equal(bodyToHtml("", "markdown"), "");
});

test("Der Titel wird als h1 vorangestellt und escaped", () => {
  assert.equal(withTitleHeading("Q&A", "<div>x</div>"), "<h1>Q&amp;A</h1><div>x</div>");
});

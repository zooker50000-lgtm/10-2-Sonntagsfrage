/**
 * Apple Notes speichert Inhalte als HTML-Fragment. Notes akzeptiert nur einen
 * kleinen Tag-Vorrat (h1–h3, div, b/i/u, ul/ol/li, a, pre/code, br, hr) — alles
 * andere wird beim Import still verworfen. Darum ein eigener, absichtlich
 * kleiner Konverter statt einer vollen Markdown-Bibliothek.
 */

export type BodyFormat = "markdown" | "text" | "html";

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Fett/kursiv/Code/Links — auf bereits escapetem Text. */
function inlineFormatting(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function inline(raw: string): string {
  return inlineFormatting(escapeHtml(raw));
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];

  let listTag: "ul" | "ol" | null = null;
  let inCodeBlock = false;

  const closeList = () => {
    if (listTag) {
      html.push(`</${listTag}>`);
      listTag = null;
    }
  };

  const openList = (tag: "ul" | "ol") => {
    if (listTag === tag) return;
    closeList();
    html.push(`<${tag}>`);
    listTag = tag;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeList();
      html.push(inCodeBlock ? "</code></pre>" : "<pre><code>");
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      html.push(`${escapeHtml(line)}<br>`);
      continue;
    }

    if (!line.trim()) {
      closeList();
      html.push("<div><br></div>");
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      closeList();
      html.push("<hr>");
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }

    // Checkboxen: Notes' echte Checklisten lassen sich nicht über `body`
    // setzen, deshalb als Unicode-Kästchen — sichtbar und kopierbar.
    const checkbox = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (checkbox) {
      openList("ul");
      const mark = checkbox[1]!.toLowerCase() === "x" ? "☑" : "☐";
      html.push(`<li>${mark} ${inline(checkbox[2]!)}</li>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      openList("ul");
      html.push(`<li>${inline(bullet[1]!)}</li>`);
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      openList("ol");
      html.push(`<li>${inline(ordered[1]!)}</li>`);
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      html.push(`<div><i>${inline(quote[1]!)}</i></div>`);
      continue;
    }

    closeList();
    html.push(`<div>${inline(line)}</div>`);
  }

  if (inCodeBlock) html.push("</code></pre>");
  closeList();

  return html.join("");
}

function plainTextToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => (line.trim() ? `<div>${escapeHtml(line)}</div>` : "<div><br></div>"))
    .join("");
}

export function bodyToHtml(body: string, format: BodyFormat): string {
  if (!body) return "";
  if (format === "html") return body;
  if (format === "text") return plainTextToHtml(body);
  return markdownToHtml(body);
}

/**
 * Notes leitet den angezeigten Titel aus der ersten Zeile des Inhalts ab, nicht
 * aus der `name`-Property. Ohne führende Überschrift heißt die Notiz in der
 * Liste also anders als angefordert.
 */
export function withTitleHeading(title: string, html: string): string {
  return `<h1>${escapeHtml(title)}</h1>${html}`;
}

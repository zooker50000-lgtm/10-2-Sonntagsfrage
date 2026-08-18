/**
 * JXA-Bruecke zu Apple Notes.
 *
 * Wird als `osascript -l JavaScript notes.js '<json>'` aufgerufen und gibt
 * eine JSON-Zeile auf stdout zurueck: {"ok":true,"data":...} oder
 * {"ok":false,"error":"<code>","message":"..."}.
 *
 * Bewusst ES5: osascript nutzt JavaScriptCore ohne Modul-Support, und
 * Apple-Event-Bridging vertraegt keine modernen Iterables.
 */

/* global Application, ObjC, $ */

var MAX_FOLDER_DEPTH = 6;
// Ab dieser Bibliotheksgroesse wird die Volltextsuche im Fallback-Pfad
// uebersprungen: `plaintext` aller Notizen in einem Rutsch zu holen wuerde
// sonst minutenlang blockieren.
var FULLTEXT_SCAN_LIMIT = 3000;

function notesApp() {
  var app = Application('Notes');
  app.includeStandardAdditions = true;
  return app;
}

function fail(code, message) {
  var err = new Error(message);
  err.code = code;
  return err;
}

/** Apple-Events werfen bei fehlenden Properties — nie den ganzen Call killen. */
function safe(fn, fallback) {
  try {
    var value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch (e) {
    return fallback;
  }
}

function toIso(value) {
  if (!value) return null;
  try {
    return new Date(value).toISOString();
  } catch (e) {
    return null;
  }
}

/**
 * Holt eine Property fuer alle Elemente einer Collection mit einem einzigen
 * Apple Event statt einem pro Notiz — der Unterschied zwischen "sofort" und
 * "zehn Sekunden" bei grossen Bibliotheken.
 */
function bulk(collection, property, count) {
  try {
    var values = collection[property]();
    if (values && values.length) return values;
  } catch (e) {
    /* faellt unten auf Einzelabfrage zurueck */
  }
  var out = [];
  for (var i = 0; i < count; i++) {
    out.push(safe(function () { return collection.at(i)[property](); }, null));
  }
  return out;
}

function collectionCount(collection) {
  return safe(function () { return collection.length; }, 0);
}

// ---------------------------------------------------------------------------
// Ordner
// ---------------------------------------------------------------------------

function collectFolders(container, accountName, prefix, out, seen, depth) {
  var folders = safe(function () { return container.folders; }, null);
  if (!folders) return;

  var count = collectionCount(folders);
  if (!count) return;

  var names = bulk(folders, 'name', count);
  var ids = bulk(folders, 'id', count);

  for (var i = 0; i < count; i++) {
    var id = ids[i];
    if (!id || seen[id]) continue;
    seen[id] = true;

    var name = names[i] || '(ohne Namen)';
    var path = prefix ? prefix + '/' + name : name;
    var folder = folders.at(i);

    out.push({
      id: id,
      name: name,
      path: path,
      account: accountName,
      noteCount: collectionCount(safe(function () { return folder.notes; }, null) || [])
    });

    if (depth < MAX_FOLDER_DEPTH) {
      collectFolders(folder, accountName, path, out, seen, depth + 1);
    }
  }
}

function allFolders(app) {
  var out = [];
  var seen = {};
  var accounts = app.accounts;
  var accountCount = collectionCount(accounts);
  var accountNames = bulk(accounts, 'name', accountCount);

  for (var i = 0; i < accountCount; i++) {
    collectFolders(accounts.at(i), accountNames[i] || 'iCloud', '', out, seen, 0);
  }
  return out;
}

/**
 * Loest einen Ordner ueber ID, vollen Pfad ("iCloud/Projekte/2026") oder
 * blossen Namen auf. Ohne Angabe: Standardordner des Standard-Accounts.
 */
function resolveFolder(app, spec, accountName) {
  if (!spec) {
    var fallback = safe(function () { return app.defaultAccount().defaultFolder(); }, null);
    if (fallback) return fallback;
    var first = safe(function () { return app.folders.at(0); }, null);
    if (first) return first;
    throw fail('no_folder', 'Kein Ordner in Apple Notes gefunden.');
  }

  var direct = safe(function () {
    var candidate = app.folders.byId(spec);
    candidate.name();
    return candidate;
  }, null);
  if (direct) return direct;

  var folders = allFolders(app);
  var wanted = String(spec).toLowerCase();
  var matches = [];

  for (var i = 0; i < folders.length; i++) {
    var folder = folders[i];
    if (accountName && folder.account !== accountName) continue;
    if (folder.path.toLowerCase() === wanted || folder.name.toLowerCase() === wanted) {
      matches.push(folder);
    }
  }

  if (!matches.length) {
    var available = [];
    for (var j = 0; j < folders.length && j < 40; j++) {
      available.push(folders[j].account + '/' + folders[j].path);
    }
    throw fail(
      'folder_not_found',
      'Ordner "' + spec + '" nicht gefunden. Verfuegbar: ' + (available.join(', ') || '(keine)')
    );
  }

  // Bei mehrdeutigem Kurznamen den flachsten Treffer nehmen.
  matches.sort(function (a, b) {
    return a.path.split('/').length - b.path.split('/').length;
  });

  var target = app.folders.byId(matches[0].id);
  target.name();
  return target;
}

// ---------------------------------------------------------------------------
// Notizen
// ---------------------------------------------------------------------------

function noteById(app, id) {
  if (!id) throw fail('invalid_args', 'Es wurde keine Notiz-ID uebergeben.');

  var direct = safe(function () {
    var candidate = app.notes.byId(id);
    candidate.name();
    return candidate;
  }, null);
  if (direct) return direct;

  var count = collectionCount(app.notes);
  var ids = bulk(app.notes, 'id', count);
  for (var i = 0; i < ids.length; i++) {
    if (ids[i] === id) return app.notes.at(i);
  }
  throw fail('note_not_found', 'Notiz mit ID "' + id + '" nicht gefunden.');
}

function snippetFrom(text, title) {
  if (!text) return '';
  var body = String(text);
  // Notes wiederholt den Titel als erste Zeile des Textes — raus damit.
  if (title) {
    var firstBreak = body.indexOf('\n');
    var firstLine = firstBreak === -1 ? body : body.slice(0, firstBreak);
    if (firstLine.trim() === String(title).trim()) {
      body = firstBreak === -1 ? '' : body.slice(firstBreak + 1);
    }
  }
  body = body.replace(/\s+/g, ' ').trim();
  return body.length > 180 ? body.slice(0, 180) + '…' : body;
}

function describeNote(note, options) {
  options = options || {};
  var title = safe(function () { return note.name(); }, '(ohne Titel)');
  var locked = safe(function () { return note.passwordProtected(); }, false);

  var result = {
    id: safe(function () { return note.id(); }, null),
    title: title,
    folder: safe(function () { return note.container().name(); }, null),
    created: toIso(safe(function () { return note.creationDate(); }, null)),
    modified: toIso(safe(function () { return note.modificationDate(); }, null)),
    locked: !!locked,
    shared: !!safe(function () { return note.shared(); }, false)
  };

  if (locked) {
    result.snippet = '';
    if (options.includeText) {
      result.text = '';
      result.note = 'Notiz ist passwortgeschuetzt und kann nicht gelesen werden.';
    }
    return result;
  }

  var plain = safe(function () { return note.plaintext(); }, '');
  result.snippet = snippetFrom(plain, title);
  if (options.includeText) result.text = plain;
  if (options.includeHtml) result.html = safe(function () { return note.body(); }, '');
  return result;
}

/** Reihenfolge: zuletzt geaenderte zuerst. */
function sortByModifiedDesc(rows) {
  rows.sort(function (a, b) {
    return (b.modifiedAt || 0) - (a.modifiedAt || 0);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Operationen
// ---------------------------------------------------------------------------

var OPS = {};

OPS.ping = function () {
  var app = notesApp();
  return {
    running: true,
    version: safe(function () { return app.version(); }, null),
    accounts: bulk(app.accounts, 'name', collectionCount(app.accounts)),
    folderCount: allFolders(app).length,
    noteCount: collectionCount(app.notes)
  };
};

OPS.list_folders = function () {
  return { folders: allFolders(notesApp()) };
};

OPS.list_notes = function (params) {
  var app = notesApp();
  var limit = params.limit || 25;
  var offset = params.offset || 0;

  var collection = params.folder
    ? resolveFolder(app, params.folder, params.account).notes
    : app.notes;

  var count = collectionCount(collection);
  if (!count) return { total: 0, offset: offset, notes: [] };

  var ids = bulk(collection, 'id', count);
  var names = bulk(collection, 'name', count);
  var modified = bulk(collection, 'modificationDate', count);

  var rows = [];
  for (var i = 0; i < count; i++) {
    if (!ids[i]) continue;
    rows.push({
      index: i,
      id: ids[i],
      title: names[i] || '(ohne Titel)',
      modifiedAt: modified[i] ? new Date(modified[i]).getTime() : 0
    });
  }

  sortByModifiedDesc(rows);
  var page = rows.slice(offset, offset + limit);

  var notes = [];
  for (var j = 0; j < page.length; j++) {
    notes.push(describeNote(collection.at(page[j].index), {}));
  }

  return { total: rows.length, offset: offset, notes: notes };
};

OPS.search_notes = function (params) {
  var app = notesApp();
  var query = String(params.query || '').trim();
  if (!query) throw fail('invalid_args', 'Suchbegriff darf nicht leer sein.');

  var limit = params.limit || 20;
  var searchBody = params.searchBody !== false;
  var scope = params.folder
    ? resolveFolder(app, params.folder, params.account).notes
    : app.notes;

  // Schneller Pfad: Notes.app filtert selbst.
  var matched = safe(function () {
    var predicate = searchBody
      ? { _or: [{ name: { _contains: query } }, { plaintext: { _contains: query } }] }
      : { name: { _contains: query } };
    var found = scope.whose(predicate);
    found.length; // erzwingt Auswertung, damit ein Fehler hier landet
    return found;
  }, null);

  var results = [];
  var strategy = 'whose';

  if (matched) {
    var matchCount = collectionCount(matched);
    for (var i = 0; i < matchCount && results.length < limit; i++) {
      results.push(describeNote(matched.at(i), {}));
    }
  } else {
    // Fallback: selbst filtern, wenn `whose` von Notes abgelehnt wird.
    strategy = 'scan';
    var needle = query.toLowerCase();
    var count = collectionCount(scope);
    var names = bulk(scope, 'name', count);
    var texts = null;

    if (searchBody && count <= FULLTEXT_SCAN_LIMIT) {
      texts = bulk(scope, 'plaintext', count);
    } else if (searchBody) {
      strategy = 'scan-titles-only';
    }

    for (var j = 0; j < count && results.length < limit; j++) {
      var inTitle = names[j] && String(names[j]).toLowerCase().indexOf(needle) !== -1;
      var inBody = texts && texts[j] && String(texts[j]).toLowerCase().indexOf(needle) !== -1;
      if (inTitle || inBody) results.push(describeNote(scope.at(j), {}));
    }
  }

  return { query: query, strategy: strategy, count: results.length, notes: results };
};

OPS.read_note = function (params) {
  var app = notesApp();
  var note = noteById(app, params.id);
  return describeNote(note, { includeText: true, includeHtml: !!params.includeHtml });
};

OPS.create_note = function (params) {
  var app = notesApp();
  var folder = resolveFolder(app, params.folder, params.account);
  var title = String(params.title || 'Ohne Titel');

  var note = app.Note({ name: title, body: params.html || '' });
  folder.notes.push(note);

  var created = safe(function () {
    note.id();
    return note;
  }, null);

  if (!created) {
    // Referenz nach dem Push ungueltig — juengste Notiz mit passendem Titel suchen.
    created = findNewestByTitle(folder, title);
  }
  if (!created) throw fail('create_failed', 'Notiz wurde angelegt, konnte aber nicht zurueckgelesen werden.');

  return describeNote(created, { includeText: true });
};

function findNewestByTitle(folder, title) {
  var collection = folder.notes;
  var count = collectionCount(collection);
  var names = bulk(collection, 'name', count);
  var created = bulk(collection, 'creationDate', count);

  var bestIndex = -1;
  var bestTime = -1;
  for (var i = 0; i < count; i++) {
    if (names[i] !== title) continue;
    var time = created[i] ? new Date(created[i]).getTime() : 0;
    if (time > bestTime) {
      bestTime = time;
      bestIndex = i;
    }
  }
  return bestIndex === -1 ? null : collection.at(bestIndex);
}

OPS.update_note = function (params) {
  var app = notesApp();
  var note = noteById(app, params.id);

  if (safe(function () { return note.passwordProtected(); }, false)) {
    throw fail('note_locked', 'Passwortgeschuetzte Notizen koennen nicht bearbeitet werden.');
  }

  var mode = params.mode || 'replace';
  var incoming = params.html || '';

  if (mode === 'replace') {
    note.body = incoming;
  } else {
    var existing = safe(function () { return note.body(); }, '');
    note.body = mode === 'prepend' ? incoming + existing : existing + incoming;
  }

  return describeNote(note, { includeText: true });
};

OPS.delete_note = function (params) {
  var app = notesApp();
  var note = noteById(app, params.id);
  var before = describeNote(note, {});
  app.delete(note);
  return { deleted: before, hint: 'Die Notiz liegt jetzt in "Zuletzt geloescht" und ist ~30 Tage wiederherstellbar.' };
};

OPS.create_folder = function (params) {
  var app = notesApp();
  var name = String(params.name || '').trim();
  if (!name) throw fail('invalid_args', 'Ordnername darf nicht leer sein.');

  var parent = params.parent
    ? resolveFolder(app, params.parent, params.account)
    : (params.account ? app.accounts.byName(params.account) : app.defaultAccount());

  var folder = app.Folder({ name: name });
  parent.folders.push(folder);

  return {
    id: safe(function () { return folder.id(); }, null),
    name: name,
    parent: safe(function () { return parent.name(); }, null)
  };
};

OPS.open_note = function (params) {
  var app = notesApp();
  var note = noteById(app, params.id);
  app.show(note);
  app.activate();
  return { opened: describeNote(note, {}) };
};

// ---------------------------------------------------------------------------
// Einstieg
// ---------------------------------------------------------------------------

function run(argv) {
  var payload;
  try {
    payload = JSON.parse(argv[0] || '{}');
  } catch (e) {
    return JSON.stringify({ ok: false, error: 'invalid_args', message: 'Argument ist kein gueltiges JSON.' });
  }

  var handler = OPS[payload.op];
  if (!handler) {
    return JSON.stringify({
      ok: false,
      error: 'unknown_op',
      message: 'Unbekannte Operation: ' + payload.op
    });
  }

  try {
    return JSON.stringify({ ok: true, data: handler(payload) });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: (e && e.code) || 'jxa_error',
      message: (e && e.message) ? String(e.message) : String(e)
    });
  }
}

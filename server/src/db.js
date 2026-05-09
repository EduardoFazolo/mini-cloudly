const { DatabaseSync } = require('node:sqlite');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/cloudly.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

// ─── Tables ───
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    domain     TEXT,
    folder     TEXT,
    folder_id  TEXT,
    tags       TEXT,
    created_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    parent_id  TEXT,
    created_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS folder_domains (
    folder_id  TEXT NOT NULL,
    domain     TEXT NOT NULL,
    PRIMARY KEY (folder_id, domain)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#6366f1',
    folder_id  TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS file_tags (
    file_id    TEXT NOT NULL,
    tag_id     TEXT NOT NULL,
    PRIMARY KEY (file_id, tag_id)
  )
`);

// ─── Migrations ───
const fileCols = db.prepare('PRAGMA table_info(files)').all().map(c => c.name);
if (!fileCols.includes('folder'))    db.exec('ALTER TABLE files ADD COLUMN folder TEXT DEFAULT NULL');
if (!fileCols.includes('folder_id')) db.exec('ALTER TABLE files ADD COLUMN folder_id TEXT');

// Ensure legacy domain files have a folder string before migration
db.exec("UPDATE files SET folder = 'all' WHERE domain IS NOT NULL AND folder IS NULL AND folder_id IS NULL");

// Migrate flat folder strings → folders table
const toMigrate = db.prepare(
  'SELECT DISTINCT folder FROM files WHERE folder IS NOT NULL AND folder_id IS NULL'
).all();

for (const { folder: name } of toMigrate) {
  let row = db.prepare('SELECT id FROM folders WHERE name = ? AND parent_id IS NULL').get(name);
  if (!row) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, NULL, ?)').run(id, name, Date.now());
    row = { id };
  }
  db.prepare('UPDATE files SET folder_id = ? WHERE folder = ? AND folder_id IS NULL').run(row.id, name);
}

// ─── Tree builder ───
function buildTree(domain) {
  const folders = db.prepare('SELECT * FROM folders ORDER BY name ASC').all();
  const domRows = db.prepare('SELECT folder_id, domain FROM folder_domains').all();

  const permMap = {};
  for (const r of domRows) (permMap[r.folder_id] ??= []).push(r.domain);

  const nodes = {};
  for (const f of folders) {
    const permitted = permMap[f.id] || [];
    nodes[f.id] = {
      ...f,
      permitted_domains: permitted,
      accessible: permitted.length === 0 || !domain || permitted.includes(domain),
      children: [],
    };
  }

  const roots = [];
  for (const f of folders) {
    if (f.parent_id && nodes[f.parent_id]) {
      nodes[f.parent_id].children.push(nodes[f.id]);
    } else {
      roots.push(nodes[f.id]);
    }
  }
  return roots;
}

// ─── Exports ───
module.exports = {
  // Files
  getAll() { return db.prepare('SELECT * FROM files ORDER BY created_at DESC').all(); },
  getByFolderId(folder_id, tag_id) {
    let rows;
    if (tag_id) {
      rows = db.prepare(
        'SELECT f.* FROM files f JOIN file_tags ft ON f.id = ft.file_id WHERE f.folder_id = ? AND ft.tag_id = ? ORDER BY f.created_at DESC'
      ).all(folder_id, tag_id);
    } else {
      rows = db.prepare('SELECT * FROM files WHERE folder_id = ? ORDER BY created_at DESC').all(folder_id);
    }
    return rows.map(f => ({
      ...f,
      tag_ids: db.prepare('SELECT tag_id FROM file_tags WHERE file_id = ?').all(f.id).map(r => r.tag_id),
    }));
  },
  getById(id) { return db.prepare('SELECT * FROM files WHERE id = ?').get(id); },
  insert(f) {
    db.prepare(
      'INSERT INTO files (id,name,mime,size,domain,folder_id,tags,created_at) VALUES (?,?,?,?,?,?,?,?)'
    ).run(f.id, f.name, f.mime, f.size, f.domain ?? null, f.folder_id ?? null, f.tags ?? null, f.created_at);
    return this.getById(f.id);
  },
  updateSize(id, size) { db.prepare('UPDATE files SET size = ? WHERE id = ?').run(size, id); },
  delete(id)           { db.prepare('DELETE FROM files WHERE id = ?').run(id); },

  // Folders
  getTree(domain)   { return buildTree(domain || null); },
  getFolderById(id) {
    const f = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!f) return null;
    return {
      ...f,
      permitted_domains: db.prepare('SELECT domain FROM folder_domains WHERE folder_id = ?').all(id).map(r => r.domain),
    };
  },
  createFolder(name, parent_id) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)').run(id, name, parent_id || null, Date.now());
    return this.getFolderById(id);
  },
  renameFolder(id, name) {
    db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id);
    return this.getFolderById(id);
  },
  deleteFolder(id) {
    const children = db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(id);
    for (const c of children) this.deleteFolder(c.id);
    db.prepare('DELETE FROM folder_domains WHERE folder_id = ?').run(id);
    db.prepare('UPDATE files SET folder_id = NULL WHERE folder_id = ?').run(id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  },
  addDomain(folder_id, domain) {
    db.prepare('INSERT OR IGNORE INTO folder_domains (folder_id, domain) VALUES (?, ?)').run(folder_id, domain);
  },

  // Tags
  getTagsForFolderPath(folder_id) {
    const ids = [];
    let cur = folder_id;
    while (cur) {
      ids.push(cur);
      const row = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(cur);
      cur = row?.parent_id || null;
    }
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM tags WHERE folder_id IN (${ph}) ORDER BY name ASC`).all(...ids);
  },
  createTag(folder_id, name, color) {
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO tags (id, name, color, folder_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name, color, folder_id, Date.now());
    return db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
  },
  deleteTag(id) {
    db.prepare('DELETE FROM file_tags WHERE tag_id = ?').run(id);
    db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  },

  // File tags
  addFileTag(file_id, tag_id) {
    db.prepare('INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)').run(file_id, tag_id);
  },
  removeFileTag(file_id, tag_id) {
    db.prepare('DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?').run(file_id, tag_id);
  },
  removeDomain(folder_id, domain) {
    db.prepare('DELETE FROM folder_domains WHERE folder_id = ? AND domain = ?').run(folder_id, domain);
  },
};

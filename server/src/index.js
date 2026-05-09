require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { encrypt, decrypt } = require('./crypto');
const db      = require('./db');
const { compress }      = require('./compress');
const { generateThumb } = require('./thumb');

const app  = express();
const PORT = process.env.PORT || 4242;
const STORAGE = process.env.STORAGE_DIR || path.join(__dirname, '../../data/files');

fs.mkdirSync(STORAGE, { recursive: true });

app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ─── Health ───
app.get('/health', (_, res) => res.json({ ok: true }));

// ─── Folder tree ───
app.get('/folders', (req, res) => {
  res.json(db.getTree(req.query.domain || null));
});

// ─── Create folder ───
app.post('/folders', (req, res) => {
  const { name, parent_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  res.json(db.createFolder(name.trim(), parent_id || null));
});

// ─── Rename folder ───
app.patch('/folders/:id', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const updated = db.renameFolder(req.params.id, name.trim());
  if (!updated) return res.status(404).json({ error: 'not found' });
  res.json(updated);
});

// ─── Delete folder ───
app.delete('/folders/:id', (req, res) => {
  db.deleteFolder(req.params.id);
  res.json({ ok: true });
});

// ─── Add domain to folder ───
app.post('/folders/:id/domains', (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  db.addDomain(req.params.id, domain);
  res.json(db.getFolderById(req.params.id));
});

// ─── Remove domain from folder ───
app.delete('/folders/:id/domains/:domain', (req, res) => {
  db.removeDomain(req.params.id, req.params.domain);
  res.json(db.getFolderById(req.params.id));
});

// ─── Tags ───
app.get('/folders/:id/tags', (req, res) => {
  res.json(db.getTagsForFolderPath(req.params.id));
});

app.post('/folders/:id/tags', (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  res.json(db.createTag(req.params.id, name.trim(), color || '#6366f1'));
});

app.delete('/tags/:id', (req, res) => {
  db.deleteTag(req.params.id);
  res.json({ ok: true });
});

app.post('/files/:id/tags/:tag_id', (req, res) => {
  db.addFileTag(req.params.id, req.params.tag_id);
  res.json({ ok: true });
});

app.delete('/files/:id/tags/:tag_id', (req, res) => {
  db.removeFileTag(req.params.id, req.params.tag_id);
  res.json({ ok: true });
});

// ─── List files ───
app.get('/files', (req, res) => {
  const { folder_id, tag_id } = req.query;
  res.json(folder_id ? db.getByFolderId(folder_id, tag_id || null) : db.getAll());
});

// ─── Upload ───
app.post('/files/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const { domain = null, folder_id = null, tags = null } = req.body;
  const id = crypto.randomUUID();
  fs.writeFileSync(path.join(STORAGE, id), encrypt(req.file.buffer));
  res.json(db.insert({
    id,
    name: req.file.originalname,
    mime: req.file.mimetype,
    size: req.file.size,
    domain,
    folder_id,
    tags,
    created_at: Date.now(),
  }));
});

// ─── Download (decrypted) ───
app.get('/files/:id', (req, res) => {
  const file = db.getById(req.params.id);
  if (!file) return res.status(404).json({ error: 'not found' });

  const encPath = path.join(STORAGE, file.id);
  if (!fs.existsSync(encPath)) return res.status(404).json({ error: 'file missing' });

  try {
    const decrypted = decrypt(fs.readFileSync(encPath));
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader('Content-Length', decrypted.length);
    res.setHeader('Cache-Control', 'no-store');
    res.send(decrypted);
  } catch {
    res.status(500).json({ error: 'decrypt failed' });
  }
});

// ─── Thumbnail ───
app.get('/files/:id/thumb', async (req, res) => {
  const file = db.getById(req.params.id);
  if (!file) return res.status(404).end();

  const supported = file.mime.startsWith('video/') || file.mime === 'image/gif';
  if (!supported) return res.status(400).end();

  const thumbPath = path.join(STORAGE, file.id + '.thumb.jpg');
  if (fs.existsSync(thumbPath)) {
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(fs.readFileSync(thumbPath));
  }

  const encPath = path.join(STORAGE, file.id);
  if (!fs.existsSync(encPath)) return res.status(404).end();

  try {
    const decrypted = decrypt(fs.readFileSync(encPath));
    await generateThumb(decrypted, file.mime, thumbPath);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(fs.readFileSync(thumbPath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Compress ───
app.post('/files/:id/compress', async (req, res) => {
  const file = db.getById(req.params.id);
  if (!file) return res.status(404).json({ error: 'not found' });

  const encPath = path.join(STORAGE, file.id);
  if (!fs.existsSync(encPath)) return res.status(404).json({ error: 'file missing' });

  let decrypted;
  try { decrypted = decrypt(fs.readFileSync(encPath)); }
  catch { return res.status(500).json({ error: 'decrypt failed' }); }

  const targetBytes = Math.floor((parseFloat(req.body.targetMB) || 10) * 1024 * 1024);
  let compressed;
  try { compressed = await compress(decrypted, file.mime, targetBytes); }
  catch (err) { return res.status(422).json({ error: err.message }); }

  fs.writeFileSync(encPath, encrypt(compressed));
  db.updateSize(file.id, compressed.length);
  res.json({ ...file, size: compressed.length });
});

// ─── Delete ───
app.delete('/files/:id', (req, res) => {
  const file = db.getById(req.params.id);
  if (!file) return res.status(404).json({ error: 'not found' });

  const encPath = path.join(STORAGE, file.id);
  if (fs.existsSync(encPath)) fs.unlinkSync(encPath);
  db.delete(file.id);
  res.json({ ok: true });
});

const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Cloudly running on http://${HOST}:${PORT}`));

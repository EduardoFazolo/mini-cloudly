const API = 'http://localhost:4242';

let files         = [];
let folderTree    = [];
let fileCounts    = {};
let currentDomain = '';
let currentFolder = null;
let inspectorActive = false;
let selectedFileId  = null;
let hasTarget       = false;
let sizeFilter      = 'all';
let availableTags   = [];
let activeTagId     = null;
let captionFileId   = null;
let captionStyle    = 'classic';
let captionPos      = 'bottom';
const SIZE_THRESHOLD = 10 * 1024 * 1024;
const TAG_COLORS = ['#6366f1','#f87171','#34d399','#fb923c','#60a5fa','#f472b6','#facc15','#c084fc','#2dd4bf'];

// ─── Domain ───
async function refreshDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentDomain = (tab?.url && !tab.url.startsWith('chrome://'))
      ? new URL(tab.url).hostname
      : '';
  } catch {
    currentDomain = '';
  }
  renderDomainPill();
}

function renderDomainPill() {
  const pill = document.getElementById('domainPill');
  const text = document.getElementById('domainText');
  if (currentDomain) {
    text.textContent = currentDomain;
    pill.classList.remove('none');
  } else {
    text.textContent = 'all';
    pill.classList.add('none');
  }
}

// ─── Folder tree ───
async function loadFolderTree() {
  try {
    const qs = currentDomain ? `?domain=${encodeURIComponent(currentDomain)}` : '';
    const [treeRes, filesRes] = await Promise.all([
      fetch(`${API}/folders${qs}`),
      fetch(`${API}/files`),
    ]);
    if (!treeRes.ok) throw new Error();
    folderTree = await treeRes.json();

    const allFiles = await filesRes.json();
    fileCounts = {};
    allFiles.forEach(f => {
      if (f.folder_id) fileCounts[f.folder_id] = (fileCounts[f.folder_id] || 0) + 1;
    });
    const total = allFiles.reduce((s, f) => s + (f.size || 0), 0);
    updateStorageDisplay(total);
  } catch {
    showToast('Server unreachable', 'error');
  }
}

function findFolderById(tree, id) {
  for (const f of tree) {
    if (f.id === id) return f;
    if (f.children?.length) {
      const found = findFolderById(f.children, id);
      if (found) return found;
    }
  }
  return null;
}

function findFolderByName(tree, name) {
  for (const f of tree) {
    if (f.name === name) return f;
    if (f.children?.length) {
      const found = findFolderByName(f.children, name);
      if (found) return found;
    }
  }
  return null;
}

// ─── Tags ───
async function loadTags() {
  if (!currentFolder) { availableTags = []; return; }
  try {
    const res = await fetch(`${API}/folders/${currentFolder.id}/tags`);
    availableTags = res.ok ? await res.json() : [];
  } catch { availableTags = []; }
}

function renderTagBar() {
  const chips = document.getElementById('tagChips');
  chips.innerHTML = '';

  for (const tag of availableTags) {
    const chip = document.createElement('div');
    chip.className = 'tag-chip' + (activeTagId === tag.id ? ' active' : '');
    chip.draggable = true;
    chip.style.setProperty('--tag-color', tag.color);
    chip.innerHTML = `<span class="tag-dot"></span><span>${escHtml(tag.name)}</span>`;

    chip.addEventListener('click', () => {
      activeTagId = activeTagId === tag.id ? null : tag.id;
      renderTagBar();
      loadFiles();
    });

    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/cloudly-tag', tag.id);
      e.dataTransfer.effectAllowed = 'copy';
      chip.classList.add('dragging-tag');
    });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging-tag'));

    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: `Delete "${tag.name}"`, danger: true, action: () => deleteTag(tag) },
      ]);
    });

    chips.appendChild(chip);
  }
}

async function createTag() {
  if (!currentFolder) return;
  const name = prompt('Tag name:');
  if (!name?.trim()) return;
  const usedColors = new Set(availableTags.map(t => t.color));
  const color = TAG_COLORS.find(c => !usedColors.has(c)) || TAG_COLORS[availableTags.length % TAG_COLORS.length];
  try {
    const res = await fetch(`${API}/folders/${currentFolder.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), color }),
    });
    if (!res.ok) throw new Error();
    availableTags.push(await res.json());
    renderTagBar();
  } catch { showToast('Failed to create tag', 'error'); }
}

async function deleteTag(tag) {
  try {
    const res = await fetch(`${API}/tags/${tag.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    availableTags = availableTags.filter(t => t.id !== tag.id);
    if (activeTagId === tag.id) { activeTagId = null; loadFiles(); }
    renderTagBar();
    render();
  } catch { showToast('Failed', 'error'); }
}

async function assignTagToFile(fileId, tagId) {
  if ((files.find(f => f.id === fileId)?.tag_ids || []).includes(tagId)) return;
  try {
    const res = await fetch(`${API}/files/${fileId}/tags/${tagId}`, { method: 'POST' });
    if (!res.ok) throw new Error();
    const file = files.find(f => f.id === fileId);
    if (file) { file.tag_ids = [...(file.tag_ids || []), tagId]; render(); }
  } catch { showToast('Failed', 'error'); }
}

async function removeTagFromFile(fileId, tagId) {
  try {
    const res = await fetch(`${API}/files/${fileId}/tags/${tagId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    const file = files.find(f => f.id === fileId);
    if (file) { file.tag_ids = (file.tag_ids || []).filter(id => id !== tagId); render(); }
  } catch { showToast('Failed', 'error'); }
}

// ─── Navigate in / out ───
async function enterFolder(folder) {
  currentFolder = folder;
  activeTagId = null;
  await saveFolderState();
  document.getElementById('panel').classList.add('in-folder');
  updateNavRow();
  await loadTags();
  renderTagBar();
  await loadFiles();
}

async function exitToRoot() {
  currentFolder = null;
  activeTagId = null;
  availableTags = [];
  await saveFolderState();
  document.getElementById('panel').classList.remove('in-folder');
  await loadFolderTree();
  renderFolderList();
}

// ─── Folder list rendering (root view) ───
function renderFolderList() {
  const list = document.getElementById('folderList');
  list.innerHTML = '';

  if (!folderTree.length) {
    list.innerHTML = `<div class="folder-empty-state">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <path d="M4 9C4 7.9 4.9 7 6 7h6l2 2h10c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V9z" stroke="currentColor" stroke-width="1.2"/>
      </svg>
      <span>No folders yet</span>
    </div>`;
    return;
  }

  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  renderFolderNodes(folderTree, list, 0, query);
}

function renderFolderNodes(nodes, container, depth, query) {
  for (const folder of nodes) {
    if (query && !folderMatchesQuery(folder, query)) continue;

    const isLocked = !folder.accessible;
    const hasLock  = folder.permitted_domains?.length > 0;

    const row = document.createElement('div');
    row.className = 'folder-row';

    const btn = document.createElement('button');
    btn.className = 'folder-item' + (isLocked ? ' locked' : '');
    btn.disabled = isLocked;
    btn.style.paddingLeft = (10 + depth * 16) + 'px';
    btn.innerHTML = `
      ${hasLock
        ? `<svg class="folder-lock" width="9" height="9" viewBox="0 0 9 9" fill="none">
             <rect x="1.5" y="3.8" width="6" height="4.7" rx="1" stroke="currentColor" stroke-width="1"/>
             <path d="M3 3.8V2.5a1.5 1.5 0 013 0v1.3" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
           </svg>`
        : `<svg class="folder-icon" width="11" height="11" viewBox="0 0 11 11" fill="none">
             <path d="M1 3.5C1 2.7 1.7 2 2.5 2H4.7l1.3 1.3H9C9.8 3.3 10 4 10 4.5V8C10 8.8 9.3 9.5 8.5 9.5h-6C1.7 9.5 1 8.8 1 8V3.5z" stroke="currentColor" stroke-width="1"/>
           </svg>`
      }
      <span class="folder-item-name">${escHtml(folder.name)}</span>
      <span class="folder-item-count">${fileCounts[folder.id] || 0}</span>
      ${!isLocked
        ? `<svg class="folder-item-arrow" width="7" height="10" viewBox="0 0 7 10" fill="none">
             <polyline points="1,1 5,5 1,9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
           </svg>`
        : ''
      }`;

    if (!isLocked) btn.addEventListener('click', () => enterFolder(folder));
    btn.addEventListener('contextmenu', (e) => openFolderContextMenu(e, folder));
    if (isLocked) row.addEventListener('contextmenu', (e) => openFolderContextMenu(e, folder));

    const addSub = document.createElement('button');
    addSub.className = 'folder-add-sub';
    addSub.title = 'New subfolder';
    addSub.textContent = '+';
    addSub.addEventListener('click', (e) => {
      e.stopPropagation();
      createFolder(folder.id);
    });

    const del = document.createElement('button');
    del.className = 'folder-del';
    del.title = 'Delete folder';
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteFolder(folder);
    });

    row.appendChild(btn);
    row.appendChild(addSub);
    row.appendChild(del);
    container.appendChild(row);

    if (folder.children?.length) {
      renderFolderNodes(folder.children, container, depth + 1, query);
    }
  }
}

function folderMatchesQuery(folder, query) {
  if (folder.name.toLowerCase().includes(query)) return true;
  if (folder.children?.length) return folder.children.some(c => folderMatchesQuery(c, query));
  return false;
}

async function createFolder(parentId = null) {
  const name = prompt(parentId ? 'Subfolder name:' : 'Folder name:');
  if (!name?.trim()) return;
  try {
    const res = await fetch(`${API}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), parent_id: parentId }),
    });
    if (!res.ok) throw new Error();
    await loadFolderTree();
    if (currentFolder) {
      currentFolder = findFolderById(folderTree, currentFolder.id) || null;
    }
    renderFolderList();
  } catch {
    showToast('Failed to create folder', 'error');
  }
}

async function deleteFolder(folder) {
  if (!confirm(`Delete folder "${folder.name}"? Files inside will become unorganized.`)) return;
  try {
    const res = await fetch(`${API}/folders/${folder.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    if (currentFolder?.id === folder.id) {
      await exitToRoot();
    } else {
      await loadFolderTree();
      renderFolderList();
    }
  } catch {
    showToast('Delete failed', 'error');
  }
}

// ─── Nav row (inside folder) ───
function updateNavRow() {
  if (!currentFolder) return;

  document.getElementById('navFolderName').textContent = currentFolder.name;

  const chipsEl = document.getElementById('navDomainChips');
  const addBtn  = document.getElementById('navDomainAdd');
  chipsEl.innerHTML = '';

  const permitted = currentFolder.permitted_domains || [];

  if (!permitted.length) {
    const open = document.createElement('span');
    open.className = 'nav-domain-open';
    open.textContent = 'open';
    chipsEl.appendChild(open);
  } else {
    permitted.forEach(d => {
      const chip = document.createElement('span');
      chip.className = 'nav-domain-chip';
      chip.title = d;
      chip.textContent = d;
      const rm = document.createElement('button');
      rm.className = 'nav-chip-remove';
      rm.textContent = '×';
      rm.title = `Remove ${d}`;
      rm.addEventListener('click', () => removeDomainFromFolder(d));
      chip.appendChild(rm);
      chipsEl.appendChild(chip);
    });
  }

  if (currentDomain && !permitted.includes(currentDomain)) {
    addBtn.textContent = `+ ${currentDomain}`;
    addBtn.style.display = 'inline-flex';
  } else {
    addBtn.style.display = 'none';
  }
}

async function addCurrentDomainToFolder() {
  if (!currentFolder || !currentDomain) return;
  try {
    const res = await fetch(`${API}/folders/${currentFolder.id}/domains`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: currentDomain }),
    });
    if (!res.ok) throw new Error();
    const updated = await res.json();
    patchFolderPermissions(currentFolder.id, updated.permitted_domains);
    updateNavRow();
  } catch {
    showToast('Failed', 'error');
  }
}

async function removeDomainFromFolder(domain) {
  if (!currentFolder) return;
  try {
    const res = await fetch(`${API}/folders/${currentFolder.id}/domains/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error();
    const updated = await res.json();
    patchFolderPermissions(currentFolder.id, updated.permitted_domains);
    updateNavRow();
  } catch {
    showToast('Failed', 'error');
  }
}

function patchFolderPermissions(id, permitted_domains) {
  const node = findFolderById(folderTree, id);
  if (node) {
    node.permitted_domains = permitted_domains;
    node.accessible = permitted_domains.length === 0 || !currentDomain || permitted_domains.includes(currentDomain);
    if (currentFolder?.id === id) currentFolder = node;
  }
}

// ─── Persisted folder per domain ───
async function saveFolderState() {
  const saved = await chrome.storage.local.get('folderMap');
  const map = saved.folderMap || {};
  if (currentDomain) {
    if (currentFolder) map[currentDomain] = currentFolder.id;
    else delete map[currentDomain];
  }
  await chrome.storage.local.set({ folderMap: map });
}

async function restoreFolderFromStorage() {
  if (!currentDomain) return;
  const saved = await chrome.storage.local.get('folderMap');
  const id = (saved.folderMap || {})[currentDomain] || null;
  currentFolder = id ? findFolderById(folderTree, id) || null : null;
}

// ─── Load files ───
async function loadFiles() {
  setLoading(true);
  try {
    const params = new URLSearchParams();
    if (currentFolder) params.set('folder_id', currentFolder.id);
    if (activeTagId)   params.set('tag_id', activeTagId);
    const res = await fetch(`${API}/files?${params}`);
    if (!res.ok) throw new Error();
    files = await res.json();
  } catch {
    files = [];
    showToast('Server unreachable', 'error');
  }
  setLoading(false);
  render();
}

function setLoading(on) {
  document.getElementById('loadingState').style.display = on ? 'flex' : 'none';
}

// ─── Render file grid ───
function render() {
  const query = document.getElementById('searchInput').value.trim().toLowerCase();
  const visible = files.filter(f => {
    if (query && !f.name.toLowerCase().includes(query)) return false;
    if (sizeFilter === 'small' && f.size >= SIZE_THRESHOLD) return false;
    if (sizeFilter === 'large' && f.size <  SIZE_THRESHOLD) return false;
    return true;
  });

  const grid  = document.getElementById('fileGrid');
  const empty = document.getElementById('emptyState');

  grid.innerHTML = '';

  if (!visible.length) {
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  visible.forEach(f => grid.appendChild(buildCard(f)));
}

// ─── Card ───
function buildCard(file) {
  const card = document.createElement('div');
  card.className = 'file-card' + (file.id === selectedFileId ? ' selected' : '');
  card.dataset.id = file.id;

  const ext     = getExt(file.name);
  const isImage = ['jpg','jpeg','png','gif','webp','svg','avif','bmp'].includes(ext);
  const isVideo = file.mime.startsWith('video/');

  const thumb = document.createElement('div');
  thumb.className = 'file-thumb';

  if (isVideo) {
    const img = document.createElement('img');
    img.src = `${API}/files/${file.id}/thumb`;
    img.alt = file.name;
    img.draggable = false;
    img.onerror = () => { thumb.innerHTML = ''; thumb.appendChild(typeBadge(ext)); };
    thumb.appendChild(img);
    const play = document.createElement('div');
    play.className = 'thumb-play';
    play.textContent = '▶';
    thumb.appendChild(play);
  } else if (file.mime === 'image/gif' || isImage) {
    const img = document.createElement('img');
    img.src = `${API}/files/${file.id}`;
    img.alt = file.name;
    img.draggable = false;
    img.onerror = () => { thumb.innerHTML = ''; thumb.appendChild(typeBadge(ext)); };
    thumb.appendChild(img);
  } else {
    thumb.appendChild(typeBadge(ext));
  }

  const info = document.createElement('div');
  info.className = 'file-info';
  info.innerHTML = `
    <div class="file-name" title="${escHtml(file.name)}">${escHtml(file.name)}</div>
    <div class="file-meta">
      <span class="file-size">${fmtSize(file.size)}</span>
      ${file.domain ? `<span class="file-domain">${escHtml(file.domain)}</span>` : ''}
    </div>`;

  const tagIds = file.tag_ids || [];
  if (tagIds.length) {
    const dots = document.createElement('div');
    dots.className = 'file-tag-dots';
    tagIds.forEach(tid => {
      const tag = availableTags.find(t => t.id === tid);
      if (!tag) return;
      const dot = document.createElement('span');
      dot.className = 'file-tag-dot';
      dot.style.background = tag.color;
      dot.title = tag.name;
      dot.addEventListener('click', (e) => { e.stopPropagation(); removeTagFromFile(file.id, tid); });
      dots.appendChild(dot);
    });
    info.appendChild(dots);
  }

  const del = document.createElement('button');
  del.className = 'card-del';
  del.title = 'Delete';
  del.textContent = '×';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await deleteFile(file.id);
  });

  const isMedia = file.mime.startsWith('video/') || file.mime.startsWith('image/');
  if (isMedia && file.size > SIZE_THRESHOLD) {
    const cmp = document.createElement('button');
    cmp.className = 'card-compress';
    cmp.title = 'Compress to under 10 MB';
    cmp.textContent = '⚡';
    cmp.addEventListener('click', async (e) => {
      e.stopPropagation();
      const input = prompt(`Compress "${file.name}" to (MB):`, '10');
      if (input === null) return;
      const targetMB = parseFloat(input);
      if (!targetMB || isNaN(targetMB) || targetMB <= 0) { showToast('Invalid size', 'error'); return; }
      await compressFile(file, cmp, card, targetMB);
    });
    card.appendChild(cmp);
  }

  if (file.mime === 'image/gif') {
    const cap = document.createElement('button');
    cap.className = 'card-caption';
    cap.title = 'Add caption';
    cap.textContent = 'Aa';
    cap.addEventListener('click', (e) => {
      e.stopPropagation();
      openCaptionEditor(file);
    });
    card.appendChild(cap);
  }

  card.appendChild(thumb);
  card.appendChild(info);
  card.appendChild(del);

  card.addEventListener('click', () => selectFile(file));
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    if (e.dataTransfer.getData('application/cloudly-tag')) return; // tag drag wins
    card.classList.add('dragging');
    e.dataTransfer.setData('text/plain', file.name);
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  card.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('application/cloudly-tag')) {
      e.preventDefault();
      e.stopPropagation();
      card.classList.add('tag-drop-target');
    }
  });
  card.addEventListener('dragleave', (e) => {
    if (!card.contains(e.relatedTarget)) card.classList.remove('tag-drop-target');
  });
  card.addEventListener('drop', (e) => {
    const tagId = e.dataTransfer.getData('application/cloudly-tag');
    if (tagId) {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('tag-drop-target');
      assignTagToFile(file.id, tagId);
    }
  });

  return card;
}

function typeBadge(ext) {
  const el = document.createElement('div');
  const known = ['pdf','doc','docx','xls','xlsx','zip','rar','mp4','mov','mp3','wav','txt','md'];
  el.className = `type-badge type-${known.includes(ext) ? ext : 'default'}`;
  el.textContent = ext || '?';
  return el;
}

// ─── Select / send mode ───
async function selectFile(file) {
  if (hasTarget) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('no active tab');
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: 'CLOUDLY_FILE_SELECTED',
        fileId: file.id,
        fileName: file.name,
        fileMime: file.mime,
      });
      if (result?.ok) {
        showToast('Injected ✓', 'success');
      } else {
        showToast(result?.error || 'Injection failed — re-pick element', 'error');
      }
    } catch {
      showToast('Content script unreachable — reload the page', 'error');
    }
    return;
  }

  // Not in send mode — open preview
  openPreview(file);
}

function setSendMode(on) {
  hasTarget = on;
  document.getElementById('sendBar').style.display = on ? 'flex' : 'none';
  document.getElementById('panel').classList.toggle('send-mode', on);
  document.getElementById('inspectorBtn').querySelector('span').textContent = on ? 'Re-pick' : 'Pick';
}

function cancelSend() {
  setSendMode(false);
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: 'CLOUDLY_CANCEL' }).catch(() => {});
  });
}

// ─── Upload from URL ───
async function uploadFromUrl(url) {
  showToast('Fetching from web…');
  let data, contentType;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'CLOUDLY_FETCH_URL', url });
    if (!res.ok) throw new Error(res.error);
    data        = res.data;
    contentType = res.contentType.split(';')[0].trim();
  } catch (err) {
    showToast('Fetch failed: ' + err.message, 'error');
    return;
  }
  const name   = decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'file';
  const binary = atob(data);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  await uploadFiles([new File([bytes], name, { type: contentType })]);
}

// ─── Compress ───
async function compressFile(file, btn, card, targetMB = 10) {
  btn.textContent = '⏳';
  btn.disabled = true;
  try {
    const res = await fetch(`${API}/files/${file.id}/compress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetMB }),
    });
    if (!res.ok) { const { error } = await res.json(); throw new Error(error); }
    const updated = await res.json();
    const idx = files.findIndex(f => f.id === file.id);
    if (idx !== -1) files[idx] = updated;
    showToast(`${file.name} → ${fmtSize(updated.size)}`, 'success');
    render();
  } catch (err) {
    btn.textContent = '⚡';
    btn.disabled = false;
    showToast('Compress failed: ' + err.message, 'error');
  }
}

// ─── Caption editor ───
function openCaptionEditor(file) {
  captionFileId = file.id;
  captionStyle  = 'classic';
  captionPos    = 'bottom';

  document.getElementById('captionPreviewImg').src = `${API}/files/${file.id}`;
  document.getElementById('captionTextInput').value = '';
  updateCaptionPreviewText('');

  document.querySelectorAll('.caption-style-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.style === captionStyle));
  document.querySelectorAll('.caption-pos-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.pos === captionPos));

  updateCaptionPreviewStyle();

  document.getElementById('captionSaveBtn').disabled = false;
  document.getElementById('captionSaveBtn').textContent = 'Save as new GIF';
  document.getElementById('captionOverlay').style.display = 'flex';
  document.getElementById('captionTextInput').focus();
}

function closeCaptionEditor() {
  document.getElementById('captionOverlay').style.display = 'none';
  const img = document.getElementById('captionPreviewImg');
  img.src = '';
  captionFileId = null;
}

function updateCaptionPreviewText(text) {
  document.getElementById('captionPreviewText').textContent = text;
}

function updateCaptionPreviewStyle() {
  const el = document.getElementById('captionPreviewText');
  el.className = `caption-preview-text style-${captionStyle} pos-${captionPos}`;
}

async function saveCaption() {
  const text = document.getElementById('captionTextInput').value.trim();
  if (!text) { showToast('Add a caption first', 'error'); return; }

  const btn = document.getElementById('captionSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    const res = await fetch(`${API}/files/${captionFileId}/caption`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, style: captionStyle, position: captionPos }),
    });
    if (!res.ok) { const { error } = await res.json(); throw new Error(error); }
    const newFile = await res.json();
    files.unshift(newFile);
    if (currentFolder) fileCounts[currentFolder.id] = (fileCounts[currentFolder.id] || 0) + 1;
    showToast(`Saved as "${newFile.name}"`, 'success');
    closeCaptionEditor();
    render();
  } catch (err) {
    showToast('Caption failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Save as new GIF';
  }
}

// ─── Delete file ───
async function deleteFile(id) {
  try {
    const res = await fetch(`${API}/files/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error();
    if (selectedFileId === id) selectedFileId = null;
    files = files.filter(f => f.id !== id);
    if (currentFolder) {
      fileCounts[currentFolder.id] = Math.max(0, (fileCounts[currentFolder.id] || 1) - 1);
    }
    render();
  } catch {
    showToast('Delete failed', 'error');
  }
}

// ─── Upload ───
async function uploadFiles(list) {
  // If no folder selected, navigate to (or create) 'all' folder
  if (!currentFolder) {
    let allFolder = findFolderByName(folderTree, 'all');
    if (!allFolder) {
      try {
        const res = await fetch(`${API}/folders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'all', parent_id: null }),
        });
        if (res.ok) {
          await loadFolderTree();
          allFolder = findFolderByName(folderTree, 'all');
        }
      } catch {}
    }
    if (allFolder) {
      await enterFolder(allFolder);
    }
  }

  for (const f of list) {
    const form = new FormData();
    form.append('file', f);
    if (currentDomain)     form.append('domain', currentDomain);
    if (currentFolder?.id) form.append('folder_id', currentFolder.id);
    try {
      const res = await fetch(`${API}/files/upload`, { method: 'POST', body: form });
      if (!res.ok) throw new Error();
      const record = await res.json();
      files.unshift(record);
      if (currentFolder) fileCounts[currentFolder.id] = (fileCounts[currentFolder.id] || 0) + 1;
      showToast(`Uploaded ${f.name}`, 'success');
    } catch {
      showToast(`Failed: ${f.name}`, 'error');
    }
  }
  render();
}

// ─── Context menu ───
let ctxMenu = null;

function showContextMenu(x, y, items) {
  hideContextMenu();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';

  for (const item of items) {
    if (item === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      ctxMenu.appendChild(sep);
    } else {
      const btn = document.createElement('button');
      btn.className = 'ctx-item' + (item.danger ? ' danger' : '');
      btn.textContent = item.label;
      btn.addEventListener('click', () => { hideContextMenu(); item.action(); });
      ctxMenu.appendChild(btn);
    }
  }

  document.body.appendChild(ctxMenu);

  // Keep menu inside viewport
  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.min(x, vw - mw - 4) + 'px';
  ctxMenu.style.top  = Math.min(y, vh - mh - 4) + 'px';
}

function hideContextMenu() {
  ctxMenu?.remove();
  ctxMenu = null;
}

function openFolderContextMenu(e, folder) {
  e.preventDefault();
  const permitted = folder.permitted_domains || [];
  const items = [
    { label: 'Rename', action: () => renameFolder(folder) },
    { label: 'New subfolder', action: () => createFolder(folder.id) },
  ];

  if (currentDomain) {
    const alreadySet = permitted.includes(currentDomain);
    items.push('sep');
    if (alreadySet) {
      items.push({ label: `Remove ${currentDomain}`, danger: true, action: () => removeDomainFromFolderById(folder, currentDomain) });
    } else {
      items.push({ label: `Add ${currentDomain}`, action: () => addDomainToFolder(folder) });
    }
  }

  items.push('sep');
  items.push({ label: 'Delete', danger: true, action: () => deleteFolder(folder) });

  showContextMenu(e.clientX, e.clientY, items);
}

async function removeDomainFromFolderById(folder, domain) {
  try {
    const res = await fetch(`${API}/folders/${folder.id}/domains/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error();
    const updated = await res.json();
    patchFolderPermissions(folder.id, updated.permitted_domains);
    if (currentFolder?.id === folder.id) updateNavRow();
    renderFolderList();
    showToast(`${domain} removed`, 'success');
  } catch {
    showToast('Failed', 'error');
  }
}

async function addDomainToFolder(folder) {
  if (!currentDomain) return;
  try {
    const res = await fetch(`${API}/folders/${folder.id}/domains`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: currentDomain }),
    });
    if (!res.ok) throw new Error();
    const updated = await res.json();
    patchFolderPermissions(folder.id, updated.permitted_domains);
    if (currentFolder?.id === folder.id) updateNavRow();
    renderFolderList();
    showToast(`${currentDomain} added`, 'success');
  } catch {
    showToast('Failed', 'error');
  }
}

async function renameFolder(folder) {
  const name = prompt('Rename folder:', folder.name);
  if (!name?.trim() || name.trim() === folder.name) return;
  try {
    const res = await fetch(`${API}/folders/${folder.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!res.ok) throw new Error();
    const updated = await res.json();
    // Patch in-memory tree
    const node = findFolderById(folderTree, folder.id);
    if (node) node.name = updated.name;
    if (currentFolder?.id === folder.id) {
      currentFolder.name = updated.name;
      updateNavRow();
    }
    renderFolderList();
  } catch {
    showToast('Rename failed', 'error');
  }
}

// ─── Preview overlay ───
function openPreview(file) {
  const overlay  = document.getElementById('previewOverlay');
  const content  = document.getElementById('previewContent');
  const title    = document.getElementById('previewTitle');
  const url      = `${API}/files/${file.id}`;
  const mime     = file.mime || '';

  content.innerHTML = '';

  if (mime.startsWith('video/')) {
    const el = document.createElement('video');
    el.src = url; el.controls = true; el.autoplay = true; el.playsInline = true;
    content.appendChild(el);
  } else if (mime.startsWith('image/')) {
    const el = document.createElement('img');
    el.src = url; el.alt = file.name;
    content.appendChild(el);
  } else if (mime.startsWith('audio/')) {
    const el = document.createElement('audio');
    el.src = url; el.controls = true; el.autoplay = true;
    content.appendChild(el);
  } else if (mime === 'application/pdf') {
    const el = document.createElement('embed');
    el.src = url; el.type = 'application/pdf';
    content.appendChild(el);
  } else {
    content.innerHTML = `
      <div class="preview-no-preview">
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
          <rect x="6" y="4" width="20" height="24" rx="2" stroke="currentColor" stroke-width="1.5"/>
          <line x1="11" y1="11" x2="21" y2="11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <line x1="11" y1="15" x2="21" y2="15" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <line x1="11" y1="19" x2="17" y2="19" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
        <span>No preview available</span>
        <a href="${url}" download="${escHtml(file.name)}">Download</a>
      </div>`;
  }

  title.textContent = file.name;
  overlay.style.display = 'flex';
}

function closePreview() {
  const overlay = document.getElementById('previewOverlay');
  const content = document.getElementById('previewContent');
  // Pause any media
  content.querySelectorAll('video, audio').forEach(el => { el.pause(); el.src = ''; });
  content.innerHTML = '';
  overlay.style.display = 'none';
}

// ─── Inspector ───
function toggleInspector(force) {
  inspectorActive = force !== undefined ? force : !inspectorActive;
  document.getElementById('inspectorBtn').classList.toggle('active', inspectorActive);
  document.getElementById('inspectorOverlay').style.display = inspectorActive ? 'flex' : 'none';
  document.getElementById('panel').classList.toggle('inspector-active', inspectorActive);
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, {
      type: inspectorActive ? 'CLOUDLY_INSPECTOR_START' : 'CLOUDLY_INSPECTOR_STOP',
    }).catch(() => {});
  });
}

// ─── Storage display ───
function updateStorageDisplay(totalBytes) {
  document.getElementById('storageUsed').textContent = fmtSize(totalBytes || 0);
  const fill = document.getElementById('storageFill');
  if (fill) {
    const MAX = 1 * 1024 * 1024 * 1024; // 1 GB reference
    fill.style.width = Math.min(100, (totalBytes / MAX) * 100).toFixed(1) + '%';
  }
}

function updateStorage() {
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  updateStorageDisplay(total);
}

// ─── Toast ───
function showToast(msg, type = '') {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.getElementById('panel').appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

// ─── Utils ───
function getExt(name) { return (name.split('.').pop() || '').toLowerCase(); }
function fmtSize(b) {
  if (!b) return '—';
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Events ───
function setupEvents() {
  document.addEventListener('click', hideContextMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hideContextMenu(); closePreview(); closeCaptionEditor(); }
  });
  document.addEventListener('scroll', hideContextMenu, true);

  document.getElementById('previewClose').addEventListener('click', closePreview);
  document.getElementById('previewBackdrop').addEventListener('click', closePreview);

  document.getElementById('captionClose').addEventListener('click', closeCaptionEditor);
  document.getElementById('captionBackdrop').addEventListener('click', closeCaptionEditor);
  document.getElementById('captionSaveBtn').addEventListener('click', saveCaption);

  document.getElementById('captionTextInput').addEventListener('input', (e) => {
    updateCaptionPreviewText(e.target.value);
  });

  document.getElementById('captionStyles').addEventListener('click', (e) => {
    const btn = e.target.closest('.caption-style-btn');
    if (!btn) return;
    captionStyle = btn.dataset.style;
    document.querySelectorAll('.caption-style-btn').forEach(b => b.classList.toggle('active', b === btn));
    updateCaptionPreviewStyle();
  });

  document.getElementById('captionPositions').addEventListener('click', (e) => {
    const btn = e.target.closest('.caption-pos-btn');
    if (!btn) return;
    captionPos = btn.dataset.pos;
    document.querySelectorAll('.caption-pos-btn').forEach(b => b.classList.toggle('active', b === btn));
    updateCaptionPreviewStyle();
  });

  document.getElementById('searchInput').addEventListener('input', () => {
    renderFolderList();
    if (currentFolder) render();
  });

  document.getElementById('sizeFilter').addEventListener('click', (e) => {
    const btn = e.target.closest('.size-btn');
    if (!btn) return;
    sizeFilter = btn.dataset.size;
    document.querySelectorAll('.size-btn').forEach(b => b.classList.toggle('active', b === btn));
    render();
  });

  document.getElementById('domainClear').addEventListener('click', async () => {
    currentDomain = '';
    renderDomainPill();
    await loadFolderTree();
    if (currentFolder) {
      currentFolder = findFolderById(folderTree, currentFolder.id) || null;
      if (!currentFolder) {
        document.getElementById('panel').classList.remove('in-folder');
      } else {
        updateNavRow();
      }
    }
    renderFolderList();
  });

  document.getElementById('backBtn').addEventListener('click', exitToRoot);
  document.getElementById('navDomainAdd').addEventListener('click', addCurrentDomainToFolder);
  document.getElementById('newFolderBtn').addEventListener('click', () => createFolder(null));
  document.getElementById('tagAddBtn').addEventListener('click', createTag);

  document.getElementById('inspectorBtn').addEventListener('click', () => toggleInspector());
  document.getElementById('inspectorCancel').addEventListener('click', () => toggleInspector(false));
  document.getElementById('sendCancel').addEventListener('click', cancelSend);

  document.getElementById('fileInput').addEventListener('change', (e) => {
    uploadFiles(Array.from(e.target.files));
    e.target.value = '';
  });

  const fileView = document.getElementById('fileView');
  fileView.addEventListener('dragover', (e) => {
    const types = [...e.dataTransfer.types];
    if (types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain')) {
      e.preventDefault();
      document.getElementById('panel').classList.add('drag-over');
    }
  });
  fileView.addEventListener('dragleave', () => document.getElementById('panel').classList.remove('drag-over'));
  fileView.addEventListener('drop', async (e) => {
    e.preventDefault();
    document.getElementById('panel').classList.remove('drag-over');
    if (e.dataTransfer.files.length) { uploadFiles(Array.from(e.dataTransfer.files)); return; }
    const raw = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
    const url = raw.split('\n').map(s => s.trim()).find(s => s.startsWith('http'));
    if (url) await uploadFromUrl(url);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CLOUDLY_ELEMENT_PICKED') {
      toggleInspector(false);
      setSendMode(true);
    }

    // User switched tabs — cancel send mode and do full refresh
    if (msg.type === 'CLOUDLY_TAB_SWITCHED') {
      setSendMode(false);
      refreshDomain().then(async () => {
        await loadFolderTree();
        await restoreFolderFromStorage();
        if (currentFolder) {
          document.getElementById('panel').classList.add('in-folder');
          updateNavRow();
          await loadFiles();
        } else {
          document.getElementById('panel').classList.remove('in-folder');
          renderFolderList();
        }
      });
    }

  });
}

// ─── Init ───
document.addEventListener('DOMContentLoaded', async () => {
  await refreshDomain();
  setupEvents();
  setLoading(true);
  await loadFolderTree();
  await restoreFolderFromStorage();
  setLoading(false);

  if (currentFolder) {
    document.getElementById('panel').classList.add('in-folder');
    updateNavRow();
    await loadFiles();
  } else {
    renderFolderList();
  }
});

(() => {
  let inspectorActive = false;
  let highlight       = null;
  let pendingTarget   = null;

  // ─── Message listener FIRST — must register before anything that can throw ───
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CLOUDLY_INSPECTOR_START') {
      startInspector();
      sendResponse({ ok: true });
    }
    if (msg.type === 'CLOUDLY_INSPECTOR_STOP') {
      stopInspector();
      sendResponse({ ok: true });
    }
    if (msg.type === 'CLOUDLY_FILE_SELECTED') {
      injectFile(msg.fileId, msg.fileName, msg.fileMime)
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true; // keep channel open for async response
    }
    if (msg.type === 'CLOUDLY_CANCEL') {
      stopInspector();
      if (pendingTarget?.btn) pendingTarget.btn.remove();
      pendingTarget = null;
      sendResponse({ ok: true });
    }
  });

  // ─── Highlight overlay ───
  function getHighlight() {
    if (!highlight) {
      highlight = document.createElement('div');
      highlight.setAttribute('data-cloudly', '1');
      Object.assign(highlight.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: '2147483647',
        border: '2px solid #6366f1',
        borderRadius: '4px',
        background: 'rgba(99,102,241,0.07)',
        boxShadow: '0 0 0 1px rgba(99,102,241,0.2)',
        display: 'none',
        transition: 'top .05s,left .05s,width .05s,height .05s',
      });
      document.body.appendChild(highlight);
    }
    return highlight;
  }

  function moveHighlight(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const h = getHighlight();
    Object.assign(h.style, {
      display: 'block',
      top:    r.top    + 'px',
      left:   r.left   + 'px',
      width:  r.width  + 'px',
      height: r.height + 'px',
    });
  }

  function hideHighlight() {
    if (highlight) highlight.style.display = 'none';
  }

  // ─── Inspector mode ───
  function onMouseOver(e) {
    if (!inspectorActive) return;
    const el = e.target;
    if (el.getAttribute && el.getAttribute('data-cloudly')) return;
    moveHighlight(el);
  }

  function onClick(e) {
    if (!inspectorActive) return;
    const el = e.target;
    if (el.getAttribute && el.getAttribute('data-cloudly')) return;

    e.preventDefault();
    e.stopPropagation();

    stopInspector();
    setTarget(el);

    chrome.runtime.sendMessage({ type: 'CLOUDLY_ELEMENT_PICKED' }).catch(() => {});
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && inspectorActive) stopInspector();
  }

  function startInspector() {
    inspectorActive = true;
    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.documentElement.style.setProperty('cursor', 'crosshair', 'important');
  }

  function stopInspector() {
    inspectorActive = false;
    hideHighlight();
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.documentElement.style.removeProperty('cursor');
  }

  // ─── Target ───
  function setTarget(el) {
    if (pendingTarget?.btn) pendingTarget.btn.remove();

    const btn = makeBtn('☁ Cloudly — select a file in the panel');
    placeBtn(btn, el);
    pendingTarget = { el, btn };
  }

  function makeBtn(label) {
    const btn = document.createElement('button');
    btn.setAttribute('data-cloudly', '1');
    btn.textContent = label;
    Object.assign(btn.style, {
      position:    'fixed',
      zIndex:      '2147483646',
      background:  '#6366f1',
      color:       'white',
      border:      'none',
      borderRadius:'5px',
      padding:     '4px 10px',
      fontSize:    '11px',
      fontFamily:  'system-ui,-apple-system,sans-serif',
      fontWeight:  '600',
      cursor:      'pointer',
      boxShadow:   '0 2px 10px rgba(99,102,241,0.5)',
      whiteSpace:  'nowrap',
      pointerEvents: 'all',
    });
    document.body.appendChild(btn);
    return btn;
  }

  function placeBtn(btn, el) {
    const r = el.getBoundingClientRect();
    btn.style.top  = Math.max(4, r.top - 32) + 'px';
    btn.style.left = r.left + 'px';
  }

  // ─── File injection (via background to bypass page CSP) ───
  async function injectFile(fileId, fileName, fileMime) {
    if (!pendingTarget) {
      return { ok: false, error: 'Target lost — re-pick element' };
    }

    const { el, btn } = pendingTarget;

    btn.textContent = '⏳ Fetching…';
    btn.style.background = '#7476f3';

    let file;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CLOUDLY_FETCH_FILE', fileId });
      if (!res?.ok) throw new Error(res?.error || 'fetch failed');
      const binary = atob(res.data);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      file = new File([bytes], fileName, { type: fileMime });
    } catch (err) {
      btn.textContent = '✗ ' + err.message;
      btn.style.background = '#f87171';
      setTimeout(() => {
        btn.textContent = '☁ Cloudly — select a file in the panel';
        btn.style.background = '#6366f1';
      }, 2500);
      return { ok: false, error: err.message };
    }

    const dt = new DataTransfer();
    dt.items.add(file);
    let ok = false;

    // Strategy 1: native <input type="file">
    if (!ok && el.tagName === 'INPUT' && el.type === 'file') {
      try {
        el.files = dt.files;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        ok = true;
      } catch {}
    }

    // Strategy 2: paste event — Discord / Slack / contenteditable
    if (!ok) {
      try {
        const editTarget =
          (el.isContentEditable ? el : null) ||
          el.querySelector('[contenteditable]') ||
          el.closest('[contenteditable]') ||
          document.querySelector('[contenteditable][data-slate-editor]') ||
          document.querySelector('[contenteditable]') ||
          el;

        editTarget.focus();
        const paste = new ClipboardEvent('paste', {
          bubbles: true, cancelable: true, clipboardData: dt,
        });
        editTarget.dispatchEvent(paste);
        ok = true;
      } catch {}
    }

    // Strategy 3: synthetic drop
    if (!ok) {
      try {
        const r  = el.getBoundingClientRect();
        const cx = r.left + r.width  / 2;
        const cy = r.top  + r.height / 2;

        for (const type of ['dragenter', 'dragover', 'drop']) {
          const ev = new DragEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy });
          Object.defineProperty(ev, 'dataTransfer', { value: dt });
          el.dispatchEvent(ev);
        }
        ok = true;
      } catch {}
    }

    // Strategy 4: any file input on page
    if (!ok) {
      try {
        const input = document.querySelector('input[type="file"]');
        if (input) {
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          ok = true;
        }
      } catch {}
    }

    if (ok) {
      btn.textContent = '✓ Done';
      btn.style.background = '#22c55e';
      setTimeout(() => {
        btn.textContent = '☁ Cloudly';
        btn.style.background = '#6366f1';
        pendingTarget = { el, btn }; // re-arm for repeated use
      }, 1200);
      return { ok: true };
    } else {
      btn.textContent = '✗ All strategies failed';
      btn.style.background = '#f87171';
      setTimeout(() => {
        btn.textContent = '☁ Cloudly — select a file in the panel';
        btn.style.background = '#6366f1';
      }, 2000);
      return { ok: false, error: 'All injection strategies failed' };
    }
  }

  // ─── Auto-attach to native file inputs ───
  function attachToInput(input) {
    if (input.dataset.cloudlyAttached) return;
    input.dataset.cloudlyAttached = '1';

    const btn = makeBtn('☁');
    btn.title = 'Inject from Cloudly';
    Object.assign(btn.style, { padding: '3px 8px', fontSize: '13px' });

    function reposition() {
      if (!document.body.contains(input)) { btn.remove(); return; }
      placeBtn(btn, input);
    }
    reposition();

    const ro = new ResizeObserver(reposition);
    ro.observe(input);
    window.addEventListener('scroll', reposition, { passive: true, capture: true });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (pendingTarget?.btn) pendingTarget.btn.remove();
      pendingTarget = { el: input, btn };
      btn.textContent = '☁ Select a file in the panel';
      chrome.runtime.sendMessage({ type: 'CLOUDLY_ELEMENT_PICKED' }).catch(() => {});
    });
  }

  // ─── Scan DOM ───
  function scanAll() {
    try {
      document.querySelectorAll('input[type="file"]').forEach(attachToInput);
    } catch (e) {
      console.warn('[Cloudly] scan error:', e);
    }
  }

  if (document.body) {
    scanAll();
    new MutationObserver(scanAll).observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      scanAll();
      new MutationObserver(scanAll).observe(document.body, { childList: true, subtree: true });
    });
  }
})();

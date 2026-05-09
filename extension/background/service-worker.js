// Open side panel on action click
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CLOUDLY_FETCH_URL') {
    fetch(msg.url)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const contentType = r.headers.get('content-type') || 'application/octet-stream';
        const buf   = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary  = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        sendResponse({ ok: true, data: btoa(binary), contentType });
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'CLOUDLY_FETCH_FILE') {
    fetch(`http://localhost:4242/files/${msg.fileId}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(buf => {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192)
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        sendResponse({ ok: true, data: btoa(binary) });
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// User switched to a different tab — panel should cancel send mode + full refresh
chrome.tabs.onActivated.addListener(() => {
  chrome.runtime.sendMessage({ type: 'CLOUDLY_TAB_SWITCHED' }).catch(() => {});
});


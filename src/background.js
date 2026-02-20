/**
 * API Reverse Engineer — Background Service Worker
 * Almacena los requests capturados, actualiza badge.
 *
 * IMPORTANT: Chrome kills service workers after ~30s of inactivity.
 * State that must survive restarts is persisted in chrome.storage.session.
 * In-memory captures are also saved to storage on every new entry.
 */

let captured = [];
let uniqueKeys = new Set();
let isRecording = false;
let recordingTabId = null;

// Restore state when service worker wakes up
chrome.storage.session.get(['isRecording', 'recordingTabId', 'captured', 'uniqueKeys'], (data) => {
  if (data.isRecording) {
    isRecording = data.isRecording;
    recordingTabId = data.recordingTabId || null;
    captured = data.captured || [];
    uniqueKeys = new Set(data.uniqueKeys || []);
  }
});

// Recibir captures desde content scripts
chrome.runtime.onMessage.addListener((msg, sender, respond) => {

  if (msg.type === 'CAPTURE') {
    // Solo capturar del tab donde se inició el recording
    const tabId = sender.tab?.id;
    if (recordingTabId !== null && tabId !== recordingTabId) {
      respond({ ok: true });
      return true;
    }

    const entry = msg.entry;
    const key = `${entry.method}:${entry.url.split('?')[0]}`;
    const isNew = !uniqueKeys.has(key);
    uniqueKeys.add(key);

    captured.push({ ...entry, isNewEndpoint: isNew });

    // Persist to session storage (survives service worker restarts)
    chrome.storage.session.set({
      captured,
      uniqueKeys: [...uniqueKeys]
    });

    // Actualizar badge solo en el tab grabando
    if (tabId) {
      chrome.action.setBadgeText({ text: String(captured.length), tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e', tabId });
    }

    respond({ ok: true });
    return true;
  }

  if (msg.type === 'GET_STATE') {
    respond({
      isRecording,
      recordingTabId,
      total: captured.length,
      unique: uniqueKeys.size
    });
    return true;
  }

  if (msg.type === 'START') {
    isRecording = true;
    recordingTabId = msg.tabId || null;
    const filter = msg.filter || '';
    // Use session storage so state survives service worker sleep/wake cycles
    chrome.storage.session.set({ isRecording: true, filter, recordingTabId, captured: [], uniqueKeys: [] });
    chrome.storage.local.set({ filter });

    // Notificar SOLO al tab activo
    if (recordingTabId) {
      chrome.tabs.sendMessage(recordingTabId, {
        type: 'START_RECORDING',
        filter
      }).catch(() => {});
    }

    respond({ ok: true });
    return true;
  }

  if (msg.type === 'STOP') {
    isRecording = false;
    chrome.storage.session.set({ isRecording: false });

    // Notificar solo al tab que grababa
    if (recordingTabId) {
      chrome.tabs.sendMessage(recordingTabId, { type: 'STOP_RECORDING' }).catch(() => {});
      chrome.action.setBadgeText({ text: '', tabId: recordingTabId });
    }
    recordingTabId = null;

    respond({ ok: true });
    return true;
  }

  if (msg.type === 'DOWNLOAD') {
    // Crear objeto agrupado por endpoint único
    const unique = {};
    captured.forEach(r => {
      const key = `${r.method}:${r.url.split('?')[0]}`;
      if (!unique[key] || r.isNewEndpoint) unique[key] = r;
    });

    const data = {
      meta: {
        capturedAt: new Date().toISOString(),
        total: captured.length,
        uniqueEndpoints: Object.keys(unique).length,
        site: msg.site || 'unknown'
      },
      endpoints: Object.values(unique),
      all: captured
    };

    respond({ data: JSON.stringify(data, null, 2) });
    return true;
  }

  if (msg.type === 'CLEAR') {
    captured = [];
    uniqueKeys = new Set();
    chrome.storage.session.set({ captured: [], uniqueKeys: [] });

    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (tab.id) {
          chrome.action.setBadgeText({ text: '', tabId: tab.id });
        }
      });
    });

    respond({ ok: true });
    return true;
  }

  if (msg.type === 'GET_PREVIEW') {
    // Devuelve los últimos 20 endpoints únicos para preview
    const unique = {};
    captured.forEach(r => {
      const key = `${r.method}:${r.url.split('?')[0]}`;
      if (!unique[key]) unique[key] = r;
    });
    respond({ endpoints: Object.values(unique).slice(-20) });
    return true;
  }
});

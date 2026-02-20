/**
 * API Reverse Engineer — Content Script
 * Intercepta fetch + XHR en la página actual.
 * Solo funciona cuando el recording está activo.
 */

let isRecording = false;
let filter = '';

// Escuchar mensajes del background
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'START_RECORDING') {
    isRecording = true;
    filter = msg.filter || '';
    respond({ ok: true });
  }
  if (msg.type === 'STOP_RECORDING') {
    isRecording = false;
    respond({ ok: true });
  }
  if (msg.type === 'GET_STATUS') {
    respond({ isRecording, filter });
  }
});

// Restore recording state on page load (survives SPA navigation + SW restarts)
chrome.storage.session.get(['isRecording', 'filter', 'recordingTabId'], (data) => {
  if (data.isRecording) {
    // Only activate recording if this tab is the one that started it
    chrome.tabs.getCurrent?.((tab) => {
      // In content scripts we can't call getCurrent, use runtime instead
    });
    // We rely on the background to only send START_RECORDING to the right tab.
    // But if the service worker restarted, check if we should be recording.
    isRecording = data.isRecording || false;
    filter = data.filter || '';
  }
});

// Inyectar interceptor en el contexto de la página (no en el content script context)
const script = document.createElement('script');
script.src = chrome.runtime.getURL('src/injected.js');
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

// Recibir datos del injected script via window events
window.addEventListener('__ARE_REQUEST__', (event) => {
  if (!isRecording) return;

  const entry = event.detail;

  // Filtrar por URL si hay filtro activo
  if (filter && !entry.url.includes(filter)) return;

  // Enviar al background
  chrome.runtime.sendMessage({
    type: 'CAPTURE',
    entry
  });
});

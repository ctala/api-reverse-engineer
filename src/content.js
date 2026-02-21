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
    console.log('[ARE Content] Recording started, filter:', filter);
    respond({ ok: true });
  }
  if (msg.type === 'STOP_RECORDING') {
    isRecording = false;
    console.log('[ARE Content] Recording stopped');
    respond({ ok: true });
  }
  if (msg.type === 'GET_STATUS') {
    respond({ isRecording, filter });
  }
  if (msg.type === 'INJECT_NOW') {
    // Background will inject via chrome.scripting.executeScript
    // This message is just to confirm content script is ready
    respond({ ok: true });
  }
});

console.log('[ARE Content] Content script loaded');
// No inyectamos aquí — el background lo hará via chrome.scripting (bypasea CSP)

// Recibir datos del injected script via window events
window.addEventListener('__ARE_REQUEST__', (event) => {
  const entry = event.detail;
  console.log('[ARE Content] Request intercepted:', entry.method, entry.url, 'recording:', isRecording);

  if (!isRecording) {
    console.log('[ARE Content] Not recording, skipping');
    return;
  }

  // Filtrar por URL si hay filtro activo
  if (filter && !entry.url.includes(filter)) {
    console.log('[ARE Content] Filtered out by:', filter);
    return;
  }

  // Enviar al background
  chrome.runtime.sendMessage({
    type: 'CAPTURE',
    entry
  }).then(() => {
    console.log('[ARE Content] Sent to background');
  }).catch((err) => {
    console.error('[ARE Content] Failed to send to background:', err);
  });
});

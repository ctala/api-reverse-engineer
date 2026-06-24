/**
 * API Reverse Engineer — Content Script (v1.3.0)
 * Bridge entre injected.js (MAIN world) y el background service worker.
 *
 * Capture Mode (v1.3.0):
 *   - Recibe SET_CAPTURE_CONFIG del background y forwardea a injected.js via
 *     window.postMessage (MAIN world). Así, el `captureConfig` queda en MAIN
 *     world antes de que llegue el primer request.
 *   - El evento __ARE_REQUEST__ ya viene redactado desde injected.js; este
 *     script solo lo pasa al background sin tocar headers/bodies.
 */

let isRecording = false;
let filter = '';
let captureConfig = null;

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
    respond({ isRecording, filter, captureConfig });
  }

  if (msg.type === 'INJECT_NOW') {
    // Background will inject via chrome.scripting.executeScript
    // This message is just to confirm content script is ready
    respond({ ok: true });
  }

  if (msg.type === 'SET_CAPTURE_CONFIG') {
    // Update local copy and forward to injected.js (MAIN world) via postMessage.
    captureConfig = msg.captureConfig || null;
    forwardCaptureConfigToInjected();
    respond({ ok: true });
  }

  // Bug fix 2026-06-24: respond to PING so the SW can wait for this content
  // script's message listener to be registered before sending START_RECORDING.
  // Without this, the SW races with content script init and the
  // START_RECORDING message lands in a no-receiver state.
  if (msg.type === 'PING') {
    // B24 fix: derive the version from the manifest instead of a hardcoded
    // string that drifts (was '1.4.0' while the manifest said '1.4.2').
    var version = '0.0.0';
    try { version = chrome.runtime.getManifest().version; } catch (e) {}
    respond({ ready: true, version: version });
    return;
  }
});

function forwardCaptureConfigToInjected() {
  try {
    window.postMessage({
      __ARE_CAPTURE_CONFIG__: true,
      captureConfig: captureConfig
    }, '*');
  } catch (e) {
    console.error('[ARE Content] Failed to forward captureConfig to injected:', e);
  }
}

console.log('[ARE Content] Content script loaded');

// Recibir datos del injected script via window events.
// Los entries ya vienen redactados (redacción aplicada en injected.js).
window.addEventListener('__ARE_REQUEST__', (event) => {
  const entry = event.detail;
  console.log('[ARE Content] Request intercepted:', entry.method, entry.url, 'recording:', isRecording);

  if (!isRecording) {
    return;
  }

  // B2 fix: el filtro legacy de substring SOLO aplica al path sin
  // captureConfig (un keyword simple escrito en la caja de filtro de URL).
  // Cuando hay un captureConfig estructurado activo, injected.js YA filtró
  // con los patterns parseados; correr este check acá rompe la captura,
  // porque para presets regex/glob `filter` es el patrón CRUDO y
  // `.includes(rawRegex)` nunca matchea una URL real → descarta TODO.
  if (!captureConfig && filter && !(entry.url || '').includes(filter)) {
    return;
  }

  // Enviar al background (entry ya está redactado si redact estaba enabled).
  chrome.runtime.sendMessage({
    type: 'CAPTURE',
    entry
  }).then(() => {
    // ok
  }).catch((err) => {
    console.error('[ARE Content] Failed to send to background:', err);
  });
});

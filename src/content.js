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

// Inyectar interceptor inline (evita CSP blocks)
async function injectInterceptor() {
  try {
    const response = await fetch(chrome.runtime.getURL('src/injected.js'));
    const scriptText = await response.text();
    const script = document.createElement('script');
    script.textContent = scriptText;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    console.log('[ARE Content] Interceptor injected');
  } catch (err) {
    console.error('[ARE Content] Failed to inject interceptor:', err);
  }
}
injectInterceptor();

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

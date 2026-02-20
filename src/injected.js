/**
 * API Reverse Engineer — Injected Script
 * Corre en el contexto REAL de la página (acceso a window.fetch original).
 * Intercepta fetch + XMLHttpRequest y los reporta via window events.
 */

(function () {
  // --- FETCH interceptor ---
  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const [resource, options = {}] = args;
    const url = typeof resource === 'string' ? resource : resource?.url || '';
    const method = options.method || 'GET';
    const startTime = Date.now();

    let requestBody = null;
    try {
      if (options.body) {
        requestBody = typeof options.body === 'string'
          ? JSON.parse(options.body)
          : options.body;
      }
    } catch {
      requestBody = options.body;
    }

    let requestHeaders = {};
    try {
      const h = new Headers(options.headers);
      h.forEach((v, k) => { requestHeaders[k] = v; });
    } catch {}

    try {
      const response = await originalFetch.apply(this, args);
      const cloned = response.clone();
      const duration = Date.now() - startTime;

      let responseBody = null;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('json')) {
        try { responseBody = await cloned.json(); } catch {}
      } else {
        try { responseBody = await cloned.text(); } catch {}
      }

      let responseHeaders = {};
      response.headers.forEach((v, k) => { responseHeaders[k] = v; });

      window.dispatchEvent(new CustomEvent('__ARE_REQUEST__', {
        detail: {
          type: 'fetch',
          method,
          url,
          requestHeaders,
          requestBody,
          status: response.status,
          responseHeaders,
          responseBody,
          duration,
          timestamp: new Date().toISOString()
        }
      }));

      return response;
    } catch (error) {
      window.dispatchEvent(new CustomEvent('__ARE_REQUEST__', {
        detail: {
          type: 'fetch',
          method,
          url,
          requestHeaders,
          requestBody,
          status: 'ERROR',
          error: error.message,
          duration: Date.now() - startTime,
          timestamp: new Date().toISOString()
        }
      }));
      throw error;
    }
  };

  // --- XHR interceptor ---
  const OriginalXHR = window.XMLHttpRequest;

  window.XMLHttpRequest = function () {
    const xhr = new OriginalXHR();
    let method = 'GET';
    let url = '';
    let requestBody = null;
    const startTime = { value: null };

    const originalOpen = xhr.open.bind(xhr);
    xhr.open = function (m, u, ...rest) {
      method = m;
      url = u;
      return originalOpen(m, u, ...rest);
    };

    const originalSend = xhr.send.bind(xhr);
    xhr.send = function (body) {
      startTime.value = Date.now();
      try {
        requestBody = body ? JSON.parse(body) : null;
      } catch {
        requestBody = body;
      }

      xhr.addEventListener('loadend', () => {
        let responseBody = null;
        try {
          responseBody = JSON.parse(xhr.responseText);
        } catch {
          responseBody = xhr.responseText;
        }

        window.dispatchEvent(new CustomEvent('__ARE_REQUEST__', {
          detail: {
            type: 'xhr',
            method,
            url,
            requestBody,
            status: xhr.status,
            responseBody,
            duration: Date.now() - (startTime.value || Date.now()),
            timestamp: new Date().toISOString()
          }
        }));
      });

      return originalSend(body);
    };

    return xhr;
  };

  console.log('[API Reverse Engineer] Interceptores activos');
})();

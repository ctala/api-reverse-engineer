# ADR 0002: Chrome MV3 capture buffer architecture — OPFS streaming with `unlimitedStorage`

- **Status:** Accepted — ⚠️ **write mechanism superseded by [ADR-0003](adr-0003-async-opfs-resumable-sessions.md).** `createSyncAccessHandle()` (the sync OPFS API this ADR relies on) is **NOT available in MV3 service workers** (only in dedicated workers), so the sync write path never worked in production — the buffer silently ran in memory-fallback. ADR-0003 keeps OPFS but switches to the async API (`createWritable`).
- **Date:** 2026-06-24
- **Deciders:** Cristian Tala + Mavis (lead) + chrome-plugin-expert (advisor)
- **Supersedes (partially):** the implicit decision in v1.3.2 to keep the capture buffer in SW memory unbounded.

## Contexto

El plugin `api-reverse-engineer` v1.3.0–v1.3.2 captura cada fetch/XHR de la página y los acumula en un array `captured[]` en el service worker. Hay dos problemas arquitectónicos con el approach actual:

1. **`chrome.storage.session` quota exceeded** (v1.3.0). Chrome limita este storage a 10MB total. LinkedIn Voyager / GraphQL devuelve responses de **500KB–2MB cada una**. Después de 10–50 captures, el `.set()` se rechaza con `Session storage quota bytes exceeded`. Cristian reprodujo esto en su sesión del 2026-06-24 11:28 CLT. v1.3.2 fix: persistir solo metadata, mantener el array en memoria.

2. **SW OOM risk** (v1.3.2). El array `captured[]` es unbounded. Con `MAX_EVENTS = 10000` y bodies hasta 5MB, el worst case es **50GB** en memoria del SW. Chrome mata el SW sin ceremonia cuando se queda sin memoria, perdiendo todos los captures. Para el caso de uso real de Cristian (sesiones largas de reverse engineering de LinkedIn, 500–2000 events × 500KB–2MB = 100MB–1GB), esto es un riesgo real.

El SW de MV3 se duerme a los 30 segundos de inactividad. Si se duerme entre eventos, el array se queda en memoria mientras el SW no esté activo, pero al wake-up el estado módulo-level se reinicia (variables de `let captured = []`). Esto ya está parcialmente mitigado por v1.3.2 (persistir `isRecording` en session storage, no el array). Pero el array en sí sigue siendo volátil.

**Por qué importa ahora:** Cristian usa el plugin para construir `linkedin-all-in-one-api`. Necesita capturar el contrato completo de la API de LinkedIn (todos los endpoints que toca una sesión típica de navegación) para el actor Apify. Perder eventos a mitad de sesión significa recompilaciones manuales del actor, no datos limpios para procesar.

## Options Considered

### Opción A: `chrome.storage.local` con `unlimitedStorage` permission

Persistir el array completo en `chrome.storage.local` con la permission `unlimitedStorage` (extiende el quota default de 10MB a ilimitado). El array se serializa a JSON y se escribe en disco (Chrome lo persiste en el user data dir).

- **Pros:** API simple (`.set`/`.get`/`.onChanged`); sobrevive a SW restart; quota efectivamente ilimitado.
- **Cons:** Chrome carga `chrome.storage.local` **eagerly en memoria del SW** al wake-up. El problema de OOM persiste (cambia el storage, no la causa raíz). Además: serializar/deserializar el array completo en cada `.set()` es O(n) — para 1000 events, son ~100MB de serialización cada vez. Latencia perceptible.

**Veredicto:** No resuelve el problema, solo lo mueve.

### Opción B: Soft cap (50MB) + auto-flush prompt

Mantener el array en memoria. Cuando `totalBytes > 50MB`, mostrar un confirm en el popup: "Buffer grande. ¿Flush a disco?" Si user dice sí, dispara `chrome.downloads.download` con el JSONL parcial. Si user ignora o no está mirando, sigue capturando con cap duro a 100MB (auto-stop).

- **Pros:** Simple, da control al user. No requiere API nueva.
- **Cons:** UX intrusiva. Si Cristian no está mirando el popup (caso normal: está navegando LinkedIn, no mirando la toolbar), pierde data al auto-stop de 100MB. La fricción del confirm rompe el flow de captura. No resuelve sesiones de 200+ MB (caso real de RE).

**Veredicto:** Solución conservadora que falla en el caso de uso principal. Necesita un mecanismo de persistencia.

### Opción C: OPFS streaming append + `unlimitedStorage` *(ELEGIDA)*

Usar **Origin Private File System (OPFS)** para escribir cada capture a un archivo `captures.jsonl` en el sandbox del extension. OPFS es una API de File System moderna, disponible en service workers de Chrome desde **Chrome 102+** sin flag, con quota que escala con `unlimitedStorage` permission.

**Flujo:**
1. En `START`, abrir (o crear) `captures.jsonl` via `navigator.storage.getDirectory()`.
2. En cada `CAPTURE`, serializar el entry a JSON y hacer `fileHandle.createSyncAccessHandle().write()` (modo síncrono, válido en service workers, no bloquea otros handlers más de lo necesario).
3. Mantener solo metadata en memoria: `total`, `unique`, `lastTimestamp`, `isRecording`. NO mantener el array completo.
4. En `DOWNLOAD`, copiar el archivo OPFS a un Blob y dispararlo via `chrome.downloads.download`. OPFS no es directamente descargable; la copia es necesaria.
5. En `CLEAR`, `fileHandle.remove()` (borra el archivo OPFS, libera cuota).

**Pros:**
- **Cero data loss en sesiones largas.** El archivo persiste aunque el SW se duerma, se reinicie, o el browser cierre. Solo se pierde si el user hace `chrome://extensions/` Remove del extension.
- **OOM-safe.** Memoria del SW queda bounded a metadata (~KB), no al array completo.
- **Quota escalable.** Con `unlimitedStorage`, OPFS puede usar GB (Chrome lo permite desde 2019 para esta permission).
- **API MV3-native.** Sin polyfills, sin hacks. Soportado desde Chrome 102+ (target audience: Cristian usa Chrome estable actualizado).
- **Streaming write.** `createSyncAccessHandle()` es la API síncrona专为 SW contexts (async file ops no funcionan en SW).

**Cons:**
- **Más complejo de implementar** que las opciones A o B (~1-2 días de trabajo para linkedin-dev). Necesita: handle management, error handling de write failures, garbage collection de archivos viejos, integración con `chrome.downloads`.
- **OPFS no se descarga directamente** — la copia a Blob + `URL.createObjectURL` + `chrome.downloads.download` agrega un paso. Latencia de download: ~100-500ms para 50MB.
- **`unlimitedStorage` permission** es un opt-in de privacy. El user la ve en la card de chrome://extensions. No es invasivo pero es visible. (Mitigación: el privacy policy (ADR-0001 previo) ya declara que el plugin es local-first, no envía datos a servers.)
- **No hay atomicidad.** Si el SW crashea mid-write, la última línea puede quedar truncada. Mitigación: usar JSONL (1 entry = 1 line) y validar al download que cada línea parsea.

**Veredicto:** Correcto técnicamente. El único trade-off real es complejidad de implementación, que es bounded y bien entendida (OPFS tiene ejemplos públicos en el repo de Chromium).

### Opción D: IndexedDB

Persistencia key-value, async API, disponible en service workers. Cada capture como un row con autoincrement ID. Query por range al download.

- **Pros:** Async API limpia. Standard web.
- **Cons:** Overhead de transacción por cada row (no streaming — cada `.put()` es un commit). 1000 inserts = 1000 commits. Latencia: ~5-50ms por insert, perceptible en captura rápida. No es streaming como OPFS. Mayor overhead de memoria que OPFS (índices, etc.).

**Veredicto:** Funciona pero es overkill. OPFS es la opción correcta para append-only streaming.

### Opción E: Unbounded (status quo v1.3.2)

Sin cap. Confiar en que Chrome mate el SW si OOM.

- **Pros:** Cero código nuevo.
- **Cons:** Data loss abrupto, sin warning. El user se entera cuando la siguiente captura falla silenciosamente. Inaceptable para el caso de uso.

**Veredicto:** No-defensa. Status quo explícitamente descartado.

## Decision

**Opción C: OPFS streaming append con `unlimitedStorage` permission.**

Razones técnicas:

1. **Resuelve el OOM en la raíz, no en el síntoma.** El array en memoria es la causa; sacarlo a disco lo elimina, no lo mitiga.

2. **Sobrevive al SW lifecycle completo.** SW restart, browser close, OS sleep — el archivo OPFS persiste. Solo se pierde si el user remueve la extensión (caso extremo, no workflow normal).

3. **MV3-native y Chrome-supported.** OPFS en service workers está documentado y soportado por Chromium team desde 2022. No es una API experimental.

4. **`unlimitedStorage` es el permiso correcto para este caso.** Chrome lo define explícitamente: "allow the extension to use unlimited storage". El privacy policy (ADR-0001) ya declara el modelo local-first.

5. **El `chrome-plugin-expert` advisor verificó:**
   - OPFS funciona en extension service workers desde Chrome 102+ sin flag (Chromium-extensions group, Jackie Han, 2022).
   - `chrome.storage.local` con `unlimitedStorage` no resuelve OOM porque Chrome carga los datos eager en SW memory al wake-up.
   - Cache API es wrong abstraction (es para HTTP responses, no append-only streams).
   - `chrome.storage.session` quota es 10MB fijos (no extensible).

## Consequences

**Bueno:**

- Sesiones de RE de 200+ MB ahora son posibles sin riesgo de OOM ni quota error.
- Plugin es robusto al SW lifecycle (restart, browser close).
- El array `captured[]` en memoria desaparece; reemplazado por metadata + handle al archivo OPFS.
- Latencia de download: bounded a la operación de copia (Blob + createObjectURL), ~100-500ms para 50MB.

**Malo (Trade-offs):**

- Complejidad de implementación: ~1-2 días para linkedin-dev. Necesita: handle lifecycle management, error handling de write failures, garbage collection de archivos viejos, integración con `chrome.downloads`.
- `unlimitedStorage` permission aparece en chrome://extensions. No es invasivo pero el user lo ve. Aceptable porque el privacy policy lo declara.
- Si el SW crashea mid-write, la última línea puede quedar truncada. Mitigación: JSONL es append-only line-oriented; el importer (linkedin-all-in-one-api) ya valida que cada línea parsea y bail-on-corrupt. La pérdida es bounded a 1 entry.
- OPFS no funciona en service workers de Firefox (Manifest V2). Si Cristian quiere port a Firefox, necesita rewrite. No es scope (F4+).

**Trabajo futuro:**

- Garbage collection: si el user hace 10 sesiones de 100MB, son 1GB en OPFS. Agregar `navigator.storage.estimate()` + cleanup policy en STOP.
- Multi-tab: si el user graba en 2 tabs simultáneamente, el archivo OPFS se intercala (race condition). Resolver con per-tab files (`captures-{tabId}.jsonl`) o mutex.
- Streaming download: en lugar de copiar todo a Blob, ofrecer opción de `Range` reads (Chrome download manager soporta).

## Implementation Guidance

Para el dev (linkedin-dev, scope: 1-2 sprints):

**1. Manifest (`manifest.json`):**
```json
{
  "permissions": ["storage", "activeTab", "scripting", "tabs", "unlimitedStorage"],
  ...
}
```
Agregar `"unlimitedStorage"` a la lista existente. No otros cambios.

**2. Background (`src/background.js`):**
- Agregar al top:
  ```js
  let opfsFileHandle = null;     // FileSystemFileHandle de captures.jsonl
  let opfsSyncAccess = null;      // FileSystemSyncAccessHandle para write
  let opfsDirHandle = null;       // FileSystemDirectoryHandle
  let opfsBytesWritten = 0;       // counter para badge
  ```
- En `START` (después de reset de `captured`/`uniqueKeys`/`totalBytes`):
  ```js
  const root = await navigator.storage.getDirectory();
  opfsDirHandle = root;
  opfsFileHandle = await root.getFileHandle('captures.jsonl', { create: true });
  opfsSyncAccess = await opfsFileHandle.createSyncAccessHandle();
  opfsSyncAccess.truncate(0);  // reset en cada START
  opfsBytesWritten = 0;
  ```
- En cada `CAPTURE` (reemplazar `captured.push` + `_persistSession`):
  ```js
  const line = JSON.stringify(entryWithMeta) + '\n';
  const encoded = new TextEncoder().encode(line);
  opfsSyncAccess.write(encoded, { at: opfsBytesWritten });
  opfsBytesWritten += encoded.byteLength;
  ```
- En `STOP` y `CLEAR`: `opfsSyncAccess.close()` + `await opfsFileHandle.remove()` (en CLEAR) o dejarlo abierto para download (en STOP).
- En `DOWNLOAD`:
  ```js
  const file = await opfsFileHandle.getFile();
  const blob = await file.arrayBuffer().then(buf => new Blob([buf], { type: 'application/x-ndjson' }));
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: `captures-${Date.now()}.jsonl` });
  ```
- Quitar `totalBytes` cap (ya no aplica — el array no está en memoria). Mantener `total` counter para badge.

**3. Popup (`src/popup.js`):**
- `updateUI` lee `total` y `unique` del background, no del array (ya lo hace). Sin cambios.
- Si la implementación es correcta, no hay cambios necesarios acá.

**4. Tests (`test/capture-config.test.mjs` + nuevo `test/opfs-buffer.test.mjs`):**
- Unit test del file handle lifecycle (mock OPFS via `navigator.storage.getDirectory`).
- Integration test: capturar 100 events, verificar que el archivo OPFS tiene 100 líneas, parsea correctamente.
- Failure test: ¿qué pasa si OPFS no está disponible (Chrome < 102)? El plugin debe degradar a `chrome.storage.session` con la v1.3.2 logic (el array + 10MB quota) y mostrar un warning en el badge. Fallback path.

**5. Compatibilidad:**
- `navigator.storage.getDirectory()` requiere Chrome 102+ (target Cristian).
- Si Cristian usa Chrome < 102, el plugin sigue funcionando con v1.3.2 logic (fallback).
- El `unlimitedStorage` permission no requiere ningún flag. Se declara en el manifest y Chrome lo honra en MV3.

**6. Edge cases que la implementación DEBE cubrir:**
- SW restart mid-session: el handle OPFS se invalida. Necesita re-open. Si el archivo ya existe con datos, append (no truncate).
- Browser close mid-session: el archivo OPFS persiste. Al re-abrir Chrome, el plugin puede offer "Resume previous session" o discard.
- Multi-tab recording: actualmente broken. Para v0.4.x, limit a single tab y mostrar warning si hay 2+ con `isRecording=true`.

**7. Versioning:**
- Bump a v1.4.0 (minor: new feature, no breaking API change). El JSONL schema es compatible con v1.3.x — el importer no necesita cambios.

## References

- ADR 0001 (predecessor): privacy policy + capture mode scope
- ADR 0009 (linkedin-all-in-one-api): normalized envelope resolver — el consumer del JSONL
- ADR 0013 (linkedin-all-in-one-api): capture-importer-validation — el importer bail-on-corrupt-line logic
- v1.3.2 release notes: "Session storage quota bytes exceeded" fix (insuficiente per this ADR)
- chrome-plugin-expert board update 2026-06-24 11:42:00: "Decision: OPFS + unlimitedStorage + streaming append"
- Chromium OPFS in service workers: https://chromium.googlesource.com/chromium/src/+/main/storage/browser/blob/ (verified by advisor)
- MDN `navigator.storage.getDirectory()`: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/OPFS
- `unlimitedStorage` permission: https://developer.chrome.com/docs/extensions/reference/manifest/unlimitedStorage

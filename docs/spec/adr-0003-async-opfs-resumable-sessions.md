# ADR-0003 — Async OPFS write path + resumable sessions (pausa/continuar)

- **Estado:** Aceptado (2026-06-24). **Supersede a ADR-0002** en el mecanismo de escritura OPFS.
- **Contexto del descubrimiento:** mientras se construía pausa/continuar (Fase 2), un test e2e en Chromium real reveló que la grabación no sobrevivía al teardown del service worker. La causa raíz fue mayor que un bug de wiring.

## Contexto

ADR-0002 eligió escribir el stream de capturas a OPFS usando
`FileSystemFileHandle.createSyncAccessHandle()` (la API **síncrona**), bajo la
premisa "OPFS en MV3 service workers funciona desde Chrome 102+".

**Esa premisa es incorrecta.** Verificado empíricamente en Chrome for Testing
149 (probe `sw.evaluate`): en el contexto del **service worker**,
`navigator.storage.getDirectory()` existe, pero
**`fileHandle.createSyncAccessHandle` es `undefined`** (`TypeError: ... is not a
function`). `createSyncAccessHandle()` solo está expuesto en **dedicated
workers**, no en service workers.

### Consecuencia de la premisa equivocada (latente desde v1.4.0)

`init()` lanzaba en `createSyncAccessHandle()` → el buffer caía a `fallbackMode`
(memoria) **siempre**. La extensión **nunca persistió a disco**: el archivo OPFS
quedaba en 0 líneas y todas las capturas vivían en memoria volátil. Todo lo que
ADR-0002 prometía (sobrevivir al restart, captures grandes sin OOM, durabilidad)
no se entregó nunca. El bug estuvo oculto porque el mock de tests implementaba
`createSyncAccessHandle` (verde contra el mock, roto en producción) — la misma
clase de problema que B1.

## Decisión

1. **Reescribir el write path de OPFS a la API async**, que SÍ funciona en el
   service worker (verificado: `createWritable()` + `seek()` + `write()` +
   `close()` + `getFile()` + `File.text()`):
   - **Append batcheado:** `append(entry)` sigue siendo **síncrono** (empuja la
     línea a una cola `pending` y devuelve `true` — el hot-path de CAPTURE no
     cambia). Un `_flush()` agendado por microtask drena la cola en una sola
     sesión `createWritable({keepExistingData:true})`.
   - **`flush()` fuerza durabilidad** antes de cada lectura y en STOP/PAUSE, para
     que una grabación sobreviva a que MV3 mate el worker (~30s idle).
2. **Sesiones reanudables (pausa/continuar):** el archivo `captures.jsonl` solo
   se **trunca/borra en `START` (sesión nueva) y `CLEAR`**. Toda otra transición
   (`PAUSE`, `STOP`, `RESUME`, wake del SW) es append-only o read-only.
   - `restoreFromExisting()` re-abre sin truncar y reconstruye contador + dedup
     desde el archivo. Se cablea en el bloque restore del SW (antes tenía 0
     callers) y en `RESUME`.
   - Verbos nuevos `PAUSE` / `RESUME` en el protocolo + botones en el popup.
3. **Salida consistente:** el path de descarga OPFS normaliza las entradas
   crudas almacenadas al shape canónico `_toJsonlLine` (`{request:{...}}`),
   igual que el path de memoria. Antes diferían, pero el path OPFS nunca corría.

## Por qué no se tira ADR-0002 entero

La garantía de ADR-0002 "START te da un archivo limpio" se mantiene (START
sigue truncando). Lo que cambia es (a) la **API** de escritura (sync→async) y
(b) el wake del SW deja de tratarse como un START implícito que borraba datos
(ahora hace `restoreFromExisting`). El motivo original de OPFS sobre
`chrome.storage.local` (streaming append sin cargar todo en memoria, sin OOM en
captures grandes) se **preserva** con la API async.

## Alternativas consideradas

- **`chrome.storage.local`:** más simple, pero carga todo el buffer en memoria
  del SW al leer (riesgo OOM en captures grandes). Descartada para preservar la
  intención de ADR-0002.
- **IndexedDB:** async, sin eager-load, robusto para volumen, pero reescribe más
  capa por menos beneficio sobre OPFS-async para este caso.

## Consecuencias

- ✅ La extensión persiste a disco de verdad por primera vez. Pausa/continuar
  sobrevive al restart del SW (validado con e2e + CDP `ServiceWorker.stopAllWorkers`).
- ✅ El mock de OPFS ahora modela la API async (`createWritable`) — el verde mide
  la API que producción realmente usa.
- ⚠️ `append` es durable solo tras el flush (microtask). La ventana de pérdida es
  ~1 microtask; STOP/PAUSE fuerzan flush. Para idle-death no hay actividad, así
  que todo queda flusheado.
- ⚠️ `flush()` abre/cierra un `createWritable` por batch. Bajo ráfaga (Voyager) el
  batcheo por microtask agrupa varias líneas por flush; si hiciera falta, se
  puede subir el batching a un debounce temporal.

## Validación

- Unit 78/78 (incluye pausa/resume, restore desde disco, START-trunca-tras-PAUSE).
- E2E 2/2 en Chromium real: captura+descarga, y **grabación sobrevive a teardown
  del SW**.

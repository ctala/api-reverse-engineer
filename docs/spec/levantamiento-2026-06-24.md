# Levantamiento — API Reverse Engineer (MV3) · 2026-06-24

> Producido con investigación multi-agente (13 agentes: lectura por componente + arnés de
> tests + traces de costura + verificación adversarial + diseño). **Todos los claims
> load-bearing fueron verificados contra el código real** (grep / file:line). El escéptico
> verificó los 14 bugs critical/high como REALES (0 falsos positivos).

## 0. Identidad del producto (invariante — no negociable)

API Reverse Engineer es una herramienta **genérica** de ingeniería inversa de APIs: captura
`fetch` + `XHR` de **cualquier** sitio. LinkedIn/Voyager es el caso de uso inmediato, pero
**el motor es site-agnostic** ("Works on any website"). Regla dura para todo este trabajo:

- **LinkedIn entra como PRESET** en `capture-config.js`, nunca como `if (linkedin)` en el core.
- Las pruebas validan la **captura genérica**; Voyager es *un* fixture entre varios (REST, GraphQL, XHR clásico).
- Los 8 key features publicados son invariantes que el test suite debe blindar: intercepta fetch+XHR ·
  tab-scoped · badge contador · URL filter (domain/path/keyword) · dedup (1 entry/endpoint) · works on any website · dark UI · MV3.

---

## 1. Veredicto ejecutivo

**La extensión no captura NADA en el Chrome real hoy.** Los 71 tests pasan en verde, pero
prueban un universo que no existe en producción. Ese es el origen mecánico del patrón
"arreglo un fix y aparece otro": cada fix de v1.3.0 → v1.4.2 se validó contra un entorno
mentiroso, mientras la costura raíz nunca tuvo cobertura.

Evidencia material — la cadena de fixes del git log es la huella del patrón:
`8849259 [object Object]` → `2f55519 regex Voyager + polling` → `a0bf328 PING before START`
→ `2b2e25e runtime bugfixes + QA harness` → `42109cf base64 decode + {ok:false}`. Cinco
fixes consecutivos en la costura popup↔SW↔content; ninguno cerró la raíz (el "QA harness"
de `2b2e25e` incluso institucionalizó el mock que esconde el bug crítico).

---

## 2. Causa raíz estructural (3 fallas que se refuerzan)

### RC#1 — El harness valida un universo que no existe (la falla madre)
`test/_chrome-mock.js:460-463` **inyecta manualmente** `globalThis.OpfsBuffer` y
`globalThis.MemoryBuffer` antes de requerir el SW. Chrome **nunca** hace eso: `manifest.json:17`
declara el SW **clásico, sin `type:module` y sin un solo `importScripts`** (`grep importScripts src/` → 0).
En producción: `OpfsBuffer === null`, `MemoryBuffer === null` → `activeBuffer = null` → toda
captura se descarta en silencio → DOWNLOAD siempre "No captures". **El verde mide el mock, no producción.**

### RC#2 — Contratos implícitos entre 4 procesos
La extensión son cuatro contextos (popup, SW, content en ISOLATED, injected en MAIN world)
que se hablan por `{type, ...}` ad-hoc **sin esquema compartido**. Cada revisor vio código
correcto por archivo; los bugs viven en las **costuras que nadie posee**: el filtro tiene dos
representaciones incompatibles (regex string vs `.includes()` literal), el "ok" del SW es
optimista, la shape del `entry` difiere entre fetch y XHR. Cada estado nuevo (opfsMode,
fallbackMode) re-expone la misma clase de desync. **Es estructuralmente infinito.**

### RC#3 — Lógica de negocio acoplada al lifecycle del SW y duplicada
`background.js` (744 líneas) mezcla dispatcher + estado + selección de buffer + dedup +
serialización + lifecycle. El estado vive en variables module-level que el SW MV3 destruye a
los ~30s. `restoreFromExisting()` existe (`opfs-buffer.js:152`) pero tiene **0 callers** → tras
el primer sleep durante grabación se pierde lo capturado y el OPFS queda huérfano. La pregunta
"¿OPFS o memoria?" está reimplementada en **6 sitios** con condiciones divergentes.

```
Mock miente sobre el entorno (RC#1) → green ≠ producción
        ▼
Contratos implícitos entre 4 procesos (RC#2) → cada costura es bug latente sin test
        ▼
Lógica acoplada al lifecycle + duplicada (RC#3) → el estado no sobrevive, los invariantes divergen
        ▼
"arreglo un fix y aparece otro" = parchear hojas con las 3 raíces vivas y sin cobertura e2e
```

---

## 3. Tabla consolidada de bugs reales (deduplicada y verificada)

| # | Sev | Bug | Archivo:línea | Fix |
|---|-----|-----|---------------|-----|
| **B1** | 🔴 | **Buffers SIEMPRE null en prod.** SW clásico sin `importScripts` → 0 capturas, DOWNLOAD siempre "No captures". | `manifest.json:17`, `background.js:84-92,108,111` | `importScripts('src/memory-buffer.js','src/opfs-buffer.js','src/capture-config.js')` 1ª línea + smoke test sin pre-inyectar globals. |
| **B2** | 🔴 | **content.js descarta TODA captura con preset.** `url.includes(filter)` con regex crudo → siempre false. | `content.js:86` (← `popup.js:106,252`) | Quitar filtro legacy substring cuando hay `captureConfig.patterns` (injected.js ya filtra). |
| **B3** | 🔴 | **START trunca el OPFS sin red** → destruye sesión pre-sleep al re-Iniciar (punto de no retorno para pausa/continuar). | `opfs-buffer.js:123-132` (← `background.js:349`) | Solo CLEAR/START borran. RESUME usa `restoreFromExisting` (append). |
| **B4** | 🟠 | **Estado se pierde al dormir el SW + OPFS huérfano.** `restoreFromExisting` 0 callers; restore apunta a memoryBuffer vacío. | `background.js:124-149`, `opfs-buffer.js:152` | En restore con `isRecording`: `restoreFromExisting()` + reconstruir count/dedup desde el archivo. |
| **B5** | 🟠 | **DOWNLOAD aborta "No captures" aunque haya datos en disco** (guard sobre contador volátil). | `background.js:467` | Guard basado en "bytes en disco O en RAM". |
| **B6** | 🟠 | **callback de START asume éxito; 0 chequeo de `lastError`.** UI dice "grabando" sin interceptor. | `popup.js:261-281`; SW `386-421` | START "pending" (confirmar vía poll GET_STATE) + `lastError` guard en los 5 sendMessage. SW propaga fallo de executeScript. |
| **B7** | 🟠 | **XHR no captura NINGÚN header** (req ni resp). No parchea `setRequestHeader` ni `getAllResponseHeaders()`. | `injected.js:189-219` | Parchear setRequestHeader + parsear getAllResponseHeaders en loadend. |
| **B8** | 🟠 | **fetch(Request) pierde method/headers/body.** Solo lee `args[1]`; POST se reporta GET. | `injected.js:102-122` | Normalizar: si `resource instanceof Request`, derivar method/headers/body. |
| **B9** | 🟠 | **Inyección tardía (al START) + doble-wrap.** Pierde requests de page-load/SPA previos; sin guard `__ARE_PATCHED__` → wrappers dobles. | `background.js:386-390`, `injected.js:97` | content_script `world:MAIN, run_at:document_start` + guard `__ARE_PATCHED__`. START solo flipa isRecording. |
| **B10** | 🟠 | **x-restli-protocol-version se redacta y rompe replay.** No es secreto (constante `2.0.0`). | `capture-config.js:90` (+`popup.js:48`) | Quitarlo de redact.headers. Redactar SOLO lo que compromete sesión. |
| **B11** | 🟠 | **Globs `*_token`/`*_secret` del spec NO implementados** → secretos no enumerados quedan en claro. | `capture-config.js:92-96,339` | Substrings de familia (`_token`,`_secret`) o glob real. Test con clave no enumerada. |
| **B12** | 🟡 | **json-array descarga datos casi vacíos en OPFS sin avisar.** Lee `memoryBuffer.snapshot()` (vacío). | `background.js:482` | Reconstruir desde el archivo OPFS, o deshabilitar json-array cuando opfsActive. |
| **B13** | 🟡 | **refreshPreview muestra "Presiona Iniciar" mientras graba (OPFS).** `[]` truthy → empty-state. | `popup.js:212-213` | Ramificar por opfsMode; no re-renderizar. |
| **B14** | 🟡 | **_persistSession() en CADA captura** martilla chrome.storage.session → throttling de cuota. | `background.js:290` | Persistir solo en START/STOP/CLEAR; contador throttled (cada N). |
| **B15** | 🟡 | **DOWNLOAD mientras graba: getFile() con handle abierto + sin flush** → lectura inconsistente en Chrome real. | `background.js:512-513`, `opfs-buffer.js:131` | `flush()`/`close()` antes de getFile(). Modelar el lock en el mock. |
| **B16** | 🟡 | **memory-buffer FIFO subestima bytes (UTF-16 vs UTF-8) y nunca expulsa la última entrada** → OOM en fallback. | `memory-buffer.js:43,65,72` | `TextEncoder().encode(...).byteLength`. |
| **B17** | 🟡 | **redactBody no recursa en objetos dentro de arrays** (Voyager `{data, included:[...]}`) → secretos en `included[]` en claro. | `capture-config.js:344-349` | Recursar elementos de Array en depth 0. |
| **B18** | 🟡 | **inMemoryUnique nunca se decrementa en evicción FIFO** → `unique` infla con claves fantasma. | `background.js:252-254,302` | `append` devuelve `{ok, evicted:[]}` y rehidrata; o mover dedup al buffer. |
| **B19** | 🟡 | **Listas de redacción duplicadas/divergentes** entre popup.js (runtime real) y capture-config.js. | `popup.js:37-63` vs `capture-config.js:57-139` | popup consume PRESETS del SW. Una fuente de verdad. |
| **B20** | 🟢 | **Captura perdida si el SW está dormido al llegar CAPTURE** (sin retry/cola). | `content.js:91-98` | Encolar + retry con backoff; `seq` para detectar gaps. |
| **B21** | 🟢 | **`recordingTabId=null` captura de cualquier tab** (semántica implícita peligrosa). | `background.js:236-241` | Validar tabId antes de START; null → `{ok:false}`. |
| **B22** | 🟢 | **Fallback permisivo silencioso: si CaptureConfig no cargó, captura TODO sin redactar.** | `injected.js:19-25,230` | Fail-closed: sin config no captura. Nunca desactivar redacción en silencio. |
| **B23** | 🟢 | **postMessage `'*'` sin verificar source/origin** → la página puede inyectar config y apagar redacción. | `content.js:61-64`, `injected.js:38-44` | Validar source/origin + nonce compartido. |
| **B24** | 🟢 | **Versión drift:** content.js PING reporta `1.4.0`, manifest `1.4.2`. | `content.js:54` | Derivar de `chrome.runtime.getManifest().version` + lint. |

**Descartados (NO-bugs):** transporte base64 en DOWNLOAD (la costura dual-format está bien
cerrada); redacción en MAIN world antes del postMessage (funciona como dice el ADR); header
`cookie` no capturado por fetch (es forbidden header del browser, no leak — el spec miente al
prometerlo: fix = documentar). **Latentes (B12/B13/B15):** no se manifiestan hoy porque B1
deja OPFS null; se arreglan junto con B1.

---

## 4. Cómo debería ser — arquitectura objetivo (refactor mínimo, sin reescribir)

Tres cambios quirúrgicos matan las 3 causas raíz. **No se toca** la arquitectura OPFS-streaming
(ADR-0002 es correcto), la ubicación de la redacción en MAIN world, ni el transporte base64.

- **R1 · `src/protocol.js` — contrato de mensajes tipado y centralizado.** Constantes de tipo
  (fin de strings mágicos), factories+validadores de shape del `entry` (fetch y XHR producen la
  MISMA shape con headers SIEMPRE presentes → mata B7/B8 de raíz), y estados de sesión explícitos
  `idle | starting | recording | paused | stopped` (mata el "ok-optimista" B6 y el desync B13).
- **R2 · `src/sw-core.js` — lógica pura separada del lifecycle.** Factory
  `createDispatcher({OpfsBuffer, MemoryBuffer, chrome, navigator})` con todos los handlers,
  inyectable y testeable sin globals. `background.js` queda como adaptador delgado
  (`importScripts` + wiring + persistencia/restore). Un solo helper `isOpfsActive()` reemplaza
  los 6 condicionales duplicados (mata B12/B18). Punto único de re-hidratación al wake (mata B4/B5).
- **R3 · `capture-config.js` única fuente de verdad** para presets, parser de patterns y listas
  de redacción. popup.js y content.js **consumen, no duplican** (mata B2, B10, B19, B24).

**Dos modos de captura (resuelve la tensión dedup vs stream):**
- **Discover** (default): dedup, 1 entry por endpoint único — para mapear una API rápido.
- **Capture/Full**: streamea cada evento a JSONL (sin dedup) — para auditoría de seguridad o
  capturar una sesión completa. El capture-mode v1.3.0 + OPFS ya es esto; hay que exponerlo como
  modo explícito en la UI, no como comportamiento que pisa al dedup.

---

## 5. Testing automatizado SIN intervención humana (prioridad #1)

Replicable en el repo, sin data privada. Tres capas, todas en CI:

### Capa 1 — UNIT (`node --test`)
- `package.json` (hoy NO existe) con `test:unit` / `test:e2e` / `test`. Mover `*.test.mjs` → `test/unit/`.
- **Fidelidad del mock** (3 fixes que lo vuelven detector, no encubridor):
  - **A:** `sendMessage` respeta `return true` / canal async → falla cualquier handler async que olvide `return true` (clase del bug `42109cf`).
  - **B:** `SyncAccessHandle` exclusivo + `flush()` requerido → `getFile()` devuelve solo bytes flusheados (expone B15).
  - **C:** PING configurable con fallo + `lastError` → ejercita `_waitForContentScript` (clase `a0bf328`).
- **`test/unit/sw-wiring.test.mjs`** — carga el SW como Chrome (importScripts simulado, SIN
  pre-inyectar globals) y asserta que `OpfsBuffer`/`MemoryBuffer` quedaron definidos + flujo
  START→CAPTURE→DOWNLOAD produce ≥1 línea. **Falla hoy → reproduce B1 en puro Node** (no necesita Chrome).

### Capa 2 — FUNCIONAL / E2E (la red que rompe el whack-a-mole)
- **Playwright + `launchPersistentContext` + `--load-extension` + `--headless=new`** (confirmado vigente 2026).
  Acceso al SW vía `context.serviceWorkers()` / `serviceWorker.evaluate()`. Para Docker/CI: contenedor
  con Chromium + `xvfb-run` como cinturón. `serviceWorker.evaluate()` permite leer `inMemoryCount`,
  forzar mensajes y simular sleep/wake del SW vía CDP `ServiceWorker.stopAllWorkers`.
- **`test/e2e/fixtures-server.mjs`** — servidor Node sin deps, sirve una página que dispara los 4
  modos que el código maneja mal (`fetch(Request)`, XHR con headers, body con ID grande, fetch de
  page-load) + endpoints que **imitan la forma de Voyager** (`/voyager/api/me` con
  `x-restli-protocol-version` y `{data, included:[{access_token}]}`). Spec ejecutable **sin tocar linkedin.com**.
- **`record-download.spec.mjs`** — carga extensión → asserta buffers existen en el SW real (B1) →
  graba → dispara requests → STOP → DOWNLOAD → asserta JSONL: contiene el endpoint, `method:POST`
  (no GET, B8), `csrf-token` redactado, `x-restli-protocol-version` legible (B10).
- **`popup.spec.mjs`** — la capa con 0 tests donde cayeron 3-4 fixes históricos.
- **`sw-restart.spec.mjs`** — graba → `ServiceWorker.stopAllWorkers` → despierta → asserta que las
  capturas pre-sleep sobreviven (pausa/continuar end-to-end).
- **`scripts/build-dist.mjs`** — empaqueta `dist/unpacked/`; `pretest:e2e` lo corre siempre → el
  e2e prueba **exactamente lo que se empaqueta** (atrapa drift manifest↔archivos).

### Capa 3 — CI (`.github/workflows/test.yml`, cada push, sin humano)
Job `unit` (node 22 + `check:version` + `test:unit`) → job `e2e` (`playwright install chromium` +
`build:dist` + `xvfb-run npm run test:e2e` + upload report). **El build del `.zip` se bloquea si
falla cualquier test.** `scripts/check-version-consistency.mjs` cierra el drift de versión (B24).

---

## 6. Pausa / Continuar (sin reset) — diseño

Hoy solo hay dos verbos destructivos: `START` (trunca OPFS) y `STOP`. No existe `paused`.

**Invariante central:** `captures.jsonl` es la fuente de verdad del stream y **solo se trunca/borra
en `START` (sesión nueva) y `CLEAR`/`DISCARD`**. Toda otra transición (`PAUSE`, `STOP`, `RESUME`,
wake del SW) es append-only o read-only. `restoreFromExisting()` ya implementa el re-abrir sin
truncar (`opfsBytesWritten = getSize()`) — solo hay que cablearlo.

**Máquina:** `IDLE —START(trunca)→ RECORDING —PAUSE(close, no trunca)→ PAUSED —RESUME(restoreFromExisting,
append)→ RECORDING`; `STOP→IDLE` (cierra, no trunca); `CLEAR→IDLE` (borra). SW sleep durante
RECORDING/PAUSED: el archivo persiste en disco, los flags en `chrome.storage.session`; al wake el
restore reabre OPFS y reconstruye count/dedup leyendo el archivo.

**Persistencia (3 planos):** OPFS = el dato · `chrome.storage.session` = flags efímeros (+ nuevos
`paused`, `sessionId`, `opfsFilename`, `capturedCount` throttled) · `chrome.storage.local` =
`lastSession` para el caso "browser cerrado" → habilita el prompt *"tienes una sesión pausada con
N eventos, ¿continuar/descargar/descartar?"*.

**UX popup:** dos botones contextuales (RECORDING: `⏸ Pausar`/`⏹ Detener`; PAUSED: `▶ Continuar`/`⏹
Detener`). `Continuar` envía `RESUME` (no `START`) — clave para no truncar. Banner inline en vez de `alert/confirm`.

**ADR-0003 propuesto** — "Resumable sessions: truncate solo en START explícito, no en wake". No tira
ADR-0002 (la garantía "START te da archivo limpio" se mantiene), lo acota: el wake deja de tratarse
como START implícito que borraba datos.

---

## 7. LinkedIn Voyager (primer preset, no cambio de core)

Gaps del preset actual + fixes (todos genéricos del engine que además habilitan Voyager):
- **Inyección tardía (B9):** la SPA dispara las llamadas Voyager más valiosas en page-load/navegación
  SPA antes del click START → `world:MAIN, document_start` lo resuelve.
- **`all_frames:false`** (manifest:28): no captura iframes. Voyager principal va en top-frame; evaluar si algún flujo lo necesita.
- **XHR sin headers (B7):** Voyager messaging/track usa XHR con `csrf-token`/`x-li-track`/`x-restli` → hoy se pierden.
- **Redacción (B10/B11/B17):** `x-restli-protocol-version` debe quedar legible (replay); `csrf-token`/`cookie`/`oauth_token`/`included[].access_token` redactados.
- **Cookie de auth (`li_at`/`JSESSIONID`):** es forbidden header del browser; NO sale por fetch. Decisión: documentar que la auth se obtiene por `chrome.cookies` aparte, o agregar path `webRequest.onSendHeaders` (más permisos).

---

## 8. Plan por fases (incremental — un cambio, validar, seguir)

| Fase | Qué | "Hecho" verificable |
|---|---|---|
| **0 · Estabilizar harness** | package.json + mover a test/unit + mock fidelidad (A/B/C) + `sw-wiring.test.mjs` | El sw-wiring test **falla en rojo** reproduciendo B1 (primer verde→rojo honesto). |
| **1 · Críticos** | B1 importScripts · B2 filtro content.js · B6 START pending+lastError · B9 world:MAIN+guard · B3 START no trunca sin red | sw-wiring pasa a verde + e2e happy-path: extensión real captura ≥1 endpoint con headers. |
| **2 · Pausa/Continuar** | Cablear restoreFromExisting (B4) · DOWNLOAD disco-o-RAM (B5) · verbos PAUSE/RESUME + popup + ADR-0003 · quitar _persistSession del hot-path (B14) | e2e: grabar → forzar sleep SW → RESUME → DOWNLOAD trae capturas pre Y post sleep. |
| **3 · Voyager** | B7 headers XHR · B8 fetch(Request) · B10/B11/B17 redacción · B19 fuente única presets · B12/B13 popup opfsMode | test corre preset Voyager sobre headers/body realistas: x-restli legible, secretos redactados. |
| **4 · CI + e2e completo** | injected/content/popup tests · suite Playwright · GitHub Action gate antes del dist | `npm test` corre todo en CI; el `.zip` bloqueado si falla; cobertura de injected/content/popup > 0. |

**Pasos 1-2 (medio día) ya entregan el 80% del valor:** un e2e real que prueba lo que se empaqueta y
reproduce el bug que hace que la extensión capture cero.

---

## 9. Decisiones abiertas (requieren input)

1. **B1 fix:** `importScripts` (mínimo, reversible, mantiene UMD/harness) vs SW `type:module` (más
   limpio pero convierte todos los UMD a import/export). **Recomendado: importScripts.**
2. **`world:MAIN, document_start` siempre-on (B9):** mejora muchísimo la captura Voyager pero el
   patch de fetch/XHR vive en la página desde el primer byte (gateado por isRecording). ¿Aceptable
   para la privacy policy, o preferís el fallback "Iniciar y recargar"?
3. **Redacción `x-li-track` (B10):** parcial (preservar clientVersion, borrar trackingId/fingerprint)
   vs todo-o-nada default OFF para Voyager. La parcial es lo correcto para RE.
4. **Cookie de auth Voyager:** documentar `chrome.cookies` aparte vs agregar `webRequest.onSendHeaders` (más permisos).
5. **Limpieza de basura del repo:** tarballs commiteados (`dist/*.tar.gz`, raíz), drafts `.pr-body-*.md`,
   `store-assets/screenshots-v2/` (duplicado exacto), `.gitignore` sin `*.tar.gz`.

---

## 10. Agentes especializados propuestos (`.claude/agents/` — el repo no tiene hoy)

- **Chrome MV3 Extension Engineer** — conoce el modelo de 4 contextos, lifecycle del SW, contratos de
  mensajes, OPFS, world MAIN/ISOLATED, e2e Playwright. Custodio de R1/R2/R3 y de que ningún fix rompa
  los 8 key features.
- **API Reverse Engineer** — genérico (no LinkedIn-específico): cómo descubrir/mapear una API no
  documentada, qué headers son obligatorios vs fingerprint, criterio de redacción (sesión vs replay),
  cómo armar un preset nuevo. Voyager es su primer caso, no su definición.

---

*Fuentes de testing: [Playwright Chrome Extensions](https://playwright.dev/docs/chrome-extensions) ·
[Playwright headless](https://playwright.dev/docs/browsers) · issues CI #33928 / #37347.*

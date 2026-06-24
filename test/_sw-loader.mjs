/**
 * Honest service-worker loader for unit tests.
 *
 * The whole reason the 71-green-but-broken suite existed is that
 * `_chrome-mock.js:loadBackgroundFresh()` pre-attaches `globalThis.OpfsBuffer`
 * and `globalThis.MemoryBuffer` BEFORE requiring background.js. Chrome never
 * does that: per the manifest, Chrome loads ONLY `src/background.js` as a
 * classic service worker; background.js is responsible for pulling its own
 * dependencies in via `importScripts`.
 *
 * This loader replicates Chrome faithfully using `node:vm`:
 *   - One shared global (`self` === globalThis), no `window`.
 *   - A real `importScripts(...)` that reads each file and runs it in the
 *     SAME global — exactly like a classic worker.
 *   - We load ONLY background.js. If background.js does not importScripts its
 *     deps, `self.OpfsBuffer` stays undefined — which is precisely the
 *     production bug (B1) the honest test reproduces.
 *
 * No secrets, no network, no real chrome.* — same hygiene as _chrome-mock.js.
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..'); // test/ -> repo root

/**
 * Build a service-worker-like global context.
 * @param {Object} opts
 * @param {Object} opts.chrome     — chrome.* mock (from installChromeMock().chrome)
 * @param {Object} [opts.navigator] — navigator mock for OPFS (from makeOpfsMock().navigator)
 * @returns {Object} the contextified sandbox (also the worker's `self`)
 */
export function makeSwContext({ chrome, navigator } = {}) {
  const sandbox = {};

  // SW global: `self` is the global object; there is NO `window`.
  sandbox.self = sandbox;

  // Runtime/Web APIs the SW + buffer modules use that are NOT vm intrinsics.
  sandbox.console = console;
  sandbox.chrome = chrome;
  sandbox.navigator = navigator;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.setImmediate = setImmediate;
  sandbox.queueMicrotask = queueMicrotask;
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  sandbox.URL = URL;
  sandbox.Buffer = Buffer; // background.js uses Buffer in a btoa fallback branch
  sandbox.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
  sandbox.atob = (s) => Buffer.from(String(s), 'base64').toString('binary');

  // importScripts mirrors Chrome's classic service-worker loader. Paths
  // resolve like the SW at chrome-extension://<id>/src/background.js:
  //   '/src/x.js'  -> <repo>/src/x.js      (root-absolute)
  //   'x.js'       -> <repo>/src/x.js      (relative to the SW dir = src/)
  //   'sub/x.js'   -> <repo>/sub/x.js
  sandbox.importScripts = function (...urls) {
    for (const raw of urls) {
      let rel = String(raw).replace(/^chrome-extension:\/\/[^/]+\//, '');
      rel = rel.replace(/^\//, '');
      const filePath = rel.includes('/')
        ? path.join(REPO, rel)
        : path.join(REPO, 'src', rel);
      const code = fs.readFileSync(filePath, 'utf8');
      vm.runInContext(code, sandbox, { filename: filePath });
    }
  };

  vm.createContext(sandbox);
  return sandbox;
}

/**
 * Load the service worker exactly as the manifest declares it: ONLY
 * src/background.js. Chrome does NOT pre-load the buffer deps. This is the
 * honest reproduction path for B1.
 * @param {Object} sandbox — from makeSwContext()
 * @returns {Object} the same sandbox (now with the SW evaluated)
 */
export function loadServiceWorker(sandbox) {
  const swPath = path.join(REPO, 'src', 'background.js');
  vm.runInContext(fs.readFileSync(swPath, 'utf8'), sandbox, { filename: swPath });
  return sandbox;
}

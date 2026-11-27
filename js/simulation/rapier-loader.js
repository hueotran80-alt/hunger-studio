/**
 * Lazy loader for the vendored Rapier WASM build.
 * `init()` is idempotent; callers only pay the WASM cost once.
 */

let rapierModule = null;
let initPromise = null;

export async function initRapier() {
  if (rapierModule) return rapierModule;
  if (!initPromise) {
    initPromise = (async () => {
      const module = await import('rapier');
      await module.init();
      rapierModule = module;
      return module;
    })();
  }
  return initPromise;
}

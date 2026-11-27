/**
 * Resolves the browser import map (`three`, `three/addons/*`) for Node tests.
 * File: tests/three-resolve-hooks.mjs
 *
 * index.html maps bare specifiers through an import map; Node has no import
 * maps, so this hook maps them to the same vendored files the browser loads.
 * Usage: node --import ./tests/three-resolve-hooks.mjs tests/<test>.mjs
 */
import { registerHooks } from 'node:module';

const vendorRoot = new URL('../vendor/three/', import.meta.url);
const ADDONS = 'three/addons/';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three') {
      return { url: new URL('three.module.js', vendorRoot).href, shortCircuit: true };
    }
    if (specifier === 'three-mesh-bvh') {
      return { url: new URL('../three-mesh-bvh/index.module.js', vendorRoot).href, shortCircuit: true };
    }
    if (specifier === 'three-bvh-csg') {
      return { url: new URL('../three-bvh-csg/index.module.js', vendorRoot).href, shortCircuit: true };
    }
    if (specifier === 'rapier') {
      return { url: new URL('../rapier/rapier.mjs', vendorRoot).href, shortCircuit: true };
    }
    if (specifier === 'mp4-muxer') {
      return { url: new URL('../mp4-muxer/mp4-muxer.mjs', vendorRoot).href, shortCircuit: true };
    }
    if (specifier.startsWith(ADDONS)) {
      return { url: new URL(`addons/${specifier.slice(ADDONS.length)}`, vendorRoot).href, shortCircuit: true };
    }
    if (specifier.startsWith('three/examples/jsm/')) {
      return { url: new URL(`addons/${specifier.slice('three/examples/jsm/'.length)}`, vendorRoot).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

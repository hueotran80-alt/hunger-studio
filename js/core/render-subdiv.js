/**
 * @file render-subdiv.js
 * @description Shared lazy wrapper to switch Subdivision/Multires modifiers to
 * render quality during final still or video export without duplicating logic or
 * introducing static Vite chunk cycles with core/modifiers.js.
 */

export async function runWithRenderSubdiv(scene, fn) {
  let hasSub = false;
  if (scene?.traverse) {
    scene.traverse((obj) => {
      if (hasSub || !obj.isMesh || !Array.isArray(obj.userData?.modifierStack)) return;
      hasSub = obj.userData.modifierStack.some((m) => {
        if (!m || m.enabled === false) return false;
        const type = String(m.type || '').toLowerCase();
        return type === 'subdivision' || type === 'subdivide' || type === 'subsurf' || type === 'multires';
      });
    });
  }
  if (!hasSub) return await fn();
  let wrap = typeof window !== 'undefined' ? window.modifiers?.withRenderSubdivisionLevels : null;
  if (!wrap) {
    const mod = await import('./modifiers.js');
    wrap = mod.withRenderSubdivisionLevels;
  }
  return wrap ? await wrap(scene, fn) : await fn();
}

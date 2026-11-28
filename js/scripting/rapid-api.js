/**
 * Web Blender Studio - Rapid 3D Modeling DSL API
 * Provides a high-level parametric 3D DSL inspired by Blender's bpy and procedural modeling.
 * File: js/scripting/rapid-api.js
 */

import * as THREE from 'three';
import { resolveCdnAssetUrl } from '../core/asset-cdn.js';
import { prefabLibrary } from './prefab-library.js';
import * as ModifierStack from '../core/modifier-stack.js';
import { executeModifier } from '../core/modifiers.js';
import { setShadingMode } from '../core/shading.js';
import { createImageObject } from '../core/image-objects.js';
import { buildPBRPresetMaterial, resolvePBRPresetId } from '../core/pbr-preset-defs.js';
import {
  sample2DContour,
  applyTriplanarUV,
  applyCreaseNormals,
  computeVertexCavityAO,
  buildExtrudeGeometry,
  buildSweepGeometry,
  buildLatheGeometry,
  buildSurfaceShellGeometry,
  buildLoftGeometry,
  sampleCurve3D,
  buildCurveScatterInstances,
  mergePartGeometries,
  buildInstancedMesh,
  modifyGeometrySync,
} from '../core/geometry/parametric-cad.js';
import { inspectSceneBudget } from '../core/scene-budget.js';
import { ProceduralTextureClient } from '../render/procedural-texture-client.js';
import { textureLeaseRegistry } from '../render/texture-lease-registry.js';

export class RapidStudio {
  constructor(options = {}) {
    this._scene = options.scene || null;
    this._camera = options.camera || null;
    this._renderer = options.renderer || null;
    this._sceneManager = options.sceneManager || null;
    this._engine = options.engine || null;
    this._THREE = options.THREE || THREE || (typeof window !== 'undefined' ? window.THREE : null);
    
    // Tracking objects created by DSL for easy scene management & cleanup
    this._createdObjects = new Set();
    this._animationCallbacks = [];
    this._isAnimating = false;
    this._clock = null;
    this._animationFrameId = null;
    this._logger = options.logger || console.log;

    this._setupBpyCompatibility();
  }

  log(message, type = 'info') {
    if (typeof window !== 'undefined' && window.codeEditor && typeof window.codeEditor.log === 'function') {
      window.codeEditor.log(type, message);
    } else if (this._logger) {
      this._logger(`[studio] ${message}`);
    } else {
      console.log(`[studio] ${message}`);
    }
  }

  /**
   * Bind or update engine references (scene, camera, renderer, THREE)
   */
  init({ scene, camera, renderer, sceneManager, engine, THREE: threeModule, logger } = {}) {
    if (scene) this._scene = scene;
    if (camera) this._camera = camera;
    if (renderer) this._renderer = renderer;
    if (sceneManager) this._sceneManager = sceneManager;
    if (engine) this._engine = engine;
    if (threeModule) this._THREE = threeModule;
    else if (!this._THREE) this._THREE = THREE;
    if (logger) this._logger = logger;
    return this;
  }

  takeScreenshot() {
    const win = typeof window !== 'undefined' ? window : null;
    const renderer = this._renderer || this._engine?.renderer || win?.engine?.renderer || win?.renderer || null;
    const scene = this._scene || this._engine?.scene || this._sceneManager?.scene || win?.engine?.scene || win?.scene || null;
    const camera = this._camera || this._engine?.camera || win?.engine?.camera || win?.camera || null;
    if (!renderer || !renderer.domElement) return null;
    if (scene && camera && typeof renderer.render === 'function') {
      try { renderer.render(scene, camera); } catch (_) {}
    }
    const dataUrl = typeof renderer.domElement.toDataURL === 'function'
      ? renderer.domElement.toDataURL('image/png')
      : null;
    return dataUrl ? {
      dataUrl,
      width: renderer.domElement.width || 0,
      height: renderer.domElement.height || 0
    } : null;
  }

  get THREE() {
    if (this._THREE) return this._THREE;
    if (typeof THREE !== 'undefined' && THREE) {
      this._THREE = THREE;
      return this._THREE;
    }
    if (typeof window !== 'undefined' && window.THREE) {
      this._THREE = window.THREE;
      return this._THREE;
    }
    return THREE;
  }

  get scene() {
    if (this._scene) return this._scene;
    if (typeof window !== 'undefined') {
      if (window.engine && window.engine.scene) {
        this._scene = window.engine.scene;
        return this._scene;
      }
      if (window.sceneManager && window.sceneManager.scene) {
        this._scene = window.sceneManager.scene;
        return this._scene;
      }
      if (window.scene) {
        this._scene = window.scene;
        return this._scene;
      }
      if (window.studioEngine && window.studioEngine.scene) {
        this._scene = window.studioEngine.scene;
        return this._scene;
      }
      if (window.app && window.app.engine && window.app.engine.scene) {
        this._scene = window.app.engine.scene;
        return this._scene;
      }
    }
    throw new Error("No Three.js Scene bound to RapidStudio. Call studio.init({ scene }).");
  }

  // Helper to parse colors (hex number, hex string, hsl, rgb)
  _parseColor(colorValue, defaultColor = 0x95a5a6) {
    const THREE = this.THREE;
    if (colorValue === undefined || colorValue === null) {
      return new THREE.Color(defaultColor);
    }
    if (colorValue instanceof THREE.Color) {
      return colorValue.clone();
    }
    if (typeof colorValue === 'string') {
      return new THREE.Color(colorValue);
    }
    if (typeof colorValue === 'number') {
      return new THREE.Color(colorValue);
    }
    return new THREE.Color(defaultColor);
  }

  // Create standard PBR material (defaults to Blender neutral unmaterialed clay if no color is specified)
  _createMaterial(options = {}) {
    const THREE = this.THREE;
    const isUnassignedClay = (options.color === undefined || options.color === null) && !options.emissive && !options.hasAssignedMaterial;
    const color = this._parseColor(options.color, 0xd2d5da);
    const emissive = options.emissive ? this._parseColor(options.emissive, 0x000000) : new THREE.Color(0x000000);
    const roughness = options.roughness !== undefined ? options.roughness : (isUnassignedClay ? 0.65 : 0.45);
    const metalness = options.metalness !== undefined ? options.metalness : (isUnassignedClay ? 0.0 : 0.15);
    const wireframe = !!options.wireframe;
    const opacity = options.opacity !== undefined ? options.opacity : 1.0;
    const transparent = opacity < 1.0 || !!options.transparent;

    const mat = new THREE.MeshStandardMaterial({
      name: options.materialName || (isUnassignedClay ? 'Default Clay (Unassigned)' : 'Material'),
      color,
      emissive,
      emissiveIntensity: options.emissiveIntensity !== undefined ? options.emissiveIntensity : (options.emissive ? 1 : 0),
      roughness,
      metalness,
      wireframe,
      opacity,
      transparent,
      vertexColors: Boolean(options.vertexColors),
      side: options.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      flatShading: options.flatShading !== undefined ? !!options.flatShading : true
    });
    mat.userData.isDefaultClay = isUnassignedClay;
    return mat;
  }

  _applyTransformProps(obj, options = {}) {
    const pos = options.position && typeof options.position === 'object' ? options.position : options;
    obj.position.set(Number(pos.x) || 0, Number(pos.y) || 0, Number(pos.z) || 0);
    if (Array.isArray(options.rotation)) {
      obj.rotation.set(Number(options.rotation[0]) || 0, Number(options.rotation[1]) || 0, Number(options.rotation[2]) || 0);
    } else if (options.rotation && typeof options.rotation === 'object') {
      obj.rotation.set(Number(options.rotation.x) || 0, Number(options.rotation.y) || 0, Number(options.rotation.z) || 0);
    } else {
      obj.rotation.set(Number(options.rotationX) || 0, Number(options.rotationY) || 0, Number(options.rotationZ) || 0);
    }
    if (typeof options.scale === 'number') {
      obj.scale.setScalar(options.scale);
    } else if (Array.isArray(options.scale)) {
      obj.scale.set(Number(options.scale[0] ?? 1), Number(options.scale[1] ?? 1), Number(options.scale[2] ?? 1));
    } else if (options.scale && typeof options.scale === 'object') {
      obj.scale.set(Number(options.scale.x ?? 1), Number(options.scale.y ?? 1), Number(options.scale.z ?? 1));
    }
    return obj;
  }

  _buildCadMesh(geometry, options = {}, defaultName = 'CAD_Mesh') {
    const THREE = this.THREE;
    const hasVertexColor = Boolean(geometry?.attributes?.color);
    let mat = options.material || null;
    if (mat) {
      if (hasVertexColor && options.vertexColors !== false && !mat.vertexColors) {
        mat = mat.clone();
        mat.vertexColors = true;
        mat.needsUpdate = true;
      }
    } else {
      mat = this._createMaterial({
        ...options,
        flatShading: options.flatShading ?? false,
        vertexColors: options.vertexColors !== undefined ? Boolean(options.vertexColors) : hasVertexColor,
      });
    }
    const mesh = new THREE.Mesh(geometry, mat);
    this._applyTransformProps(mesh, options);
    mesh.castShadow = options.castShadow !== false;
    mesh.receiveShadow = options.receiveShadow !== false;
    mesh.userData.explicitShadowSet = true;
    if (options.parent && options.parent.isObject3D) {
      mesh.name = options.name || defaultName;
      const sm = this._sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
      if (sm && typeof sm.addObject === 'function') {
        sm.addObject(mesh, options.parent, false, Boolean(sm._batchStack?.length || options.recordHistory !== false));
        this._createdObjects.add(mesh);
      } else {
        options.parent.add(mesh);
      }
      const eng = this._engine || (typeof window !== 'undefined' ? (window.engine || window.studioEngine) : null);
      eng?.markShadowDirty?.();
      eng?.requestRender?.();
      return mesh;
    }
    return this._register(mesh, options.name || defaultName);
  }

  _finalizePrimitive(geom, primitiveType, primitiveParams, options = {}, defaultName = 'Mesh', extraMatOpts = {}) {
    const THREE = this.THREE;
    const mat = options.material || this._createMaterial({ ...extraMatOpts, ...options });
    const mesh = new THREE.Mesh(geom, mat);
    this._applyTransformProps(mesh, options);
    mesh.userData.primitiveType = primitiveType;
    mesh.userData.primitiveParams = primitiveParams;
    mesh.castShadow = options.castShadow !== false;
    mesh.receiveShadow = options.receiveShadow !== false;
    mesh.userData.explicitShadowSet = true;
    if (options.parent && options.parent.isObject3D) {
      mesh.name = options.name || defaultName;
      const sm = this._sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
      if (sm && typeof sm.addObject === 'function') {
        sm.addObject(mesh, options.parent, false, Boolean(sm._batchStack?.length || options.recordHistory !== false));
        this._createdObjects.add(mesh);
      } else {
        options.parent.add(mesh);
      }
      const eng = this._engine || (typeof window !== 'undefined' ? (window.engine || window.studioEngine) : null);
      eng?.markShadowDirty?.();
      eng?.requestRender?.();
      return mesh;
    }
    return this._register(mesh, options.name || defaultName);
  }

  // Register and add mesh to scene
  _register(obj, name = null) {
    if (name) obj.name = name;
    if (obj.isMesh || obj.isInstancedMesh) {
      if (!obj.userData?.explicitShadowSet) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    } else if (obj.isGroup || obj.isObject3D) {
      obj.traverse((child) => {
        if ((child.isMesh || child.isInstancedMesh) && !child.userData?.explicitShadowSet) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
    }
    const sm = this._sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    if (sm && typeof sm.addObject === 'function' && (!obj.userData || !sm.objects.has(obj.userData.id))) {
      sm.addObject(obj, null, true, true);
    } else {
      this.scene.add(obj);
    }
    const eng = this._engine || (typeof window !== 'undefined' ? (window.engine || window.studioEngine) : null);
    eng?.markShadowDirty?.();
    eng?.requestRender?.();
    this._createdObjects.add(obj);
    return obj;
  }

  // ==========================================
  // UNIVERSAL PARAMETRIC CAD, SWEEP, LOFT & GPU INSTANCING
  // ==========================================

  sampleContour(contour, segments = 20) {
    return sample2DContour(contour, segments);
  }

  addExtrude(options = {}) {
    const geom = buildExtrudeGeometry(options, this.THREE);
    return this._buildCadMesh(geom, options, 'Extrude');
  }

  addSweep(options = {}) {
    const geom = buildSweepGeometry(options, this.THREE);
    return this._buildCadMesh(geom, options, 'Sweep');
  }

  addLathe(options = {}) {
    const geom = buildLatheGeometry(options, this.THREE);
    return this._buildCadMesh(geom, options, 'Lathe');
  }

  addSurfaceGrid(options = {}) {
    const geom = buildSurfaceShellGeometry(options, this.THREE);
    return this._buildCadMesh(geom, { doubleSided: true, ...options }, 'SurfaceShell');
  }

  addLoft(options = {}) {
    const geom = buildLoftGeometry(options, this.THREE);
    return this._buildCadMesh(geom, { doubleSided: Boolean(options.grid), ...options }, 'Loft');
  }

  sampleCurve3D(options = {}) {
    return sampleCurve3D(options, this.THREE);
  }

  createCurve3D(options = {}) {
    return sampleCurve3D(options, this.THREE);
  }

  scatterOnCurve(sourceOrOpts, curveOrOptions = {}, options = {}) {
    // Support BOTH (source, curveOrOptions, options) AND single-object ({ source, geometry, material, curve, ... })
    if (
      sourceOrOpts &&
      typeof sourceOrOpts === 'object' &&
      !sourceOrOpts.isObject3D &&
      !sourceOrOpts.isBufferGeometry &&
      ('curve' in sourceOrOpts || 'geometry' in sourceOrOpts || 'source' in sourceOrOpts)
    ) {
      const cfg = sourceOrOpts;
      const samples = Array.isArray(cfg.curve) ? cfg.curve : sampleCurve3D(cfg.curve || cfg, this.THREE);
      const instances = buildCurveScatterInstances(samples, cfg);
      const src = cfg.source || cfg.geometry || new this.THREE.BoxGeometry(0.2, 0.2, 0.2);
      return this.addInstancedMesh(src, instances, { name: cfg.name || 'CurveScatter', ...cfg });
    }
    const samples = Array.isArray(curveOrOptions)
      ? curveOrOptions
      : sampleCurve3D(curveOrOptions, this.THREE);
    const instances = buildCurveScatterInstances(samples, options);
    return this.addInstancedMesh(sourceOrOpts, instances, { name: options.name || 'CurveScatter', ...options });
  }

  boolean(arg0 = 'subtract', arg1 = null, arg2 = null, options = {}) {
    const opMap = { subtract: 'difference', difference: 'difference', union: 'union', intersect: 'intersect' };
    let operation, targetA, targetB;
    if (typeof arg0 === 'string' && opMap[arg0.toLowerCase()]) {
      operation = arg0; targetA = arg1; targetB = arg2;
    } else {
      // Support (targetA, targetB, operation, options) overload cleanly
      targetA = arg0; targetB = arg1; operation = typeof arg2 === 'string' ? arg2 : 'subtract';
    }
    const normalizedOp = opMap[String(operation || 'subtract').toLowerCase()] || 'difference';
    const objA = typeof targetA === 'string' ? this.getObject(targetA) : targetA;
    const objB = typeof targetB === 'string' ? this.getObject(targetB) : targetB;
    if (!objA?.isMesh || !objB?.isMesh) {
      throw new Error('studio.boolean requires two Mesh operands (targetA, targetB).');
    }
    const mods = (typeof window !== 'undefined' && window.Modifiers) || options.modifiers;
    if (!mods || typeof mods.applyBoolean !== 'function') {
      throw Object.assign(new Error('Boolean CSG engine is unavailable in this environment.'), { code: 'E_UNSUPPORTED' });
    }
    return mods.applyBoolean(objA, objB, normalizedOp, options);
  }

  inspectSceneBudget(targetOrTier = null, options = {}) {
    const TIER_NAMES = new Set(['mobile', 'product', 'architecture']);
    let root = null;
    let opts = options;
    if (typeof targetOrTier === 'string' && TIER_NAMES.has(targetOrTier.toLowerCase())) {
      opts = { tier: targetOrTier.toLowerCase(), ...options };
      root = this._sceneManager?.rootContainer || this.scene;
    } else if (targetOrTier && typeof targetOrTier === 'object' && !targetOrTier.isObject3D) {
      opts = { ...targetOrTier, ...options };
      root = this._sceneManager?.rootContainer || this.scene;
    } else {
      root = targetOrTier
        ? (typeof targetOrTier === 'string' ? this.getObject(targetOrTier) : targetOrTier)
        : (this._sceneManager?.rootContainer || this.scene);
    }
    const eng = this._engine || (typeof window !== 'undefined' ? (window.engine || window.studioEngine) : null);
    return inspectSceneBudget(root, { ...opts, renderer: eng?.renderer || null });
  }

  async exportModel(options = {}) {
    const exporter = (typeof window !== 'undefined' && (window.app?.exporter || window.exporter)) || null;
    if (!exporter || typeof exporter.exportGLTF !== 'function') {
      throw Object.assign(new Error('StudioExporter is unavailable in this environment.'), { code: 'E_UNSUPPORTED' });
    }
    const res = await exporter.exportGLTF(options.target || null, {
      binary: options.binary !== false,
      download: options.download === true,
      optimize: options.optimize !== false,
      ...options,
    });
    return {
      ok: true,
      filename: res?.filename || (options.binary === false ? 'model.gltf' : 'model.glb'),
      bytes: res?.blob?.size || res?.buffer?.byteLength || 0,
      blob: res?.blob || null,
      buffer: res?.buffer || null,
    };
  }

  /**
   * General-purpose crisp CanvasTexture signage / inscription / architectural clock / decal generator.
   * Zero hardcoded content: all text, colors, borders, and layout are parameterized.
   */
  createSignTexture(options = {}) {
    if (typeof document === 'undefined') return null;
    const width = Math.max(64, Math.min(2048, Math.round(Number(options.width) || 1024)));
    const height = Math.max(64, Math.min(2048, Math.round(Number(options.height) || 256)));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = options.bg || '#1e293b';
    ctx.fillRect(0, 0, width, height);
    if (options.borderColor) {
      const bw = Math.max(2, Number(options.borderWidth) || Math.round(Math.min(width, height) * 0.06));
      ctx.strokeStyle = options.borderColor;
      ctx.lineWidth = bw;
      ctx.strokeRect(bw * 0.5, bw * 0.5, width - bw, height - bw);
    }
    if (options.text) {
      const fontSize = Math.max(12, Number(options.fontSize) || Math.round(height * 0.42));
      ctx.fillStyle = options.color || '#f8fafc';
      ctx.font = `${options.fontWeight || 'bold'} ${fontSize}px ${options.fontFamily || 'Georgia, serif'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(options.text), width * 0.5, height * 0.52, width * 0.9);
    }
    const tex = new this.THREE.CanvasTexture(canvas);
    tex.anisotropy = 16;
    if (this.THREE.SRGBColorSpace) tex.colorSpace = this.THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  _detachSourceForBatch(sm, item, useBatch) {
    if (!item?.isObject3D) return;
    if (sm && item.userData?.id && sm.objects?.has(item.userData.id)) {
      sm.removeObject(item, useBatch, false);
    } else if (item.parent) {
      const parent = item.parent;
      const childIndex = parent.children.indexOf(item);
      if (useBatch && typeof sm?.recordExecutedCommand === 'function') {
        const detachCmd = {
          description: `Detach ${item.name || 'Child'}`,
          execute() {
            if (item.parent) item.parent.remove(item);
          },
          undo() {
            if (!parent) return;
            if (item.parent !== parent) parent.add(item);
            const curIdx = parent.children.indexOf(item);
            if (childIndex >= 0 && childIndex < parent.children.length && curIdx !== childIndex) {
              parent.children.splice(curIdx, 1);
              parent.children.splice(childIndex, 0, item);
            }
          },
        };
        detachCmd.execute();
        try {
          sm.recordExecutedCommand(detachCmd);
        } catch (err) {
          try { detachCmd.undo(); } catch (_) {}
          throw err;
        }
      } else {
        item.parent.remove(item);
      }
    }
    this._createdObjects.delete(item);
  }

  mergeMeshes(parts = [], options = {}) {
    const sm = this._sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    const geom = mergePartGeometries(parts, options, this.THREE);
    const useBatch = Boolean(options.removeSources && sm && typeof sm.beginBatch === 'function');
    if (useBatch) sm.beginBatch('Merge Meshes');
    try {
      if (options.removeSources) {
        for (const item of parts) {
          this._detachSourceForBatch(sm, item, useBatch);
        }
      }
      const out = this._buildCadMesh(geom, options, 'MergedMesh');
      if (useBatch) sm.endBatch();
      return out;
    } catch (err) {
      if (useBatch) {
        try {
          const batch = sm._batchStack?.pop?.();
          const cmds = batch?.commands || [];
          for (let i = cmds.length - 1; i >= 0; i--) {
            try { cmds[i].undo?.(); } catch (_) {}
          }
        } catch (_) {}
      }
      throw err;
    }
  }

  addInstancedMesh(source, instances = [], options = {}) {
    const THREE = this.THREE;
    const geom = source?.isBufferGeometry ? source : source?.geometry;
    const hasVertexColor = Boolean(geom?.attributes?.color);
    let mat = options.material || source?.material || null;
    if (mat) {
      if (hasVertexColor && options.vertexColors !== false && !mat.vertexColors) {
        mat = mat.clone();
        mat.vertexColors = true;
        mat.needsUpdate = true;
      }
    } else {
      mat = this._createMaterial({
        ...options,
        flatShading: options.flatShading ?? false,
        vertexColors: options.vertexColors !== undefined ? Boolean(options.vertexColors) : hasVertexColor,
      });
    }
    const inst = buildInstancedMesh(geom, mat, instances, options, THREE);
    this._applyTransformProps(inst, options);
    const sm = this._sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    const useBatch = Boolean(options.removeSource && source?.isObject3D && sm && typeof sm.beginBatch === 'function');
    if (useBatch) sm.beginBatch('Instance Mesh');
    try {
      if (options.removeSource && source?.isObject3D) {
        this._detachSourceForBatch(sm, source, useBatch);
      }
      let out;
      if (options.parent && options.parent.isObject3D) {
        if (sm && typeof sm.addObject === 'function' && (useBatch || options.recordHistory !== false)) {
          inst.name = options.name || 'InstancedMesh';
          sm.addObject(inst, options.parent, false, Boolean(useBatch || sm._batchStack?.length || options.recordHistory !== false));
          out = inst;
        } else {
          options.parent.add(inst);
          out = inst;
        }
      } else {
        out = this._register(inst, options.name || 'InstancedMesh');
      }
      if (useBatch) sm.endBatch();
      return out;
    } catch (err) {
      if (useBatch) {
        try {
          const batch = sm._batchStack?.pop?.();
          const cmds = batch?.commands || [];
          for (let i = cmds.length - 1; i >= 0; i--) {
            try { cmds[i].undo?.(); } catch (_) {}
          }
        } catch (_) {}
      }
      throw err;
    }
  }

  boxProjectUV(target, options = {}) {
    const resolved = typeof target === 'string' ? this.getObject(target) : target;
    if (!resolved) return null;
    const applyOne = (mesh) => {
      if (!mesh?.geometry) return;
      mesh.updateWorldMatrix?.(true, false);
      applyTriplanarUV(mesh.geometry, {
        metersPerTile: options.metersPerTile ?? options.scale ?? 2.0,
        matrix: options.worldSpace !== false ? mesh.matrixWorld : null,
      }, this.THREE);
    };
    if (resolved.isBufferGeometry) applyTriplanarUV(resolved, options, this.THREE);
    else resolved.traverse?.((c) => { if (c.isMesh) applyOne(c); });
    return resolved;
  }

  computeCreaseNormals(target, angleDeg = 32) {
    const resolved = typeof target === 'string' ? this.getObject(target) : target;
    if (!resolved) return null;
    if (resolved.isBufferGeometry) return applyCreaseNormals(resolved, angleDeg, this.THREE);
    resolved.traverse?.((c) => {
      if (c.isMesh && c.geometry) {
        const next = applyCreaseNormals(c.geometry, angleDeg, this.THREE);
        if (next !== c.geometry) {
          c.geometry.dispose?.();
          c.geometry = next;
        }
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach((m) => { if (m && m.flatShading) { m.flatShading = false; m.needsUpdate = true; } });
      }
    });
    return resolved;
  }

  bakeVertexAO(target, options = {}) {
    const resolved = typeof target === 'string' ? this.getObject(target) : target;
    if (!resolved) return null;
    if (resolved.isBufferGeometry) return computeVertexCavityAO(resolved, options, this.THREE);
    resolved.traverse?.((c) => {
      if (c.isMesh && c.geometry) {
        computeVertexCavityAO(c.geometry, options, this.THREE);
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach((m) => {
          if (m && !m.vertexColors) {
            m.vertexColors = true;
            m.needsUpdate = true;
          }
        });
      }
    });
    return resolved;
  }

  modifyGeometry(target, type, params = {}) {
    const resolved = typeof target === 'string' ? this.getObject(target) : target;
    if (!resolved) return null;
    const runGeom = (geom) => {
      const syncTypes = new Set(['creasenormals', 'autosmooth', 'boxuv', 'triplanaruv', 'vertexao', 'cavityao', 'taper', 'twist']);
      const clean = String(type || '').toLowerCase().replace(/[-_\s]/g, '');
      if (syncTypes.has(clean)) return modifyGeometrySync(geom, type, params, this.THREE);
      try {
        return executeModifier(geom, type, params);
      } catch (_) {
        return modifyGeometrySync(geom, type, params, this.THREE);
      }
    };
    if (resolved.isBufferGeometry) return runGeom(resolved);
    if (resolved.isMesh && resolved.geometry) {
      const next = runGeom(resolved.geometry);
      if (next && next !== resolved.geometry) {
        resolved.geometry.dispose?.();
        resolved.geometry = next;
      }
    }
    return resolved;
  }

  getObject(nameOrUuid) {
    if (!nameOrUuid) return null;
    if (nameOrUuid.isObject3D) return nameOrUuid;
    const sm = this._sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    if (sm?.resolveObject) {
      const hit = sm.resolveObject(nameOrUuid);
      if (hit) return hit;
    }
    return this.scene?.getObjectByName?.(String(nameOrUuid)) || this.scene?.getObjectByProperty?.('uuid', String(nameOrUuid)) || null;
  }

  setColor(target, color) {
    const obj = this.getObject(target);
    if (!obj) return null;
    const parsed = this._parseColor(color, 0x95a5a6);
    obj.traverse?.((c) => {
      if (!c.material) return;
      for (const m of Array.isArray(c.material) ? c.material : [c.material]) {
        m?.color?.copy(parsed);
      }
    });
    return obj;
  }

  setEmissive(target, color, intensity = 1.0) {
    const obj = this.getObject(target);
    if (!obj) return null;
    const parsed = this._parseColor(color, 0x000000);
    obj.traverse?.((c) => {
      if (!c.material) return;
      for (const m of Array.isArray(c.material) ? c.material : [c.material]) {
        if (m?.emissive) m.emissive.copy(parsed);
        if (m) m.emissiveIntensity = intensity;
      }
    });
    return obj;
  }

  /**
   * Generates high-res (up to 2048x2048) tileable procedural PBR textures (Albedo + Sobel Normal + Roughness)
   * off-main-thread with mipmaps & 16x Anisotropy, and binds them to target Mesh / Group / Material name.
   */
  async applyProceduralPBR(target, options = {}) {
    const THREE = this.THREE;
    const eng = this._engine || (typeof window !== 'undefined' ? (window.engine || window.studioEngine) : null);
    if (!this._procTexClient) {
      const maxAniso = eng?.renderer?.capabilities?.getMaxAnisotropy?.() || 16;
      this._procTexClient = new ProceduralTextureClient({ maxAnisotropy: maxAniso });
    }
    const finiteNum = (v, fb, lo = -Infinity, hi = Infinity) => {
      if (v === undefined || v === null || v === '') return fb;
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fb;
    };
    const pattern = options.pattern || options.type || 'ashlar_stone';
    const resolution = Math.round(finiteNum(options.resolution ?? options.width, 1024, 64, 2048));
    const maps = await this._procTexClient.generateTextureMaps(pattern, resolution, resolution, options);
    if (!this._matProcLeases) this._matProcLeases = new WeakMap();

    const repeatX = finiteNum(options.repeatX ?? (Array.isArray(options.repeat) ? options.repeat[0] : options.repeat), 1, 0.01, 256);
    const repeatY = finiteNum(options.repeatY ?? (Array.isArray(options.repeat) ? options.repeat[1] : options.repeat), 1, 0.01, 256);
    const cloneTex = (baseTex) => {
      if (!baseTex) return null;
      if (repeatX === 1 && repeatY === 1) return baseTex;
      const t = baseTex.clone();
      t.image = baseTex.image;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = baseTex.anisotropy || 16;
      t.colorSpace = baseTex.colorSpace;
      t.repeat.set(repeatX, repeatY);
      t.needsUpdate = true;
      return t;
    };

    const roots = [];
    if (Array.isArray(target)) {
      for (const item of target) {
        const o = this.getObject(item);
        if (o) roots.push(o);
      }
    } else if (typeof target === 'string') {
      const exact = this.getObject(target);
      if (exact) roots.push(exact);
      else {
        const needle = target.toLowerCase();
        this.scene.traverse((c) => {
          if (c.isMesh && (c.name?.toLowerCase().includes(needle) || c.material?.name?.toLowerCase() === needle)) {
            roots.push(c);
          }
        });
      }
    } else if (target?.isObject3D) {
      roots.push(target);
    }

    const normalStrength = finiteNum(options.normalScale, 0.85, 0, 10);
    const diffTex = options.useDiffuseMap === false ? null : cloneTex(maps.diffuseTexture);
    const normTex = normalStrength === 0 ? null : cloneTex(maps.normalTexture);
    const roughTex = options.useRoughnessMap === false ? null : cloneTex(maps.roughnessTexture);
    const uvMeters = finiteNum(options.uvScale, 2.0, 0.01, 1000);
    const slotIndex = Number.isInteger(options.slotIndex) && options.slotIndex >= 0 ? options.slotIndex : null;
    let updatedCount = 0;

    const procClient = this._procTexClient;
    const leasedExtras = [diffTex, normTex, roughTex].filter(Boolean);

    const targetMeshSet = new Set();
    for (const root of roots) {
      root.traverse((m) => { if (m.isMesh || m.isInstancedMesh) targetMeshSet.add(m); });
    }
    const isMaterialUsedElsewhere = (candidate, excludeMeshes = targetMeshSet) => {
      if (!candidate || !this.scene) return false;
      let used = false;
      this.scene.traverse((obj) => {
        if (used || excludeMeshes.has(obj) || (!obj.isMesh && !obj.isInstancedMesh)) return;
        const ms = Array.isArray(obj.material) ? obj.material : [obj.material];
        if (ms.includes(candidate)) used = true;
      });
      return used;
    };

    const sharedMatCacheVC1 = new WeakMap();
    const sharedMatCacheVC0 = new WeakMap();
    const undoRecords = [];
    const replacedOldMats = new Map(); // srcMat -> prevLeaseInfo snapshot

    for (const mesh of targetMeshSet) {
      if (!mesh.geometry?.attributes?.uv) {
        applyTriplanarUV(mesh.geometry, { metersPerTile: uvMeters }, THREE);
      }
      const hasVC = Boolean(mesh.geometry?.attributes?.color);
      const cacheMap = hasVC ? sharedMatCacheVC1 : sharedMatCacheVC0;
      const upgradeMat = (srcMat) => {
        if (srcMat && cacheMap.has(srcMat)) return cacheMap.get(srcMat);
        const usePhysical = Boolean(
          srcMat?.isMeshPhysicalMaterial ||
          options.clearcoat !== undefined ||
          options.sheen !== undefined ||
          options.transmission !== undefined ||
          options.iridescence !== undefined ||
          options.anisotropy !== undefined
        );

        let next;
        if (srcMat && ((usePhysical && srcMat.isMeshPhysicalMaterial) || (!usePhysical && srcMat.isMeshStandardMaterial))) {
          // Full clone preserves every Three.js flag/map (clearcoatNormalScale, normalMapType,
          // alphaHash, depthWrite, depthTest, polygonOffset, blending, dithering, toneMapped, etc.)
          next = srcMat.clone();
        } else if (srcMat && usePhysical && srcMat.isMeshStandardMaterial) {
          next = new THREE.MeshPhysicalMaterial();
          next.copy(srcMat);
        } else {
          next = new (usePhysical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial)();
          if (srcMat) {
            for (const baseKey of [
              'side', 'transparent', 'opacity', 'depthWrite', 'depthTest', 'alphaTest', 'alphaHash',
              'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'blending', 'dithering',
              'fog', 'toneMapped', 'colorWrite', 'premultipliedAlpha', 'visible', 'name'
            ]) {
              if (srcMat[baseKey] !== undefined) next[baseKey] = srcMat[baseKey];
            }
          }
        }
        // Detach userData object reference so srcMat and next never share mutable metadata
        next.userData = srcMat?.userData ? { ...srcMat.userData } : {};

        next.name = options.materialName || srcMat?.name || `PBR_${pattern}`;
        if (options.tint !== undefined) {
          next.color.copy(this._parseColor(options.tint, 0xffffff));
        } else {
          next.color.setHex(0xffffff);
        }
        next.map = diffTex;
        next.normalMap = normTex;
        if (next.normalScale?.set) next.normalScale.set(normalStrength, normalStrength);
        else next.normalScale = new THREE.Vector2(normalStrength, normalStrength);
        next.roughnessMap = roughTex;
        next.roughness = finiteNum(options.roughness, roughTex ? 1.0 : finiteNum(srcMat?.roughness, 0.78, 0, 1), 0, 1);
        next.metalness = finiteNum(options.metalness, finiteNum(srcMat?.metalness, 0.0, 0, 1), 0, 1);
        if (options.emissive !== undefined && next.emissive) {
          next.emissive.copy(this._parseColor(options.emissive, 0x000000));
        }
        if (options.emissiveFromMap) next.emissiveMap = diffTex;
        if (options.emissiveIntensity !== undefined) {
          next.emissiveIntensity = finiteNum(options.emissiveIntensity, 0, 0, 100);
        }
        next.vertexColors = options.vertexColors !== undefined ? Boolean(options.vertexColors) : Boolean(srcMat?.vertexColors || hasVC);
        next.flatShading = Boolean(options.flatShading ?? false);
        if (options.doubleSided !== undefined) {
          next.side = options.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
        }
        if (options.transparent !== undefined) next.transparent = Boolean(options.transparent);
        if (options.opacity !== undefined) next.opacity = finiteNum(options.opacity, 1.0, 0, 1);

        if (usePhysical) {
          if (options.clearcoat !== undefined) next.clearcoat = finiteNum(options.clearcoat, next.clearcoat ?? 0, 0, 1);
          if (options.clearcoatRoughness !== undefined) next.clearcoatRoughness = finiteNum(options.clearcoatRoughness, next.clearcoatRoughness ?? 0, 0, 1);
          if (options.sheen !== undefined) next.sheen = finiteNum(options.sheen, next.sheen ?? 0, 0, 1);
          if (options.sheenRoughness !== undefined) next.sheenRoughness = finiteNum(options.sheenRoughness, next.sheenRoughness ?? 1, 0, 1);
          if (options.transmission !== undefined) next.transmission = finiteNum(options.transmission, next.transmission ?? 0, 0, 1);
          if (options.ior !== undefined) next.ior = finiteNum(options.ior, next.ior ?? 1.5, 1.0, 2.5);
        }

        if (srcMat && !replacedOldMats.has(srcMat)) {
          const prevLease = textureLeaseRegistry.getLease(srcMat);
          replacedOldMats.set(srcMat, prevLease ? { entry: prevLease.entry, client: prevLease.client, textures: [...prevLease.textures] } : null);
        }
        textureLeaseRegistry.bind(next, maps, procClient, leasedExtras);
        next.needsUpdate = true;
        if (srcMat) cacheMap.set(srcMat, next);
        return next;
      };

      const prevMaterial = Array.isArray(mesh.material) ? mesh.material.slice() : mesh.material;
      if (Array.isArray(mesh.material)) {
        if (slotIndex !== null && slotIndex < mesh.material.length) {
          const nextArr = mesh.material.slice();
          nextArr[slotIndex] = upgradeMat(mesh.material[slotIndex]);
          mesh.material = nextArr;
        } else {
          mesh.material = mesh.material.map(upgradeMat);
        }
      } else {
        mesh.material = upgradeMat(mesh.material);
      }
      const nextMaterial = Array.isArray(mesh.material) ? mesh.material.slice() : mesh.material;
      undoRecords.push({ mesh, prevMaterial, nextMaterial });
      updatedCount++;
    }

    // Release replaced source materials' leases ONLY if no mesh anywhere in the scene still references them
    const emptyExcl = new Set();
    for (const [srcMat] of replacedOldMats) {
      if (!isMaterialUsedElsewhere(srcMat, emptyExcl)) {
        textureLeaseRegistry.release(srcMat);
      }
    }

    const sm = this._sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    if (options.recordHistory !== false && sm && typeof sm.recordExecutedCommand === 'function' && undoRecords.length > 0) {
      const nextMatSet = new Set();
      for (const rec of undoRecords) {
        const list = Array.isArray(rec.nextMaterial) ? rec.nextMaterial : [rec.nextMaterial];
        for (const m of list) if (m) nextMatSet.add(m);
      }
      const syncLeasesAfterSwap = (restoredMats, removedMats) => {
        for (const m of restoredMats) {
          const snap = replacedOldMats.get(m);
          if (snap?.entry && (!snap.client || [...snap.client.cache.values()].includes(snap.entry))) {
            textureLeaseRegistry.bind(m, snap.entry, snap.client, snap.textures);
          } else if (nextMatSet.has(m) && [...procClient.cache.values()].includes(maps)) {
            textureLeaseRegistry.bind(m, maps, procClient, leasedExtras);
          }
        }
        for (const m of removedMats) {
          if (!isMaterialUsedElsewhere(m, emptyExcl)) {
            textureLeaseRegistry.release(m);
          }
        }
      };
      sm.recordExecutedCommand({
        description: `Apply Procedural PBR (${pattern})`,
        execute() {
          const restored = new Set();
          const removed = new Set();
          for (const rec of undoRecords) {
            for (const m of (Array.isArray(rec.prevMaterial) ? rec.prevMaterial : [rec.prevMaterial])) if (m) removed.add(m);
            rec.mesh.material = Array.isArray(rec.nextMaterial) ? rec.nextMaterial.slice() : rec.nextMaterial;
            for (const m of (Array.isArray(rec.nextMaterial) ? rec.nextMaterial : [rec.nextMaterial])) if (m) restored.add(m);
          }
          syncLeasesAfterSwap(restored, removed);
          eng?.markShadowDirty?.();
          eng?.requestRender?.();
          sm?.emit?.('sceneChanged', { source: 'applyProceduralPBR', pattern, updatedMeshes: undoRecords.length });
        },
        undo() {
          const restored = new Set();
          const removed = new Set();
          for (const rec of undoRecords) {
            for (const m of (Array.isArray(rec.nextMaterial) ? rec.nextMaterial : [rec.nextMaterial])) if (m) removed.add(m);
            rec.mesh.material = Array.isArray(rec.prevMaterial) ? rec.prevMaterial.slice() : rec.prevMaterial;
            for (const m of (Array.isArray(rec.prevMaterial) ? rec.prevMaterial : [rec.prevMaterial])) if (m) restored.add(m);
          }
          syncLeasesAfterSwap(restored, removed);
          eng?.markShadowDirty?.();
          eng?.requestRender?.();
          sm?.emit?.('sceneChanged', { source: 'applyProceduralPBR:undo', pattern, updatedMeshes: undoRecords.length });
        },
      });
    }

    eng?.markShadowDirty?.();
    eng?.requestRender?.();
    sm?.emit?.('sceneChanged', { source: 'applyProceduralPBR', pattern, updatedMeshes: updatedCount });
    if (typeof window !== 'undefined') window.app?.budgetHud?.refresh?.();
    return { ok: true, pattern, resolution, updatedMeshes: updatedCount };
  }

  /**
   * Configures directional sunlight, hemisphere/fill balance, and auto-fits a crisp 4K shadow frustum
   * to the active scene bounds so buildings of any scale render sharp, unclipped architectural shadows.
   */
  setupSunLight(options = {}) {
    const eng = this._engine || (typeof window !== 'undefined' ? (window.engine || window.studioEngine) : null);
    if (options.withSky && typeof window !== 'undefined' && window.environmentStudio) {
      window.environmentStudio.enableSky(true, {
        elevation: options.elevation ?? 38,
        azimuth: options.azimuth ?? 142,
      });
    }
    if (eng && typeof eng.fitShadowFrustumToScene === 'function') {
      return eng.fitShadowFrustumToScene(options);
    }
    return null;
  }

  /**
   * Switches realtime render pipeline quality ('fast' | 'studio' | 'cinematic') with GTAO, Bloom & AgX.
   */
  setRenderQuality(preset = 'studio', options = {}) {
    const eng = this._engine || (typeof window !== 'undefined' ? (window.engine || window.studioEngine) : null);
    if (eng && typeof eng.setRenderQuality === 'function') {
      return eng.setRenderQuality(preset, options);
    }
    return null;
  }

  // ==========================================
  // PREFAB LIBRARY (Stage 2.2 — assemble high-quality .glb prefabs)
  // ==========================================

  /**
   * Place a .glb library prefab into the scene.
   * @param {string} prefabId ID in prefab-library.js ('michelle', 'soldier', ...)
   * @param {{x?:number, y?:number, z?:number, height?:number, scale?:number,
   *          rotationY?:number, rotationX?:number, rotationZ?:number, name?:string}} [opts]
   * @returns {Promise<THREE.Object3D>}
   */
  async placePrefab(prefabId, opts = {}) {
    prefabLibrary.bindStudio(this);
    try {
      return await prefabLibrary.place(prefabId, opts);
    } catch (err) {
      this.log(`Error placing prefab "${prefabId}": ${err?.message || err}`, 'error');
      return null;
    }
  }

  /** Danh sách prefab có sẵn (cho UI / script liệt kê). */
  listPrefabs() {
    return prefabLibrary.list();
  }

  /** Tìm prefab theo mô tả tự nhiên. */
  searchPrefabs(query) {
    return prefabLibrary.search(query);
  }

  // ==========================================
  // BASIC PRIMITIVES (Blender Default Unmaterialed Clay Blocks)
  // ==========================================

  /**
   * Add a primitive by type name (LLM convenience alias: cube, sphere, cylinder, cone, torus, plane)
   */
  addPrimitive(typeOrOpts = 'cube', opts = {}) {
    const rawOpts = (typeof typeOrOpts === 'object' && typeOrOpts !== null)
      ? typeOrOpts
      : { ...(opts || {}), type: typeOrOpts };
    const kind = String(rawOpts.type || rawOpts.primitive || 'cube').toLowerCase().trim();
    if (kind === 'sphere' || kind === 'uvsphere' || kind === 'ball') return this.addSphere(rawOpts);
    if (kind === 'cylinder' || kind === 'tube') return this.addCylinder(rawOpts);
    if (kind === 'cone' || kind === 'pyramid') return this.addCone(rawOpts);
    if (kind === 'torus' || kind === 'donut') return this.addTorus(rawOpts);
    if (kind === 'plane' || kind === 'floor' || kind === 'ground') return this.addPlane(rawOpts);
    return this.addCube(rawOpts);
  }

  selectFace(index = 0) {
    const em = typeof window !== 'undefined' ? window.editMode : null;
    if (em && typeof em.selectFace === 'function') return em.selectFace(index);
    return false;
  }

  selectEdge(index = 0) {
    const em = typeof window !== 'undefined' ? window.editMode : null;
    if (em && typeof em.selectEdge === 'function') return em.selectEdge(index);
    return false;
  }

  executeCommand(cmd = {}) {
    const t = typeof window !== 'undefined' ? window.stemTutor : null;
    if (cmd && typeof cmd === 'object' && t && typeof t.executeAICommand === 'function') {
      return t.executeAICommand(cmd);
    }
    return false;
  }

  /**
   * Add a Box / Cube mesh
   */
  addCube({
    x = 0, y = 0, z = 0,
    width = 2, height = 2, depth = 2,
    widthSegments = 1, heightSegments = 1, depthSegments = 1,
    color = undefined, roughness = undefined, metalness = undefined,
    flatShading = true,
    name = 'Cube', ...matProps
  } = {}) {
    const THREE = this.THREE;
    const geom = new THREE.BoxGeometry(width, height, depth, widthSegments, heightSegments, depthSegments);
    return this._finalizePrimitive(
      geom,
      'cube',
      { width, height, depth, widthSegments, heightSegments, depthSegments, flatShading },
      { x, y, z, color, roughness, metalness, flatShading, name, ...matProps },
      'Cube'
    );
  }

  /**
   * Add a UV Sphere mesh
   */
  addSphere({
    x = 0, y = 0, z = 0,
    radius = 1.0,
    widthSegments = 32, heightSegments = 16,
    color = undefined, roughness = undefined, metalness = undefined,
    flatShading = true,
    name = 'Sphere', ...matProps
  } = {}) {
    const THREE = this.THREE;
    const geom = new THREE.SphereGeometry(radius, widthSegments, heightSegments);
    return this._finalizePrimitive(
      geom,
      'uv_sphere',
      { radius, widthSegments, heightSegments, flatShading },
      { x, y, z, color, roughness, metalness, flatShading, name, ...matProps },
      'Sphere'
    );
  }

  /**
   * Add an Ico Sphere mesh (Blender Geodesic Polyhedron)
   */
  addIcoSphere({
    x = 0, y = 0, z = 0,
    radius = 1.0,
    subdivisions = 2,
    color = undefined, roughness = undefined, metalness = undefined,
    flatShading = true,
    name = 'Icosphere', ...matProps
  } = {}) {
    const THREE = this.THREE;
    const geom = new THREE.IcosahedronGeometry(radius, Math.max(0, Math.min(5, Math.round(subdivisions))));
    return this._finalizePrimitive(
      geom,
      'ico_sphere',
      { radius, subdivisions, flatShading },
      { x, y, z, color, roughness, metalness, flatShading, name, ...matProps },
      'Icosphere'
    );
  }

  /**
   * Add a Cylinder mesh
   */
  addCylinder({
    x = 0, y = 0, z = 0,
    radiusTop = 1.0, radiusBottom = 1.0, height = 2.0,
    radialSegments = 32, heightSegments = 1, openEnded = false,
    color = undefined, roughness = undefined, metalness = undefined,
    flatShading = true,
    name = 'Cylinder', ...matProps
  } = {}) {
    const THREE = this.THREE;
    const geom = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded);
    return this._finalizePrimitive(
      geom,
      'cylinder',
      { radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded, flatShading },
      { x, y, z, color, roughness, metalness, flatShading, name, ...matProps },
      'Cylinder',
      { doubleSided: openEnded }
    );
  }

  /**
   * Add a Cone mesh
   */
  addCone({
    x = 0, y = 0, z = 0,
    radius = 1.0, height = 2.0,
    radialSegments = 32, heightSegments = 1, openEnded = false,
    color = undefined, roughness = undefined, metalness = undefined,
    flatShading = true,
    name = 'Cone', ...matProps
  } = {}) {
    const THREE = this.THREE;
    const geom = new THREE.ConeGeometry(radius, height, radialSegments, heightSegments, openEnded);
    return this._finalizePrimitive(
      geom,
      'cone',
      { radius, height, radialSegments, heightSegments, openEnded, flatShading },
      { x, y, z, color, roughness, metalness, flatShading, name, ...matProps },
      'Cone',
      { doubleSided: openEnded }
    );
  }

  /**
   * Add a Torus / Donut mesh
   */
  addTorus({
    x = 0, y = 0, z = 0,
    radius = 1.0, tube = 0.25,
    radialSegments = 16, tubularSegments = 48,
    color = undefined, roughness = undefined, metalness = undefined,
    flatShading = true,
    name = 'Torus', ...matProps
  } = {}) {
    const THREE = this.THREE;
    const geom = new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments);
    geom.rotateX(Math.PI / 2); // Lay flat on X-Z plane like Blender Torus
    return this._finalizePrimitive(
      geom,
      'torus',
      { radius, tube, radialSegments, tubularSegments, flatShading },
      { x, y, z, color, roughness, metalness, flatShading, name, ...matProps },
      'Torus'
    );
  }

  /**
   * Add a Plane mesh (default horizontal ground orientation)
   */
  addPlane({
    x = 0, y = 0, z = 0,
    width = 2, height = 2,
    widthSegments = 1, heightSegments = 1,
    color = undefined, roughness = undefined, metalness = undefined,
    flatShading = true,
    rotationX = -Math.PI / 2,
    name = 'Plane', ...matProps
  } = {}) {
    const THREE = this.THREE;
    const geom = new THREE.PlaneGeometry(width, height, widthSegments, heightSegments);
    if (rotationX !== 0) {
      geom.rotateX(rotationX);
    }
    return this._finalizePrimitive(
      geom,
      'plane',
      { width, height, widthSegments, heightSegments, flatShading },
      { x, y, z, color, roughness, metalness, flatShading, name, ...matProps, rotationX: 0 },
      'Plane',
      { doubleSided: true }
    );
  }

  /**
   * Add a Subdivided Grid mesh (Blender Add -> Mesh -> Grid)
   */
  addGrid({
    x = 0, y = 0, z = 0,
    width = 4, height = 4,
    subdivisionsX = 10, subdivisionsY = 10,
    color = undefined, roughness = undefined, metalness = undefined,
    flatShading = true,
    name = 'Grid', ...matProps
  } = {}) {
    const THREE = this.THREE;
    const geom = new THREE.PlaneGeometry(width, height, subdivisionsX, subdivisionsY);
    geom.rotateX(-Math.PI / 2);
    return this._finalizePrimitive(
      geom,
      'grid',
      { width, height, subdivisionsX, subdivisionsY, flatShading },
      { x, y, z, color, roughness, metalness, flatShading, name, ...matProps },
      'Grid',
      { doubleSided: true }
    );
  }

  /**
   * Add a Circle polygon mesh (Blender Add -> Mesh -> Circle)
   */
  addCircle({
    x = 0, y = 0, z = 0,
    radius = 1.0, segments = 32,
    rotationX = -Math.PI / 2,
    color = undefined, roughness = undefined, metalness = undefined,
    flatShading = true,
    name = 'Circle', ...matProps
  } = {}) {
    const THREE = this.THREE;
    const geom = new THREE.CircleGeometry(radius, Math.max(3, Math.round(segments)));
    if (rotationX !== 0) geom.rotateX(rotationX);
    return this._finalizePrimitive(
      geom,
      'circle',
      { radius, segments, flatShading },
      { x, y, z, color, roughness, metalness, flatShading, name, ...matProps, rotationX: 0 },
      'Circle',
      { doubleSided: true }
    );
  }

  /**
   * Add a Capsule / Pill mesh
   */
  addCapsule({
    x = 0, y = 0, z = 0,
    radius = 0.6, length = 1.2,
    capSegments = 12, radialSegments = 24,
    color = undefined, roughness = undefined, metalness = undefined,
    flatShading = true,
    name = 'Capsule', ...matProps
  } = {}) {
    const THREE = this.THREE;
    const geom = new THREE.CapsuleGeometry(radius, length, capSegments, radialSegments);
    return this._finalizePrimitive(
      geom,
      'capsule',
      { radius, length, capSegments, radialSegments, flatShading },
      { x, y, z, color, roughness, metalness, flatShading, name, ...matProps },
      'Capsule'
    );
  }

  /**
   * Add a Group container to the scene
   * @param {string|Object} [name='Group']
   * @param {Object} [options={}]
   * @returns {THREE.Group}
   */
  addGroup(name = 'Group', options = {}) {
    const THREE = this.THREE;
    const opts = (typeof name === 'object' && name !== null) ? name : (options || {});
    const resolvedName = typeof name === 'string' ? name : (opts.name || 'Group');
    const group = new THREE.Group();
    this._applyTransformProps(group, opts);
    if (opts.parent && opts.parent.isObject3D) {
      group.name = resolvedName;
      opts.parent.add(group);
      return group;
    }
    return this._register(group, resolvedName);
  }

  /**
   * Add a custom Light
   */
  addLight({
    type = 'point',
    x = 5, y = 10, z = 5,
    color = 0xffffff,
    intensity = 1.0,
    distance = 0,
    name = null
  } = {}) {
    const THREE = this.THREE;
    let light;
    const parsedColor = this._parseColor(color);

    switch (type.toLowerCase()) {
      case 'directional':
        light = new THREE.DirectionalLight(parsedColor, intensity);
        light.castShadow = true;
        break;
      case 'spot':
        light = new THREE.SpotLight(parsedColor, intensity, distance);
        light.castShadow = true;
        break;
      case 'area':
      case 'rectarea':
        light = new THREE.RectAreaLight(parsedColor, intensity, 2.5, 2.5);
        light.castShadow = false;
        break;
      case 'ambient':
        light = new THREE.AmbientLight(parsedColor, intensity);
        break;
      case 'point':
      default:
        light = new THREE.PointLight(parsedColor, intensity, distance);
        light.castShadow = true;
        break;
    }

    light.position.set(x, y, z);
    return this._register(light, name || `${type}Light`);
  }

  /**
   * Add a scene camera with a selectable body and frustum helper.
   */
  addCamera({
    x = 6, y = 4, z = 8,
    targetX = 0, targetY = 1, targetZ = 0,
    fov = 50,
    focalLength = null,
    name = 'Camera'
  } = {}) {
    const cm = typeof window !== 'undefined' ? window.cameraManager : null;
    if (!cm) {
      console.warn('[RapidStudio] CameraManager is not available.');
      return null;
    }
    const resolvedFov = focalLength ? (180 / Math.PI) * 2 * Math.atan(24 / (2 * focalLength)) : fov;
    return cm.createCamera({
      name,
      position: { x, y, z },
      target: { x: targetX, y: targetY, z: targetZ },
      fov: resolvedFov
    });
  }

  /**
   * Add a Reference, Background, or Lit Mesh Plane Image object into the scene.
   */
  async addImage({
    src = null,
    source = null,
    file = null,
    texture = null,
    mode = 'reference',
    width = 4.0,
    size = null,
    opacity = null,
    align = 'view',
    depthOrder = null,
    displaySide = 'both',
    flipX = false,
    flipY = false,
    x = 0,
    y = null,
    z = 0,
    name = null,
    pixelWidth = null,
    pixelHeight = null,
  } = {}) {
    const sm = typeof window !== 'undefined' ? window.sceneManager : null;
    const cam = this._camera || (typeof window !== 'undefined' ? window.engine?.camera : null);
    const hasExplicitY = y !== null && y !== undefined;
    const resolvedWidth = size !== null && size !== undefined ? size : width;
    const mesh = await createImageObject({
      src: src || source,
      file,
      texture,
      mode,
      width: resolvedWidth,
      opacity,
      align,
      depthOrder,
      displaySide,
      flipX,
      flipY,
      name,
      pixelWidth,
      pixelHeight,
      position: hasExplicitY ? { x, y, z } : null,
      camera: cam,
      sceneManager: sm,
      scene: sm ? null : this.scene,
    });
    if (mesh && !hasExplicitY) {
      mesh.position.x = x;
      mesh.position.z = z;
      mesh.updateMatrixWorld?.(true);
    }
    if (mesh) this._createdObjects.add(mesh);
    return mesh;
  }

  // ==========================================
  // PROCEDURAL & PARAMETRIC ARCHITECTURAL DSL
  // ==========================================

  /**
   * Create an automated staircase (linear flight or spiral stairs)
   */
  createStaircase({
    x = 0, y = 0, z = 0,
    steps = 16,
    width = 1.8,
    stepHeight = 0.18,
    stepDepth = 0.35,
    spiral = false,
    radius = 2.0,
    anglePerStep = 0.28,
    color = 0xbdc3c7,
    railingColor = 0x2c3e50,
    withRailing = true,
    name = 'Staircase'
  } = {}) {
    const THREE = this.THREE;
    const group = new THREE.Group();
    group.name = name;
    group.position.set(x, y, z);

    const stepMat = this._createMaterial({ color, roughness: 0.5, metalness: 0.1 });
    const railMat = this._createMaterial({ color: railingColor, roughness: 0.3, metalness: 0.7 });

    if (spiral) {
      // Spiral Staircase with central column
      const totalHeight = steps * stepHeight;
      const poleRadius = 0.25;
      const poleGeom = new THREE.CylinderGeometry(poleRadius, poleRadius, totalHeight + 1, 32);
      const poleMesh = new THREE.Mesh(poleGeom, railMat);
      poleMesh.position.y = (totalHeight + 1) / 2;
      group.add(poleMesh);

      const stepGeom = new THREE.BoxGeometry(width, stepHeight * 0.9, stepDepth);
      // Offset geometry so step anchors at pole center
      stepGeom.translate(width / 2 + poleRadius * 0.8, 0, 0);

      for (let i = 0; i < steps; i++) {
        const stepMesh = new THREE.Mesh(stepGeom, stepMat);
        const currentAngle = i * anglePerStep;
        stepMesh.position.y = (i + 0.5) * stepHeight;
        stepMesh.rotation.y = currentAngle;
        group.add(stepMesh);

        // Optional railing post per step
        if (withRailing) {
          const postHeight = 0.9;
          const postGeom = new THREE.CylinderGeometry(0.03, 0.03, postHeight, 8);
          const postMesh = new THREE.Mesh(postGeom, railMat);
          const outerX = Math.cos(currentAngle) * (radius + width * 0.45);
          const outerZ = -Math.sin(currentAngle) * (radius + width * 0.45);
          postMesh.position.set(outerX, stepMesh.position.y + postHeight / 2, outerZ);
          group.add(postMesh);
        }
      }
    } else {
      // Linear Flight Staircase
      const stepGeom = new THREE.BoxGeometry(width, stepHeight, stepDepth);
      for (let i = 0; i < steps; i++) {
        const stepMesh = new THREE.Mesh(stepGeom, stepMat);
        stepMesh.position.set(0, (i + 0.5) * stepHeight, i * stepDepth);
        group.add(stepMesh);
      }

      // Linear Handrail
      if (withRailing) {
        const railLength = Math.hypot(steps * stepDepth, steps * stepHeight);
        const railAngle = Math.atan2(steps * stepHeight, steps * stepDepth);
        const railBarGeom = new THREE.CylinderGeometry(0.04, 0.04, railLength, 12);
        railBarGeom.rotateX(Math.PI / 2);

        [-width / 2 - 0.05, width / 2 + 0.05].forEach((sideX) => {
          const rail = new THREE.Mesh(railBarGeom, railMat);
          rail.position.set(sideX, (steps * stepHeight) / 2 + 0.85, (steps * stepDepth) / 2 - stepDepth / 2);
          rail.rotation.x = -railAngle;
          group.add(rail);

          // Support posts (start, middle, top)
          [0, Math.floor(steps / 2), steps - 1].forEach((idx) => {
            const postGeom = new THREE.CylinderGeometry(0.03, 0.03, 0.9, 8);
            const post = new THREE.Mesh(postGeom, railMat);
            post.position.set(sideX, idx * stepHeight + 0.45, idx * stepDepth);
            group.add(post);
          });
        });
      }
    }

    return this._register(group, name);
  }

  /**
   * Create a procedural parametric skyscraper or commercial building
   */
  createBuilding({
    x = 0, y = 0, z = 0,
    floors = 6,
    width = 4,
    depth = 4,
    floorHeight = 1.3,
    color = 0x2c3e50,
    windowColor = 0x74b9ff,
    windowEmissive = 0x34495e,
    roofType = 'terrace',
    withAntenna = true,
    name = 'Building'
  } = {}) {
    const THREE = this.THREE;
    const group = new THREE.Group();
    group.name = name;
    group.position.set(x, y, z);

    const bodyMat = this._createMaterial({ color, roughness: 0.6, metalness: 0.3 });
    const ledgeMat = this._createMaterial({ color: 0x1a252f, roughness: 0.7, metalness: 0.2 });
    const windowMat = this._createMaterial({
      color: windowColor,
      roughness: 0.1,
      metalness: 0.9,
      emissive: windowEmissive,
      emissiveIntensity: 0.4
    });

    // Concrete Foundation
    const baseHeight = 0.4;
    const baseGeom = new THREE.BoxGeometry(width + 0.4, baseHeight, depth + 0.4);
    const baseMesh = new THREE.Mesh(baseGeom, ledgeMat);
    baseMesh.position.y = baseHeight / 2;
    group.add(baseMesh);

    // Floors construction
    for (let f = 0; f < floors; f++) {
      const floorBaseY = baseHeight + f * floorHeight;
      const floorCenterY = floorBaseY + floorHeight / 2;

      // Floor main core
      const coreGeom = new THREE.BoxGeometry(width, floorHeight, depth);
      const coreMesh = new THREE.Mesh(coreGeom, bodyMat);
      coreMesh.position.y = floorCenterY;
      group.add(coreMesh);

      // Floor dividing ledge
      const ledgeGeom = new THREE.BoxGeometry(width + 0.15, 0.1, depth + 0.15);
      const ledgeMesh = new THREE.Mesh(ledgeGeom, ledgeMat);
      ledgeMesh.position.y = floorBaseY + floorHeight;
      group.add(ledgeMesh);

      // Procedural windows on 4 sides
      const windowWidth = 0.6;
      const windowHeight = floorHeight * 0.6;
      const winGeom = new THREE.PlaneGeometry(windowWidth, windowHeight);

      // Windows along width (Front & Back)
      const countX = Math.max(1, Math.floor(width / (windowWidth + 0.4)));
      const startX = -((countX - 1) * (windowWidth + 0.4)) / 2;

      for (let i = 0; i < countX; i++) {
        const wx = startX + i * (windowWidth + 0.4);

        // Front window (+Z)
        const winFront = new THREE.Mesh(winGeom, windowMat);
        winFront.position.set(wx, floorCenterY, depth / 2 + 0.02);
        group.add(winFront);

        // Back window (-Z)
        const winBack = new THREE.Mesh(winGeom, windowMat);
        winBack.position.set(wx, floorCenterY, -depth / 2 - 0.02);
        winBack.rotation.y = Math.PI;
        group.add(winBack);
      }

      // Windows along depth (Left & Right)
      const countZ = Math.max(1, Math.floor(depth / (windowWidth + 0.4)));
      const startZ = -((countZ - 1) * (windowWidth + 0.4)) / 2;

      for (let i = 0; i < countZ; i++) {
        const wz = startZ + i * (windowWidth + 0.4);

        // Right window (+X)
        const winRight = new THREE.Mesh(winGeom, windowMat);
        winRight.position.set(width / 2 + 0.02, floorCenterY, wz);
        winRight.rotation.y = Math.PI / 2;
        group.add(winRight);

        // Left window (-X)
        const winLeft = new THREE.Mesh(winGeom, windowMat);
        winLeft.position.set(-width / 2 - 0.02, floorCenterY, wz);
        winLeft.rotation.y = -Math.PI / 2;
        group.add(winLeft);
      }
    }

    // Roof construction
    const totalBuildingHeight = baseHeight + floors * floorHeight;
    if (roofType === 'terrace') {
      // Parapet walls around roof
      const parapetThickness = 0.2;
      const parapetHeight = 0.45;
      const parapetMat = ledgeMat;

      const pNorthGeom = new THREE.BoxGeometry(width, parapetHeight, parapetThickness);
      const pNorth = new THREE.Mesh(pNorthGeom, parapetMat);
      pNorth.position.set(0, totalBuildingHeight + parapetHeight / 2, depth / 2 - parapetThickness / 2);
      group.add(pNorth);

      const pSouth = new THREE.Mesh(pNorthGeom, parapetMat);
      pSouth.position.set(0, totalBuildingHeight + parapetHeight / 2, -depth / 2 + parapetThickness / 2);
      group.add(pSouth);

      const pEastGeom = new THREE.BoxGeometry(parapetThickness, parapetHeight, depth - parapetThickness * 2);
      const pEast = new THREE.Mesh(pEastGeom, parapetMat);
      pEast.position.set(width / 2 - parapetThickness / 2, totalBuildingHeight + parapetHeight / 2, 0);
      group.add(pEast);

      const pWest = new THREE.Mesh(pEastGeom, parapetMat);
      pWest.position.set(-width / 2 + parapetThickness / 2, totalBuildingHeight + parapetHeight / 2, 0);
      group.add(pWest);

      // Rooftop AC / Elevator utility room
      const utilityGeom = new THREE.BoxGeometry(width * 0.4, 0.8, depth * 0.4);
      const utilityMesh = new THREE.Mesh(utilityGeom, bodyMat);
      utilityMesh.position.set(0, totalBuildingHeight + 0.4, 0);
      group.add(utilityMesh);
    }

    // Communication Antenna
    if (withAntenna) {
      const mastGeom = new THREE.CylinderGeometry(0.04, 0.1, 2.2, 8);
      const mastMat = this._createMaterial({ color: 0x95a5a6, roughness: 0.2, metalness: 0.9 });
      const mastMesh = new THREE.Mesh(mastGeom, mastMat);
      mastMesh.position.set(0, totalBuildingHeight + (roofType === 'terrace' ? 0.8 + 1.1 : 1.1), 0);
      group.add(mastMesh);

      // Blinking red beacon light at top
      const beaconGeom = new THREE.SphereGeometry(0.08, 12, 12);
      const beaconMat = this._createMaterial({
        color: 0xff0000,
        emissive: 0xff0000,
        emissiveIntensity: 2.0
      });
      const beacon = new THREE.Mesh(beaconGeom, beaconMat);
      beacon.position.set(0, mastMesh.position.y + 1.1, 0);
      group.add(beacon);
    }

    return this._register(group, name);
  }

  /**
   * Create a procedural natural tree (lowpoly or lush evergreen/deciduous)
   */
  createTree({
    x = 0, y = 0, z = 0,
    trunkHeight = 2.4,
    trunkRadius = 0.22,
    foliageRadius = 1.3,
    foliageColor = 0x27ae60,
    trunkColor = 0x795548,
    style = 'lowpoly', // 'lowpoly' (tiered cones) or 'lush' (spheres)
    name = 'Tree'
  } = {}) {
    const THREE = this.THREE;
    const group = new THREE.Group();
    group.name = name;
    group.position.set(x, y, z);

    // Reuse shared tree materials by color/style key to prevent N duplicate materials on forests
    if (!this._treeMatCache) this._treeMatCache = new Map();
    const getTreeMat = (key, opts) => {
      let m = this._treeMatCache.get(key);
      if (!m) {
        m = this._createMaterial(opts);
        m.name = key;
        this._treeMatCache.set(key, m);
      }
      return m;
    };

    const trunkHex = this._parseColor(trunkColor, 0x795548).getHexString();
    const foliageHex = this._parseColor(foliageColor, 0x27ae60).getHexString();
    const trunkMat = getTreeMat(`Tree_Trunk_${trunkHex}`, { color: trunkColor, roughness: 0.85, metalness: 0.05 });
    const trunkGeom = new THREE.CylinderGeometry(trunkRadius * 0.7, trunkRadius, trunkHeight, 8);
    const trunkMesh = new THREE.Mesh(trunkGeom, trunkMat);
    trunkMesh.position.y = trunkHeight / 2;
    group.add(trunkMesh);

    const foliageMat = getTreeMat(`Tree_Foliage_${style}_${foliageHex}`, {
      color: foliageColor,
      roughness: 0.6,
      metalness: 0.0,
      flatShading: style === 'lowpoly'
    });

    if (style === 'lowpoly') {
      const foliageParts = [];
      const tiers = 3;
      for (let t = 0; t < tiers; t++) {
        const tierScale = 1 - t * 0.22;
        foliageParts.push({
          geometry: new THREE.ConeGeometry(foliageRadius * tierScale, trunkHeight * 0.7, 7),
          x: 0,
          y: trunkHeight * 0.65 + t * (trunkHeight * 0.38),
          z: 0,
        });
      }
      const mergedFoliage = mergePartGeometries(foliageParts, {}, THREE);
      foliageParts.forEach((p) => p.geometry.dispose());
      group.add(new THREE.Mesh(mergedFoliage, foliageMat));
    } else {
      const foliageCenterY = trunkHeight + foliageRadius * 0.4;
      const foliageParts = [
        { geometry: new THREE.SphereGeometry(foliageRadius, 12, 10), x: 0, y: foliageCenterY, z: 0 },
      ];
      const clusterOffsets = [
        [foliageRadius * 0.5, 0.1, 0, 0.7],
        [-foliageRadius * 0.45, -0.15, 0.2, 0.65],
        [0, 0.3, foliageRadius * 0.5, 0.6],
        [0.2, -0.1, -foliageRadius * 0.45, 0.7]
      ];
      clusterOffsets.forEach(([ox, oy, oz, scale]) => {
        foliageParts.push({
          geometry: new THREE.SphereGeometry(foliageRadius * scale, 10, 8),
          x: ox,
          y: foliageCenterY + oy,
          z: oz,
        });
      });
      const mergedFoliage = mergePartGeometries(foliageParts, {}, THREE);
      foliageParts.forEach((p) => p.geometry.dispose());
      group.add(new THREE.Mesh(mergedFoliage, foliageMat));
    }

    return this._register(group, name);
  }

  // ==========================================
  // ARRAY & DUPLICATION OPERATORS
  // ==========================================

  /**
   * Radial Array: Duplicates target mesh/group in a circle
   */
  repeatRadial(target, count = 8, radius = 4, { yOffset = 0, rotateWithRadius = true, name = 'RadialArray' } = {}) {
    const THREE = this.THREE;
    const group = new THREE.Group();
    group.name = name;

    const angleStep = (Math.PI * 2) / count;

    for (let i = 0; i < count; i++) {
      const angle = i * angleStep;
      let clone;

      if (typeof target === 'function') {
        clone = target(i, count);
      } else {
        clone = target.clone(true);
      }

      clone.position.x = Math.cos(angle) * radius;
      clone.position.z = Math.sin(angle) * radius;
      clone.position.y += i * yOffset;

      if (rotateWithRadius) {
        clone.rotation.y = -angle + Math.PI / 2;
      }

      group.add(clone);
    }

    return this._register(group, name);
  }

  /**
   * Grid Array: Duplicates target mesh/group across an X/Z grid
   */
  repeatGrid(target, countX = 4, countZ = 4, spacing = 2, { spacingX = null, spacingZ = null, center = true, name = 'GridArray' } = {}) {
    const THREE = this.THREE;
    const group = new THREE.Group();
    group.name = name;

    const spX = spacingX !== null ? spacingX : spacing;
    const spZ = spacingZ !== null ? spacingZ : spacing;

    const offsetX = center ? -((countX - 1) * spX) / 2 : 0;
    const offsetZ = center ? -((countZ - 1) * spZ) / 2 : 0;

    for (let ix = 0; ix < countX; ix++) {
      for (let iz = 0; iz < countZ; iz++) {
        let clone;
        if (typeof target === 'function') {
          clone = target(ix, iz, countX, countZ);
        } else {
          clone = target.clone(true);
        }

        clone.position.x += offsetX + ix * spX;
        clone.position.z += offsetZ + iz * spZ;

        group.add(clone);
      }
    }

    return this._register(group, name);
  }

  // ==========================================
  // ANIMATION SYSTEM
  // ==========================================

  /**
   * Register a frame animation callback
   * @param {THREE.Object3D|null} mesh - Optional target object (passed to callback)
   * @param {Function} callback - (time, deltaTime, mesh) => void
   */
  animate(mesh, callback) {
    if (typeof mesh === 'function' && !callback) {
      callback = mesh;
      mesh = null;
    }
    const entry = { mesh, callback };
    this._animationCallbacks.push(entry);
    // QUAN TRỌNG: nếu engine render loop đang chạy (isRunning=true), đăng ký
    // callback qua engine.addRenderCallback thay vì RAF riêng — RAF riêng bị
    // engine loop "đè" (engine render mỗi frame rồi mới tới RAF này, sai nhịp
    // và gây nhảy/không mượt). RAF riêng chỉ dùng khi engine không chạy.
    if (typeof window !== 'undefined' && window.engine && typeof window.engine.addRenderCallback === 'function') {
      if (!this._engineCallbacks) this._engineCallbacks = [];
      const engineCb = (delta) => {
        for (let i = 0; i < this._animationCallbacks.length; i++) {
          const item = this._animationCallbacks[i];
          try {
            item.callback(this._engineClock?.getElapsedTime() || 0, delta || 0.016, item.mesh);
          } catch (err) {
            console.warn('[RapidStudio Animation Error]:', err);
          }
        }
      };
      // Tránh đăng ký trùng: gỡ callback cũ rồi thêm mới
      while (this._engineCallbacks.length) {
        const prev = this._engineCallbacks.pop();
        try { prev(); } catch (_) {}
      }
      this._engineCallbacks.push(window.engine.addRenderCallback(engineCb));
      this._isAnimating = true;
      if (!this._engineClock) this._engineClock = new (this.THREE).Clock();
      this._engineClock.start();
      return () => {
        const idx = this._animationCallbacks.indexOf(entry);
        if (idx !== -1) this._animationCallbacks.splice(idx, 1);
      };
    }
    // Engine chưa sẵn sàng: fallback RAF ticker cũ
    this._startAnimationTicker();
    return () => {
      const idx = this._animationCallbacks.indexOf(entry);
      if (idx !== -1) this._animationCallbacks.splice(idx, 1);
    };
  }

  /**
   * Load standard human asset with skeleton and animation
   * @param {string} [clipName='Walk'] - 'Walk', 'Run', 'Idle', 'TPose'
   * @param {boolean} [showSkeleton=true] - Display X-Ray skeleton bone helper
   */
  async loadHumanWithAnimation(clipName = 'Walk', showSkeleton = true, options = {}) {
    // Support both positional (clipName, showSkeleton, options) and object ({ animation, clipName, showSkeleton, showBones, x, y, z, url }) overloads
    let resolvedClip = clipName;
    let resolvedShowSkeleton = showSkeleton;
    let resolvedOptions = options;
    if (clipName && typeof clipName === 'object') {
      resolvedOptions = clipName;
      resolvedClip = clipName.animation || clipName.clipName || 'Walk';
      resolvedShowSkeleton = clipName.showSkeleton ?? clipName.showBones ?? true;
    }
    if (resolvedOptions?.clearScene !== false) this.clearScene();
    const exp = (typeof window !== 'undefined' ? window.exporter : null) || this._exporter;
    if (!exp) throw new Error('Exporter module required');
    const normClip = String(resolvedClip || 'Walk').toLowerCase();
    const candidates = resolvedOptions?.url
      ? [resolvedOptions.url]
      : (normClip.includes('idle')
          ? ['/models/Mannequin_CC0.glb', '/models/Bot_CC0.glb']
          : ['/models/Bot_CC0.glb', '/models/Mannequin_CC0.glb']);
    let model = null;
    let lastErr = null;
    for (const url of candidates) {
      try {
        model = await exp.importGLTF(url);
        if (model) break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!model) throw lastErr || new Error('Failed to load CC0 character model.');
    if (resolvedOptions && (resolvedOptions.x !== undefined || resolvedOptions.y !== undefined || resolvedOptions.z !== undefined)) {
      model.position.set(Number(resolvedOptions.x) || 0, Number(resolvedOptions.y) || 0, Number(resolvedOptions.z) || 0);
    }

    const eng = this._engine || (typeof window !== 'undefined' ? (window.engine || window.studioEngine) : null);
    if (eng?.camera && eng?.controls) {
      eng.camera.position.set(1.8, 1.4, 2.2);
      eng.controls.target.set(0, 1.0, 0);
      eng.camera.lookAt(0, 1.0, 0);
      eng.controls.update();
      if (eng.transformControls) {
        eng.transformControls.detach();
        eng.transformControls.visible = false;
      }
    }

    if (resolvedShowSkeleton) {
      this.showSkeletonHelper(model);
    }

    this.playCharacterAnimation(model, resolvedClip);
    return model;
  }

  showSkeletonHelper(model, visible = true) {
    const THREE = this.THREE;
    if (this._currentSkeletonHelper) {
      if (this._currentSkeletonHelper.parent) {
        this._currentSkeletonHelper.parent.remove(this._currentSkeletonHelper);
      }
      this._currentSkeletonHelper = null;
    }
    if (!visible || !model) return;

    const helper = new THREE.SkeletonHelper(model);
    helper.material.linewidth = 3;
    helper.material.depthTest = false;
    helper.material.transparent = true;
    helper.material.opacity = 0.95;
    helper.renderOrder = 999;
    helper.userData.isSystemObject = true;
    helper.userData.isSkeletonHelper = true;
    helper.userData.targetRoot = model;
    helper.userData.selectable = false;
    const sm = this._sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    helper.visible = (sm && typeof sm._isNodeEffectivelyVisible === 'function')
      ? sm._isNodeEffectivelyVisible(model)
      : model.visible !== false;
    this.scene.add(helper);
    this._currentSkeletonHelper = helper;
  }

  playCharacterAnimation(model, clipName = 'Walk') {
    if (!model || !model.animations || model.animations.length === 0) return null;
    const req = String(clipName || 'Walk').toLowerCase();
    let clip = model.animations.find(a => a.name.toLowerCase() === req)
      || (req.includes('idle') ? model.animations.find(a => /idle/i.test(a.name)) : null)
      || (req.includes('run') ? model.animations.find(a => /walk|run/i.test(a.name)) : null)
      || model.animations[0];

    const eng = this._engine || (typeof window !== 'undefined' ? (window.engine || window.studioEngine) : null);
    if (!this._characterMixer || this._characterMixerRoot !== model) {
      this._characterMixer = new this.THREE.AnimationMixer(model);
      this._characterMixerRoot = model;
      if (!this._mixerCallbackRegistered && eng && typeof eng.addRenderCallback === 'function') {
        eng.addRenderCallback((delta) => {
          if (this._characterMixer) {
            this._characterMixer.update(delta);
            if (this._currentSkeletonHelper) {
              let cur = this._currentSkeletonHelper.root || this._currentSkeletonHelper.userData?.targetRoot;
              let inScene = false;
              while (cur) {
                if (cur === this.scene) { inScene = true; break; }
                cur = cur.parent;
              }
              if (!inScene) {
                if (this._currentSkeletonHelper.parent) {
                  this._currentSkeletonHelper.parent.remove(this._currentSkeletonHelper);
                }
                this._currentSkeletonHelper = null;
              } else if (this._currentSkeletonHelper.update) {
                this._currentSkeletonHelper.update();
              }
            }
          }
        });
        this._mixerCallbackRegistered = true;
      }
    }

    if (this._currentAction) {
      this._currentAction.fadeOut(0.25);
    }
    const action = this._characterMixer.clipAction(clip);
    action.reset().fadeIn(0.25).play();
    this._currentAction = action;
    return action;
  }

  /**
   * Internal animation tick processor
   */
  _startAnimationTicker() {
    if (this._isAnimating) return;
    this._isAnimating = true;

    const THREE = this.THREE;
    if (!this._clock) {
      this._clock = new THREE.Clock();
    } else {
      this._clock.start();
    }

    const tick = () => {
      if (!this._isAnimating) return;
      const delta = this._clock.getDelta();
      const time = this._clock.getElapsedTime();

      for (let i = 0; i < this._animationCallbacks.length; i++) {
        const item = this._animationCallbacks[i];
        try {
          item.callback(time, delta, item.mesh);
        } catch (err) {
          console.warn("[RapidStudio Animation Error]:", err);
        }
      }

      this._animationFrameId = requestAnimationFrame(tick);
    };

    this._animationFrameId = requestAnimationFrame(tick);
  }

  /**
   * Stop all active script animations
   */
  stopAnimations() {
    this._isAnimating = false;
    if (this._animationFrameId) {
      cancelAnimationFrame(this._animationFrameId);
      this._animationFrameId = null;
    }
    // Gỡ các callback đã đăng ký vào engine render loop
    if (this._engineCallbacks) {
      while (this._engineCallbacks.length) {
        const unreg = this._engineCallbacks.pop();
        try { unreg(); } catch (_) {}
      }
    }
    this._animationCallbacks = [];
    if (this._clock) this._clock.stop();
    if (this._engineClock) this._engineClock.stop();
  }

  // ==========================================
  // SCENE CLEANUP & UTILITIES
  // ==========================================

  /**
   * Clear all objects created by this rapid DSL session and completely clean the scene
   */
  clearScene({ disposeMaterials = true } = {}) {
    this.stopAnimations();
    try {
      if (typeof window !== 'undefined') {
        if (window.editMode?.isActive) window.editMode.exit();
        if (window.sculptMode?.isActive) window.sculptMode.exit();
      }
    } catch (_) {}

    const sm = this._sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    if (sm && typeof sm.clearScene === 'function') {
      sm.clearScene();
    } else {
      this._createdObjects.forEach((obj) => {
        if (sm && typeof sm.removeObject === 'function' && obj.userData && sm.objects.has(obj.userData.id)) {
          sm.removeObject(obj, false, true);
        } else if (sm && typeof sm.deepDisposeObject === 'function') {
          sm.deepDisposeObject(obj);
        } else if (obj.parent) {
          obj.parent.remove(obj);
        }
      });
    }

    this._createdObjects.clear();
    this._treeMatCache?.clear?.();
    this._procTexClient?.clearCache?.({ force: true });
    try {
      const eng = this._engine || (typeof window !== 'undefined' ? (window.engine || window.studioEngine) : null);
      eng?.renderer?.renderLists?.dispose?.();
    } catch (_) {}
    this.log('✓ Cleared entire Scene and freed 100% resources (No Orphans)', 'success');
    return this;
  }

  /**
   * Helper to set mesh color conveniently
   */
  setColor(mesh, color) {
    const parsed = this._parseColor(color);
    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.color.copy(parsed));
      } else {
        mesh.material.color.copy(parsed);
      }
    }
    return mesh;
  }

  /**
   * Helper to set mesh emissive color & intensity
   */
  setEmissive(mesh, color, intensity = 1.0) {
    const parsed = this._parseColor(color);
    if (mesh.material) {
      const setMat = (m) => {
        if (m.emissive) {
          m.emissive.copy(parsed);
          m.emissiveIntensity = intensity;
        }
      };
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(setMat);
      } else {
        setMat(mesh.material);
      }
    }
    return mesh;
  }

  /**
   * Get list of currently tracked objects
   */
  getCreatedObjects() {
    return Array.from(this._createdObjects);
  }

  // ==========================================
  // SHADING & ENVIRONMENT DSL HELPERS
  // ==========================================
  /**
   * Applies MatCap shading style to scene or object
   * @param {string} [style='red-wax'] 'red-wax' | 'chrome' | 'clay' | 'ceramic' | 'normal' | 'toon' | 'pearl' | 'obsidian'
   */
  setShadingMode(mode = 'solid') {
    if (typeof window !== 'undefined') {
      const app = window.blenderApp || window.app;
      if (app && typeof app.setShadingMode === 'function') {
        const ok = app.setShadingMode(mode);
        if (ok) this.log('Viewport shading mode set to: ' + mode, 'info');
        return ok;
      }
      if (window.shadingPopover && typeof window.shadingPopover.setMode === 'function') {
        window.shadingPopover.setMode(mode);
        this.log('Viewport shading mode set to: ' + mode, 'info');
        return true;
      }
    }
    return false;
  }

  setMatCap(style = 'red-wax') {
    if (typeof window !== 'undefined' && window.matcapStudio) {
      window.matcapStudio.toggleMatCapMode(true, style);
      this.log(`Applied MatCap style: ${style}`, 'success');
      return true;
    }
    return false;
  }

  /**
   * Restores original standard/PBR materials
   */
  restoreMaterials() {
    if (typeof window !== 'undefined' && window.matcapStudio) {
      window.matcapStudio.toggleMatCapMode(false);
      this.log('Restored standard materials', 'info');
      return true;
    }
    return false;
  }

  /**
   * Toggles curved photography studio cyclorama backdrop
   * @param {boolean} [enabled=true]
   * @param {string} [color='#2b2d30']
   */
  setStudioBackdrop(enabled = true, color = '#2b2d30') {
    if (typeof window !== 'undefined' && window.environmentStudio) {
      window.environmentStudio.enableBackdrop(enabled, color);
      this.log(`Studio Cyclorama: ${enabled ? 'Enabled (' + color + ')' : 'Disabled'}`, 'info');
      return true;
    }
    return false;
  }

  /**
   * Toggles volumetric atmospheric fog
   * @param {boolean} [enabled=true]
   * @param {string} [preset='studio'] 'studio' | 'day' | 'sunset' | 'cyberpunk' | 'dense-mist'
   */
  setAtmosphericFog(enabled = true, preset = 'studio') {
    if (typeof window !== 'undefined' && window.environmentStudio) {
      window.environmentStudio.enableFog(enabled);
      if (preset) window.environmentStudio.setFogPreset(preset);
      this.log(`Atmospheric Fog: ${enabled ? 'Enabled (' + preset + ')' : 'Disabled'}`, 'info');
      return true;
    }
    return false;
  }

  /**
   * Toggles dynamic procedural sky dome and syncs sun lighting
   * @param {boolean} [enabled=true]
   * @param {number} [elevation=35]
   * @param {number} [azimuth=180]
   */
  setSkyDome(enabled = true, elevation = 35, azimuth = 180) {
    if (typeof window !== 'undefined' && window.environmentStudio) {
      window.environmentStudio.enableSky(enabled, { elevation, azimuth });
      this.log(`Sky Dome: ${enabled ? 'Enabled (' + elevation + '° elev)' : 'Disabled'}`, 'info');
      return true;
    }
    return false;
  }

  /**
   * Sets up a professional Blender Look-Dev Studio with AgX Color Transform,
   * 3-Point Photography Lighting with Kelvin Temperature Contrast, and a Curved Cyclorama Backdrop.
   * @param {Object} [options]
   * @param {string} [options.backdropColor='#1e2024']
   * @param {boolean} [options.withTurntable=false]
   * @param {string} [options.hdri='studio-softbox']
   */
  setupProStudio(options = {}) {
    const {
      backdropColor = '#c9ccd1',
      withBackdrop = false,
      withTurntable = false,
      hdri = 'studio-softbox'
    } = options;

    // 1. Cyclorama wall is opt-in only: a big dark wall hides the scene when orbiting.
    if (withBackdrop) this.setStudioBackdrop(true, backdropColor);

    // 2. Set HDRI Softbox
    if (hdri && typeof window !== 'undefined' && window.environmentStudio) {
      window.environmentStudio.enableHdri(true, { preset: hdri, intensity: 1.0, blur: 0.15 });
    }

    // 3. Set AgX Color Management
    if (typeof window !== 'undefined' && window.studioEngine && typeof window.studioEngine.setToneMapping === 'function') {
      window.studioEngine.setToneMapping('agx', 1.0);
    }

    // 4. Optional Turntable
    if (withTurntable) {
      this.setTurntable(true);
    }

    // 5. clearScene() removes cameras; a look-dev studio without a camera
    // cannot render, so guarantee one exists.
    const cm = typeof window !== 'undefined' ? window.cameraManager : null;
    if (cm && typeof cm.getActiveCameraObject === 'function' && !cm.getActiveCameraObject()) {
      this.addCamera({ name: 'Camera' });
    }

    this.log('Professional Blender Look-Dev Studio (AgX + 3-Point + Cyc Backdrop) active!', 'success');
    return true;
  }

  // ==========================================
  // TIMELINE & KEYFRAME ANIMATION DSL HELPERS
  // ==========================================
  /**
   * Inserts a keyframe on an object (or currently active object)
   * @param {THREE.Object3D} [object]
   * @param {number} [frame]
   * @param {Array<string>} [channels=['position','rotation','scale']]
   * @param {'smooth'|'linear'|'easeInOut'} [interp='smooth']
   */
  insertKeyframe(object = null, frame = null, channels = ['position', 'rotation', 'scale'], interp = 'smooth') {
    if (typeof window !== 'undefined' && window.timelineEngine) {
      const target = object || (window.sceneManager ? window.sceneManager.getActiveObject() : null);
      const f = frame !== null ? frame : window.timelineEngine.currentFrame;
      const kf = window.timelineEngine.insertKeyframe(target, f, channels, interp);
      this.log(`Inserted Keyframe at frame ${f} for ${target ? target.name : 'Active'}`, 'success');
      return kf;
    }
    return null;
  }

  /**
   * Deletes a keyframe on an object
   * @param {THREE.Object3D} [object]
   * @param {number} [frame]
   */
  deleteKeyframe(object = null, frame = null) {
    if (typeof window !== 'undefined' && window.timelineEngine) {
      const target = object || (window.sceneManager ? window.sceneManager.getActiveObject() : null);
      const f = frame !== null ? frame : window.timelineEngine.currentFrame;
      const res = window.timelineEngine.deleteKeyframe(target, f);
      this.log(`Deleted Keyframe at frame ${f}`, 'info');
      return res;
    }
    return false;
  }

  /**
   * Controls timeline playback
   */
  playAnimation() {
    if (typeof window !== 'undefined' && window.timelineEngine) {
      window.timelineEngine.play();
      this.log('Timeline: Playing', 'info');
    }
  }

  pauseAnimation() {
    if (typeof window !== 'undefined' && window.timelineEngine) {
      window.timelineEngine.pause();
      this.log('Timeline: Paused', 'info');
    }
  }

  seekFrame(frame) {
    if (typeof window !== 'undefined' && window.timelineEngine) {
      window.timelineEngine.seekToFrame(frame);
      this.log(`Timeline: Seek to frame ${frame}`, 'info');
    }
  }

  /**
   * Inserts a keyframe on a specific bone of an Armature or SkinnedMesh
   */
  insertBoneKeyframe(armatureOrMesh = null, boneNameOrBone = null, frame = null, channels = ['rotation'], interp = 'smooth') {
    if (typeof window !== 'undefined' && window.timelineEngine) {
      const f = frame !== null ? frame : window.timelineEngine.currentFrame;
      const kf = window.timelineEngine.insertBoneKeyframe(armatureOrMesh, boneNameOrBone, f, channels, interp);
      this.log(`Inserted Bone Keyframe at frame ${f}`, 'success');
      return kf;
    }
    return null;
  }

  /**
   * Inserts keyframes for all bones of an Armature or SkinnedMesh at the current frame
   */
  insertAllBonesKeyframe(armatureOrMesh = null, frame = null, channels = ['rotation'], interp = 'smooth') {
    if (typeof window !== 'undefined' && window.timelineEngine) {
      const f = frame !== null ? frame : window.timelineEngine.currentFrame;
      const kfs = window.timelineEngine.insertAllBonesKeyframe(armatureOrMesh, f, channels, interp);
      this.log(`Inserted All Bones Keyframes (${kfs.length} bones) at frame ${f}`, 'success');
      return kfs;
    }
    return [];
  }

  /**
   * Applies a built-in skeletal motion preset to an armature or character
   * @param {THREE.Object3D} [armatureOrMesh]
   * @param {'walk_cycle'|'combat_slash'|'wave_hand'} [presetKey='walk_cycle']
   */
  applyMotionPreset(armatureOrMesh = null, presetKey = 'walk_cycle') {
    if (typeof window !== 'undefined' && window.timelineEngine) {
      const ok = window.timelineEngine.applyMotionPreset(armatureOrMesh, presetKey);
      if (ok) {
        this.log(`Applied Skeletal Motion Preset [${presetKey}]`, 'success');
      }
      return ok;
    }
    return false;
  }

  /**
   * Sets Timeline FPS (e.g. 24, 30, 60)
   */
  setFPS(fps = 30) {
    if (typeof window !== 'undefined' && window.timelineEngine) {
      window.timelineEngine.setFPS(fps);
      this.log(`Timeline FPS set to ${fps}`, 'info');
    }
  }

  /**
   * Toggles Turntable 360 camera showcase
   * @param {boolean} [active]
   * @param {THREE.Object3D} [target]
   */
  setTurntable(active = true, target = null) {
    if (typeof window !== 'undefined' && window.timelineEngine) {
      if (active) {
        window.timelineEngine.startTurntable(target);
        // CẢNH BÁO QUAN TRỌNG: Turntable chiếm quyền điều khiển camera (ghi đè
        // position each frame). Users cannot orbit/zoom manually while enabled.
        this.log('⚠️ Turntable is ON: camera orbits around the target object automatically. Disable via "studio.setTurntable(false)" or the ⏹ Turntable button on Timeline to regain mouse control.', 'warn');
      } else {
        window.timelineEngine.stopTurntable();
      }
      this.log(`Turntable 360: ${active ? 'Enabled' : 'Disabled'}`, 'info');
      return true;
    }
    return false;
  }

  // ==========================================
  // EXTERNAL MODEL LOADERS & REALISTIC ASSETS
  // ==========================================

  /**
   * Load an external GLTF/GLB model into the Studio scene
   */
  async loadGLTF(url, {
    x = 0, y = 0, z = 0,
    scale = 1.0,
    rotationX = 0, rotationY = 0, rotationZ = 0,
    name = 'Imported_Model',
    castShadow = true,
    receiveShadow = true
  } = {}) {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const resolvedUrl = resolveCdnAssetUrl(url);
    return new Promise((resolve, reject) => {
      loader.load(
        resolvedUrl,
        (gltf) => {
          const root = gltf.scene || gltf.scenes[0];
          root.name = name;
          root.animations = Array.isArray(gltf.animations) ? gltf.animations.slice() : [];
          root.userData.animations = root.animations;
          root.position.set(x, y, z);
          if (typeof scale === 'number') {
            root.scale.set(scale, scale, scale);
          } else if (Array.isArray(scale)) {
            root.scale.set(scale[0], scale[1], scale[2]);
          }
          root.rotation.set(rotationX, rotationY, rotationZ);
          root.traverse((child) => {
            if (child.isMesh) {
              child.castShadow = castShadow;
              child.receiveShadow = receiveShadow;
              if (child.material) {
                child.material.side = this.THREE.DoubleSide;
              }
            }
          });
          this._register(root, name);
          resolve(root);
        },
        undefined,
        (err) => {
          console.error('Failed to load GLTF model:', err);
          reject(err);
        }
      );
    });
  }

  /**
   * Create a true realistic human character with full anatomical topology, PBR skin & materials
   */
  async createRealisticHuman({
    type = 'female', // 'female' | 'mannequin' | 'bot' | 'head_scan'
    x = 0, y = 0, z = 0,
    scale = 1.0,
    name = 'Realistic_Human'
  } = {}) {
    if (type === 'female' || type === 'mannequin') {
      const model = await this.loadGLTF('/models/Mannequin_CC0.glb', {
        x, y, z,
        scale: 1.0 * scale, // Mannequin_CC0 is natively 1.66m in height
        name
      });
      return model;
    } else if (type === 'bot' || type === 'male' || type === 'soldier') {
      const model = await this.loadGLTF('/models/Bot_CC0.glb', {
        x, y, z,
        scale: 1.0 * scale,
        name
      });
      return model;
    } else if (type === 'head_scan') {
      const model = await this.loadGLTF('/models/LeePerrySmith.glb', {
        x, y: y + 1.2, z,
        scale: 0.12 * scale,
        name: 'Realistic_Human_Head_Scan'
      });
      return model;
    }
  }

  // ==========================================
  // RIGGING & SKELETON ARMATURE METHODS
  // ==========================================

  /**
   * Create and register a standard Humanoid Skeleton Armature
   */
  createHumanoidArmature({ height = 1.8, x = 0, y = 0, z = 0, name = 'Humanoid_Armature' } = {}) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      const res = window.rigSystem.createHumanoidArmature(height, { addToScene: false });
      res.armatureGroup.position.set(x, y, z);
      this._register(res.armatureGroup, name);
      window.rigSystem.createSkeletonVisualizer(res.skeleton, res.armatureGroup);
      return res;
    }
    return null;
  }

  /**
   * Create a skeleton armature from any multi-asset template:
   * 'humanoid_standard', 'humanoid_pro', 'quadruped', 'bird', 'fish', 'serpent', 'arachnid', 'vehicle'.
   */
  createSkeletonTemplate(templateId = 'humanoid_pro', { size, height, pose = 't-pose', x = 0, y = 0, z = 0, name } = {}) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      const res = window.rigSystem.createSkeletonFromTemplate(templateId, {
        size: size ?? height,
        pose,
        addToScene: false,
        name,
      });
      res.armatureGroup.position.set(x, y, z);
      this._register(res.armatureGroup, res.armatureGroup.name);
      window.rigSystem.createSkeletonVisualizer(res.skeleton, res.armatureGroup);
      return res;
    }
    return null;
  }

  /**
   * Automatically fit & bind a skeleton to any static mesh or multi-mesh character Group.
   */
  autoRigCharacter(target, options = {}) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.autoRigCharacter(target, options);
    }
    return null;
  }

  /**
   * Create and register a fully articulated Anatomical Mannequin (ready for posing)
   */
  createRiggedMannequin({ height = 1.8, skinned = true, x = 0, y = 0, z = 0, name = 'Articulated_Mannequin' } = {}) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      const res = window.rigSystem.createRiggedMannequin(height, { skinned });
      res.armatureGroup.position.set(x, y, z);
      this._register(res.armatureGroup, name);
      window.rigSystem.createSkeletonVisualizer(res.skeleton, res.armatureGroup);
      return res.armatureGroup;
    }
    return null;
  }

  /**
   * Automatically bind any mesh geometry to a skeleton with bone weights (Auto-Skinning)
   */
  autoSkinMesh(mesh, armatureOrSkeleton = null) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.autoSkinMesh(mesh, armatureOrSkeleton);
    }
    return null;
  }

  autoSkin(mesh, armatureOrSkeleton = null) {
    return this.autoSkinMesh(mesh, armatureOrSkeleton);
  }

  /**
   * Apply a pose preset (14+ presets available)
   */
  setPose(characterOrSkeleton, poseKey) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.applyPose(characterOrSkeleton, poseKey);
    }
    return false;
  }

  /**
   * Reset all bones or a specific bone to rest bind pose
   */
  resetPose(characterOrSkeleton = null, boneName = null) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.resetPose(characterOrSkeleton, boneName);
    }
    return false;
  }

  /**
   * Mirror pose symmetrically between Left and Right limbs
   */
  mirrorPose(characterOrSkeleton = null, direction = 'left_to_right') {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.mirrorPose(characterOrSkeleton, direction);
    }
    return false;
  }

  /**
   * Save current character posture as a custom pose preset
   */
  savePose(name, characterOrSkeleton = null) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.saveCustomPose(name, characterOrSkeleton);
    }
    return null;
  }

  /**
   * Toggle Pose Mode (enables bone selection & rotation Gizmo)
   */
  setPoseMode(enabled, character = null) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.setPoseMode(enabled, character);
    }
    return false;
  }

  /**
   * Toggle Two-Bone IK (Inverse Kinematics) system and interactive handles
   */
  setIKEnabled(enabled, character = null) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      if (character) window.rigSystem.activeCharacter = character;
      return window.rigSystem.setIKEnabled(enabled);
    }
    return false;
  }

  /**
   * Toggle Weight Paint visualization mode (Blender Heatmap)
   */
  toggleWeightPaint(character = null) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.toggleWeightPaintMode(character);
    }
    return false;
  }

  cleanWeights(mesh = null, threshold = 0.01, maxInfluences = 4) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.cleanWeights(mesh, threshold, maxInfluences);
    }
    return { cleanedVertices: 0, removedSlots: 0 };
  }

  transferWeights(sourceMesh, targetMesh, options = {}) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.transferWeights(sourceMesh, targetMesh, options);
    }
    return null;
  }

  addBoneConstraint(boneOrName, config = {}) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.addBoneConstraint(boneOrName, config);
    }
    return null;
  }

  applyHumanoidLimits(characterOrSkeleton = null) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.applyHumanoidJointLimits(characterOrSkeleton);
    }
    return 0;
  }

  keyframePose(target = null, boneOrAll = 'all', options = {}) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.keyframePoseToTimeline(target, boneOrAll, options);
    }
    return { frame: 0, count: 0, boneNames: [], tracks: 0 };
  }

  bakeRig(options = {}) {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.bakeRigToClip(options);
    }
    return null;
  }

  setBoneDisplayMode(mode = 'octahedral') {
    if (typeof window !== 'undefined' && window.rigSystem) {
      return window.rigSystem.setBoneDisplayMode(mode);
    }
    return mode;
  }

  // ==========================================
  // PBR MATERIAL STUDIO METHODS
  // ==========================================

  /**
   * Apply a production-grade PBR material preset to a target mesh or group
   */
  applyMaterialPreset(target, presetKey) {
    if (typeof window !== 'undefined' && window.materialStudio) {
      return window.materialStudio.applyPreset(target, presetKey);
    }
    return null;
  }

  // ==========================================
  // BLENDER EDIT MODE & MESH MODELING DSL
  // ==========================================

  /**
   * Enters Edit Mode on the active or specified Mesh
   */
  enterEditMode(mesh = null) {
    const editMode = (typeof window !== 'undefined') ? window.editMode : null;
    if (!editMode) return false;
    const target = mesh || (window.sceneManager ? window.sceneManager.getActiveObject() : null);
    if (target && target.isMesh) {
      return editMode.enter(target);
    }
    return false;
  }

  /**
   * Exits Edit Mode back to Object Mode
   */
  exitEditMode() {
    const editMode = (typeof window !== 'undefined') ? window.editMode : null;
    if (editMode && editMode.isActive) {
      editMode.exit();
      return true;
    }
    return false;
  }

  /**
   * Sets Edit Mode selection mode ('vertex' | 'edge' | 'face')
   */
  setEditSelectionMode(mode) {
    const editMode = (typeof window !== 'undefined') ? window.editMode : null;
    if (editMode) {
      editMode.setMode(mode);
      return true;
    }
    return false;
  }

  /**
   * Extrudes selected face(s) in Edit Mode
   */
  extrude(distance = 0.5) {
    const editMode = (typeof window !== 'undefined') ? window.editMode : null;
    if (editMode && editMode.isActive) {
      editMode.extrude(distance);
      return true;
    }
    return false;
  }

  /**
   * Insets selected face(s) towards centroid
   */
  inset(offset = 0.25) {
    const editMode = (typeof window !== 'undefined') ? window.editMode : null;
    if (editMode && editMode.isActive) {
      editMode.inset(offset);
      return true;
    }
    return false;
  }

  /**
   * Subdivides selected faces (or all faces)
   */
  subdivide() {
    const editMode = (typeof window !== 'undefined') ? window.editMode : null;
    if (editMode && editMode.isActive) {
      editMode.subdivide();
      return true;
    }
    return false;
  }

  /**
   * Bevels selected elements
   */
  bevel(width = 0.08) {
    const editMode = (typeof window !== 'undefined') ? window.editMode : null;
    if (editMode && editMode.isActive) {
      editMode.bevel(width);
      return true;
    }
    return false;
  }

  /**
   * Deletes selected elements in Edit Mode
   */
  deleteSelection() {
    const editMode = (typeof window !== 'undefined') ? window.editMode : null;
    if (editMode && editMode.isActive) {
      editMode.deleteSelection();
      return true;
    }
    return false;
  }

  /**
   * Creates a PBR Material from MaterialStudio presets (24 presets including interior, clothing, smartphone)
   */
  createPBRMaterial(presetId, overrides = {}) {
    const THREE = this.THREE;
    const resolvedId = resolvePBRPresetId(presetId) || presetId;
    const ms = (typeof window !== 'undefined') ? window.materialStudio : null;
    if (ms && typeof ms.getMaterialPresets === 'function') {
      try {
        const presets = ms.getMaterialPresets();
        const preset = presets && (presets[presetId] || presets[resolvedId]);
        const mat = preset && typeof preset.create === 'function' ? preset.create() : null;
        if (mat) {
          if (overrides.color !== undefined && mat.color) mat.color.set(overrides.color);
          if (overrides.roughness !== undefined) mat.roughness = overrides.roughness;
          if (overrides.metalness !== undefined) mat.metalness = overrides.metalness;
          if (overrides.emissive !== undefined && mat.emissive) mat.emissive.set(overrides.emissive);
          if (overrides.emissiveIntensity !== undefined) mat.emissiveIntensity = overrides.emissiveIntensity;
          mat.needsUpdate = true;
          return mat;
        }
      } catch (_) {}
    }
    return buildPBRPresetMaterial(THREE, presetId, overrides);
  }

  /**
   * General-purpose articulated 3D human character rig with expressive face (jaw/lip-sync, eyebrows, eyes),
   * upper/lower arms, hands, legs, and optional outer jacket layer.
   */
  createArticulatedActor({
    name = 'Actor',
    x = 0, y = 0, z = 0, rotY = 0,
    shirtColor = 0x2563eb,
    pantsColor = 0x1e3a5f,
    hairColor = 0x18181b,
    skinColor = 0xf1c29d,
    isFemale = false,
    hasJacketLayer = false,
    jacketColor = 0xd93829
  } = {}) {
    const THREE = this.THREE;
    const root = new THREE.Group();
    root.name = name;
    root.position.set(x, y, z);
    root.rotation.y = rotY;

    const skinMat = this.createPBRMaterial('skin', { color: skinColor, roughness: 0.52 });
    const shirtMat = this.createPBRMaterial('cotton_shirt_sale', { color: shirtColor, roughness: 0.72 });
    const pantsMat = this.createPBRMaterial('denim_jeans', { color: pantsColor, roughness: 0.82 });
    const hairMat = new THREE.MeshStandardMaterial({ color: hairColor, roughness: 0.78 });
    const shoeMat = this.createPBRMaterial('leather', { color: 0x1f2937, roughness: 0.45 });
    const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.1 });
    const mouthMat = new THREE.MeshStandardMaterial({ color: 0x881337, roughness: 0.6 });

    // Legs & Shoes
    const leftLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.76, 14), pantsMat);
    leftLeg.position.set(-0.11, 0.42, 0);
    leftLeg.castShadow = true;
    root.add(leftLeg);

    const rightLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.76, 14), pantsMat);
    rightLeg.position.set(0.11, 0.42, 0);
    rightLeg.castShadow = true;
    root.add(rightLeg);

    const leftShoe = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.24), shoeMat);
    leftShoe.position.set(-0.11, 0.045, 0.04);
    root.add(leftShoe);

    const rightShoe = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.09, 0.24), shoeMat);
    rightShoe.position.set(0.11, 0.045, 0.04);
    root.add(rightShoe);

    // Torso
    const torsoPivot = new THREE.Group();
    torsoPivot.position.set(0, 0.78, 0);
    root.add(torsoPivot);

    const torsoMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(isFemale ? 0.18 : 0.21, isFemale ? 0.16 : 0.18, 0.56, 16),
      shirtMat
    );
    torsoMesh.position.set(0, 0.28, 0);
    torsoMesh.scale.set(1.15, 1.0, 0.78);
    torsoMesh.castShadow = true;
    torsoPivot.add(torsoMesh);

    // Optional Outer Jacket Layer
    let jacketGroup = null;
    if (hasJacketLayer) {
      jacketGroup = new THREE.Group();
      jacketGroup.name = `${name}_Jacket`;
      const jacketMat = this.createPBRMaterial('cotton_shirt_sale', { color: jacketColor, roughness: 0.65 });
      const jacketShell = new THREE.Mesh(
        new THREE.CylinderGeometry(0.228, 0.198, 0.58, 16),
        jacketMat
      );
      jacketShell.position.set(0, 0.28, 0);
      jacketShell.scale.set(1.18, 1.0, 0.84);
      jacketShell.castShadow = true;
      jacketGroup.add(jacketShell);

      const collar = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.032, 10, 20), jacketMat);
      collar.rotation.x = Math.PI / 2;
      collar.position.set(0, 0.57, 0);
      jacketGroup.add(collar);

      jacketGroup.visible = false;
      torsoPivot.add(jacketGroup);
    }

    // Neck & Head
    const neckPivot = new THREE.Group();
    neckPivot.position.set(0, 0.58, 0);
    torsoPivot.add(neckPivot);

    const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.072, 0.12, 12), skinMat);
    neckMesh.position.set(0, 0.05, 0);
    neckPivot.add(neckMesh);

    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.21, 0);
    neckPivot.add(headGroup);

    const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.165, 24, 20), skinMat);
    headMesh.scale.set(0.95, 1.08, 0.98);
    headMesh.castShadow = true;
    headGroup.add(headMesh);

    // Hair (scaled slightly larger than headMesh and tilted back so hairline is smooth with zero z-fighting)
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.172, 24, 18, 0, Math.PI * 2, 0, Math.PI * 0.56), hairMat);
    hairCap.scale.set(0.99, 1.12, 1.03);
    hairCap.position.set(0, 0.028, -0.012);
    hairCap.rotation.x = -0.26;
    headGroup.add(hairCap);

    if (isFemale) {
      const ponytail = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.18, 8, 12), hairMat);
      ponytail.position.set(0, -0.04, -0.17);
      ponytail.rotation.x = 0.35;
      headGroup.add(ponytail);
    }

    // Eyes & Brows & Mouth
    const leftEye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 12, 10), eyeWhiteMat);
    leftEye.position.set(-0.055, 0.025, 0.148);
    headGroup.add(leftEye);
    const leftPupil = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), pupilMat);
    leftPupil.position.set(-0.055, 0.025, 0.167);
    headGroup.add(leftPupil);

    const rightEye = new THREE.Mesh(new THREE.SphereGeometry(0.024, 12, 10), eyeWhiteMat);
    rightEye.position.set(0.055, 0.025, 0.148);
    headGroup.add(rightEye);
    const rightPupil = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), pupilMat);
    rightPupil.position.set(0.055, 0.025, 0.167);
    headGroup.add(rightPupil);

    const browGeo = new THREE.BoxGeometry(0.048, 0.012, 0.015);
    const leftBrow = new THREE.Mesh(browGeo, hairMat);
    leftBrow.position.set(-0.055, 0.068, 0.155);
    headGroup.add(leftBrow);

    const rightBrow = new THREE.Mesh(browGeo, hairMat);
    rightBrow.position.set(0.055, 0.068, 0.155);
    headGroup.add(rightBrow);

    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.045, 8), skinMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, -0.005, 0.172);
    headGroup.add(nose);

    const mouthMesh = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.016, 0.02), mouthMat);
    mouthMesh.position.set(0, -0.062, 0.152);
    headGroup.add(mouthMesh);

    // Arms
    const buildArm = (side) => {
      const s = side === 'left' ? -1 : 1;
      const shoulder = new THREE.Group();
      shoulder.position.set(s * (isFemale ? 0.22 : 0.26), 0.50, 0);
      torsoPivot.add(shoulder);

      const upperArm = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.045, 0.28, 12), shirtMat);
      upperArm.position.set(0, -0.13, 0);
      upperArm.castShadow = true;
      shoulder.add(upperArm);

      const elbow = new THREE.Group();
      elbow.position.set(0, -0.27, 0);
      shoulder.add(elbow);

      const foreArm = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.036, 0.26, 12), skinMat);
      foreArm.position.set(0, -0.12, 0);
      foreArm.castShadow = true;
      elbow.add(foreArm);

      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.042, 12, 10), skinMat);
      hand.position.set(0, -0.26, 0);
      elbow.add(hand);

      return { shoulder, elbow, hand, upperArm };
    };

    const leftArm = buildArm('left');
    const rightArm = buildArm('right');

    this.scene.add(root);
    if (typeof window !== 'undefined' && window.sceneManager && typeof window.sceneManager.addObject === 'function') {
      window.sceneManager.addObject(root);
    }
    this._createdObjects.add(root);

    return {
      root,
      torsoPivot,
      neckPivot,
      headGroup,
      leftBrow,
      rightBrow,
      mouthMesh,
      leftArm,
      rightArm,
      jacketGroup
    };
  }

  /**
   * Records a deterministic director timeline into a lightweight .webm video (VP9/VP8),
   * uploads it to /api/agent/upload (agent_assets/), and returns the saved asset metadata.
   */
  async recordDirectorWebM({
    duration = 35,
    fps = 30,
    width = 540,
    height = 960,
    bitrate = 1400000,
    fileName = 'short_video.webm',
    onFrame = null,
    onOverlay = null
  } = {}) {
    const engine = (typeof window !== 'undefined') ? (window.engine || window.studioEngine) : null;
    if (!engine || !engine.renderer || !engine.camera) {
      throw new Error('3D Engine renderer/camera not initialized');
    }

    const camera = engine.camera;
    const glCanvas = engine.renderer.domElement;
    const prevRatio = engine.renderer.getPixelRatio();
    const prevW = glCanvas.clientWidth || 800;
    const prevH = glCanvas.clientHeight || 600;
    const prevAspect = camera.aspect;
    const prevLeft = camera.left;
    const prevRight = camera.right;
    const prevControlsEnabled = engine.controls.enabled;
    let stream, recorder, blob;

    try {
      engine.controls.enabled = false;
      engine.renderer.setPixelRatio(1);
      engine.renderer.setSize(width, height, false);
      if (camera.isOrthographicCamera) {
        const halfWidth = (camera.top - camera.bottom) / 2 * width / height;
        camera.left = -halfWidth;
        camera.right = halfWidth;
      } else {
        camera.aspect = width / height;
      }
      camera.updateProjectionMatrix();

      const compCanvas = document.createElement('canvas');
      compCanvas.width = width;
      compCanvas.height = height;
      const compCtx = compCanvas.getContext('2d');

      let mimeType = 'video/webm;codecs=vp9';
      if (typeof MediaRecorder.isTypeSupported === 'function' && !MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
      }

      stream = compCanvas.captureStream(fps);
      const chunks = [];
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitrate });
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      const donePromise = new Promise((resolve, reject) => {
        recorder.onerror = (e) => reject(e.error || new Error('MediaRecorder error'));
        recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType }));
      });

      recorder.start(200);
      const startWall = performance.now();
      await new Promise((resolve, reject) => {
        const step = () => {
          try {
            const elapsed = (performance.now() - startWall) / 1000;
            const t = Math.min(duration, elapsed);
            if (typeof onFrame === 'function') onFrame(t);
            engine.renderer.render(engine.scene, camera);
            compCtx.clearRect(0, 0, width, height);
            compCtx.drawImage(glCanvas, 0, 0, width, height);
            if (typeof onOverlay === 'function') onOverlay(compCtx, width, height, t);
            if (elapsed >= duration) resolve();
            else requestAnimationFrame(step);
          } catch (error) {
            reject(error);
          }
        };
        requestAnimationFrame(step);
      });

      await new Promise((r) => setTimeout(r, 200));
      if (recorder.state !== 'inactive') recorder.stop();
      blob = await donePromise;
    } finally {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
      stream?.getTracks().forEach((track) => track.stop());
      engine.controls.enabled = prevControlsEnabled;
      engine.renderer.setPixelRatio(prevRatio);
      engine.renderer.setSize(prevW, prevH, false);
      if (camera.isOrthographicCamera) {
        camera.left = prevLeft;
        camera.right = prevRight;
      } else {
        camera.aspect = prevAspect;
      }
      camera.updateProjectionMatrix();
      engine.renderer.render(engine.scene, engine.camera);
    }

    // Upload to /api/agent/upload so CLI/MCP immediately has the file on disk
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const pureBase64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

    const resp = await fetch('/api/agent/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, fileData: pureBase64 })
    });
    const uploaded = await resp.json();
    return {
      ok: true,
      size: blob.size,
      duration,
      width,
      height,
      fps,
      uploaded
    };
  }

  /**
   * Deterministic client-side video export to MP4 (H.264) via WebCodecs + Rust WASM Kernel.
   * Frame-by-frame exact timeline seeking (no dropped frames).
   * @param {Object} [options]
   * @returns {Promise<{ blob: Blob, filename: string, duration: number, frameCount: number, width: number, height: number }>}
   */
  async renderVideo(options = {}) {
    const engine = (typeof window !== 'undefined') ? (window.engine || window.studioEngine) : null;
    const timeline = (typeof window !== 'undefined') ? (window.timelineEngine || window.app?.timelineEngine) : null;
    const sim = (typeof window !== 'undefined') ? (window.simulationManager || window.app?.simulationManager) : null;
    if (!engine || !engine.renderer || !engine.camera) {
      throw new Error('3D Engine renderer/camera not initialized');
    }

    const { VideoExportManager } = await import('../render/video-export.js');
    const exporter = new VideoExportManager({
      renderer: engine.renderer,
      scene: engine.scene,
      camera: options.camera || engine.camera,
      rasterRenderer: engine.rasterRenderer,
      timeline,
      engineInstance: engine,
    });

    const res = await exporter.renderVideo({
      simulationManager: sim,
      ...options,
    });
    if (options.download !== false) {
      exporter.downloadBlob(res.blob, res.filename);
    }
    return res;
  }



  // ==========================================
  // 1-ON-1 AI TUTOR & UI POINTER CONTROL API (studio.tutor.*)
  // Allows user's AI Model (Motapis / Gemini / OpenAI / Copilot / DSL)
  // to directly fly the Tutor pointer icon, speak Vietnamese instructions,
  // switch viewport modes, open panels, and grade 3D modeling tasks!
  // ==========================================
  get tutor() {
    const getInstance = () => (typeof window !== 'undefined' ? (window.stemTutor || window.app?.stemTutor) : null);
    return {
      pointAt(selector, speechText = '', opts = {}) {
        const t = getInstance();
        if (!t) return null;
        return t.moveToTarget(selector, {
          openBubble: true,
          speechText: speechText || opts.speechText || '',
          title: opts.title,
          stepBadge: opts.stepBadge || 'AI 1:1',
          speak: opts.speak !== false && !!speechText
        });
      },
      speak(text, opts = {}) {
        const t = getInstance();
        return t ? t.speak(text, opts) : null;
      },
      setRate(rate = 1.2) {
        const t = getInstance();
        return t ? t.setVoiceRate(rate) : rate;
      },
      command(cmd = {}) {
        const t = getInstance();
        if (!t) return null;
        const normalized = (cmd && Array.isArray(cmd.steps) && cmd.steps.length > 1 && cmd.autoAdvance === false && !cmd.forcePause)
          ? { ...cmd, autoAdvance: true }
          : cmd;
        return t.executeAICommand(normalized);
      },
      guideSteps(steps = [], opts = {}) {
        const t = getInstance();
        if (!t) return null;
        const list = Array.isArray(steps) ? steps : [];
        const normalizedOpts = (opts && typeof opts === 'object') ? { ...opts } : {};
        if (list.length > 1 && !normalizedOpts.forcePause) {
          normalizedOpts.autoAdvance = true;
        }
        if (normalizedOpts.speak === undefined) {
          normalizedOpts.speak = true;
        }
        return t.guideSteps(list, normalizedOpts);
      },
      stop() {
        const t = getInstance();
        if (!t) return false;
        t.stopWalkthrough?.({ stopVoice: true });
        return true;
      },
      ask(question, opts = {}) {
        const t = getInstance();
        return t ? t.askAICoach(question, opts) : null;
      },
      startLesson(lessonIdOrNumber, opts = {}) {
        const t = getInstance();
        return t ? t.startLesson(lessonIdOrNumber, opts) : null;
      },
      nextStep(opts = {}) {
        const t = getInstance();
        return t ? t.nextStep(opts) : null;
      },
      grade(opts = {}) {
        const t = getInstance();
        return t ? t.gradeCurrentLesson(opts) : null;
      },
      demo(opts = {}) {
        const t = getInstance();
        return t ? t.runLessonDemo(opts) : null;
      }
    };
  }

  // ==========================================
  // BLENDER BPY COMPATIBILITY LAYER
  // ==========================================
  _setupBpyCompatibility() {
    const self = this;
    this.bpy = {
      ops: {
        object: {
          mode_set({ mode = 'OBJECT' } = {}) {
            if (mode.toUpperCase() === 'EDIT') {
              return self.enterEditMode();
            } else {
              return self.exitEditMode();
            }
          },
          modifier_add({ type = 'SUBSURF', ...params } = {}) {
            const norm = String(type || 'SUBSURF').toLowerCase();
            const mapped = (norm === 'subsurf' || norm === 'subdivide') ? 'subdivision' : norm;
            return studio.modifiers.add(mapped, params);
          },
          shade_smooth() {
            const mesh = _activeMesh();
            if (mesh) return setShadingMode(mesh, 'smooth');
          },
          shade_flat() {
            const mesh = _activeMesh();
            if (mesh) return setShadingMode(mesh, 'flat');
          },
          shade_auto_smooth({ angle = 30 } = {}) {
            const mesh = _activeMesh();
            if (mesh) return setShadingMode(mesh, 'auto', { angleThreshold: angle });
          }
        },
        anim: {
          keyframe_insert({ data_path = 'all', frame = null } = {}) {
            const ch = data_path === 'all' ? ['position', 'rotation', 'scale'] : [data_path];
            return self.insertKeyframe(null, frame, ch);
          },
          keyframe_delete({ frame = null } = {}) {
            return self.deleteKeyframe(null, frame);
          }
        },
        screen: {
          animation_play() {
            self.playAnimation();
          },
          animation_cancel() {
            self.pauseAnimation();
          }
        },
        render: {
          render(opts = {}) {
            const { animation = false, ...rest } = opts || {};
            if (animation) {
              return self.renderVideo(rest);
            } else {
              return self.takeScreenshot();
            }
          }
        },
        mesh: {
          primitive_cube_add({ size = 2, location = [0, 0, 0], scale = [1, 1, 1] } = {}) {
            return self.addCube({
              width: size * scale[0],
              height: size * scale[1],
              depth: size * scale[2],
              x: location[0],
              y: location[1],
              z: location[2]
            });
          },
          primitive_uv_sphere_add({ radius = 1, location = [0, 0, 0], segments = 32 } = {}) {
            return self.addSphere({
              radius,
              widthSegments: segments,
              x: location[0],
              y: location[1],
              z: location[2]
            });
          },
          primitive_cylinder_add({ radius = 1, depth = 2, location = [0, 0, 0] } = {}) {
            return self.addCylinder({
              radiusTop: radius,
              radiusBottom: radius,
              height: depth,
              x: location[0],
              y: location[1],
              z: location[2]
            });
          },
          primitive_cone_add({ radius1 = 1, depth = 2, location = [0, 0, 0] } = {}) {
            return self.addCone({
              radius: radius1,
              height: depth,
              x: location[0],
              y: location[1],
              z: location[2]
            });
          },
          primitive_torus_add({ radius = 1, ring_radius = 0.25, location = [0, 0, 0] } = {}) {
            return self.addTorus({
              radius,
              tube: ring_radius,
              x: location[0],
              y: location[1],
              z: location[2]
            });
          },
          primitive_plane_add({ size = 2, location = [0, 0, 0] } = {}) {
            return self.addPlane({
              width: size,
              height: size,
              x: location[0],
              y: location[1],
              z: location[2]
            });
          },
          extrude_region_move({ distance = 0.5 } = {}) {
            return self.extrude(distance);
          },
          inset({ thickness = 0.25 } = {}) {
            return self.inset(thickness);
          },
          subdivide() {
            return self.subdivide();
          },
          bevel({ offset = 0.08 } = {}) {
            return self.bevel(offset);
          },
          delete() {
            return self.deleteSelection();
          }
        }
      }
    };
  }
}

// Global singleton instance
export const studio = new RapidStudio();

// DSL modifier stack async (Phase 1): studio.modifiers.*
const _activeMesh = () => {
  const sm = typeof window !== 'undefined' ? window.sceneManager : null;
  const sel = sm?.getSelectedObjects ? sm.getSelectedObjects() : [];
  return sel.find((o) => o.isMesh) || null;
};
const _sm = () => (typeof window !== 'undefined' ? window.sceneManager : null);
studio.modifiers = {
  add: (type, params = {}, mesh = _activeMesh()) => ModifierStack.addModifier(mesh, type, params, { sceneManager: _sm() }),
  update: (index, params, mesh = _activeMesh()) => ModifierStack.updateModifier(mesh, index, params, { sceneManager: _sm() }),
  remove: (index, mesh = _activeMesh()) => ModifierStack.removeModifier(mesh, index, { sceneManager: _sm() }),
  toggle: (index, mesh = _activeMesh()) => ModifierStack.toggleModifier(mesh, index, { sceneManager: _sm() }),
  reorder: (from, to, mesh = _activeMesh()) => ModifierStack.reorderModifier(mesh, from, to, { sceneManager: _sm() }),
  bake: (upTo, mesh = _activeMesh()) => ModifierStack.bakeModifiers(mesh, upTo, { sceneManager: _sm() }),
  list: (mesh = _activeMesh()) => ModifierStack.getStack(mesh),
  evaluate: (mesh = _activeMesh(), opts = {}) => ModifierStack.evaluateStack(mesh, opts)
};

// Rust WASM Auto-LOD, Non-Destructive Simplification & GPU Surface Scatter DSL
const _lodMgr = () => (typeof window !== 'undefined' ? (window.lodManager || window.engine?.lodManager || null) : null);
const _instSys = () => (typeof window !== 'undefined' ? (window.instancingSystem || window.engine?.instancingSystem || null) : null);

studio.simplify = async (target = _activeMesh(), ratio = 0.35, opts = {}) => {
  const lm = _lodMgr();
  if (!lm || !target) return null;
  return await lm.setMeshDetailLevel(target, ratio, opts);
};

studio.enableAutoLOD = async (target = _activeMesh(), opts = {}) => {
  const lm = _lodMgr();
  const obj = target || (typeof window !== 'undefined' ? window.sceneManager?.getActiveObject?.() : null);
  if (!lm || !obj) return null;
  return await lm.enableAutoLOD(obj, opts);
};

studio.disableAutoLOD = (target = _activeMesh()) => {
  const lm = _lodMgr();
  const obj = target || (typeof window !== 'undefined' ? window.sceneManager?.getActiveObject?.() : null);
  if (!lm || !obj) return false;
  return lm.disableAutoLOD(obj);
};

studio.scatter = async (sourceOrPreset = 'grass', surfaceMesh = null, opts = {}) => {
  const is = _instSys();
  if (!is) return null;
  return await is.scatterOnSurface(sourceOrPreset, surfaceMesh, {
    sceneManager: _sm(),
    ...opts,
  });
};

studio.batchToInstances = async (meshes = null, opts = {}) => {
  const is = _instSys();
  const sm = _sm();
  if (!is) return null;
  const list = Array.isArray(meshes) ? meshes : (sm?.getSelectedObjects?.() || []);
  return await is.batchMeshesToInstanceGroup(list, { sceneManager: sm, ...opts });
};

// Expose globally for browser console & script execution
if (typeof window !== 'undefined') {
  window.RapidStudio = RapidStudio;
  window.studio = studio;
  window.prefabLibrary = prefabLibrary;
  window.bpy = studio.bpy;
}

export default studio;

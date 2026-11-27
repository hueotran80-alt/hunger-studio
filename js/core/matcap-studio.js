/**
 * @file matcap-studio.js
 * @description Procedural MatCap (Material Capture) Shading System for Web Blender Studio.
 * Generates high-fidelity Blender 4.x solid MatCap styles procedurally using HTML5 Canvas:
 * - 'Red Wax': Iconic ZBrush & Blender clay sculpting wax with subsurface scatter and rim
 * - 'Chrome': Ultra-reflective mirror metal with high-contrast studio environment
 * - 'Clay': Matte warm earthen sculpting clay with soft ambient occlusion
 * - 'Ceramic': Glazed pristine porcelain with clearcoat specular sheen
 * - 'Normal': Exact camera-space normal vector mapping (R=X, G=Y, B=Z)
 * - 'Toon': Anime / Cel-shaded banded lighting with sharp rim accents
 * - 'Pearl': Pearlescent iridescent opal with chromatic grazing angles
 * - 'Obsidian': Glossy polished black onyx lacquer
 * 
 * Works completely offline without external image textures, supports non-destructive
 * material swapping and restoration, and binds seamlessly to Three.js scenes.
 */

import * as THREE from 'three';

export class MatCapStudio {
  /**
   * @param {Object} [options]
   * @param {THREE.Scene} [options.scene]
   * @param {Object} [options.sceneManager]
   */
  constructor(options = {}) {
    this.scene = options.scene || null;
    this.sceneManager = options.sceneManager || null;

    // Cache of generated CanvasTexture instances by style name
    this.textureCache = new Map();

    // Cache of MeshMatcapMaterial instances by style name
    this.materialCache = new Map();

    // Thumbnail data URLs for UI popovers
    this.previewThumbnails = new Map();

    // Active state
    this.isMatCapActive = false;
    this.currentStyle = 'blender-solid';

    // Event listeners
    this.listeners = new Map();

    // Pre-register all built-in styles
    this.styles = [
      {
        id: 'blender-solid',
        name: 'Blender Solid Gray',
        description: 'Default Blender 4.x neutral studio clay gray for clean polygonal modeling',
        accentColor: '#d0d3d8'
      },
      {
        id: 'red-wax',
        name: 'Red Wax',
        description: 'Iconic clay sculpture wax with warm subsurface scatter & rim highlights',
        accentColor: '#b84337'
      },
      {
        id: 'chrome',
        name: 'Chrome',
        description: 'High-contrast mirror chrome with studio softbox reflections',
        accentColor: '#cfd8dc'
      },
      {
        id: 'clay',
        name: 'Clay',
        description: 'Warm matte diffuse earthen clay for detailed anatomical sculpting',
        accentColor: '#8c7f74'
      },
      {
        id: 'ceramic',
        name: 'Ceramic',
        description: 'Pristine glazed porcelain with glossy clearcoat specular highlights',
        accentColor: '#e8edf3'
      },
      {
        id: 'normal',
        name: 'Normal',
        description: 'Camera-space normal vector orientation (X=Red, Y=Green, Z=Blue)',
        accentColor: '#7c7cff'
      },
      {
        id: 'toon',
        name: 'Toon',
        description: 'Anime / manga cel-shaded banded posterization with crisp rim',
        accentColor: '#5382ff'
      },
      {
        id: 'pearl',
        name: 'Pearl',
        description: 'Iridescent pearlescent opal with pastel color shift',
        accentColor: '#f7d6e0'
      },
      {
        id: 'obsidian',
        name: 'Obsidian',
        description: 'Glossy polished black onyx lacquer with razor studio reflections',
        accentColor: '#2b2e38'
      }
    ];

    // Generate MatCap textures and preview thumbnails lazily on first use
    // (avoids ~1.4s main-thread blocking during initial Studio startup).

    // Hook to sceneManager if provided to automatically apply matcap to newly added objects
    if (this.sceneManager) {
      this.sceneManager.on('objectAdded', ({ object }) => {
        if (this.isMatCapActive && object) {
          this.applyMatCap(object, this.currentStyle);
        }
      });
    }
  }

  /**
   * Pre-generates canvas textures and thumbnails for each style
   * @private
   */
  _initializeStyles() {
    for (const style of this.styles) {
      this.getTexture(style.id);
      this.getPreviewThumbnail(style.id);
    }
  }

  /**
   * Retrieves list of available MatCap styles metadata
   * @returns {Array<Object>}
   */
  getAvailableStyles() {
    return this.styles.map(s => ({
      ...s,
      preview: this.previewThumbnails.get(s.id) || this.getPreviewThumbnail(s.id)
    }));
  }

  /**
   * Gets or generates a THREE.CanvasTexture for the requested style
   * @param {string} styleId
   * @param {number} [resolution=256]
   * @returns {THREE.CanvasTexture}
   */
  getTexture(styleId, resolution = 256) {
    const key = `${styleId}_${resolution}`;
    if (this.textureCache.has(key)) {
      return this.textureCache.get(key);
    }

    const canvas = this.generateProceduralMatCapCanvas(styleId, resolution);
    const texture = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) {
      texture.colorSpace = THREE.SRGBColorSpace;
    }
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;

    this.textureCache.set(key, texture);
    return texture;
  }

  /**
   * Gets or generates a data URL preview thumbnail for UI popovers
   * @param {string} styleId
   * @returns {string} data URL
   */
  getPreviewThumbnail(styleId) {
    if (this.previewThumbnails.has(styleId)) {
      return this.previewThumbnails.get(styleId);
    }
    const canvas = this.generateProceduralMatCapCanvas(styleId, 72);
    const dataUrl = canvas.toDataURL('image/png');
    this.previewThumbnails.set(styleId, dataUrl);
    return dataUrl;
  }

  /**
   * Creates or returns a cached THREE.MeshMatcapMaterial
   * @param {string} styleId
   * @param {Object} [options]
   * @returns {THREE.MeshMatcapMaterial}
   */
  getMaterial(styleId, options = {}) {
    const validStyle = this._resolveStyleId(styleId);
    const flat = Boolean(options.flatShading);
    const wire = Boolean(options.wireframe);
    const hasOpacity = Number.isFinite(options.opacity) && options.opacity < 1.0;
    const transparent = Boolean(options.transparent) || hasOpacity;
    const opacity = transparent && Number.isFinite(options.opacity) ? options.opacity : 1.0;
    const key = `${validStyle}_${flat ? 'flat' : 'smooth'}_${wire ? 'wire' : 'solid'}_${transparent ? `t${Math.round(opacity * 100)}` : 'opaque'}`;

    if (this.materialCache.has(key)) {
      return this.materialCache.get(key);
    }

    const texture = this.getTexture(validStyle);
    const matOpts = { ...options };
    delete matOpts.wireframe;
    const mat = new THREE.MeshMatcapMaterial({
      matcap: texture,
      ...matOpts,
      flatShading: flat,
      transparent,
      opacity,
    });
    mat.wireframe = wire;
    mat.name = `MatCap_${validStyle}`;
    mat.userData = { ...(mat.userData || {}), isMatCapMaterial: true, matcapStyleId: validStyle };

    this.materialCache.set(key, mat);
    return mat;
  }

  /**
   * Procedural Sphere Normal Mapping Algorithm:
   * Maps 2D circle pixels (u, v) to 3D view-space normal N = (u, v, sqrt(1 - u^2 - v^2))
   * and renders sophisticated lighting shaders per style.
   * @param {string} styleId
   * @param {number} size Width & Height in pixels
   * @returns {HTMLCanvasElement}
   */
  generateProceduralMatCapCanvas(styleId, size = 256) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(size, size);
    const data = imgData.data;

    const half = size / 2;
    const radius = half - 1.5;

    // Light direction constants in view space (Z pointing towards camera)
    const keyLight = this._normalize(-0.45, 0.55, 0.7);
    const fillLight = this._normalize(0.55, -0.4, 0.5);
    const topLight = this._normalize(0.0, 0.85, 0.52);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;

        // Normalized circle coordinates [-1, 1]
        const u = (x - half + 0.5) / radius;
        const v = -(y - half + 0.5) / radius; // Invert Y so up is positive
        const distSq = u * u + v * v;

        if (distSq > 1.0) {
          // Antialiased circle edge
          if (distSq < 1.06) {
            const edgeAlpha = Math.max(0, 1 - (distSq - 1.0) / 0.06);
            data[idx + 0] = 20;
            data[idx + 1] = 20;
            data[idx + 2] = 20;
            data[idx + 3] = Math.round(edgeAlpha * 128);
          } else {
            data[idx + 3] = 0;
          }
          continue;
        }

        // View space normal N
        const nz = Math.sqrt(Math.max(0, 1.0 - distSq));
        const nx = u;
        const ny = v;

        let r = 0, g = 0, b = 0;

        switch (styleId) {
          case 'blender-solid': {
            // Blender 4.x default neutral Studio Solid Gray (#d2d5da)
            const diffKey = Math.max(0, nx * keyLight.x + ny * keyLight.y + nz * keyLight.z);
            const diffFill = Math.max(0, nx * fillLight.x + ny * fillLight.y + nz * fillLight.z);
            const diffTop = Math.max(0, nx * topLight.x + ny * topLight.y + nz * topLight.z);

            const hx = keyLight.x;
            const hy = keyLight.y;
            const hz = keyLight.z + 1.0;
            const hLen = Math.hypot(hx, hy, hz) || 1;
            const nDotH = Math.max(0, nx * (hx / hLen) + ny * (hy / hLen) + nz * (hz / hLen));
            const spec = Math.pow(nDotH, 26) * 0.32;
            const rim = Math.pow(1.0 - nz, 3.0) * 0.25;

            const base = 186 * (0.28 + 0.62 * diffKey + 0.18 * diffFill + 0.12 * diffTop);
            r = base + spec * 180 + rim * 95;
            g = base + spec * 182 + rim * 100 + diffFill * 4;
            b = base + spec * 188 + rim * 112 + diffFill * 10;
            break;
          }

          case 'red-wax': {
            // ZBrush / Blender iconic Red Wax clay
            const diffKey = Math.max(0, nx * keyLight.x + ny * keyLight.y + nz * keyLight.z);
            const diffFill = Math.max(0, nx * fillLight.x + ny * fillLight.y + nz * fillLight.z);
            
            // Subsurface scatter simulation: warm wrap light
            const sss = Math.max(0, (-(nx * keyLight.x + ny * keyLight.y) + 0.4) / 1.4);
            
            // Specular Blinn-Phong highlight
            const hx = keyLight.x;
            const hy = keyLight.y;
            const hz = keyLight.z + 1.0;
            const hLen = Math.hypot(hx, hy, hz) || 1;
            const nDotH = Math.max(0, nx * (hx / hLen) + ny * (hy / hLen) + nz * (hz / hLen));
            const spec = Math.pow(nDotH, 38) * 0.95;

            // Rim light around grazing angles
            const rim = Math.pow(1.0 - nz, 3.2);

            // Shading synthesis
            const baseR = 158;
            const baseG = 56;
            const baseB = 48;

            r = baseR * (0.35 + 0.65 * diffKey) + diffFill * 45 + sss * 40 + rim * 120 + spec * 230;
            g = baseG * (0.30 + 0.70 * diffKey) + diffFill * 20 + sss * 15 + rim * 70  + spec * 200;
            b = baseB * (0.28 + 0.72 * diffKey) + diffFill * 18 + rim * 55             + spec * 180;
            break;
          }

          case 'chrome': {
            // Mirror reflection vector R = 2(N.V)N - V
            const rx = 2 * nz * nx;
            const ry = 2 * nz * ny;
            const rz = 2 * nz * nz - 1;

            // Studio horizon & softbox reflections
            const horizonBand = Math.exp(-Math.pow((ry + 0.05) * 8.0, 2));
            const upperLight = Math.max(0, ry);
            const lowerDark = Math.max(0, -ry);

            // Rectangular studio softbox simulation
            const box1 = Math.exp(-Math.pow((rx + 0.25) * 4.0, 4) - Math.pow((ry - 0.45) * 5.0, 4)) * 1.5;
            const box2 = Math.exp(-Math.pow((rx - 0.4) * 8.0, 4) - Math.pow((ry - 0.1) * 3.0, 4)) * 0.9;
            
            const specHotspot = Math.pow(Math.max(0, rx * keyLight.x + ry * keyLight.y + rz * keyLight.z), 40);
            const fresnel = Math.pow(1.0 - nz, 2.5);

            const chromeTone = 45 + upperLight * 165 - lowerDark * 30 + horizonBand * 75 + (box1 + box2 + specHotspot) * 190 + fresnel * 60;
            r = chromeTone * 0.96;
            g = chromeTone * 1.0;
            b = chromeTone * 1.06;
            break;
          }

          case 'clay': {
            // Warm neutral diffuse matte sculpting clay
            const diffKey = Math.max(0, nx * keyLight.x + ny * keyLight.y + nz * keyLight.z);
            const diffTop = Math.max(0, nx * topLight.x + ny * topLight.y + nz * topLight.z);
            const diffFill = Math.max(0, nx * fillLight.x + ny * fillLight.y + nz * fillLight.z);
            const aoEdge = Math.pow(nz, 0.4);

            const clayR = 145;
            const clayG = 132;
            const clayB = 120;

            const illumination = 0.22 + 0.50 * diffKey + 0.25 * diffTop + 0.15 * diffFill;
            r = clayR * illumination * aoEdge;
            g = clayG * illumination * aoEdge;
            b = clayB * illumination * aoEdge;
            break;
          }

          case 'ceramic': {
            // Glazed pristine porcelain with clearcoat specular sheen
            const diffKey = Math.max(0, nx * keyLight.x + ny * keyLight.y + nz * keyLight.z);
            const diffFill = Math.max(0, nx * fillLight.x + ny * fillLight.y + nz * fillLight.z);
            
            // Dual specular reflections (sharp clearcoat + broad glaze)
            const hx = keyLight.x;
            const hy = keyLight.y;
            const hz = keyLight.z + 1.0;
            const hLen = Math.hypot(hx, hy, hz) || 1;
            const nDotH = Math.max(0, nx * (hx / hLen) + ny * (hy / hLen) + nz * (hz / hLen));
            
            const specSharp = Math.pow(nDotH, 90) * 1.6;
            const specBroad = Math.pow(nDotH, 16) * 0.35;
            const fresnel = Math.pow(1.0 - nz, 3.0) * 0.6;

            const baseTone = 175 + 60 * diffKey + 25 * diffFill + fresnel * 40;
            r = baseTone + specSharp * 255 + specBroad * 180;
            g = baseTone * 1.02 + specSharp * 255 + specBroad * 190;
            b = baseTone * 1.06 + specSharp * 255 + specBroad * 210;
            break;
          }

          case 'normal': {
            // Camera-space normal map (R=X, G=Y, B=Z)
            r = (nx * 0.5 + 0.5) * 255;
            g = (ny * 0.5 + 0.5) * 255;
            b = (nz * 0.5 + 0.5) * 255;
            break;
          }

          case 'toon': {
            // Cel-shaded / anime banded steps
            const diff = nx * keyLight.x + ny * keyLight.y + nz * keyLight.z;
            const rim = Math.pow(1.0 - nz, 2.5);

            let bandR, bandG, bandB;
            if (diff > 0.6) {
              // Highlight band
              bandR = 245; bandG = 248; bandB = 255;
            } else if (diff > 0.22) {
              // Midtone band
              bandR = 150; bandG = 165; bandB = 195;
            } else {
              // Shadow band
              bandR = 60;  bandG = 70;  bandB = 98;
            }

            // Anime rim light on silhouette
            if (rim > 0.65 && ny > -0.3) {
              bandR = 160; bandG = 210; bandB = 255;
            }

            r = bandR;
            g = bandG;
            b = bandB;
            break;
          }

          case 'pearl': {
            // Pearlescent iridescent opal with chromatic grazing shift
            const diffKey = Math.max(0, nx * keyLight.x + ny * keyLight.y + nz * keyLight.z);
            const angle = Math.atan2(ny, nx);
            const fresnel = Math.pow(1.0 - nz, 2.2);

            const shift = Math.sin(angle * 2.0 + fresnel * 4.0);
            const pearlR = 230 + shift * 22;
            const pearlG = 215 + Math.cos(angle * 2.0) * 25;
            const pearlB = 240 - shift * 20;

            const spec = Math.pow(Math.max(0, nx * keyLight.x + ny * keyLight.y + nz * keyLight.z), 32);

            r = (pearlR * (0.55 + 0.45 * diffKey) + fresnel * 35 + spec * 140);
            g = (pearlG * (0.55 + 0.45 * diffKey) + fresnel * 25 + spec * 140);
            b = (pearlB * (0.55 + 0.45 * diffKey) + fresnel * 40 + spec * 140);
            break;
          }

          case 'obsidian': {
            // Polished black onyx lacquer
            const rx = 2 * nz * nx;
            const ry = 2 * nz * ny;
            const rz = 2 * nz * nz - 1;

            const specHotspot = Math.pow(Math.max(0, rx * keyLight.x + ry * keyLight.y + rz * keyLight.z), 50);
            const rim = Math.pow(1.0 - nz, 3.5);
            const softbox = Math.exp(-Math.pow((rx + 0.2) * 6.0, 2) - Math.pow((ry - 0.4) * 4.0, 2));

            r = 22 + softbox * 80 + specHotspot * 220 + rim * 170;
            g = 24 + softbox * 95 + specHotspot * 230 + rim * 185;
            b = 30 + softbox * 120 + specHotspot * 255 + rim * 210;
            break;
          }

          default:
            r = 128; g = 128; b = 128;
        }

        // Clamp values to [0, 255]
        data[idx + 0] = Math.min(255, Math.max(0, Math.round(r)));
        data[idx + 1] = Math.min(255, Math.max(0, Math.round(g)));
        data[idx + 2] = Math.min(255, Math.max(0, Math.round(b)));
        data[idx + 3] = 255;
      }
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas;
  }

  _isSystemOrHelperNode(node) {
    let cur = node;
    while (cur) {
      if (cur.isScene || cur.name === 'Scene_Collection') return false;
      if (
        cur.userData?.isSystemObject ||
        cur.userData?.isSystemHelper ||
        cur.userData?.isHelper ||
        cur.userData?.isLightHelper ||
        cur.userData?.isCameraPart ||
        cur.isTransformControls ||
        cur.isTransformControlsGizmo ||
        cur.isTransformControlsPlane ||
        cur.name === 'Studio_Cyclorama_Backdrop'
      ) {
        return true;
      }
      cur = cur.parent;
    }
    return false;
  }

  /**
   * Applies MatCap shading to a specific mesh or recursively to all child meshes
   * Preserves original materials in mesh.userData.__originalMaterial for non-destructive restore
   * @param {THREE.Object3D} root
   * @param {string} [styleName='red-wax']
   */
  applyMatCap(root, styleName = this.currentStyle) {
    if (!root) return;

    const validStyle = this._resolveStyleId(styleName);
    this.currentStyle = validStyle;

    root.traverse((node) => {
      if (node.isMesh && !this._isSystemOrHelperNode(node)) {
        // Backup original material if not already backed up
        if (!node.userData.__originalMaterial) {
          node.userData.__originalMaterial = node.material;
        }

        const isFlat = Array.isArray(node.material)
          ? !!node.material[0]?.flatShading
          : !!node.material?.flatShading;
        const isWire = Array.isArray(node.material)
          ? node.material.some((m) => !!m?.wireframe)
          : !!node.material?.wireframe;

        // Variant caching guarantees we never mutate a shared MatCap singleton
        const matcapMaterial = this.getMaterial(validStyle, { flatShading: isFlat, wireframe: isWire });
        node.material = matcapMaterial;
      }
    });

    this._emit('styleChanged', { style: validStyle, isMatCapActive: this.isMatCapActive });
  }

  /**
   * Restores original materials across a mesh or scene hierarchy
   * @param {THREE.Object3D} [root] Defaults to this.scene
   */
  restoreOriginalMaterials(root = this.scene) {
    if (!root) return;

    root.traverse((node) => {
      if (node.isMesh && !this._isSystemOrHelperNode(node) && node.userData.__originalMaterial) {
        node.material = node.userData.__originalMaterial;
        delete node.userData.__originalMaterial;
      }
    });
  }

  /**
   * Toggles MatCap mode globally for the active scene
   * @param {boolean} enabled
   * @param {string} [styleName]
   */
  toggleMatCapMode(enabled, styleName = this.currentStyle) {
    this.isMatCapActive = !!enabled;
    const validStyle = this._resolveStyleId(styleName);
    this.currentStyle = validStyle;

    if (!this.scene) return;

    if (this.isMatCapActive) {
      this.applyMatCap(this.scene, validStyle);
    } else {
      this.restoreOriginalMaterials(this.scene);
    }

    this._emit('modeChanged', { 
      isMatCapActive: this.isMatCapActive, 
      style: validStyle 
    });
  }

  /**
   * Sets active MatCap style and updates scene if currently in MatCap mode
   * @param {string} styleName
   */
  setStyle(styleName) {
    const validStyle = this._resolveStyleId(styleName);
    this.currentStyle = validStyle;

    if (this.isMatCapActive && this.scene) {
      this.applyMatCap(this.scene, validStyle);
    }

    this._emit('styleChanged', { style: validStyle, isMatCapActive: this.isMatCapActive });
  }

  /**
   * Alias for setStyle
   */
  setMatCapStyle(styleName) {
    return this.setStyle(styleName);
  }

  /**
   * Disables MatCap mode and restores original materials
   */
  disableMatCap() {
    this.toggleMatCapMode(false);
  }

  /**
   * Enables MatCap mode
   */
  enableMatCap(styleName) {
    this.toggleMatCapMode(true, styleName);
  }

  /**
   * Returns current active style ID
   * @returns {string}
   */
  getActiveStyle() {
    return this.currentStyle;
  }

  /**
   * Binds an event listener
   * @param {string} event 'styleChanged' | 'modeChanged'
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.listeners.get(event).delete(callback);
  }

  /**
   * Emits an internal event
   * @private
   */
  _emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(cb => {
        try { cb(data); } catch (e) { console.error('MatCapStudio event error:', e); }
      });
    }
  }

  /**
   * Resolves given style string to known valid style ID
   * @private
   */
  _resolveStyleId(styleId) {
    if (!styleId) return 'red-wax';
    const lower = String(styleId).toLowerCase().trim().replace(/[\s_]+/g, '-');
    const match = this.styles.find(s => s.id === lower || s.name.toLowerCase().replace(/[\s_]+/g, '-') === lower);
    return match ? match.id : 'red-wax';
  }

  /**
   * Normalizes a 3D vector
   * @private
   */
  _normalize(x, y, z) {
    const len = Math.hypot(x, y, z) || 1;
    return { x: x / len, y: y / len, z: z / len };
  }

  /**
   * Cleanup and dispose cached textures & materials
   */
  dispose() {
    this.textureCache.forEach(t => t.dispose());
    this.materialCache.forEach(m => m.dispose());
    this.textureCache.clear();
    this.materialCache.clear();
    this.previewThumbnails.clear();
    this.listeners.clear();
  }
}

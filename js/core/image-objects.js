/**
 * @file image-objects.js
 * @description Standalone Blender-standard Image Objects core:
 *   - Add -> Image -> Reference / Background / Mesh Plane
 *   - Aspect-ratio-preserving geometry, UV Flip X/Y, Depth Order (Default / In Front / Back),
 *     Display Side (Both / Front / Back), Opacity, Quick Alignment, Replace Image,
 *     and Convert Image Empty to Lit Mesh Plane.
 */

import * as THREE from 'three';

export const IMAGE_FILE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif',
]);

export const IMAGE_MODES = new Set(['reference', 'background', 'plane']);

export function isImageFile(fileOrName) {
  const name = typeof fileOrName === 'string'
    ? fileOrName
    : (fileOrName && typeof fileOrName.name === 'string' ? fileOrName.name : '');
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function stripImageExtension(fileName = 'Image') {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error('No image file provided'));
      return;
    }
    if (typeof FileReader !== 'undefined') {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Failed to read image file'));
      reader.readAsDataURL(file);
      return;
    }
    if (typeof file.arrayBuffer === 'function') {
      file.arrayBuffer().then((buf) => {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const mime = file.type || 'image/png';
        const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
        resolve(`data:${mime};base64,${base64}`);
      }).catch(reject);
      return;
    }
    reject(new Error('FileReader is unavailable in this environment'));
  });
}

export async function loadImageTexture({ src = null, file = null, texture = null, pixelWidth = null, pixelHeight = null } = {}) {
  if (texture) {
    const img = texture.image || {};
    const w = Number(pixelWidth) || Number(img.naturalWidth) || Number(img.width) || 512;
    const h = Number(pixelHeight) || Number(img.naturalHeight) || Number(img.height) || 512;
    if (texture.colorSpace !== THREE.SRGBColorSpace) {
      texture.colorSpace = THREE.SRGBColorSpace;
    }
    texture.needsUpdate = true;
    return {
      texture,
      imageSrc: src || (typeof img.src === 'string' ? img.src : null),
      pixelWidth: w,
      pixelHeight: h,
      fileName: file?.name || null,
    };
  }

  let resolvedSrc = src;
  if (!resolvedSrc && file) {
    resolvedSrc = await readFileAsDataUrl(file);
  }
  if (!resolvedSrc) {
    throw new Error('Image source (src, file, or texture) is required');
  }

  // Browser DOM path: decode via HTMLImageElement so pixel dimensions & DataURL stay accurate.
  if (typeof Image !== 'undefined') {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      if (!resolvedSrc.startsWith('data:') && !resolvedSrc.startsWith('blob:')) {
        el.crossOrigin = 'anonymous';
      }
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Failed to decode image source: ${file?.name || resolvedSrc.slice(0, 64)}`));
      el.src = resolvedSrc;
    });
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return {
      texture: tex,
      imageSrc: resolvedSrc,
      pixelWidth: img.naturalWidth || img.width || Number(pixelWidth) || 512,
      pixelHeight: img.naturalHeight || img.height || Number(pixelHeight) || 512,
      fileName: file?.name || null,
    };
  }

  // Headless / Node fallback when no DOM Image constructor is present.
  const w = Math.max(1, Number(pixelWidth) || 64);
  const h = Math.max(1, Number(pixelHeight) || 64);
  const data = new Uint8Array(w * h * 4);
  data.fill(255);
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return {
    texture: tex,
    imageSrc: resolvedSrc,
    pixelWidth: w,
    pixelHeight: h,
    fileName: file?.name || null,
  };
}

function buildPlaneGeometryWithFlip(width, aspect, flipX = false, flipY = false) {
  const safeW = Math.max(0.01, Number(width) || 4);
  const safeAspect = Math.max(0.05, Math.min(20, Number(aspect) || 1));
  const height = safeW / safeAspect;
  const geom = new THREE.PlaneGeometry(safeW, height);
  const uv = geom.getAttribute('uv');
  if (uv && (flipX || flipY)) {
    for (let i = 0; i < uv.count; i++) {
      const u = flipX ? (1 - uv.getX(i)) : uv.getX(i);
      const v = flipY ? (1 - uv.getY(i)) : uv.getY(i);
      uv.setXY(i, u, v);
    }
    uv.needsUpdate = true;
  }
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  return { geometry: geom, width: safeW, height };
}

function sideEnumFromName(side) {
  if (side === 'front') return THREE.FrontSide;
  if (side === 'back') return THREE.BackSide;
  return THREE.DoubleSide;
}

function applyMaterialSettings(mesh) {
  const ud = mesh.userData;
  const mat = mesh.material;
  if (!mat) return;

  const mode = ud.imageMode || 'reference';
  const opacity = THREE.MathUtils.clamp(Number(ud.opacity ?? 1), 0.02, 1);
  const depthOrder = ud.depthOrder || (mode === 'background' ? 'back' : 'default');

  mat.opacity = opacity;
  mat.side = sideEnumFromName(ud.displaySide || 'both');

  if (mode === 'plane') {
    mat.transparent = opacity < 0.999;
    mat.alphaTest = mat.transparent ? 0.0 : 0.45;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  } else {
    mat.transparent = true;
    mat.alphaTest = 0.0;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
  }

  if (depthOrder === 'front') {
    mat.depthTest = false;
    mat.depthWrite = false;
    mesh.renderOrder = 50;
  } else if (depthOrder === 'back') {
    mat.depthTest = false;
    mat.depthWrite = false;
    mesh.renderOrder = -10;
  } else {
    mat.depthTest = true;
    mat.depthWrite = mode === 'plane' && opacity >= 0.999;
    mesh.renderOrder = 0;
  }

  mat.needsUpdate = true;
}

export function applyImageAlignment(mesh, align = 'view', camera = null) {
  if (!mesh) return mesh;
  const normalized = ['view', 'front', 'back', 'left', 'right', 'top'].includes(align) ? align : 'front';
  if (normalized === 'view' && camera?.quaternion) {
    mesh.quaternion.copy(camera.quaternion);
  } else if (normalized === 'back') {
    mesh.rotation.set(0, Math.PI, 0);
  } else if (normalized === 'right') {
    mesh.rotation.set(0, Math.PI / 2, 0);
  } else if (normalized === 'left') {
    mesh.rotation.set(0, -Math.PI / 2, 0);
  } else if (normalized === 'top') {
    mesh.rotation.set(-Math.PI / 2, 0, 0);
  } else {
    mesh.rotation.set(0, 0, 0);
  }
  mesh.userData.align = normalized;
  mesh.updateMatrixWorld?.(true);
  return mesh;
}

/**
 * Create a Blender-standard Image Object (Reference, Background, or Lit Mesh Plane).
 */
export async function createImageObject({
  src = null,
  file = null,
  texture = null,
  name = null,
  mode = 'reference',
  width = 4.0,
  opacity = null,
  align = 'view',
  depthOrder = null,
  displaySide = 'both',
  flipX = false,
  flipY = false,
  position = null,
  pixelWidth = null,
  pixelHeight = null,
  camera = null,
  sceneManager = null,
  scene = null,
  recordHistory = true,
  selectAfter = true,
} = {}) {
  const imageMode = IMAGE_MODES.has(mode) ? mode : 'reference';
  const loaded = await loadImageTexture({ src, file, texture, pixelWidth, pixelHeight });
  const aspect = Math.max(0.05, Math.min(20, loaded.pixelWidth / Math.max(1, loaded.pixelHeight)));
  const resolvedWidth = Math.max(0.05, Number(width) || 4.0);

  const { geometry, height } = buildPlaneGeometryWithFlip(resolvedWidth, aspect, Boolean(flipX), Boolean(flipY));

  const resolvedOpacity = opacity !== null && opacity !== undefined
    ? THREE.MathUtils.clamp(Number(opacity), 0.02, 1)
    : (imageMode === 'background' ? 0.55 : (imageMode === 'reference' ? 0.85 : 1.0));

  const resolvedDepthOrder = depthOrder || (imageMode === 'background' ? 'back' : 'default');

  const material = imageMode === 'plane'
    ? new THREE.MeshStandardMaterial({
      map: loaded.texture,
      roughness: 0.7,
      metalness: 0.0,
      side: sideEnumFromName(displaySide),
      transparent: resolvedOpacity < 0.999,
      opacity: resolvedOpacity,
      alphaTest: resolvedOpacity < 0.999 ? 0.0 : 0.45,
    })
    : new THREE.MeshBasicMaterial({
      map: loaded.texture,
      side: sideEnumFromName(displaySide),
      transparent: true,
      opacity: resolvedOpacity,
      depthWrite: false,
    });

  const mesh = new THREE.Mesh(geometry, material);
  const modePrefix = imageMode === 'background'
    ? 'BG_Image'
    : (imageMode === 'plane' ? 'Image_Plane' : 'Ref_Image');
  const rawBaseName = name || (loaded.fileName ? `${modePrefix}_${stripImageExtension(loaded.fileName)}` : modePrefix);
  mesh.name = rawBaseName;

  mesh.userData = {
    ...(mesh.userData || {}),
    isImageObject: true,
    imageMode,
    fileName: loaded.fileName || name || `${rawBaseName}.png`,
    imageSrc: loaded.imageSrc || '',
    pixelWidth: loaded.pixelWidth,
    pixelHeight: loaded.pixelHeight,
    aspect,
    baseWidth: resolvedWidth,
    opacity: resolvedOpacity,
    flipX: Boolean(flipX),
    flipY: Boolean(flipY),
    displaySide: ['both', 'front', 'back'].includes(displaySide) ? displaySide : 'both',
    depthOrder: ['default', 'front', 'back'].includes(resolvedDepthOrder) ? resolvedDepthOrder : 'default',
    align,
  };

  applyMaterialSettings(mesh);
  applyImageAlignment(mesh, align, camera);

  if (position) {
    mesh.position.set(
      Number(position.x) || 0,
      Number(position.y) || 0,
      Number(position.z) || 0
    );
  } else {
    mesh.position.set(0, align === 'top' ? 0.01 : height * 0.5, 0);
  }
  mesh.updateMatrixWorld?.(true);

  if (sceneManager && typeof sceneManager.addObject === 'function') {
    sceneManager.addObject(mesh, null, selectAfter, recordHistory);
  } else if (scene && typeof scene.add === 'function') {
    scene.add(mesh);
  }

  sceneManager?.requestRender?.();
  return mesh;
}

/**
 * Update properties of an existing Image Object cleanly without breaking transforms/selection.
 */
export function updateImageObjectProperties(mesh, patch = {}) {
  if (!mesh || !mesh.userData?.isImageObject) return mesh;
  const ud = mesh.userData;

  let geometryDirty = false;
  if (patch.baseWidth !== undefined) {
    const nextW = Math.max(0.05, Number(patch.baseWidth));
    if (Number.isFinite(nextW) && Math.abs(nextW - (ud.baseWidth || 4)) > 1e-6) {
      ud.baseWidth = nextW;
      geometryDirty = true;
    }
  }
  if (patch.flipX !== undefined && Boolean(patch.flipX) !== Boolean(ud.flipX)) {
    ud.flipX = Boolean(patch.flipX);
    geometryDirty = true;
  }
  if (patch.flipY !== undefined && Boolean(patch.flipY) !== Boolean(ud.flipY)) {
    ud.flipY = Boolean(patch.flipY);
    geometryDirty = true;
  }
  if (patch.aspect !== undefined && Number.isFinite(Number(patch.aspect)) && Number(patch.aspect) > 0.05) {
    ud.aspect = Number(patch.aspect);
    geometryDirty = true;
  }

  if (geometryDirty) {
    const prevGeom = mesh.geometry;
    const { geometry } = buildPlaneGeometryWithFlip(ud.baseWidth || 4, ud.aspect || 1, ud.flipX, ud.flipY);
    mesh.geometry = geometry;
    prevGeom?.dispose?.();
  }

  if (patch.opacity !== undefined && Number.isFinite(Number(patch.opacity))) {
    ud.opacity = THREE.MathUtils.clamp(Number(patch.opacity), 0.02, 1);
  }
  if (patch.displaySide && ['both', 'front', 'back'].includes(patch.displaySide)) {
    ud.displaySide = patch.displaySide;
  }
  if (patch.depthOrder && ['default', 'front', 'back'].includes(patch.depthOrder)) {
    ud.depthOrder = patch.depthOrder;
  }
  if (patch.imageMode && IMAGE_MODES.has(patch.imageMode) && patch.imageMode !== ud.imageMode) {
    ud.imageMode = patch.imageMode;
  }

  if (patch.align) {
    applyImageAlignment(mesh, patch.align, patch.camera || null);
  }

  applyMaterialSettings(mesh);
  mesh.updateMatrixWorld?.(true);
  return mesh;
}

export async function replaceImageObjectSource(mesh, { src = null, file = null, texture = null, pixelWidth = null, pixelHeight = null } = {}) {
  if (!mesh || !mesh.userData?.isImageObject || !mesh.material) return mesh;
  const loaded = await loadImageTexture({ src, file, texture, pixelWidth, pixelHeight });
  const prevMap = mesh.material.map;
  mesh.material.map = loaded.texture;
  mesh.material.needsUpdate = true;
  if (prevMap && prevMap !== loaded.texture) {
    prevMap.dispose?.();
  }

  const aspect = Math.max(0.05, Math.min(20, loaded.pixelWidth / Math.max(1, loaded.pixelHeight)));
  mesh.userData.pixelWidth = loaded.pixelWidth;
  mesh.userData.pixelHeight = loaded.pixelHeight;
  mesh.userData.imageSrc = loaded.imageSrc || mesh.userData.imageSrc;
  if (loaded.fileName) mesh.userData.fileName = loaded.fileName;

  updateImageObjectProperties(mesh, { aspect });
  return mesh;
}

/**
 * Upgrade a Reference or Background image into a lit MeshStandardMaterial plane
 * that receives lights/shadows while keeping transform, UVs, texture, and UUID intact.
 */
export function convertImageToMeshPlane(mesh, { sceneManager = null } = {}) {
  if (!mesh || !mesh.userData?.isImageObject) return null;
  const prevMat = mesh.material;
  const map = prevMat?.map || null;
  const side = sideEnumFromName(mesh.userData.displaySide || 'both');

  const nextMat = new THREE.MeshStandardMaterial({
    map,
    roughness: 0.7,
    metalness: 0.0,
    side,
    transparent: false,
    opacity: 1.0,
    alphaTest: 0.45,
  });

  mesh.material = nextMat;
  if (prevMat && prevMat !== nextMat) {
    // Do not dispose `map` because it was transferred to `nextMat`.
    prevMat.map = null;
    prevMat.dispose?.();
  }

  mesh.userData.imageMode = 'plane';
  mesh.userData.opacity = 1.0;
  mesh.userData.depthOrder = 'default';
  applyMaterialSettings(mesh);
  sceneManager?.requestRender?.();
  return mesh;
}

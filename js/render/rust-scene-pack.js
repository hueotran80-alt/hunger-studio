/**
 * @file rust-scene-pack.js
 * @description Packs a three.js scene (visible PBR meshes, SkinnedMesh bone poses,
 * UVs, texture atlas, lights, equirect HDR environment, volume fog,
 * perspective/ortho camera + DOF + shutter motion blur)
 * into flat typed arrays consumed by the Rust render kernel.
 *
 * Includes `packSceneGeometryForRefit()` for ultra-fast animation frame 1..N packing
 * (updates only pos/nrm/lights/camera/env with zero texture re-extraction or IPC cloning).
 */
import * as THREE from 'three';
import { getShaderGraphForMaterial } from '../core/shader-graph.js';

export const RUST_LIMITS = { maxTriangles: 2_000_000, maxEnvWidth: 1024, maxTexSize: 2048 };
export const MAT_STRIDE = 32;
export const LIGHT_STRIDE = 16;

const EXCLUDED_HELPER_NAMES = new Set([
  'Floor_Grid',
  'Selection_Helpers',
  'ModalTransform_Helpers',
  'Blender_3D_Cursor',
  'Blender_Measure_Helper',
  'EditMode_GizmoProxy',
  'Camera.Frustum',
]);

export function isRenderExcludedHelper(node) {
  if (!node) return true;
  if (EXCLUDED_HELPER_NAMES.has(node.name)) return true;
  if (
    node.isTransformControls ||
    node.type === 'TransformControlsGizmo' ||
    node.type === 'TransformControlsPlane' ||
    /Helper$/.test(node.type || '')
  ) {
    return true;
  }
  if (
    node.name !== 'Scene_Collection' &&
    node.userData &&
    (node.userData.isHelper ||
      node.userData.isCameraPart ||
      (node.userData.isSystemObject && (!node.children || node.children.length === 0)))
  ) {
    return true;
  }
  return false;
}

function walkVisibleRenderNodes(node, visit) {
  if (!node || node.visible === false) return;
  if (isRenderExcludedHelper(node)) return;
  visit(node);
  const children = node.children;
  if (children && children.length) {
    for (let i = 0; i < children.length; i++) {
      walkVisibleRenderNodes(children[i], visit);
    }
  }
}

export function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + m / 1024);
}

/** Extracts normalized RGBA8 pixels (row 0 = v = 0) from a THREE.Texture. */
function extractTexturePixels(tex) {
  const img = tex?.image;
  if (!img) return null;
  let w = img.width || img.videoWidth || 0;
  let h = img.height || img.videoHeight || 0;
  if (!(w > 0 && h > 0)) return null;

  const flip = !!tex.flipY;
  let rgba = null;

  if (img.data && ArrayBuffer.isView(img.data)) {
    const raw = img.data;
    const stride = Math.floor(raw.length / (w * h));
    if (stride < 1) return null;
    rgba = new Uint8Array(w * h * 4);
    const isFloat = raw instanceof Float32Array;
    const isHalf = raw instanceof Uint16Array;
    for (let y = 0; y < h; y++) {
      const sy = flip ? h - 1 - y : y;
      for (let x = 0; x < w; x++) {
        const si = (sy * w + x) * stride;
        const di = (y * w + x) * 4;
        const read = (c) => {
          const val = raw[si + c];
          if (isFloat) return Math.max(0, Math.min(255, Math.round(val * 255)));
          if (isHalf) return Math.max(0, Math.min(255, Math.round(halfToFloat(val) * 255)));
          return val;
        };
        if (stride === 1) {
          const v = read(0);
          rgba[di] = v; rgba[di + 1] = v; rgba[di + 2] = v; rgba[di + 3] = 255;
        } else if (stride === 2) {
          const v = read(0);
          rgba[di] = v; rgba[di + 1] = v; rgba[di + 2] = v; rgba[di + 3] = read(1);
        } else {
          rgba[di] = read(0);
          rgba[di + 1] = read(1);
          rgba[di + 2] = read(2);
          rgba[di + 3] = stride >= 4 ? read(3) : 255;
        }
      }
    }
    if (w > RUST_LIMITS.maxTexSize || h > RUST_LIMITS.maxTexSize) {
      const scale = RUST_LIMITS.maxTexSize / Math.max(w, h);
      const nw = Math.max(1, Math.floor(w * scale));
      const nh = Math.max(1, Math.floor(h * scale));
      const down = new Uint8Array(nw * nh * 4);
      for (let y = 0; y < nh; y++) {
        const sy = Math.min(h - 1, Math.floor(y * h / nh));
        for (let x = 0; x < nw; x++) {
          const sx = Math.min(w - 1, Math.floor(x * w / nw));
          const si = (sy * w + sx) * 4;
          const di = (y * nw + x) * 4;
          down[di] = rgba[si]; down[di + 1] = rgba[si + 1]; down[di + 2] = rgba[si + 2]; down[di + 3] = rgba[si + 3];
        }
      }
      rgba = down;
      w = nw; h = nh;
    }
    return { rgba, w, h };
  }

  const maxDim = RUST_LIMITS.maxTexSize;
  const scale = Math.max(w, h) > maxDim ? maxDim / Math.max(w, h) : 1;
  const dw = Math.max(1, Math.floor(w * scale));
  const dh = Math.max(1, Math.floor(h * scale));
  let canvas = null;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(dw, dh);
  else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = dw; canvas.height = dh;
  }
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (flip) {
    ctx.translate(0, dh);
    ctx.scale(1, -1);
  }
  ctx.drawImage(img, 0, 0, dw, dh);
  const imgData = ctx.getImageData(0, 0, dw, dh);
  return { rgba: new Uint8Array(imgData.data.buffer), w: dw, h: dh };
}

export function readEnvironment(scene) {
  const raw = scene.userData?.rawEnvironmentSource || scene.environment;
  const data = raw?.image?.data;
  if (!raw?.isDataTexture || !(data instanceof Uint16Array || data instanceof Float32Array)) return null;
  const { width, height } = raw.image;
  const half = data instanceof Uint16Array;
  const stride = data.length / (width * height);
  if (stride < 3) return null;
  const step = Math.max(1, Math.ceil(width / RUST_LIMITS.maxEnvWidth));
  const w = Math.floor(width / step), h = Math.floor(height / step);
  const rgb = new Float32Array(w * h * 3);
  const flip = !raw.flipY;
  for (let y = 0; y < h; y++) {
    const dy = flip ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < step; sy++) for (let sx = 0; sx < step; sx++) {
        const i = ((y * step + sy) * width + (x * step + sx)) * stride;
        r += half ? halfToFloat(data[i]) : data[i];
        g += half ? halfToFloat(data[i + 1]) : data[i + 1];
        b += half ? halfToFloat(data[i + 2]) : data[i + 2];
      }
      const o = (dy * w + x) * 3, n = step * step;
      rgb[o] = r / n; rgb[o + 1] = g / n; rgb[o + 2] = b / n;
    }
  }
  return { rgb, w, h };
}

function packLightNode(node, lights, wpos, quat, scl) {
  if (node.isDirectionalLight) {
    const p = node.getWorldPosition(new THREE.Vector3());
    const t = node.target ? node.target.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
    const d = p.sub(t).normalize();
    const row = new Float32Array(LIGHT_STRIDE);
    const angle = node.userData?.angle ?? 0;
    row.set([1, 0, 0, 0, node.color.r * node.intensity, node.color.g * node.intensity, node.color.b * node.intensity, d.x, d.y, d.z, angle, 0, 0, 0, 0, 0]);
    lights.push(row);
  } else if (node.isSpotLight) {
    const p = node.getWorldPosition(new THREE.Vector3());
    const t = node.target ? node.target.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 0, -1);
    const d = t.sub(p).normalize();
    const angle = node.angle ?? Math.PI / 4;
    const penumbra = node.penumbra ?? 0;
    const cosOuter = Math.cos(angle);
    const cosInner = Math.cos(angle * (1 - penumbra));
    const row = new Float32Array(LIGHT_STRIDE);
    row.set([2, p.x, p.y, p.z, node.color.r * node.intensity, node.color.g * node.intensity, node.color.b * node.intensity, d.x, d.y, d.z, node.userData?.radius ?? 0.02, cosOuter, cosInner, node.distance || 0, node.decay ?? 2, 0]);
    lights.push(row);
  } else if (node.isRectAreaLight) {
    node.matrixWorld.decompose(wpos, quat, scl);
    const normal = new THREE.Vector3(0, 0, -1).applyQuaternion(quat).normalize();
    const uAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(quat).normalize();
    const hw = (node.width || 1) * 0.5 * Math.abs(scl.x);
    const hh = (node.height || 1) * 0.5 * Math.abs(scl.y);
    const row = new Float32Array(LIGHT_STRIDE);
    row.set([3, wpos.x, wpos.y, wpos.z, node.color.r * node.intensity, node.color.g * node.intensity, node.color.b * node.intensity, normal.x, normal.y, normal.z, 0, hw, hh, uAxis.x, uAxis.y, uAxis.z]);
    lights.push(row);
  } else if (node.isPointLight) {
    const p = node.getWorldPosition(new THREE.Vector3());
    const row = new Float32Array(LIGHT_STRIDE);
    row.set([0, p.x, p.y, p.z, node.color.r * node.intensity, node.color.g * node.intensity, node.color.b * node.intensity, 0, 0, 0, node.userData?.radius ?? 0.02, 0, 0, node.distance || 0, node.decay ?? 2, 0]);
    lights.push(row);
  }
}

function packEnvVolumeCamera({ scene, camera, width, height, transparent = false, shutter = 0, cachedEnv = null }) {
  const env = cachedEnv !== null ? cachedEnv : readEnvironment(scene);
  const intensity = env ? (scene.environmentIntensity ?? scene.userData?.environmentIntensity ?? 1) : 0;
  const rotY = scene.environmentRotation?.y ?? ((scene.userData?.environmentRotation || 0) * Math.PI / 180);
  const bg = !transparent && scene.background?.isColor ? scene.background : null;
  const envParams = new Float32Array(16);
  envParams.set([intensity, rotY], 0);
  // bg_mode: 0 = HDRI env visible, 1 = solid bg color, 2 = transparent alpha
  envParams[11] = transparent ? 2 : (bg ? 1 : (env && scene.background === scene.environment ? 0 : 2));
  if (bg) envParams.set([bg.r, bg.g, bg.b], 12);

  let volume = null;
  if (scene.userData?.volume?.density > 0) {
    const vd = scene.userData.volume;
    volume = {
      density: vd.density,
      anisotropy: vd.anisotropy ?? 0,
      color: vd.color || [0.9, 0.9, 0.9],
      maxDist: vd.maxDist ?? 100
    };
  } else if (scene.fog?.isFogExp2 && scene.fog.density > 0) {
    const c = scene.fog.color;
    volume = { density: scene.fog.density, anisotropy: 0, color: [c.r, c.g, c.b], maxDist: 100 };
  }

  const cam = new Float32Array(16);
  const e = camera.matrixWorld.elements;
  const right = new THREE.Vector3(e[0], e[1], e[2]).normalize();
  const up = new THREE.Vector3(e[4], e[5], e[6]).normalize();
  const fwd = new THREE.Vector3(-e[8], -e[9], -e[10]).normalize();
  const aspect = width / height;
  const isOrtho = !!camera.isOrthographicCamera;
  let sx, sy;
  if (isOrtho) {
    const zoom = camera.zoom || 1;
    sx = Math.abs(camera.right - camera.left) / (2 * zoom) || aspect;
    sy = Math.abs(camera.top - camera.bottom) / (2 * zoom) || 1;
  } else {
    sy = Math.tan(THREE.MathUtils.degToRad(camera.fov || 50) / 2) / (camera.zoom || 1);
    sx = sy * aspect;
  }
  const aperture = camera.userData?.aperture ?? scene.userData?.aperture ?? 0;
  const focus = camera.userData?.focusDistance ?? scene.userData?.focusDistance ?? 5;
  const clampedShutter = Math.max(0, Math.min(1, Number(shutter) || 0));
  cam.set([
    e[12], e[13], e[14],
    fwd.x, fwd.y, fwd.z,
    right.x * sx, right.y * sx, right.z * sx,
    up.x * sy, up.y * sy, up.z * sy,
    aperture, focus, isOrtho ? 1 : 0, clampedShutter
  ]);

  return {
    env: { params: envParams, rgb: env?.rgb || null, w: env?.w || 0, h: env?.h || 0 },
    volume,
    camera: cam,
    orthographic: isOrtho,
    _rawEnv: env,
  };
}

/**
 * Evaluates world-space vertex positions & normals for a mesh group, supporting
 * morph targets (shape keys), SkinnedMesh bone poses, and InstancedMesh world matrices.
 */
function writeMeshGroupGeometry(node, geo, g, count, P, N, U, v, v2, nm, worldMatrix = null) {
  const pos = geo.attributes.position;
  const norm = geo.attributes.normal;
  const uvAttr = geo.attributes.uv;
  const matWorld = worldMatrix || node.matrixWorld;

  const influences = node.morphTargetInfluences;
  const morphPosAttrs = geo.morphAttributes?.position;
  const morphNrmAttrs = geo.morphAttributes?.normal;
  const morphRelative = Boolean(geo.morphTargetsRelative);
  let activeMorphPos = null;
  let activeMorphNrm = null;
  if (influences && influences.length) {
    if (morphPosAttrs && morphPosAttrs.length) {
      for (let m = 0; m < morphPosAttrs.length; m++) {
        const w = influences[m];
        if (w) {
          if (!activeMorphPos) activeMorphPos = [];
          activeMorphPos.push([morphPosAttrs[m], w]);
        }
      }
    }
    if (N && norm && morphNrmAttrs && morphNrmAttrs.length) {
      for (let m = 0; m < morphNrmAttrs.length; m++) {
        const w = influences[m];
        if (w) {
          if (!activeMorphNrm) activeMorphNrm = [];
          activeMorphNrm.push([morphNrmAttrs[m], w]);
        }
      }
    }
  }

  const isSkinned = Boolean(
    node.isSkinnedMesh &&
    node.skeleton &&
    geo.attributes.skinIndex &&
    geo.attributes.skinWeight &&
    typeof node.applyBoneTransform === 'function'
  );
  if (isSkinned) {
    node.skeleton.update();
  }
  nm.getNormalMatrix(matWorld);

  for (let t = 0; t < count; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = geo.index ? geo.index.getX(g.start + t * 3 + k) : g.start + t * 3 + k;
      v.fromBufferAttribute(pos, vi);
      if (activeMorphPos) {
        const bx = v.x, by = v.y, bz = v.z;
        for (let m = 0; m < activeMorphPos.length; m++) {
          const [attr, w] = activeMorphPos[m];
          if (morphRelative) {
            v.x += attr.getX(vi) * w;
            v.y += attr.getY(vi) * w;
            v.z += attr.getZ(vi) * w;
          } else {
            v.x += (attr.getX(vi) - bx) * w;
            v.y += (attr.getY(vi) - by) * w;
            v.z += (attr.getZ(vi) - bz) * w;
          }
        }
      }

      if (N && norm) {
        v2.fromBufferAttribute(norm, vi);
        if (activeMorphNrm) {
          const bnx = v2.x, bny = v2.y, bnz = v2.z;
          for (let m = 0; m < activeMorphNrm.length; m++) {
            const [attr, w] = activeMorphNrm[m];
            if (morphRelative) {
              v2.x += attr.getX(vi) * w;
              v2.y += attr.getY(vi) * w;
              v2.z += attr.getZ(vi) * w;
            } else {
              v2.x += (attr.getX(vi) - bnx) * w;
              v2.y += (attr.getY(vi) - bny) * w;
              v2.z += (attr.getZ(vi) - bnz) * w;
            }
          }
          if (v2.lengthSq() > 1e-12) v2.normalize();
        }
      }

      if (isSkinned) {
        if (N && norm) {
          v2.multiplyScalar(0.01).add(v);
          node.applyBoneTransform(vi, v);
          node.applyBoneTransform(vi, v2);
          v2.sub(v).applyMatrix3(nm);
          if (v2.lengthSq() > 1e-12) v2.normalize();
          N.set([v2.x, v2.y, v2.z], t * 9 + k * 3);
        } else {
          node.applyBoneTransform(vi, v);
        }
        v.applyMatrix4(matWorld);
      } else {
        v.applyMatrix4(matWorld);
        if (N && norm) {
          v2.applyMatrix3(nm);
          if (v2.lengthSq() > 1e-12) v2.normalize();
          N.set([v2.x, v2.y, v2.z], t * 9 + k * 3);
        }
      }
      P.set([v.x, v.y, v.z], t * 9 + k * 3);
      if (U && uvAttr) {
        U[t * 6 + k * 2] = uvAttr.getX(vi);
        U[t * 6 + k * 2 + 1] = uvAttr.getY(vi);
      }
    }
  }
}

/**
 * Full scene pack (frame 0 or topology change): meshes + SkinnedMesh poses + textures + materials + shader graphs + lights + env + camera.
 * @param {{scene: THREE.Scene, camera: THREE.Camera, width: number, height: number, maxTriangles?: number, transparent?: boolean, shutter?: number}} o
 */
export function packSceneForRust({ scene, camera, width, height, maxTriangles = RUST_LIMITS.maxTriangles, transparent = false, shutter = 0 }) {
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);

  const texMap = new Map();
  const texChunks = [];
  const texMetaRows = [];
  let texPixelOffset = 0;

  const addTexture = (tex, srgb) => {
    if (!tex) return -1;
    const key = `${tex.uuid}:${srgb ? 1 : 0}`;
    if (texMap.has(key)) return texMap.get(key);
    const extracted = extractTexturePixels(tex);
    if (!extracted) return -1;
    const id = texMetaRows.length;
    texMap.set(key, id);
    texChunks.push(extracted.rgba);
    texMetaRows.push([texPixelOffset, extracted.w, extracted.h, srgb ? 1 : 0]);
    texPixelOffset += extracted.w * extracted.h;
    return id;
  };

  const materialRow = (m) => {
    const row = new Float32Array(MAT_STRIDE);
    const color = m.color || new THREE.Color(0.8, 0.8, 0.8);
    row.set([color.r, color.g, color.b], 0);
    row[3] = m.metalness ?? 0;
    row[4] = m.roughness ?? 0.5;
    if (m.emissive) {
      const k = m.emissiveIntensity ?? 1;
      row.set([m.emissive.r * k, m.emissive.g * k, m.emissive.b * k], 5);
    }
    row[8] = m.transmission ?? 0;
    row[9] = m.ior ?? 1.5;
    row[10] = (m.transparent || (m.opacity !== undefined && m.opacity < 1) || (m.alphaTest > 0))
      ? Math.max(0, Math.min(1, m.opacity ?? 1))
      : 1;

    row[11] = addTexture(m.map, true);
    row[12] = addTexture(m.normalMap, false);
    row[13] = addTexture(m.roughnessMap, false);
    row[14] = addTexture(m.metalnessMap, false);
    row[15] = addTexture(m.emissiveMap, true);

    row[16] = m.clearcoat ?? 0;
    row[17] = m.clearcoatRoughness ?? 0.1;
    row[18] = m.sheen ?? 0;
    row[19] = m.sheenRoughness ?? 0.5;
    if (m.sheenColor) row.set([m.sheenColor.r, m.sheenColor.g, m.sheenColor.b], 20);
    else row.set([1, 1, 1], 20);

    if (m.attenuationColor) row.set([m.attenuationColor.r, m.attenuationColor.g, m.attenuationColor.b], 23);
    else row.set([1, 1, 1], 23);
    row[26] = Number.isFinite(m.attenuationDistance) && m.attenuationDistance > 0 ? m.attenuationDistance : 0;
    row[27] = m.normalScale?.x ?? 1;
    row[28] = m.anisotropy ?? 0;
    row[29] = m.userData?.subsurface ?? 0;
    const rep = m.map?.repeat || m.normalMap?.repeat || m.roughnessMap?.repeat;
    row[30] = rep?.x ?? 1;
    row[31] = rep?.y ?? 1;
    return row;
  };

  const matIndex = new Map();
  const matRows = [];
  const shaderProgs = [];
  const posChunks = [], nrmChunks = [], uvChunks = [], idChunks = [];
  let triCount = 0, skipped = 0;
  const lights = [];
  const v = new THREE.Vector3(), v2 = new THREE.Vector3(), nm = new THREE.Matrix3();
  const quat = new THREE.Quaternion(), scl = new THREE.Vector3(), wpos = new THREE.Vector3();
  const instMat = new THREE.Matrix4(), instWorld = new THREE.Matrix4(), instCol = new THREE.Color();

  const registerMaterial = (mat, tintColor = null) => {
    if (!tintColor && matIndex.has(mat)) return matIndex.get(mat);
    const mIdx = matRows.length;
    const row = materialRow(mat);
    if (tintColor) {
      row[0] *= tintColor.r;
      row[1] *= tintColor.g;
      row[2] *= tintColor.b;
    } else {
      matIndex.set(mat, mIdx);
    }
    matRows.push(row);
    const sg = getShaderGraphForMaterial(mat);
    if (sg) {
      const prog = sg.compileToBytecode((snode) => {
        const slot = snode.props?.slot;
        const tex = slot === 'normal' ? mat.normalMap
          : (slot === 'roughness' ? mat.roughnessMap
            : (slot === 'metalness' ? mat.metalnessMap : mat.map));
        return addTexture(tex, snode.props?.srgb !== false);
      });
      shaderProgs[mIdx] = { ops: prog.ops, consts: prog.consts };
    } else {
      shaderProgs[mIdx] = null;
    }
    return mIdx;
  };

  const resolveMaterialTint = (mat, geo, g, baseTint = null) => {
    let tint = baseTint;
    const colAttr = mat?.vertexColors ? geo?.attributes?.color : null;
    if (colAttr) {
      const start = g.start || 0;
      const totalVerts = g.count || colAttr.count;
      // Accurate full-group weighting up to 65,536 vertices (avoids 192-sample aliasing on large vertex-AO meshes)
      const maxSamples = Math.min(totalVerts, 65536);
      const step = Math.max(1, Math.floor(totalVerts / Math.max(1, maxSamples)));
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let idx = start; idx < start + totalVerts; idx += step) {
        const vi = geo.index ? geo.index.getX(idx) : idx;
        if (vi < colAttr.count) {
          sr += colAttr.getX(vi);
          sg += colAttr.getY(vi);
          sb += colAttr.getZ(vi);
          n++;
        }
      }
      if (n > 0) {
        const vCol = new THREE.Color(sr / n, sg / n, sb / n);
        tint = tint ? tint.clone().multiply(vCol) : vCol;
      }
    }
    return tint;
  };

  walkVisibleRenderNodes(scene, (node) => {
    if (node.isLight) {
      packLightNode(node, lights, wpos, quat, scl);
      return;
    }
    if (!node.isMesh) return;
    const geo = node.geometry;
    const pos = geo?.attributes?.position;
    if (!pos) return;
    // Unwrap viewport MatCap/Wireframe override material cleanly to restore true PBR material
    const matSrc = node.userData?.__originalMaterial || node.material;
    const mats = Array.isArray(matSrc) ? matSrc : [matSrc];
    const norm = geo.attributes.normal;
    const uvAttr = geo.attributes.uv;
    const groups = Array.isArray(matSrc) && geo.groups.length
      ? geo.groups
      : [{ start: 0, count: geo.index ? geo.index.count : pos.count, materialIndex: 0 }];

    if (node.isInstancedMesh) {
      const instCount = Math.max(0, Math.min(node.count | 0, node.instanceMatrix?.count ?? 0));
      if (instCount <= 0) return;
      const hasInstColor = Boolean(node.instanceColor);
      for (let instIdx = 0; instIdx < instCount; instIdx++) {
        node.getMatrixAt(instIdx, instMat);
        instWorld.multiplyMatrices(node.matrixWorld, instMat);
        if (hasInstColor) node.getColorAt(instIdx, instCol);
        for (const g of groups) {
          const mat = mats[g.materialIndex] || mats[0];
          if (!mat || mat.visible === false) { skipped++; continue; }
          const id = registerMaterial(mat, resolveMaterialTint(mat, geo, g, hasInstColor ? instCol : null));
          const count = Math.floor(g.count / 3);
          if (count <= 0) continue;
          if (triCount + count > maxTriangles) throw new Error(`Scene exceeds ${maxTriangles.toLocaleString()} triangles.`);
          const P = new Float32Array(count * 9);
          const N = norm ? new Float32Array(count * 9) : null;
          const U = uvAttr ? new Float32Array(count * 6) : null;
          writeMeshGroupGeometry(node, geo, g, count, P, N, U, v, v2, nm, instWorld);
          posChunks.push(P);
          nrmChunks.push(N || new Float32Array(count * 9));
          uvChunks.push(U || new Float32Array(count * 6));
          idChunks.push(new Uint32Array(count).fill(id));
          triCount += count;
        }
      }
      return;
    }

    for (const g of groups) {
      const mat = mats[g.materialIndex] || mats[0];
      if (!mat || mat.visible === false) { skipped++; continue; }
      const id = registerMaterial(mat, resolveMaterialTint(mat, geo, g, null));
      const count = Math.floor(g.count / 3);
      if (count <= 0) continue;
      if (triCount + count > maxTriangles) throw new Error(`Scene exceeds ${maxTriangles.toLocaleString()} triangles.`);
      const P = new Float32Array(count * 9);
      const N = norm ? new Float32Array(count * 9) : null;
      const U = uvAttr ? new Float32Array(count * 6) : null;
      writeMeshGroupGeometry(node, geo, g, count, P, N, U, v, v2, nm);
      posChunks.push(P);
      nrmChunks.push(N || new Float32Array(count * 9));
      uvChunks.push(U || new Float32Array(count * 6));
      idChunks.push(new Uint32Array(count).fill(id));
      triCount += count;
    }
  });

  const concat = (chunks, Type, len) => {
    const out = new Type(len);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  };
  const mats = concat(matRows, Float32Array, matRows.length * MAT_STRIDE);

  const totalTexBytes = texChunks.reduce((s, c) => s + c.byteLength, 0);
  const texData = new Uint8Array(totalTexBytes);
  let tOff = 0;
  for (const c of texChunks) { texData.set(c, tOff); tOff += c.byteLength; }
  const texMetas = new Uint32Array(texMetaRows.length * 4);
  texMetaRows.forEach((m, i) => texMetas.set(m, i * 4));

  const envCam = packEnvVolumeCamera({ scene, camera, width, height, transparent, shutter });

  return {
    triCount,
    skipped,
    pos: concat(posChunks, Float32Array, triCount * 9),
    nrm: concat(nrmChunks, Float32Array, triCount * 9),
    uvs: concat(uvChunks, Float32Array, triCount * 6),
    matIds: concat(idChunks, Uint32Array, triCount),
    mats,
    shaderProgs,
    lights: concat(lights, Float32Array, lights.length * LIGHT_STRIDE),
    textures: { data: texData, metas: texMetas, count: texMetaRows.length },
    env: envCam.env,
    volume: envCam.volume,
    camera: envCam.camera,
    orthographic: envCam.orthographic,
    _rawEnv: envCam._rawEnv,
  };
}

/**
 * Ultra-fast per-frame animation packer for O(N) Rust BVH refit (`rk_refit`).
 * Skips all texture atlas extraction, UV packing, material encoding, and shader compilation!
 * Returns null if triangle count changed (caller should fall back to full `packSceneForRust`).
 */
export function packSceneGeometryForRefit({ scene, camera, width, height, prevPacked, transparent = false, shutter = 0 }) {
  if (!prevPacked || !prevPacked.triCount) return null;
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);

  const expectedTris = prevPacked.triCount;
  const posOut = new Float32Array(expectedTris * 9);
  const nrmOut = new Float32Array(expectedTris * 9);
  const lights = [];
  const v = new THREE.Vector3(), v2 = new THREE.Vector3(), nm = new THREE.Matrix3();
  const quat = new THREE.Quaternion(), scl = new THREE.Vector3(), wpos = new THREE.Vector3();
  const instMat = new THREE.Matrix4(), instWorld = new THREE.Matrix4();

  let triCursor = 0;
  let mismatch = false;

  walkVisibleRenderNodes(scene, (node) => {
    if (mismatch) return;
    if (node.isLight) {
      packLightNode(node, lights, wpos, quat, scl);
      return;
    }
    if (!node.isMesh) return;
    const geo = node.geometry;
    const pos = geo?.attributes?.position;
    if (!pos) return;
    const matSrc = node.userData?.__originalMaterial || node.material;
    const mats = Array.isArray(matSrc) ? matSrc : [matSrc];
    const norm = geo.attributes.normal;
    const groups = Array.isArray(matSrc) && geo.groups.length
      ? geo.groups
      : [{ start: 0, count: geo.index ? geo.index.count : pos.count, materialIndex: 0 }];

    if (node.isInstancedMesh) {
      const instCount = Math.max(0, Math.min(node.count | 0, node.instanceMatrix?.count ?? 0));
      for (let instIdx = 0; instIdx < instCount; instIdx++) {
        node.getMatrixAt(instIdx, instMat);
        instWorld.multiplyMatrices(node.matrixWorld, instMat);
        for (const g of groups) {
          const mat = mats[g.materialIndex] || mats[0];
          if (!mat || mat.visible === false) continue;
          const count = Math.floor(g.count / 3);
          if (count <= 0) continue;
          if (triCursor + count > expectedTris) {
            mismatch = true;
            return;
          }
          const P = posOut.subarray(triCursor * 9, (triCursor + count) * 9);
          const N = norm ? nrmOut.subarray(triCursor * 9, (triCursor + count) * 9) : null;
          writeMeshGroupGeometry(node, geo, g, count, P, N, null, v, v2, nm, instWorld);
          triCursor += count;
        }
      }
      return;
    }

    for (const g of groups) {
      const mat = mats[g.materialIndex] || mats[0];
      if (!mat || mat.visible === false) continue;
      const count = Math.floor(g.count / 3);
      if (count <= 0) continue;
      if (triCursor + count > expectedTris) {
        mismatch = true;
        return;
      }
      const P = posOut.subarray(triCursor * 9, (triCursor + count) * 9);
      const N = norm ? nrmOut.subarray(triCursor * 9, (triCursor + count) * 9) : null;
      writeMeshGroupGeometry(node, geo, g, count, P, N, null, v, v2, nm);
      triCursor += count;
    }
  });

  if (mismatch || triCursor !== expectedTris) {
    return null;
  }

  const lightsOut = new Float32Array(lights.length * LIGHT_STRIDE);
  for (let i = 0; i < lights.length; i++) lightsOut.set(lights[i], i * LIGHT_STRIDE);

  const envCam = packEnvVolumeCamera({
    scene,
    camera,
    width,
    height,
    transparent,
    shutter,
    cachedEnv: prevPacked._rawEnv !== undefined ? prevPacked._rawEnv : null,
  });

  return {
    refitOnly: true,
    triCount: expectedTris,
    pos: posOut,
    nrm: nrmOut,
    lights: lightsOut,
    env: envCam.env,
    volume: envCam.volume,
    camera: envCam.camera,
    orthographic: envCam.orthographic,
  };
}

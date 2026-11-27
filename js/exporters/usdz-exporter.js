/**
 * Apple AR / Pixar USDZ Exporter (Wave 1C)
 * File: js/exporters/usdz-exporter.js
 *
 * Emits a standards-compliant `.usdz` archive containing:
 *  - `model.usda` (USDA ASCII with Xform hierarchy, Mesh points/normals/UVs, UsdPreviewSurface PBR)
 *  - Embedded texture assets (`.png`/`.jpg`)
 *  - Uncompressed ZIP (method 0) with 64-byte alignment on every file data payload
 *    as required by the USDZ specification and Apple AR Quick Look.
 */

import * as THREE from 'three';

const encoder = new TextEncoder();

// Precompute CRC32 table once
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Builds an uncompressed ZIP archive whose file payloads start on exact
 * 64-byte boundaries (Pixar/Apple USDZ specification §2.1).
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @returns {Uint8Array}
 */
export function buildAlignedUsdzZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
    const crc = crc32(data);

    // Local header size is 30 + nameBytes.length + extraBytes.length
    const baseDataOffset = offset + 30 + nameBytes.length;
    const rem = baseDataOffset % 64;
    const padBytes = rem === 0 ? 0 : 64 - rem;
    // Extra field uses 4-byte header (tag 0x1986 + size) when >= 4, else pad appropriately:
    // If padBytes is 1..3, step to next 64-byte boundary (padBytes + 64) so extra field >= 4 bytes.
    const extraLen = padBytes === 0 ? 0 : (padBytes >= 4 ? padBytes : padBytes + 64);

    const localHeader = new Uint8Array(30 + nameBytes.length + extraLen);
    const ldv = new DataView(localHeader.buffer);
    ldv.setUint32(0, 0x04034b50, true); // Local file header signature
    ldv.setUint16(4, 20, true);         // Version needed (2.0)
    ldv.setUint16(6, 0x0800, true);     // UTF-8 filename flag
    ldv.setUint16(8, 0, true);          // Compression method 0 (STORE)
    ldv.setUint16(10, 0, true);         // Mod time
    ldv.setUint16(12, 0x5421, true);    // Mod date
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, data.byteLength, true);
    ldv.setUint32(22, data.byteLength, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, extraLen, true);
    localHeader.set(nameBytes, 30);
    if (extraLen >= 4) {
      ldv.setUint16(30 + nameBytes.length, 0x1986, true); // USDZ padding extra tag
      ldv.setUint16(30 + nameBytes.length + 2, extraLen - 4, true);
    }

    const dataOffset = offset + localHeader.byteLength;
    localParts.push(localHeader, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true); // Central directory signature
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0x5421, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, data.byteLength, true);
    cdv.setUint32(24, data.byteLength, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset = dataOffset + data.byteLength;
  }

  const centralOffset = offset;
  let centralSize = 0;
  for (const c of centralParts) centralSize += c.byteLength;

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true);
  edv.setUint16(6, 0, true);
  edv.setUint16(8, entries.length, true);
  edv.setUint16(10, entries.length, true);
  edv.setUint32(12, centralSize, true);
  edv.setUint32(16, centralOffset, true);
  edv.setUint16(20, 0, true);

  const totalBytes = centralOffset + centralSize + eocd.byteLength;
  const out = new Uint8Array(totalBytes);
  let cursor = 0;
  for (const part of localParts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  for (const part of centralParts) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  out.set(eocd, cursor);
  return out;
}

function fmt(n) {
  const v = Math.abs(n) < 1e-6 ? 0 : n;
  return Number.isInteger(v) ? String(v) : Number(v.toFixed(6)).toString();
}

function sanitizePrimName(name, fallback = 'Prim') {
  let clean = String(name || fallback).replace(/[^A-Za-z0-9_]/g, '_');
  if (!clean || /^[0-9]/.test(clean)) clean = `_${clean}`;
  return clean;
}

function formatMatrix4RowMajor(mat4) {
  // Three.js Matrix4.elements is column-major; USD matrix4d is row-major for row vectors:
  // v' = M_three * v  =>  v'^T = v^T * M_three^T, so USD row-major stores M_three.elements directly by column-as-row!
  const e = mat4.elements;
  return `( (${fmt(e[0])}, ${fmt(e[1])}, ${fmt(e[2])}, ${fmt(e[3])}), (${fmt(e[4])}, ${fmt(e[5])}, ${fmt(e[6])}, ${fmt(e[7])}), (${fmt(e[8])}, ${fmt(e[9])}, ${fmt(e[10])}, ${fmt(e[11])}), (${fmt(e[12])}, ${fmt(e[13])}, ${fmt(e[14])}, ${fmt(e[15])}) )`;
}

async function extractTextureBytes(texture) {
  const img = texture?.image;
  if (!img) return null;

  // Data URI image
  if (typeof img.src === 'string' && img.src.startsWith('data:')) {
    const comma = img.src.indexOf(',');
    if (comma !== -1) {
      const hdr = img.src.slice(5, comma);
      const body = img.src.slice(comma + 1);
      if (hdr.endsWith(';base64')) {
        const bin = atob(body);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const ext = hdr.includes('jpeg') || hdr.includes('jpg') ? 'jpg' : 'png';
        return { bytes, ext };
      }
    }
  }

  // Canvas / HTMLImageElement / ImageBitmap in browser
  if (typeof document !== 'undefined' && (img.width > 0 && img.height > 0)) {
    try {
      const canvas = typeof img.toDataURL === 'function' ? img : document.createElement('canvas');
      if (canvas !== img) {
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
      }
      const dataUrl = canvas.toDataURL('image/png');
      const b64 = dataUrl.split(',')[1];
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return { bytes, ext: 'png' };
    } catch (_) {}
  }

  return null;
}

function isExportable(node, root) {
  if (!node) return false;
  if (node !== root && node.userData) {
    if (node.userData.isHelper || node.userData.isSystemObject || node.userData.isLightHelper) {
      if (node.name !== 'Scene_Collection') return false;
    }
  }
  if (node.isTransformControls || node.isGridHelper || node.isCameraHelper ||
      node.isPointLightHelper || node.isDirectionalLightHelper || node.isSpotLightHelper) {
    return false;
  }
  return true;
}

export class USDZExporter {
  /**
   * Exports a Three.js Scene or Object3D into a `.usdz` Uint8Array archive.
   * @param {THREE.Object3D} target
   * @param {{ onlyVisible?: boolean, maxMeshes?: number }} [options]
   * @returns {Promise<{ bytes: Uint8Array, usda: string, meshCount: number, materialCount: number, textureCount: number }>}
   */
  async parseAsync(target, options = {}) {
    if (!target) throw new Error('USDZExporter.parseAsync requires a target Object3D/Scene.');
    const onlyVisible = options.onlyVisible !== false;
    target.updateMatrixWorld(true);

    const usedNames = new Set();
    const allocPrim = (base) => {
      const clean = sanitizePrimName(base, 'Object');
      let name = clean;
      let i = 1;
      while (usedNames.has(name)) {
        name = `${clean}_${i++}`;
      }
      usedNames.add(name);
      return name;
    };

    const materialsMap = new Map(); // material -> { name, mat }
    const texturesMap = new Map();  // texture -> { filePath, bytes }
    const textureNames = new Set();

    const registerTexture = async (tex, hint) => {
      if (!tex || !tex.isTexture) return null;
      if (texturesMap.has(tex)) return texturesMap.get(tex).filePath;
      const extracted = await extractTextureBytes(tex);
      if (!extracted) return null;
      let base = sanitizePrimName(tex.name || hint || 'tex');
      let filePath = `textures/${base}.${extracted.ext}`;
      let c = 1;
      while (textureNames.has(filePath)) {
        filePath = `textures/${base}_${c++}.${extracted.ext}`;
      }
      textureNames.add(filePath);
      texturesMap.set(tex, { filePath, bytes: extracted.bytes });
      return filePath;
    };

    const registerMaterial = async (mat) => {
      if (!mat) return null;
      if (materialsMap.has(mat)) return materialsMap.get(mat);
      const name = allocPrim(mat.name || mat.type || 'Material');
      const diffuseTex = await registerTexture(mat.map, `${name}_diffuse`);
      const roughTex = await registerTexture(mat.roughnessMap, `${name}_roughness`);
      const metalTex = await registerTexture(mat.metalnessMap, `${name}_metallic`);
      const normTex = await registerTexture(mat.normalMap, `${name}_normal`);
      const info = { name, mat, diffuseTex, roughTex, metalTex, normTex };
      materialsMap.set(mat, info);
      return info;
    };

    const lines = [
      '#usda 1.0',
      '(',
      '    defaultPrim = "Scene"',
      '    metersPerUnit = 1',
      '    upAxis = "Y"',
      ')',
      '',
      'def Xform "Scene"',
      '{',
    ];

    let meshCount = 0;

    const emitMesh = async (mesh, indent) => {
      const geom = mesh.geometry;
      const posAttr = geom?.attributes?.position;
      if (!posAttr || posAttr.count < 3) return;
      meshCount += 1;

      const primName = allocPrim(mesh.name || `Mesh_${meshCount}`);
      const normAttr = geom.attributes.normal || null;
      const uvAttr = geom.attributes.uv || null;
      const indexAttr = geom.index || null;
      const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);

      const primaryMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const matInfo = await registerMaterial(primaryMat);

      const points = [];
      for (let i = 0; i < posAttr.count; i += 1) {
        points.push(`(${fmt(posAttr.getX(i))}, ${fmt(posAttr.getY(i))}, ${fmt(posAttr.getZ(i))})`);
      }

      const faceVertexCounts = new Array(triCount).fill('3');
      const faceVertexIndices = new Array(triCount * 3);
      for (let t = 0; t < triCount; t += 1) {
        faceVertexIndices[t * 3] = indexAttr ? indexAttr.getX(t * 3) : t * 3;
        faceVertexIndices[t * 3 + 1] = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
        faceVertexIndices[t * 3 + 2] = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;
      }

      const normals = [];
      if (normAttr) {
        for (let i = 0; i < normAttr.count; i += 1) {
          normals.push(`(${fmt(normAttr.getX(i))}, ${fmt(normAttr.getY(i))}, ${fmt(normAttr.getZ(i))})`);
        }
      }

      const uvs = [];
      if (uvAttr) {
        for (let i = 0; i < uvAttr.count; i += 1) {
          uvs.push(`(${fmt(uvAttr.getX(i))}, ${fmt(uvAttr.getY(i))})`);
        }
      }

      mesh.updateMatrix();
      lines.push(
        `${indent}def Mesh "${primName}"` + (matInfo ? ' (\n' + `${indent}    prepend apiSchemas = ["MaterialBindingAPI"]\n` + `${indent})` : ''),
        `${indent}{`,
        `${indent}    matrix4d xformOp:transform = ${formatMatrix4RowMajor(mesh.matrix)}`,
        `${indent}    uniform token[] xformOpOrder = ["xformOp:transform"]`,
        `${indent}    int[] faceVertexCounts = [${faceVertexCounts.join(', ')}]`,
        `${indent}    int[] faceVertexIndices = [${faceVertexIndices.join(', ')}]`,
        `${indent}    point3f[] points = [${points.join(', ')}]`,
      );
      if (normals.length === posAttr.count) {
        lines.push(`${indent}    normal3f[] normals = [${normals.join(', ')}] (\n${indent}        interpolation = "vertex"\n${indent}    )`);
      }
      if (uvs.length === posAttr.count) {
        lines.push(`${indent}    texCoord2f[] primvars:st = [${uvs.join(', ')}] (\n${indent}        interpolation = "vertex"\n${indent}    )`);
      }
      if (matInfo) {
        lines.push(`${indent}    rel material:binding = </Scene/Materials/${matInfo.name}>`);
      }
      lines.push(`${indent}}`);
    };

    const walk = async (node, indent) => {
      if (!isExportable(node, target)) return;
      if (onlyVisible && node !== target && !node.visible) return;

      if (node.isMesh) {
        await emitMesh(node, indent);
        if (node.children?.length) {
          for (const kid of node.children) await walk(kid, indent);
        }
        return;
      }

      if (node === target) {
        for (const kid of node.children || []) {
          await walk(kid, indent);
        }
        return;
      }

      if (node.children?.length) {
        const xformName = allocPrim(node.name || 'Group');
        node.updateMatrix();
        lines.push(
          `${indent}def Xform "${xformName}"`,
          `${indent}{`,
          `${indent}    matrix4d xformOp:transform = ${formatMatrix4RowMajor(node.matrix)}`,
          `${indent}    uniform token[] xformOpOrder = ["xformOp:transform"]`,
        );
        for (const kid of node.children) {
          await walk(kid, `${indent}    `);
        }
        lines.push(`${indent}}`);
      }
    };

    await walk(target, '    ');

    // Emit Materials Scope
    if (materialsMap.size > 0) {
      lines.push('', '    def Scope "Materials"', '    {');
      for (const info of materialsMap.values()) {
        const m = info.mat;
        const c = m.color || new THREE.Color(0xcccccc);
        const e = m.emissive || new THREE.Color(0x000000);
        const roughness = Number.isFinite(m.roughness) ? m.roughness : 0.5;
        const metalness = Number.isFinite(m.metalness) ? m.metalness : 0.0;
        const opacity = m.transparent && Number.isFinite(m.opacity) ? m.opacity : 1.0;

        lines.push(
          `        def Material "${info.name}"`,
          '        {',
          `            token outputs:surface.connect = </Scene/Materials/${info.name}/PreviewSurface.outputs:surface>`,
          '            def Shader "PreviewSurface"',
          '            {',
          '                uniform token info:id = "UsdPreviewSurface"',
          '                token outputs:surface',
        );

        if (info.diffuseTex) {
          lines.push(`                color3f inputs:diffuseColor.connect = </Scene/Materials/${info.name}/TexDiffuse.outputs:rgb>`);
        } else {
          lines.push(`                color3f inputs:diffuseColor = (${fmt(c.r)}, ${fmt(c.g)}, ${fmt(c.b)})`);
        }

        if (info.roughTex) {
          lines.push(`                float inputs:roughness.connect = </Scene/Materials/${info.name}/TexRoughness.outputs:r>`);
        } else {
          lines.push(`                float inputs:roughness = ${fmt(roughness)}`);
        }

        if (info.metalTex) {
          lines.push(`                float inputs:metallic.connect = </Scene/Materials/${info.name}/TexMetallic.outputs:r>`);
        } else {
          lines.push(`                float inputs:metallic = ${fmt(metalness)}`);
        }

        if (info.normTex) {
          lines.push(`                normal3f inputs:normal.connect = </Scene/Materials/${info.name}/TexNormal.outputs:rgb>`);
        }

        lines.push(
          `                color3f inputs:emissiveColor = (${fmt(e.r)}, ${fmt(e.g)}, ${fmt(e.b)})`,
          `                float inputs:opacity = ${fmt(opacity)}`,
          '            }',
        );

        if (info.diffuseTex || info.roughTex || info.metalTex || info.normTex) {
          lines.push(
            '            def Shader "STReader"',
            '            {',
            '                uniform token info:id = "UsdPrimvarReader_float2"',
            '                string inputs:varname = "st"',
            '                float2 outputs:result',
            '            }',
          );
        }

        const emitTexShader = (shaderName, filePath, colorSpace, channelOut = 'rgb', typeOut = 'float3') => {
          lines.push(
            `            def Shader "${shaderName}"`,
            '            {',
            '                uniform token info:id = "UsdUVTexture"',
            `                asset inputs:file = @${filePath}@`,
            `                token inputs:sourceColorSpace = "${colorSpace}"`,
            `                float2 inputs:st.connect = </Scene/Materials/${info.name}/STReader.outputs:result>`,
            `                ${typeOut} outputs:${channelOut}`,
            '            }',
          );
        };
        if (info.diffuseTex) emitTexShader('TexDiffuse', info.diffuseTex, 'sRGB', 'rgb', 'float3');
        if (info.roughTex) emitTexShader('TexRoughness', info.roughTex, 'raw', 'r', 'float');
        if (info.metalTex) emitTexShader('TexMetallic', info.metalTex, 'raw', 'r', 'float');
        if (info.normTex) emitTexShader('TexNormal', info.normTex, 'raw', 'rgb', 'float3');

        lines.push('        }');
      }
      lines.push('    }');
    }

    lines.push('}', '');
    const usda = lines.join('\n');

    const entries = [{ name: 'model.usda', data: encoder.encode(usda) }];
    for (const tex of texturesMap.values()) {
      entries.push({ name: tex.filePath, data: tex.bytes });
    }

    const bytes = buildAlignedUsdzZip(entries);
    return {
      bytes,
      usda,
      meshCount,
      materialCount: materialsMap.size,
      textureCount: texturesMap.size,
    };
  }
}

export default USDZExporter;

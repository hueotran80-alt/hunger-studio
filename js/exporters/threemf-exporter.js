/**
 * 3D Manufacturing Format (.3mf) Exporter (Wave 1C)
 * File: js/exporters/threemf-exporter.js
 *
 * Produces a standard OPC/ZIP 3MF archive (`[Content_Types].xml`, `_rels/.rels`,
 * `3D/3dmodel.model`) with millimeter coordinates, base material colors, and
 * build item world transforms suitable for PrusaSlicer / Bambu Studio / Cura.
 */

import * as THREE from 'three';
import { zipSync, strToU8 } from 'three/addons/libs/fflate.module.js';

function fmt(n) {
  const v = Math.abs(n) < 1e-6 ? 0 : n;
  return Number.isInteger(v) ? String(v) : Number(v.toFixed(5)).toString();
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colorTo3mfHex(mat) {
  const col = mat?.color ? mat.color.clone() : new THREE.Color(0xcccccc);
  const hex = col.getHexString(THREE.SRGBColorSpace).toUpperCase();
  const alpha = mat?.transparent && Number.isFinite(mat.opacity)
    ? Math.max(0, Math.min(255, Math.round(mat.opacity * 255)))
    : 255;
  return alpha < 255 ? `#${hex}${alpha.toString(16).padStart(2, '0').toUpperCase()}` : `#${hex}`;
}

export class ThreeMFExporter {
  /**
   * @param {THREE.Object3D} target
   * @param {{ unitScaleToMm?: number, swapYZ?: boolean, onlyVisible?: boolean }} [options]
   * @returns {{ bytes: Uint8Array, xml: string, meshCount: number, triangleCount: number }}
   */
  parse(target, options = {}) {
    if (!target) throw new Error('ThreeMFExporter.parse requires a target Object3D/Scene.');
    const scale = Number(options.unitScaleToMm ?? 1000); // Three.js meters -> 3MF millimeters
    const swapYZ = options.swapYZ !== false; // Convert Three.js Y-up to 3MF Z-up bed
    const onlyVisible = options.onlyVisible !== false;

    target.updateMatrixWorld(true);

    const meshes = [];
    target.traverse((node) => {
      if (!node?.isMesh || !node.geometry?.attributes?.position) return;
      if (node.userData?.isHelper || node.userData?.isSystemObject || node.userData?.isLightHelper) return;
      if (onlyVisible && !node.visible) return;
      meshes.push(node);
    });

    if (meshes.length === 0) {
      throw new Error('No exportable meshes found for 3MF export.');
    }

    const baseMaterials = [];
    const matToIdx = new Map();
    const registerMat = (mat) => {
      const key = mat ? `${mat.name || ''}_${colorTo3mfHex(mat)}` : 'default';
      if (matToIdx.has(key)) return matToIdx.get(key);
      const idx = baseMaterials.length;
      baseMaterials.push({
        name: escapeXml(mat?.name || `Material_${idx + 1}`),
        color: colorTo3mfHex(mat),
      });
      matToIdx.set(key, idx);
      return idx;
    };

    const objectXmlParts = [];
    const buildItems = [];
    const vTmp = new THREE.Vector3();
    let totalTriangles = 0;
    let nextId = 2; // ID 1 reserved for <basematerials id="1">

    for (const mesh of meshes) {
      const geom = mesh.geometry;
      const posAttr = geom.attributes.position;
      const indexAttr = geom.index;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const matIdx = registerMat(mat);

      const vertsXml = [];
      for (let i = 0; i < posAttr.count; i += 1) {
        vTmp.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
        const x = vTmp.x * scale;
        const y = (swapYZ ? -vTmp.z : vTmp.y) * scale;
        const z = (swapYZ ? vTmp.y : vTmp.z) * scale;
        vertsXml.push(`          <vertex x="${fmt(x)}" y="${fmt(y)}" z="${fmt(z)}" />`);
      }

      const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(posAttr.count / 3);
      totalTriangles += triCount;
      const trisXml = [];
      for (let t = 0; t < triCount; t += 1) {
        const a = indexAttr ? indexAttr.getX(t * 3) : t * 3;
        const b = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
        const c = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;
        trisXml.push(`          <triangle v1="${a}" v2="${b}" v3="${c}" pid="1" p1="${matIdx}" />`);
      }

      const objId = nextId++;
      const objName = escapeXml(mesh.name || `Object_${objId}`);
      objectXmlParts.push([
        `    <object id="${objId}" name="${objName}" type="model" pid="1" pindex="${matIdx}">`,
        '      <mesh>',
        '        <vertices>',
        ...vertsXml,
        '        </vertices>',
        '        <triangles>',
        ...trisXml,
        '        </triangles>',
        '      </mesh>',
        '    </object>',
      ].join('\n'));
      buildItems.push(`    <item objectid="${objId}" />`);
    }

    const baseMatXml = [
      '    <basematerials id="1">',
      ...baseMaterials.map((m) => `      <base name="${m.name}" displaycolor="${m.color}" />`),
      '    </basematerials>',
    ].join('\n');

    const modelXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
      '  <metadata name="Application">Web Blender Studio</metadata>',
      '  <resources>',
      baseMatXml,
      ...objectXmlParts,
      '  </resources>',
      '  <build>',
      ...buildItems,
      '  </build>',
      '</model>',
      '',
    ].join('\n');

    const contentTypesXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />',
      '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />',
      '</Types>',
      '',
    ].join('\n');

    const relsXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
      '  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />',
      '</Relationships>',
      '',
    ].join('\n');

    const bytes = zipSync({
      '[Content_Types].xml': strToU8(contentTypesXml),
      '_rels/.rels': strToU8(relsXml),
      '3D/3dmodel.model': strToU8(modelXml),
    }, { level: 6 });

    return {
      bytes,
      xml: modelXml,
      meshCount: meshes.length,
      triangleCount: totalTriangles,
    };
  }
}

export default ThreeMFExporter;

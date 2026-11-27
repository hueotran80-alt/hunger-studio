/**
 * Full Autodesk FBX 7.4 Exporter (Binary FBX 7400 + optional ASCII FBX 7.4)
 * for Three.js Meshes, Rigged Characters, Skin Deformers, BlendShapes
 * (Morph Targets), Materials & AnimationClips.
 *
 * File: js/animation/fbx-exporter.js
 *
 * Default output emits standards-compliant Binary FBX 7.4 (`bytes: Uint8Array`)
 * accepted natively by Blender 4.x, Unreal, Unity, Maya & Three.js `FBXLoader`.
 * Pass `{ format: 'ascii' }` to emit legacy ASCII FBX 7.4 text (`fbx: string`).
 */

import * as THREE from 'three';
import { zlibSync } from 'three/addons/libs/fflate.module.js';

const FBX_TICKS_PER_SECOND = 46186158000;
const RAD2DEG = 180 / Math.PI;
const FBX_BINARY_HEADER = 'Kaydara FBX Binary  \x00\x1a\x00';
const FBX_VERSION = 7400;
const FBX_SENTINEL_BYTES = 13;
const TEXT_ENCODER = new TextEncoder();

// AST property constructors
const I = (v) => ({ t: 'I', v: v | 0 });
const L = (v) => ({ t: 'L', v: typeof v === 'bigint' ? v : BigInt(Math.trunc(v)) });
const F = (v) => ({ t: 'F', v: Number(v) });
const D = (v) => ({ t: 'D', v: Number(v) });
const S = (v) => ({ t: 'S', v: String(v ?? '') });
const C = (v) => ({ t: 'C', v: typeof v === 'string' ? (v.charCodeAt(0) & 0xff) : (v ? 1 : 0), ch: typeof v === 'string' ? v : (v ? 'Y' : 'T') });
const OName = (name, cls) => ({ t: 'N', name: String(name ?? ''), cls: String(cls ?? '') });
const ConnType = (cType) => ({ t: 'S', v: String(cType) });
const iArr = (arr) => ({ t: 'i', v: arr instanceof Int32Array ? arr : Int32Array.from(arr) });
const lArr = (arr) => ({ t: 'l', v: arr instanceof BigInt64Array ? arr : BigInt64Array.from(arr, (x) => (typeof x === 'bigint' ? x : BigInt(x))) });
const fArr = (arr) => ({ t: 'f', v: arr instanceof Float32Array ? arr : Float32Array.from(arr) });
const dArr = (arr) => ({ t: 'd', v: arr instanceof Float64Array ? arr : Float64Array.from(arr) });

const N = (name, props = [], children = null, forceBlock = false) => ({
  name,
  props,
  children: children && children.length ? children : null,
  forceBlock,
});

const P = (propName, type1, type2, flag, ...vals) =>
  N('P', [S(propName), S(type1), S(type2), S(flag), ...vals]);

function fmt(n) {
  const v = Math.abs(n) < 1e-6 ? 0 : n;
  return Number.isInteger(v) ? String(v) : Number(v.toFixed(5)).toString();
}

function sanitizeFbxName(name, fallback = 'Node') {
  const clean = String(name || fallback).replace(/["\r\n,;{}\x00-\x1f]/g, '_').trim();
  return clean || fallback;
}

function unwrapDeg(prevDeg, curDeg) {
  if (!Number.isFinite(prevDeg)) return curDeg;
  let d = curDeg;
  while (d - prevDeg > 180) d -= 360;
  while (d - prevDeg < -180) d += 360;
  return d;
}

function fbxTick(sec) {
  return BigInt(Math.round(Math.max(0, sec) * FBX_TICKS_PER_SECOND));
}

function isExportableNode(node, root) {
  if (!node) return false;
  if (node !== root && node.userData) {
    if (node.userData.isHelper || node.userData.isSystemObject || node.userData.isLightHelper) {
      if (node.name !== 'Scene_Collection') return false;
    }
  }
  if (
    node.isTransformControls || node.isGridHelper || node.isCameraHelper ||
    node.isPointLightHelper || node.isDirectionalLightHelper || node.isSpotLightHelper
  ) {
    return false;
  }
  return true;
}

function findRootBone(character) {
  if (!character) return null;
  let hipsCandidate = null;
  let firstBone = null;
  character.traverse((o) => {
    if (!o.isBone) return;
    if (!firstBone) firstBone = o;
    const n = (o.name || '').toLowerCase();
    if (!hipsCandidate && (n.includes('hips') || n.includes('pelvis') || n === 'j_bip_c_hips')) {
      hipsCandidate = o;
    }
  });
  return hipsCandidate || firstBone;
}

function buildGeometryPayload(mesh, scale) {
  const geom = mesh.geometry;
  const posAttr = geom?.attributes?.position;
  if (!posAttr || posAttr.count < 3) return null;

  const normAttr = geom.attributes.normal || null;
  const uvAttr = geom.attributes.uv || null;
  const colorAttr = geom.attributes.color || null;
  const indexAttr = geom.index || null;
  const vertCount = posAttr.count;

  const vertices = new Float64Array(vertCount * 3);
  for (let i = 0; i < vertCount; i += 1) {
    vertices[i * 3] = posAttr.getX(i) * scale;
    vertices[i * 3 + 1] = posAttr.getY(i) * scale;
    vertices[i * 3 + 2] = posAttr.getZ(i) * scale;
  }

  const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(vertCount / 3);
  const polyIndices = new Int32Array(triCount * 3);
  const normals = new Float64Array(triCount * 9);
  const uvIndex = uvAttr ? new Int32Array(triCount * 3) : null;
  const colors = colorAttr ? new Float64Array(triCount * 12) : null;

  const matIndices = new Int32Array(triCount);
  if (Array.isArray(geom.groups) && geom.groups.length > 0) {
    for (const grp of geom.groups) {
      const startTri = Math.floor(grp.start / 3);
      const endTri = Math.min(triCount, Math.floor((grp.start + grp.count) / 3));
      const mIdx = Math.max(0, grp.materialIndex || 0);
      for (let t = startTri; t < endTri; t += 1) {
        matIndices[t] = mIdx;
      }
    }
  }

  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const faceN = new THREE.Vector3();
  const tmpColor = new THREE.Color();

  for (let t = 0; t < triCount; t += 1) {
    const ia = indexAttr ? indexAttr.getX(t * 3) : t * 3;
    const ib = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
    const ic = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

    polyIndices[t * 3] = ia;
    polyIndices[t * 3 + 1] = ib;
    polyIndices[t * 3 + 2] = -ic - 1;

    if (normAttr) {
      normals[t * 9] = normAttr.getX(ia);
      normals[t * 9 + 1] = normAttr.getY(ia);
      normals[t * 9 + 2] = normAttr.getZ(ia);
      normals[t * 9 + 3] = normAttr.getX(ib);
      normals[t * 9 + 4] = normAttr.getY(ib);
      normals[t * 9 + 5] = normAttr.getZ(ib);
      normals[t * 9 + 6] = normAttr.getX(ic);
      normals[t * 9 + 7] = normAttr.getY(ic);
      normals[t * 9 + 8] = normAttr.getZ(ic);
    } else {
      vA.fromBufferAttribute(posAttr, ia);
      vB.fromBufferAttribute(posAttr, ib);
      vC.fromBufferAttribute(posAttr, ic);
      e1.subVectors(vB, vA);
      e2.subVectors(vC, vA);
      faceN.crossVectors(e1, e2).normalize();
      for (let k = 0; k < 3; k += 1) {
        normals[t * 9 + k * 3] = faceN.x;
        normals[t * 9 + k * 3 + 1] = faceN.y;
        normals[t * 9 + k * 3 + 2] = faceN.z;
      }
    }

    if (uvIndex) {
      uvIndex[t * 3] = ia;
      uvIndex[t * 3 + 1] = ib;
      uvIndex[t * 3 + 2] = ic;
    }

    if (colors) {
      const idx3 = [ia, ib, ic];
      for (let k = 0; k < 3; k += 1) {
        const vi = idx3[k];
        tmpColor.setRGB(colorAttr.getX(vi), colorAttr.getY(vi), colorAttr.getZ(vi));
        if (typeof tmpColor.convertLinearToSRGB === 'function') {
          tmpColor.convertLinearToSRGB();
        }
        const alpha = colorAttr.itemSize >= 4 ? colorAttr.getW(vi) : 1;
        const base = t * 12 + k * 4;
        colors[base] = tmpColor.r;
        colors[base + 1] = tmpColor.g;
        colors[base + 2] = tmpColor.b;
        colors[base + 3] = alpha;
      }
    }
  }

  let uvs = null;
  if (uvAttr) {
    uvs = new Float64Array(vertCount * 2);
    for (let i = 0; i < vertCount; i += 1) {
      uvs[i * 2] = uvAttr.getX(i);
      uvs[i * 2 + 1] = uvAttr.getY(i);
    }
  }

  // Morph targets (BlendShapes)
  const morphPosList = geom.morphAttributes?.position || [];
  const morphNormList = geom.morphAttributes?.normal || [];
  const morphDict = mesh.morphTargetDictionary || {};
  const reverseDict = new Map();
  for (const [mName, mIdx] of Object.entries(morphDict)) {
    reverseDict.set(mIdx, mName);
  }

  const shapes = [];
  for (let mi = 0; mi < morphPosList.length; mi += 1) {
    const mAttr = morphPosList[mi];
    if (!mAttr) continue;
    const mNormAttr = morphNormList[mi] || null;
    const shapeName = sanitizeFbxName(reverseDict.get(mi) || mAttr.name || `BlendShape_${mi}`, `BlendShape_${mi}`);
    const indexes = [];
    const sVerts = [];
    const sNorms = [];
    const isRelative = Boolean(geom.morphTargetsRelative);

    for (let vi = 0; vi < vertCount; vi += 1) {
      let dx = mAttr.getX(vi);
      let dy = mAttr.getY(vi);
      let dz = mAttr.getZ(vi);
      if (!isRelative) {
        dx -= posAttr.getX(vi);
        dy -= posAttr.getY(vi);
        dz -= posAttr.getZ(vi);
      }
      if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6 || Math.abs(dz) > 1e-6) {
        indexes.push(vi);
        sVerts.push(dx * scale, dy * scale, dz * scale);
        if (mNormAttr) {
          let nx = mNormAttr.getX(vi);
          let ny = mNormAttr.getY(vi);
          let nz = mNormAttr.getZ(vi);
          if (!isRelative && normAttr) {
            nx -= normAttr.getX(vi);
            ny -= normAttr.getY(vi);
            nz -= normAttr.getZ(vi);
          }
          sNorms.push(nx, ny, nz);
        }
      }
    }

    const initialPct = Number(mesh.morphTargetInfluences?.[mi] ?? 0) * 100;
    shapes.push({
      index: mi,
      name: shapeName,
      indexes: Int32Array.from(indexes),
      vertices: Float64Array.from(sVerts),
      normals: Float64Array.from(sNorms),
      initialPct,
    });
  }

  return {
    vertCount,
    triCount,
    vertices,
    polyIndices,
    normals,
    uvs,
    uvIndex,
    colors,
    matIndices,
    hasMultiMat: Array.isArray(mesh.material) && mesh.material.length > 1 && geom.groups?.length > 0,
    shapes,
  };
}

function buildModelTransformProps(pos, rotDeg, scl) {
  return N('Properties70', [], [
    P('InheritType', 'enum', '', '', I(1)),
    P('RotationOrder', 'enum', '', '', I(0)),
    P('Lcl Translation', 'Lcl Translation', '', 'A', D(pos.x), D(pos.y), D(pos.z)),
    P('Lcl Rotation', 'Lcl Rotation', '', 'A', D(rotDeg[0]), D(rotDeg[1]), D(rotDeg[2])),
    P('Lcl Scaling', 'Lcl Scaling', '', 'A', D(scl.x), D(scl.y), D(scl.z)),
  ]);
}

function buildMaterialNode(mat, matId, idx) {
  const name = sanitizeFbxName(mat?.name || `Material_${idx}`, `Material_${idx}`);
  const col = mat?.color ? mat.color.clone() : new THREE.Color(0xcccccc);
  const colSrgb = { r: col.r, g: col.g, b: col.b };
  if (typeof col.getRGB === 'function') col.getRGB(colSrgb, THREE.SRGBColorSpace);

  const em = mat?.emissive ? mat.emissive.clone() : new THREE.Color(0x000000);
  const emSrgb = { r: em.r, g: em.g, b: em.b };
  if (typeof em.getRGB === 'function') em.getRGB(emSrgb, THREE.SRGBColorSpace);

  const roughness = Number.isFinite(mat?.roughness) ? mat.roughness : 0.5;
  const shininess = Math.max(2, Math.round((1 - roughness) * 64));
  const opacity = mat?.transparent && Number.isFinite(mat?.opacity) ? mat.opacity : 1;
  const emFactor = Number.isFinite(mat?.emissiveIntensity) ? mat.emissiveIntensity : 1;

  return N('Material', [L(matId), OName(name, 'Material'), S('')], [
    N('Version', [I(102)]),
    N('ShadingModel', [S('phong')]),
    N('MultiLayer', [I(0)]),
    N('Properties70', [], [
      P('AmbientColor', 'Color', '', 'A', D(0), D(0), D(0)),
      P('DiffuseColor', 'Color', '', 'A', D(colSrgb.r), D(colSrgb.g), D(colSrgb.b)),
      P('EmissiveColor', 'Color', '', 'A', D(emSrgb.r), D(emSrgb.g), D(emSrgb.b)),
      P('EmissiveFactor', 'Number', '', 'A', D(emFactor)),
      P('SpecularColor', 'Color', '', 'A', D(0.5), D(0.5), D(0.5)),
      P('ShininessExponent', 'Number', '', 'A', D(shininess)),
      P('Opacity', 'Number', '', 'A', D(opacity)),
    ]),
  ]);
}

function buildConn(connections, type, src, dst, prop = null) {
  const args = [ConnType(type), L(src), L(dst)];
  if (prop !== null && prop !== undefined) args.push(S(prop));
  connections.push(N('C', args));
}

function buildMeshGeometryNodes(objects, connections, allocId, entry) {
  const payload = entry.payload;
  const geoId = entry.geoId;
  const geoName = sanitizeFbxName(entry.mesh.geometry?.name || `${entry.name}_Geo`);

  const geoChildren = [
    N('Vertices', [dArr(payload.vertices)]),
    N('PolygonVertexIndex', [iArr(payload.polyIndices)]),
    N('GeometryVersion', [I(124)]),
    N('LayerElementNormal', [I(0)], [
      N('Version', [I(102)]),
      N('Name', [S('')]),
      N('MappingInformationType', [S('ByPolygonVertex')]),
      N('ReferenceInformationType', [S('Direct')]),
      N('Normals', [dArr(payload.normals)]),
    ]),
  ];

  const layerElements = [
    N('LayerElement', [], [N('Type', [S('LayerElementNormal')]), N('TypedIndex', [I(0)])]),
  ];

  if (payload.uvs) {
    geoChildren.push(
      N('LayerElementUV', [I(0)], [
        N('Version', [I(101)]),
        N('Name', [S('UVMap')]),
        N('MappingInformationType', [S('ByPolygonVertex')]),
        N('ReferenceInformationType', [S('IndexToDirect')]),
        N('UV', [dArr(payload.uvs)]),
        N('UVIndex', [iArr(payload.uvIndex)]),
      ]),
    );
    layerElements.push(
      N('LayerElement', [], [N('Type', [S('LayerElementUV')]), N('TypedIndex', [I(0)])]),
    );
  }

  if (payload.colors) {
    geoChildren.push(
      N('LayerElementColor', [I(0)], [
        N('Version', [I(101)]),
        N('Name', [S('Col')]),
        N('MappingInformationType', [S('ByPolygonVertex')]),
        N('ReferenceInformationType', [S('Direct')]),
        N('Colors', [dArr(payload.colors)]),
      ]),
    );
    layerElements.push(
      N('LayerElement', [], [N('Type', [S('LayerElementColor')]), N('TypedIndex', [I(0)])]),
    );
  }

  if (payload.hasMultiMat) {
    geoChildren.push(
      N('LayerElementMaterial', [I(0)], [
        N('Version', [I(101)]),
        N('Name', [S('')]),
        N('MappingInformationType', [S('ByPolygon')]),
        N('ReferenceInformationType', [S('IndexToDirect')]),
        N('Materials', [iArr(payload.matIndices)]),
      ]),
    );
  } else {
    geoChildren.push(
      N('LayerElementMaterial', [I(0)], [
        N('Version', [I(101)]),
        N('Name', [S('')]),
        N('MappingInformationType', [S('AllSame')]),
        N('ReferenceInformationType', [S('IndexToDirect')]),
        N('Materials', [iArr([0])]),
      ]),
    );
  }
  layerElements.push(
    N('LayerElement', [], [N('Type', [S('LayerElementMaterial')]), N('TypedIndex', [I(0)])]),
  );

  geoChildren.push(
    N('Layer', [I(0)], [
      N('Version', [I(100)]),
      ...layerElements,
    ]),
  );

  objects.push(N('Geometry', [L(geoId), OName(geoName, 'Geometry'), S('Mesh')], geoChildren));
  buildConn(connections, 'OO', geoId, entry.id);

  // BlendShapes (Morph Targets)
  const channelByMorphIndex = new Map();
  if (payload.shapes.length > 0) {
    const bsId = allocId();
    objects.push(
      N('Deformer', [L(bsId), OName(`${entry.name}_BlendShape`, 'Deformer'), S('BlendShape')], [
        N('Version', [I(100)]),
      ]),
    );
    buildConn(connections, 'OO', bsId, geoId);

    for (const sh of payload.shapes) {
      const chId = allocId();
      const shapeGeoId = allocId();
      channelByMorphIndex.set(sh.index, chId);

      objects.push(
        N('Deformer', [L(chId), OName(sh.name, 'SubDeformer'), S('BlendShapeChannel')], [
          N('Version', [I(100)]),
          N('DeformPercent', [D(sh.initialPct)]),
          N('FullWeights', [dArr([100])]),
        ]),
      );

      const shapeChildren = [
        N('Version', [I(100)]),
        N('Indexes', [iArr(sh.indexes)]),
        N('Vertices', [dArr(sh.vertices)]),
      ];
      if (sh.normals.length === sh.vertices.length && sh.normals.length > 0) {
        shapeChildren.push(N('Normals', [dArr(sh.normals)]));
      }
      objects.push(
        N('Geometry', [L(shapeGeoId), OName(sh.name, 'Geometry'), S('Shape')], shapeChildren),
      );

      buildConn(connections, 'OO', chId, bsId);
      buildConn(connections, 'OO', shapeGeoId, chId);
    }
  }

  return channelByMorphIndex;
}

function buildSkinDeformer(objects, connections, allocId, meshEntry, boneIdMap, scale, poseNodes) {
  const mesh = meshEntry.mesh;
  const geom = mesh.geometry;
  const skeleton = mesh.skeleton;
  if (!mesh.isSkinnedMesh || !skeleton || !Array.isArray(skeleton.bones) || skeleton.bones.length === 0) {
    return;
  }
  const skinIdxAttr = geom.attributes.skinIndex;
  const skinWgtAttr = geom.attributes.skinWeight;
  if (!skinIdxAttr || !skinWgtAttr) return;

  const vertCount = geom.attributes.position.count;
  const perBone = new Map();

  for (let v = 0; v < vertCount; v += 1) {
    const idx4 = [skinIdxAttr.getX(v), skinIdxAttr.getY(v), skinIdxAttr.getZ(v), skinIdxAttr.getW(v)];
    const wgt4 = [skinWgtAttr.getX(v), skinWgtAttr.getY(v), skinWgtAttr.getZ(v), skinWgtAttr.getW(v)];
    for (let k = 0; k < 4; k += 1) {
      const bi = idx4[k];
      const w = wgt4[k];
      if (w > 1e-6 && bi >= 0 && bi < skeleton.bones.length) {
        let bucket = perBone.get(bi);
        if (!bucket) {
          bucket = { indices: [], weights: [] };
          perBone.set(bi, bucket);
        }
        bucket.indices.push(v);
        bucket.weights.push(w);
      }
    }
  }

  const skinId = allocId();
  objects.push(
    N('Deformer', [L(skinId), OName(`${meshEntry.name}_Skin`, 'Deformer'), S('Skin')], [
      N('Version', [I(101)]),
      N('Link_DeformAcuracy', [D(50)]),
    ]),
  );
  buildConn(connections, 'OO', skinId, meshEntry.geoId);

  mesh.updateMatrixWorld(true);
  const meshBindWorld = mesh.bindMatrix ? mesh.bindMatrix.clone() : mesh.matrixWorld.clone();
  if (scale !== 1) {
    meshBindWorld.elements[12] *= scale;
    meshBindWorld.elements[13] *= scale;
    meshBindWorld.elements[14] *= scale;
  }
  poseNodes.set(meshEntry.id, meshBindWorld);

  const tmpMat = new THREE.Matrix4();
  skeleton.bones.forEach((bone, bi) => {
    const boneEntry = boneIdMap.get(bone);
    if (!boneEntry) return;
    const clusterId = allocId();
    const bucket = perBone.get(bi) || { indices: [], weights: [] };

    if (skeleton.boneInverses && skeleton.boneInverses[bi]) {
      tmpMat.copy(skeleton.boneInverses[bi]).invert();
    } else {
      bone.updateMatrixWorld(true);
      tmpMat.copy(bone.matrixWorld);
    }
    if (scale !== 1) {
      tmpMat.elements[12] *= scale;
      tmpMat.elements[13] *= scale;
      tmpMat.elements[14] *= scale;
    }
    poseNodes.set(boneEntry.id, tmpMat.clone());

    const clusterChildren = [
      N('Version', [I(100)]),
      N('UserData', [S(''), S('')]),
    ];
    if (bucket.indices.length > 0) {
      clusterChildren.push(
        N('Indexes', [iArr(bucket.indices)]),
        N('Weights', [dArr(bucket.weights)]),
      );
    }
    clusterChildren.push(
      N('Transform', [dArr(meshBindWorld.elements)]),
      N('TransformLink', [dArr(tmpMat.elements)]),
    );

    objects.push(
      N('Deformer', [L(clusterId), OName(`${boneEntry.name}_Cluster`, 'SubDeformer'), S('Cluster')], clusterChildren),
    );
    buildConn(connections, 'OO', clusterId, skinId);
    buildConn(connections, 'OO', boneEntry.id, clusterId);
  });
}

function buildCurveNode3(objects, connections, allocId, layerId, modelId, attrType, propName, valuesX, valuesY, valuesZ, ticksBig) {
  const cnId = allocId();
  objects.push(
    N('AnimationCurveNode', [L(cnId), OName(attrType, 'AnimCurveNode'), S('')], [
      N('Properties70', [], [
        P('d|X', 'Number', '', 'A', D(valuesX[0] || 0)),
        P('d|Y', 'Number', '', 'A', D(valuesY[0] || 0)),
        P('d|Z', 'Number', '', 'A', D(valuesZ[0] || 0)),
      ]),
    ]),
  );
  for (const [axis, arr] of [['d|X', valuesX], ['d|Y', valuesY], ['d|Z', valuesZ]]) {
    const cId = allocId();
    objects.push(
      N('AnimationCurve', [L(cId), OName('', 'AnimCurve'), S('')], [
        N('Default', [D(0)]),
        N('KeyVer', [I(4008)]),
        N('KeyTime', [lArr(ticksBig)]),
        N('KeyValueFloat', [fArr(arr)]),
      ]),
    );
    buildConn(connections, 'OP', cId, cnId, axis);
  }
  buildConn(connections, 'OO', cnId, layerId);
  buildConn(connections, 'OP', cnId, modelId, propName);
}

function buildFbxHeaderNodes(fps, clipName, unitScaleFactor) {
  const now = new Date();
  return [
    N('FBXHeaderExtension', [], [
      N('FBXHeaderVersion', [I(1003)]),
      N('FBXVersion', [I(FBX_VERSION)]),
      N('EncryptionType', [I(0)]),
      N('CreationTimeStamp', [], [
        N('Version', [I(1000)]),
        N('Year', [I(now.getUTCFullYear())]),
        N('Month', [I(now.getUTCMonth() + 1)]),
        N('Day', [I(now.getUTCDate())]),
        N('Hour', [I(now.getUTCHours())]),
        N('Minute', [I(now.getUTCMinutes())]),
        N('Second', [I(now.getUTCSeconds())]),
        N('Millisecond', [I(now.getUTCMilliseconds())]),
      ]),
      N('Creator', [S('Web Blender Studio')]),
    ]),
    N('GlobalSettings', [], [
      N('Version', [I(1000)]),
      N('Properties70', [], [
        P('UpAxis', 'int', 'Integer', '', I(1)),
        P('UpAxisSign', 'int', 'Integer', '', I(1)),
        P('FrontAxis', 'int', 'Integer', '', I(2)),
        P('FrontAxisSign', 'int', 'Integer', '', I(1)),
        P('CoordAxis', 'int', 'Integer', '', I(0)),
        P('CoordAxisSign', 'int', 'Integer', '', I(1)),
        P('OriginalUpAxis', 'int', 'Integer', '', I(1)),
        P('OriginalUpAxisSign', 'int', 'Integer', '', I(1)),
        P('UnitScaleFactor', 'double', 'Number', '', D(unitScaleFactor)),
        P('OriginalUnitScaleFactor', 'double', 'Number', '', D(unitScaleFactor)),
        P('CustomFrameRate', 'double', 'Number', '', D(fps)),
      ]),
    ]),
    N('Documents', [], [
      N('Count', [I(1)]),
      N('Document', [L(100001), S(''), S('Scene')], [
        N('Properties70', [], [
          P('SourceObject', 'object', '', ''),
          P('ActiveAnimStackName', 'KString', '', '', S(clipName || '')),
        ]),
        N('RootNode', [L(0)]),
      ]),
    ]),
    N('References', [], [], true),
  ];
}

function buildStrictlyIncreasingTicks(frameCount, duration, frameTime) {
  const ticks = new BigInt64Array(frameCount);
  let prev = -1n;
  for (let f = 0; f < frameCount; f += 1) {
    const t = Math.min(duration, f * frameTime);
    let tk = fbxTick(t);
    if (tk <= prev) tk = prev + 1n;
    ticks[f] = tk;
    prev = tk;
  }
  return ticks;
}

// =========================================================================
// SERIALIZERS: BINARY FBX 7.4 & ASCII FBX 7.4
// =========================================================================

class BinaryWriter {
  constructor(initialCapacity = 65536) {
    this.buf = new Uint8Array(initialCapacity);
    this.dv = new DataView(this.buf.buffer);
    this.pos = 0;
  }

  ensure(extra) {
    const need = this.pos + extra;
    if (need <= this.buf.byteLength) return;
    let next = this.buf.byteLength * 2;
    while (next < need) next *= 2;
    const nextBuf = new Uint8Array(next);
    nextBuf.set(this.buf.subarray(0, this.pos));
    this.buf = nextBuf;
    this.dv = new DataView(this.buf.buffer);
  }

  writeBytes(u8) {
    this.ensure(u8.byteLength);
    this.buf.set(u8, this.pos);
    this.pos += u8.byteLength;
  }

  writeZero(count) {
    this.ensure(count);
    this.buf.fill(0, this.pos, this.pos + count);
    this.pos += count;
  }

  writeUint8(v) {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  writeInt16(v) {
    this.ensure(2);
    this.dv.setInt16(this.pos, v, true);
    this.pos += 2;
  }

  writeInt32(v) {
    this.ensure(4);
    this.dv.setInt32(this.pos, v, true);
    this.pos += 4;
  }

  writeUint32(v) {
    this.ensure(4);
    this.dv.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }

  writeBigInt64(v) {
    this.ensure(8);
    this.dv.setBigInt64(this.pos, v, true);
    this.pos += 8;
  }

  writeFloat32(v) {
    this.ensure(4);
    this.dv.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  writeFloat64(v) {
    this.ensure(8);
    this.dv.setFloat64(this.pos, v, true);
    this.pos += 8;
  }

  patchUint32(offset, v) {
    this.dv.setUint32(offset, v >>> 0, true);
  }

  finish() {
    return this.buf.subarray(0, this.pos);
  }
}

function typedArrayToRawBytes(prop) {
  const arr = prop.v;
  if (prop.t === 'i') {
    const out = new Uint8Array(arr.length * 4);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < arr.length; i += 1) dv.setInt32(i * 4, arr[i], true);
    return out;
  }
  if (prop.t === 'l') {
    const out = new Uint8Array(arr.length * 8);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < arr.length; i += 1) dv.setBigInt64(i * 8, arr[i], true);
    return out;
  }
  if (prop.t === 'f') {
    const out = new Uint8Array(arr.length * 4);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < arr.length; i += 1) dv.setFloat32(i * 4, arr[i], true);
    return out;
  }
  // 'd'
  const out = new Uint8Array(arr.length * 8);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < arr.length; i += 1) dv.setFloat64(i * 8, arr[i], true);
  return out;
}

function writeBinaryProperty(w, prop) {
  switch (prop.t) {
    case 'C':
      w.writeUint8(67); // 'C'
      w.writeUint8(prop.v);
      return;
    case 'Y':
      w.writeUint8(89); // 'Y'
      w.writeInt16(prop.v);
      return;
    case 'I':
      w.writeUint8(73); // 'I'
      w.writeInt32(prop.v);
      return;
    case 'L':
      w.writeUint8(76); // 'L'
      w.writeBigInt64(prop.v);
      return;
    case 'F':
      w.writeUint8(70); // 'F'
      w.writeFloat32(prop.v);
      return;
    case 'D':
      w.writeUint8(68); // 'D'
      w.writeFloat64(prop.v);
      return;
    case 'S': {
      const bytes = TEXT_ENCODER.encode(prop.v);
      w.writeUint8(83); // 'S'
      w.writeUint32(bytes.byteLength);
      w.writeBytes(bytes);
      return;
    }
    case 'N': {
      const bytes = TEXT_ENCODER.encode(`${prop.name}\x00\x01${prop.cls}`);
      w.writeUint8(83); // 'S'
      w.writeUint32(bytes.byteLength);
      w.writeBytes(bytes);
      return;
    }
    case 'i':
    case 'l':
    case 'f':
    case 'd': {
      const typeCode = prop.t.charCodeAt(0);
      const count = prop.v.length;
      const raw = typedArrayToRawBytes(prop);
      let payload = raw;
      let encoding = 0;
      if (raw.byteLength > 64) {
        const zipped = zlibSync(raw, { level: 6 });
        if (zipped.byteLength < raw.byteLength) {
          payload = zipped;
          encoding = 1;
        }
      }
      w.writeUint8(typeCode);
      w.writeUint32(count);
      w.writeUint32(encoding);
      w.writeUint32(payload.byteLength);
      w.writeBytes(payload);
      return;
    }
    default:
      throw new Error(`Unsupported FBX binary property type: ${prop.t}`);
  }
}

function writeBinaryNode(w, node) {
  const startOffset = w.pos;
  const nameBytes = TEXT_ENCODER.encode(node.name);
  const props = node.props || [];

  w.writeUint32(0); // placeholder endOffset
  w.writeUint32(props.length);
  const propLenOffset = w.pos;
  w.writeUint32(0); // placeholder propertyListLen
  w.writeUint8(nameBytes.byteLength);
  w.writeBytes(nameBytes);

  const propsStart = w.pos;
  for (let i = 0; i < props.length; i += 1) {
    writeBinaryProperty(w, props[i]);
  }
  const propLen = w.pos - propsStart;
  w.patchUint32(propLenOffset, propLen);

  if (node.children || node.forceBlock) {
    if (node.children) {
      for (let i = 0; i < node.children.length; i += 1) {
        writeBinaryNode(w, node.children[i]);
      }
    }
    w.writeZero(FBX_SENTINEL_BYTES);
  }

  const endOffset = w.pos;
  if (endOffset - startOffset > 0xffffffff) {
    throw new Error('FBX 7.4 binary node exceeded 4 GiB offset limit.');
  }
  w.patchUint32(startOffset, endOffset);
}

/**
 * Serialize AST nodes into standards-compliant Binary FBX 7.4 (`Uint8Array`).
 */
export function serializeFbxBinary(rootNodes) {
  const w = new BinaryWriter(65536);
  w.writeBytes(TEXT_ENCODER.encode(FBX_BINARY_HEADER));
  w.writeUint32(FBX_VERSION);

  for (let i = 0; i < rootNodes.length; i += 1) {
    writeBinaryNode(w, rootNodes[i]);
  }

  // Root NULL sentinel
  w.writeZero(FBX_SENTINEL_BYTES);

  // Standard 160-byte + 16-byte-aligned Binary FBX footer expected by FBXLoader & SDK tools
  const footerId = Uint8Array.from([
    0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66,
    0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e,
  ]);
  const footerTail = Uint8Array.from([
    0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e,
    0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b,
  ]);
  w.writeBytes(footerId);
  const pad = (16 - (w.pos % 16)) || 16;
  w.writeZero(pad);
  w.writeZero(4);
  w.writeUint32(FBX_VERSION);
  w.writeZero(120);
  w.writeBytes(footerTail);

  return w.finish().slice();
}

function escapeAsciiStr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatAsciiProp(prop) {
  switch (prop.t) {
    case 'I':
    case 'Y':
      return String(prop.v);
    case 'L':
      return String(prop.v);
    case 'F':
    case 'D':
      return fmt(prop.v);
    case 'C':
      return prop.ch || (prop.v ? 'Y' : 'T');
    case 'S':
      return `"${escapeAsciiStr(prop.v)}"`;
    case 'N':
      return `"${escapeAsciiStr(prop.cls)}::${escapeAsciiStr(prop.name)}"`;
    default:
      return String(prop.v);
  }
}

function writeAsciiNode(lines, node, depth) {
  const indent = '\t'.repeat(depth);
  const props = node.props || [];
  const hasBlock = Boolean(node.children || node.forceBlock);

  if (props.length === 1 && ['i', 'l', 'f', 'd'].includes(props[0].t) && !hasBlock) {
    const arr = props[0].v;
    const joined = props[0].t === 'l' || props[0].t === 'i'
      ? Array.from(arr, (x) => String(x)).join(',')
      : Array.from(arr, (x) => fmt(x)).join(',');
    lines.push(
      `${indent}${node.name}: *${arr.length} {`,
      `${indent}\ta: ${joined}`,
      `${indent}}`,
    );
    return;
  }

  const propStr = props.map(formatAsciiProp).join(', ');
  if (hasBlock) {
    lines.push(`${indent}${node.name}: ${propStr} {`);
    if (node.children) {
      for (let i = 0; i < node.children.length; i += 1) {
        writeAsciiNode(lines, node.children[i], depth + 1);
      }
    }
    lines.push(`${indent}}`);
  } else {
    lines.push(`${indent}${node.name}: ${propStr}`);
  }
}

/**
 * Serialize AST nodes into ASCII FBX 7.4 text.
 */
export function serializeFbxAscii(rootNodes) {
  const lines = [
    '; FBX 7.4.0 project file',
    '; Created by Web Blender Studio',
    '; ----------------------------------------------------',
    '',
  ];
  for (let i = 0; i < rootNodes.length; i += 1) {
    writeAsciiNode(lines, rootNodes[i], 0);
  }
  lines.push('');
  return lines.join('\n');
}

// =========================================================================
// PUBLIC EXPORTERS
// =========================================================================

/**
 * Exports a Three.js scene or Object3D hierarchy (meshes, materials, skins,
 * blendshapes, skeletons, and optional AnimationClips) to Autodesk FBX 7.4.
 * Defaults to Binary FBX (`bytes: Uint8Array`) compatible with Blender 4.x & FBXLoader.
 *
 * @param {THREE.Object3D} target
 * @param {{fps?:number, scale?:number, unitScaleFactor?:number, format?:'binary'|'ascii'|'both', includeFingers?:boolean, animations?:THREE.AnimationClip[], clip?:THREE.AnimationClip, clipName?:string}} [options]
 */
export function exportSceneToFBX(target, options = {}) {
  if (!target) {
    throw new Error('exportSceneToFBX requires a Three.js Object3D or Scene.');
  }
  const fps = Math.max(10, Math.min(120, Number(options.fps) || 30));
  const scale = Number(options.scale ?? 1.0);
  const unitScaleFactor = Number(options.unitScaleFactor ?? 100.0);
  const includeFingers = options.includeFingers !== false;
  const format = options.format || 'binary';

  target.updateMatrixWorld(true);

  let nextId = 1000000;
  const allocId = () => ++nextId;

  const boneEntries = [];
  const boneMap = new Map();
  const meshEntries = [];
  const groupEntries = [];
  const savedTransforms = new Map();
  const euler = new THREE.Euler(0, 0, 0, 'ZYX');

  const collectChildren = (node, parentId) => {
    if (!isExportableNode(node, target)) return;

    savedTransforms.set(node, {
      position: node.position.clone(),
      quaternion: node.quaternion.clone(),
      scale: node.scale.clone(),
      morphTargetInfluences: Array.isArray(node.morphTargetInfluences) ? [...node.morphTargetInfluences] : null,
    });

    if (node.isBone) {
      if (!includeFingers && /thumb|index|middle|ring|pinky/i.test(node.name || '')) return;
      const id = allocId();
      const attrId = allocId();
      const name = sanitizeFbxName(node.name, `Bone_${boneEntries.length}`);
      euler.setFromQuaternion(node.quaternion, 'ZYX');
      const entry = {
        bone: node,
        id,
        attrId,
        parentId,
        name,
        restPos: node.position.clone().multiplyScalar(scale),
        restRotDeg: [euler.x * RAD2DEG, euler.y * RAD2DEG, euler.z * RAD2DEG],
        restScale: node.scale.clone(),
        rotX: [],
        rotY: [],
        rotZ: [],
        posX: [],
        posY: [],
        posZ: [],
        prevRot: [NaN, NaN, NaN],
      };
      boneEntries.push(entry);
      boneMap.set(node, entry);
      for (const kid of node.children || []) collectChildren(kid, id);
      return;
    }

    if (node.isMesh) {
      const payload = buildGeometryPayload(node, scale);
      if (payload) {
        const id = allocId();
        const geoId = allocId();
        const name = sanitizeFbxName(node.name, `Mesh_${meshEntries.length}`);
        euler.setFromQuaternion(node.quaternion, 'ZYX');
        const entry = {
          mesh: node,
          id,
          geoId,
          parentId,
          name,
          payload,
          restPos: node.position.clone().multiplyScalar(scale),
          restRotDeg: [euler.x * RAD2DEG, euler.y * RAD2DEG, euler.z * RAD2DEG],
          restScale: node.scale.clone(),
          posX: [], posY: [], posZ: [],
          rotX: [], rotY: [], rotZ: [],
          prevRot: [NaN, NaN, NaN],
          morphCurves: payload.shapes.map(() => []),
          channelByMorphIndex: new Map(),
        };
        meshEntries.push(entry);
        for (const kid of node.children || []) collectChildren(kid, id);
        return;
      }
    }

    let curParent = parentId;
    if (node !== target && !node.isLight && !node.isCamera) {
      const id = allocId();
      const name = sanitizeFbxName(node.name, `Group_${groupEntries.length}`);
      euler.setFromQuaternion(node.quaternion, 'ZYX');
      groupEntries.push({
        node,
        id,
        parentId,
        name,
        restPos: node.position.clone().multiplyScalar(scale),
        restRotDeg: [euler.x * RAD2DEG, euler.y * RAD2DEG, euler.z * RAD2DEG],
        restScale: node.scale.clone(),
      });
      curParent = id;
    }

    for (const kid of node.children || []) {
      collectChildren(kid, curParent);
    }
  };

  collectChildren(target, 0);

  // Gather clips
  const clips = [];
  if (options.clip) clips.push(options.clip);
  if (Array.isArray(options.animations)) {
    for (const c of options.animations) if (c && !clips.includes(c)) clips.push(c);
  }
  if (clips.length === 0) {
    const seen = new Set();
    target.traverse((o) => {
      for (const c of o.animations || []) {
        if (c && !seen.has(c) && c.tracks?.length) {
          seen.add(c);
          clips.push(c);
        }
      }
    });
  }

  const primaryClipName = sanitizeFbxName(options.clipName || clips[0]?.name || '');
  const rootNodes = buildFbxHeaderNodes(fps, primaryClipName, unitScaleFactor);
  const objects = [];
  const connections = [];
  const poseNodes = new Map();
  let totalBlendShapes = 0;

  // Group (Null) nodes
  for (const g of groupEntries) {
    objects.push(
      N('Model', [L(g.id), OName(g.name, 'Model'), S('Null')], [
        N('Version', [I(232)]),
        buildModelTransformProps(g.restPos, g.restRotDeg, g.restScale),
        N('Shading', [C('Y')]),
        N('Culling', [S('CullingOff')]),
      ]),
    );
    buildConn(connections, 'OO', g.id, g.parentId);
  }

  // Bone (LimbNode) nodes
  for (const b of boneEntries) {
    objects.push(
      N('NodeAttribute', [L(b.attrId), OName(b.name, 'NodeAttribute'), S('LimbNode')], [
        N('TypeFlags', [S('Skeleton')]),
      ]),
      N('Model', [L(b.id), OName(b.name, 'Model'), S('LimbNode')], [
        N('Version', [I(232)]),
        buildModelTransformProps(b.restPos, b.restRotDeg, b.restScale),
        N('Shading', [C('Y')]),
        N('Culling', [S('CullingOff')]),
      ]),
    );
    buildConn(connections, 'OO', b.id, b.parentId);
    buildConn(connections, 'OO', b.attrId, b.id);
  }

  // Mesh models, Geometries, Materials, Skin Deformers & BlendShapes
  const matCache = new Map();
  for (const mEntry of meshEntries) {
    objects.push(
      N('Model', [L(mEntry.id), OName(mEntry.name, 'Model'), S('Mesh')], [
        N('Version', [I(232)]),
        buildModelTransformProps(mEntry.restPos, mEntry.restRotDeg, mEntry.restScale),
        N('Shading', [C('T')]),
        N('Culling', [S('CullingOff')]),
      ]),
    );
    buildConn(connections, 'OO', mEntry.id, mEntry.parentId);

    mEntry.channelByMorphIndex = buildMeshGeometryNodes(objects, connections, allocId, mEntry);
    totalBlendShapes += mEntry.payload.shapes.length;

    const mats = Array.isArray(mEntry.mesh.material)
      ? mEntry.mesh.material
      : (mEntry.mesh.material ? [mEntry.mesh.material] : [null]);
    mats.forEach((mat) => {
      let matId = mat && matCache.get(mat);
      if (!matId) {
        matId = allocId();
        if (mat) matCache.set(mat, matId);
        objects.push(buildMaterialNode(mat, matId, matCache.size));
      }
      buildConn(connections, 'OO', matId, mEntry.id);
    });

    buildSkinDeformer(objects, connections, allocId, mEntry, boneMap, scale, poseNodes);
  }

  // BindPose
  if (poseNodes.size > 0) {
    const poseId = allocId();
    const poseChildren = [
      N('Type', [S('BindPose')]),
      N('Version', [I(100)]),
      N('NbPoseNodes', [I(poseNodes.size)]),
    ];
    for (const [nodeId, mat4] of poseNodes.entries()) {
      poseChildren.push(
        N('PoseNode', [], [
          N('Node', [L(nodeId)]),
          N('Matrix', [dArr(mat4.elements)]),
        ]),
      );
    }
    objects.push(N('Pose', [L(poseId), OName('BindPose', 'Pose'), S('BindPose')], poseChildren));
  }

  // Sample & emit Animations (non-destructive)
  let lastFrameCount = 0;
  const frameTime = 1 / fps;
  for (let ci = 0; ci < clips.length; ci += 1) {
    const clip = clips[ci];
    const clipName = sanitizeFbxName(ci === 0 && options.clipName ? options.clipName : (clip.name || `Clip_${ci}`));
    const duration = Math.max(frameTime, Number(clip.duration) || 0);
    const frameCount = Math.max(1, Math.round(duration * fps) + 1);
    lastFrameCount = Math.max(lastFrameCount, frameCount);

    for (const b of boneEntries) {
      b.posX = []; b.posY = []; b.posZ = [];
      b.rotX = []; b.rotY = []; b.rotZ = [];
      b.prevRot = [NaN, NaN, NaN];
    }
    for (const m of meshEntries) {
      m.posX = []; m.posY = []; m.posZ = [];
      m.rotX = []; m.rotY = []; m.rotZ = [];
      m.prevRot = [NaN, NaN, NaN];
      m.morphCurves = m.payload.shapes.map(() => []);
    }

    const mixer = new THREE.AnimationMixer(target);
    const action = mixer.clipAction(clip);
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(1.0);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();

    const ticks = buildStrictlyIncreasingTicks(frameCount, duration, frameTime);
    try {
      for (let f = 0; f < frameCount; f += 1) {
        const t = Math.min(duration, f * frameTime);
        mixer.setTime(t);
        target.updateMatrixWorld(true);

        for (const b of boneEntries) {
          b.posX.push(b.bone.position.x * scale);
          b.posY.push(b.bone.position.y * scale);
          b.posZ.push(b.bone.position.z * scale);
          euler.setFromQuaternion(b.bone.quaternion, 'ZYX');
          const rx = unwrapDeg(b.prevRot[0], euler.x * RAD2DEG);
          const ry = unwrapDeg(b.prevRot[1], euler.y * RAD2DEG);
          const rz = unwrapDeg(b.prevRot[2], euler.z * RAD2DEG);
          b.prevRot = [rx, ry, rz];
          b.rotX.push(rx);
          b.rotY.push(ry);
          b.rotZ.push(rz);
        }

        for (const m of meshEntries) {
          m.posX.push(m.mesh.position.x * scale);
          m.posY.push(m.mesh.position.y * scale);
          m.posZ.push(m.mesh.position.z * scale);
          euler.setFromQuaternion(m.mesh.quaternion, 'ZYX');
          const rx = unwrapDeg(m.prevRot[0], euler.x * RAD2DEG);
          const ry = unwrapDeg(m.prevRot[1], euler.y * RAD2DEG);
          const rz = unwrapDeg(m.prevRot[2], euler.z * RAD2DEG);
          m.prevRot = [rx, ry, rz];
          m.rotX.push(rx);
          m.rotY.push(ry);
          m.rotZ.push(rz);

          m.payload.shapes.forEach((sh, si) => {
            const pct = Number(m.mesh.morphTargetInfluences?.[sh.index] ?? 0) * 100;
            m.morphCurves[si].push(pct);
          });
        }
      }
    } finally {
      action.stop();
      mixer.stopAllAction();
      mixer.uncacheRoot(target);
      for (const [obj, tr] of savedTransforms.entries()) {
        obj.position.copy(tr.position);
        obj.quaternion.copy(tr.quaternion);
        obj.scale.copy(tr.scale);
        if (tr.morphTargetInfluences && Array.isArray(obj.morphTargetInfluences)) {
          for (let i = 0; i < tr.morphTargetInfluences.length; i += 1) {
            obj.morphTargetInfluences[i] = tr.morphTargetInfluences[i];
          }
        }
      }
      target.updateMatrixWorld(true);
    }

    const stackId = allocId();
    const layerId = allocId();
    const stopTick = ticks[ticks.length - 1] || fbxTick(duration);

    objects.push(
      N('AnimationStack', [L(stackId), OName(clipName, 'AnimStack'), S('')], [
        N('Properties70', [], [
          P('LocalStart', 'KTime', 'Time', '', L(0)),
          P('LocalStop', 'KTime', 'Time', '', L(stopTick)),
          P('ReferenceStart', 'KTime', 'Time', '', L(0)),
          P('ReferenceStop', 'KTime', 'Time', '', L(stopTick)),
        ]),
      ]),
      N('AnimationLayer', [L(layerId), OName('BaseLayer', 'AnimLayer'), S('')], [], true),
    );
    buildConn(connections, 'OO', layerId, stackId);

    for (const b of boneEntries) {
      buildCurveNode3(objects, connections, allocId, layerId, b.id, 'T', 'Lcl Translation', b.posX, b.posY, b.posZ, ticks);
      buildCurveNode3(objects, connections, allocId, layerId, b.id, 'R', 'Lcl Rotation', b.rotX, b.rotY, b.rotZ, ticks);
    }

    for (const m of meshEntries) {
      const trackTargetsMesh = clip.tracks.some((tr) => tr.name.startsWith(`${m.mesh.name}.`) || tr.name.startsWith('.'));
      if (trackTargetsMesh || boneEntries.length === 0) {
        buildCurveNode3(objects, connections, allocId, layerId, m.id, 'T', 'Lcl Translation', m.posX, m.posY, m.posZ, ticks);
        buildCurveNode3(objects, connections, allocId, layerId, m.id, 'R', 'Lcl Rotation', m.rotX, m.rotY, m.rotZ, ticks);
      }

      m.payload.shapes.forEach((sh, si) => {
        const chId = m.channelByMorphIndex.get(sh.index);
        if (!chId) return;
        const arr = m.morphCurves[si];
        const hasMorphTrack = clip.tracks.some((tr) => tr.name.includes(`morphTargetInfluences[${sh.index}]`) || tr.name.includes(`morphTargetInfluences[${sh.name}]`));
        if (!hasMorphTrack && arr.every((v) => Math.abs(v) < 1e-6)) return;

        const cnId = allocId();
        const curveId = allocId();
        objects.push(
          N('AnimationCurveNode', [L(cnId), OName('DeformPercent', 'AnimCurveNode'), S('')], [
            N('Properties70', [], [P('d|DeformPercent', 'Number', '', 'A', D(arr[0] || 0))]),
          ]),
          N('AnimationCurve', [L(curveId), OName('', 'AnimCurve'), S('')], [
            N('Default', [D(0)]),
            N('KeyVer', [I(4008)]),
            N('KeyTime', [lArr(ticks)]),
            N('KeyValueFloat', [fArr(arr)]),
          ]),
        );
        buildConn(connections, 'OO', cnId, layerId);
        buildConn(connections, 'OP', cnId, chId, 'DeformPercent');
        buildConn(connections, 'OP', curveId, cnId, 'd|DeformPercent');
      });
    }
  }

  rootNodes.push(
    N('Objects', [], objects, true),
    N('Connections', [], connections, true),
  );

  const wantAscii = format === 'ascii' || format === 'both' || options.includeAscii;
  const wantBinary = format !== 'ascii';
  const fbxText = wantAscii ? serializeFbxAscii(rootNodes) : null;
  const bytes = wantBinary ? serializeFbxBinary(rootNodes) : TEXT_ENCODER.encode(fbxText);

  return {
    bytes,
    fbx: fbxText,
    format: wantBinary ? 'binary' : 'ascii',
    meshCount: meshEntries.length,
    boneCount: boneEntries.length,
    blendShapeCount: totalBlendShapes,
    clipCount: clips.length,
    frameCount: lastFrameCount,
    frameTime,
  };
}

/**
 * Serialize a rigged character skeleton (+ any attached Meshes/SkinnedMeshes/BlendShapes)
 * + `THREE.AnimationClip` to Autodesk FBX 7.4 (Binary by default).
 * Non-destructive: restores all bone/root transforms after sampling.
 *
 * @param {THREE.Object3D} character
 * @param {THREE.AnimationClip} clip
 * @param {{fps?:number, scale?:number, unitScaleFactor?:number, format?:'binary'|'ascii'|'both', includeFingers?:boolean, includeMeshes?:boolean, clipName?:string}} [options]
 */
export function exportClipToFBX(character, clip, options = {}) {
  if (!character || !clip) {
    throw new Error('exportClipToFBX requires both a rigged character and an AnimationClip.');
  }
  const rootBone = findRootBone(character);
  if (!rootBone) {
    throw new Error('No THREE.Bone hierarchy found on character.');
  }

  let hasMeshes = false;
  if (options.includeMeshes !== false) {
    character.traverse((o) => {
      if (o.isMesh && o.geometry?.attributes?.position) hasMeshes = true;
    });
  }
  if (hasMeshes) {
    const out = exportSceneToFBX(character, { ...options, clip });
    return {
      ...out,
      duration: Math.max(out.frameTime, Number(clip.duration) || 0),
    };
  }

  const fps = Math.max(10, Math.min(120, Number(options.fps) || 30));
  const scale = Number(options.scale ?? 1.0);
  const unitScaleFactor = Number(options.unitScaleFactor ?? 100.0);
  const includeFingers = options.includeFingers !== false;
  const format = options.format || 'binary';
  const frameTime = 1 / fps;
  const duration = Math.max(frameTime, Number(clip.duration) || 0);
  const frameCount = Math.max(1, Math.round(duration * fps) + 1);
  const clipName = sanitizeFbxName(options.clipName || clip.name || 'MocapClip');

  const savedTransforms = new Map();
  character.traverse((o) => {
    if (o.isBone || o === character) {
      savedTransforms.set(o, {
        position: o.position.clone(),
        quaternion: o.quaternion.clone(),
        scale: o.scale.clone(),
      });
    }
  });

  let nextId = 1000000;
  const allocId = () => ++nextId;

  const bones = [];
  const collectBoneChildren = (bone) => {
    const rawKids = (bone.children || []).filter((c) => c.isBone);
    if (includeFingers) return rawKids;
    return rawKids.filter((c) => !/thumb|index|middle|ring|pinky/i.test(c.name || ''));
  };

  character.updateMatrixWorld(true);
  const armRelMat = new THREE.Matrix4();
  const armRelPos = new THREE.Vector3();
  const armRelQuat = new THREE.Quaternion();
  const armRelScaleVec = new THREE.Vector3(1, 1, 1);
  if (rootBone.parent && rootBone.parent !== character) {
    armRelMat.copy(character.matrixWorld).invert().multiply(rootBone.parent.matrixWorld);
  } else if (rootBone.parent === character) {
    const chQuat = new THREE.Quaternion();
    const chPos = new THREE.Vector3();
    const chScale = new THREE.Vector3(1, 1, 1);
    character.matrixWorld.decompose(chPos, chQuat, chScale);
    armRelMat.compose(new THREE.Vector3(0, 0, 0), new THREE.Quaternion(), chScale);
  }
  armRelMat.decompose(armRelPos, armRelQuat, armRelScaleVec);
  const armScale = (Math.abs(armRelScaleVec.x) + Math.abs(armRelScaleVec.y) + Math.abs(armRelScaleVec.z)) / 3 || 1;
  const effectiveScale = scale * armScale;

  const euler = new THREE.Euler(0, 0, 0, 'ZYX');
  const tmpQuat = new THREE.Quaternion();
  const walk = (bone, parentId, isRoot) => {
    const id = allocId();
    const attrId = allocId();
    const name = sanitizeFbxName(bone.name, `Bone_${bones.length}`);
    const restPos = isRoot
      ? bone.position.clone().applyMatrix4(armRelMat).multiplyScalar(scale)
      : bone.position.clone().multiplyScalar(effectiveScale);
    if (isRoot) {
      tmpQuat.copy(armRelQuat).multiply(bone.quaternion);
    } else {
      tmpQuat.copy(bone.quaternion);
    }
    euler.setFromQuaternion(tmpQuat, 'ZYX');
    const entry = {
      bone,
      id,
      attrId,
      parentId,
      isRoot,
      name,
      restPos,
      restRotDeg: [euler.x * RAD2DEG, euler.y * RAD2DEG, euler.z * RAD2DEG],
      restScale: new THREE.Vector3(1, 1, 1),
      rotX: [],
      rotY: [],
      rotZ: [],
      posX: isRoot ? [] : null,
      posY: isRoot ? [] : null,
      posZ: isRoot ? [] : null,
      prevRot: [NaN, NaN, NaN],
    };
    bones.push(entry);
    for (const kid of collectBoneChildren(bone)) {
      walk(kid, id, false);
    }
  };
  walk(rootBone, 0, true);

  const mixer = new THREE.AnimationMixer(character);
  const action = mixer.clipAction(clip);
  action.reset();
  action.enabled = true;
  action.setEffectiveWeight(1.0);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();

  const ticks = buildStrictlyIncreasingTicks(frameCount, duration, frameTime);
  const rootPosWorld = new THREE.Vector3();

  try {
    for (let f = 0; f < frameCount; f += 1) {
      const t = Math.min(duration, f * frameTime);
      mixer.setTime(t);
      character.updateMatrixWorld(true);

      for (const entry of bones) {
        const b = entry.bone;
        if (entry.isRoot) {
          rootPosWorld.copy(b.position).applyMatrix4(armRelMat).multiplyScalar(scale);
          entry.posX.push(rootPosWorld.x);
          entry.posY.push(rootPosWorld.y);
          entry.posZ.push(rootPosWorld.z);
          tmpQuat.copy(armRelQuat).multiply(b.quaternion);
        } else {
          tmpQuat.copy(b.quaternion);
        }

        euler.setFromQuaternion(tmpQuat, 'ZYX');
        const rx = unwrapDeg(entry.prevRot[0], euler.x * RAD2DEG);
        const ry = unwrapDeg(entry.prevRot[1], euler.y * RAD2DEG);
        const rz = unwrapDeg(entry.prevRot[2], euler.z * RAD2DEG);
        entry.prevRot = [rx, ry, rz];
        entry.rotX.push(rx);
        entry.rotY.push(ry);
        entry.rotZ.push(rz);
      }
    }
  } finally {
    action.stop();
    mixer.stopAllAction();
    mixer.uncacheRoot(character);
    for (const [obj, tr] of savedTransforms.entries()) {
      obj.position.copy(tr.position);
      obj.quaternion.copy(tr.quaternion);
      obj.scale.copy(tr.scale);
    }
    character.updateMatrixWorld(true);
  }

  const stackId = allocId();
  const layerId = allocId();
  const stopTick = ticks[ticks.length - 1] || fbxTick(duration);
  const rootNodes = buildFbxHeaderNodes(fps, clipName, unitScaleFactor);
  const objects = [];
  const connections = [];

  for (const entry of bones) {
    objects.push(
      N('NodeAttribute', [L(entry.attrId), OName(entry.name, 'NodeAttribute'), S('LimbNode')], [
        N('TypeFlags', [S('Skeleton')]),
      ]),
      N('Model', [L(entry.id), OName(entry.name, 'Model'), S('LimbNode')], [
        N('Version', [I(232)]),
        buildModelTransformProps(entry.restPos, entry.restRotDeg, entry.restScale),
        N('Shading', [C('Y')]),
        N('Culling', [S('CullingOff')]),
      ]),
    );
    buildConn(connections, 'OO', entry.id, entry.parentId);
    buildConn(connections, 'OO', entry.attrId, entry.id);
  }

  objects.push(
    N('AnimationStack', [L(stackId), OName(clipName, 'AnimStack'), S('')], [
      N('Properties70', [], [
        P('LocalStart', 'KTime', 'Time', '', L(0)),
        P('LocalStop', 'KTime', 'Time', '', L(stopTick)),
        P('ReferenceStart', 'KTime', 'Time', '', L(0)),
        P('ReferenceStop', 'KTime', 'Time', '', L(stopTick)),
      ]),
    ]),
    N('AnimationLayer', [L(layerId), OName('BaseLayer', 'AnimLayer'), S('')], [], true),
  );
  buildConn(connections, 'OO', layerId, stackId);

  for (const entry of bones) {
    if (entry.isRoot) {
      buildCurveNode3(objects, connections, allocId, layerId, entry.id, 'T', 'Lcl Translation', entry.posX, entry.posY, entry.posZ, ticks);
    }
    buildCurveNode3(objects, connections, allocId, layerId, entry.id, 'R', 'Lcl Rotation', entry.rotX, entry.rotY, entry.rotZ, ticks);
  }

  rootNodes.push(
    N('Objects', [], objects, true),
    N('Connections', [], connections, true),
  );

  const wantAscii = format === 'ascii' || format === 'both' || options.includeAscii;
  const wantBinary = format !== 'ascii';
  const fbxText = wantAscii ? serializeFbxAscii(rootNodes) : null;
  const bytes = wantBinary ? serializeFbxBinary(rootNodes) : TEXT_ENCODER.encode(fbxText);

  return {
    bytes,
    fbx: fbxText,
    format: wantBinary ? 'binary' : 'ascii',
    meshCount: 0,
    boneCount: bones.length,
    blendShapeCount: 0,
    clipCount: 1,
    frameCount,
    frameTime,
    duration,
  };
}

export default exportClipToFBX;

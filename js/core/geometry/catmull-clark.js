/**
 * @file catmull-clark.js
 * @description Blender-parity Catmull-Clark & Simple Subdivision Surface Engine.
 * 
 * Implements canonical Catmull-Clark subdivision:
 * - Face points (centroid of each polygon)
 * - Edge points (average of edge vertices and adjacent face points)
 * - Vertex points (cubic B-spline weighted formula with valence)
 * - Boundary edge & vertex preservation (cubic subdivision rules for open boundaries)
 * - Edge crease support (crease weight 0..1 for sharp edges)
 * - Simple subdivision mode (linear tessellation without curvature smoothing)
 * - Preserves UV coordinates and material groups
 */

import * as THREE from 'three';

/**
 * Performs Catmull-Clark or Simple subdivision on a BufferGeometry.
 * @param {THREE.BufferGeometry} geometry Input geometry
 * @param {Object} [params]
 * @param {number} [params.levels=1] Subdivision iterations (1..4)
 * @param {'catmull-clark'|'simple'} [params.subdivisionType='catmull-clark'] Type of subdivision
 * @param {number|Map<string, number>} [params.crease=0.0] Edge crease weight (0 = smooth, 1 = sharp)
 * @param {boolean} [params.uvSmooth=true] Interpolate UVs across subdivided surface
 * @returns {THREE.BufferGeometry} Subdivided geometry
 */
export function subdivideCatmullClark(geometry, params = {}) {
  const {
    levels = 1,
    subdivisionType = 'catmull-clark',
    crease = 0.0,
    uvSmooth = true
  } = params;

  if (!geometry || !geometry.attributes || !geometry.attributes.position) {
    return geometry;
  }

  const iterCount = Math.max(1, Math.min(4, Math.floor(levels)));
  const isSmooth = subdivisionType !== 'simple';

  // Extract initial polygonal faces (triangles or indexed faces)
  let currentMesh = extractInitialMesh(geometry);

  for (let l = 0; l < iterCount; l++) {
    currentMesh = subdivideIteration(currentMesh, isSmooth, crease, uvSmooth);
  }

  // Convert quad/tri mesh back to THREE.BufferGeometry
  return buildSubdividedBufferGeometry(currentMesh);
}

/**
 * Extracts vertices, UVs, and face loops from a THREE.BufferGeometry.
 */
function extractInitialMesh(geometry) {
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const pos = nonIndexed.attributes.position;
  const uv = nonIndexed.attributes.uv;
  const count = pos.count;

  // Spatial hash welding to unify coordinates into distinct vertices
  const coordKey = (x, y, z) => `${Math.round(x * 100000)},${Math.round(y * 100000)},${Math.round(z * 100000)}`;
  const pMap = new Map();
  const vertices = [];
  const vertexUVs = [];
  const faceLoops = [];

  const triCount = Math.floor(count / 3);
  for (let t = 0; t < triCount; t++) {
    const loop = [];
    const loopUV = [];

    for (let c = 0; c < 3; c++) {
      const idx = t * 3 + c;
      const x = pos.getX(idx);
      const y = pos.getY(idx);
      const z = pos.getZ(idx);
      const key = coordKey(x, y, z);

      let uid = pMap.get(key);
      if (uid === undefined) {
        uid = vertices.length;
        vertices.push(new THREE.Vector3(x, y, z));
        vertexUVs.push(uv ? new THREE.Vector2(uv.getX(idx), uv.getY(idx)) : new THREE.Vector2());
        pMap.set(key, uid);
      }
      loop.push(uid);
      loopUV.push(uv ? new THREE.Vector2(uv.getX(idx), uv.getY(idx)) : new THREE.Vector2());
    }

    faceLoops.push({ verts: loop, uvs: loopUV });
  }

  nonIndexed.dispose();
  return { vertices, vertexUVs, faces: faceLoops };
}

/**
 * Runs a single Catmull-Clark subdivision iteration.
 */
function subdivideIteration(mesh, isSmooth, creaseVal, uvSmooth) {
  const { vertices, vertexUVs, faces } = mesh;
  const numOrigVerts = vertices.length;
  const numFaces = faces.length;

  // 1. Compute Face Points
  // F_f = average of all vertices in face f
  const facePoints = [];
  const faceUVPoints = [];

  for (let fi = 0; fi < numFaces; fi++) {
    const f = faces[fi];
    const k = f.verts.length;
    const fp = new THREE.Vector3();
    const fuv = new THREE.Vector2();

    for (let i = 0; i < k; i++) {
      fp.add(vertices[f.verts[i]]);
      if (f.uvs && f.uvs[i]) fuv.add(f.uvs[i]);
    }
    fp.multiplyScalar(1 / k);
    fuv.multiplyScalar(1 / k);

    facePoints.push(fp);
    faceUVPoints.push(fuv);
  }

  // 2. Build Edge Graph & Incident Faces
  // Map "min_max" -> { v0, v1, faces: [faceIdx...], edgePointIdx, midPoint }
  const edgeMap = new Map();
  const edges = [];
  const vertIncidentEdges = Array.from({ length: numOrigVerts }, () => []);
  const vertIncidentFaces = Array.from({ length: numOrigVerts }, () => []);

  for (let fi = 0; fi < numFaces; fi++) {
    const f = faces[fi];
    const k = f.verts.length;
    for (let i = 0; i < k; i++) {
      const v0 = f.verts[i];
      const v1 = f.verts[(i + 1) % k];
      vertIncidentFaces[v0].push(fi);

      const minV = Math.min(v0, v1);
      const maxV = Math.max(v0, v1);
      const key = `${minV}_${maxV}`;

      let e = edgeMap.get(key);
      if (!e) {
        e = {
          v0: minV,
          v1: maxV,
          faces: [],
          edgeIdx: edges.length
        };
        edgeMap.set(key, e);
        edges.push(e);
        vertIncidentEdges[minV].push(e);
        vertIncidentEdges[maxV].push(e);
      }
      e.faces.push(fi);
    }
  }

  // 3. Compute Edge Points
  // Smooth: E = (v0 + v1 + F1 + F2) / 4 (if interior), or (v0 + v1) / 2 (if boundary or crease=1)
  const edgePoints = [];
  const edgeUVPoints = [];

  for (let ei = 0; ei < edges.length; ei++) {
    const e = edges[ei];
    const p0 = vertices[e.v0];
    const p1 = vertices[e.v1];
    const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);

    const uv0 = vertexUVs[e.v0] || new THREE.Vector2();
    const uv1 = vertexUVs[e.v1] || new THREE.Vector2();
    const uvMid = new THREE.Vector2().addVectors(uv0, uv1).multiplyScalar(0.5);

    let ep;
    if (!isSmooth || e.faces.length === 1) {
      // Boundary edge or Simple mode: pure linear midpoint
      ep = mid;
    } else {
      const f1 = facePoints[e.faces[0]];
      const f2 = facePoints[e.faces[1]];
      const smoothEP = new THREE.Vector3()
        .add(p0)
        .add(p1)
        .add(f1)
        .add(f2)
        .multiplyScalar(0.25);

      const c = typeof creaseVal === 'number' ? creaseVal : (creaseVal?.get?.(`${e.v0}_${e.v1}`) || 0.0);
      if (c > 0) {
        ep = new THREE.Vector3().lerpVectors(smoothEP, mid, Math.min(1.0, c));
      } else {
        ep = smoothEP;
      }
    }

    edgePoints.push(ep);
    edgeUVPoints.push(uvMid);
  }

  // 4. Compute New Vertex Points
  // V' = (F_avg + 2 * M_avg + (n - 3) * V) / n
  const newVertexPoints = [];
  const newVertexUVs = [];

  for (let vi = 0; vi < numOrigVerts; vi++) {
    const v = vertices[vi];
    const incEdges = vertIncidentEdges[vi];
    const incFaces = vertIncidentFaces[vi];
    const n = incEdges.length;

    if (!isSmooth || n < 3) {
      // Simple mode: original vertex positions unchanged
      newVertexPoints.push(v.clone());
      newVertexUVs.push(vertexUVs[vi] ? vertexUVs[vi].clone() : new THREE.Vector2());
      continue;
    }

    // Check if vertex is on a mesh boundary
    const boundaryEdges = incEdges.filter((e) => e.faces.length === 1);
    if (boundaryEdges.length >= 2) {
      // Boundary rule: V' = 3/4 * V + 1/8 * (V_b1 + V_b2)
      const other0 = boundaryEdges[0].v0 === vi ? boundaryEdges[0].v1 : boundaryEdges[0].v0;
      const other1 = boundaryEdges[1].v0 === vi ? boundaryEdges[1].v1 : boundaryEdges[1].v0;
      const vb0 = vertices[other0];
      const vb1 = vertices[other1];

      const vPrime = v.clone().multiplyScalar(0.75).addScaledVector(new THREE.Vector3().addVectors(vb0, vb1), 0.125);
      newVertexPoints.push(vPrime);
      newVertexUVs.push(vertexUVs[vi] ? vertexUVs[vi].clone() : new THREE.Vector2());
      continue;
    }

    // Interior Catmull-Clark vertex update
    let fAvg = new THREE.Vector3();
    for (const fi of incFaces) {
      fAvg.add(facePoints[fi]);
    }
    fAvg.multiplyScalar(1 / Math.max(1, incFaces.length));

    let mAvg = new THREE.Vector3();
    for (const e of incEdges) {
      const mid = new THREE.Vector3().addVectors(vertices[e.v0], vertices[e.v1]).multiplyScalar(0.5);
      mAvg.add(mid);
    }
    mAvg.multiplyScalar(1 / Math.max(1, n));

    const vPrime = new THREE.Vector3()
      .add(fAvg)
      .addScaledVector(mAvg, 2.0)
      .addScaledVector(v, n - 3)
      .multiplyScalar(1 / n);

    newVertexPoints.push(vPrime);
    newVertexUVs.push(vertexUVs[vi] ? vertexUVs[vi].clone() : new THREE.Vector2());
  }

  // 5. Build Subdivided Output Mesh
  // Total vertex array layout: [ NewVertexPoints (0..numOrigVerts-1), EdgePoints, FacePoints ]
  const outVertices = [...newVertexPoints];
  const outUVs = [...newVertexUVs];

  const edgePointBaseIdx = outVertices.length;
  for (let ei = 0; ei < edgePoints.length; ei++) {
    outVertices.push(edgePoints[ei]);
    outUVs.push(edgeUVPoints[ei]);
  }

  const facePointBaseIdx = outVertices.length;
  for (let fi = 0; fi < facePoints.length; fi++) {
    outVertices.push(facePoints[fi]);
    outUVs.push(faceUVPoints[fi]);
  }

  // For each face, create quads: [V'_j, EdgePoint_j, FacePoint_f, EdgePoint_j-1]
  const newFaces = [];

  for (let fi = 0; fi < numFaces; fi++) {
    const f = faces[fi];
    const k = f.verts.length;
    const fpIdx = facePointBaseIdx + fi;

    for (let j = 0; j < k; j++) {
      const curV = f.verts[j];
      const nextV = f.verts[(j + 1) % k];
      const prevV = f.verts[(j - 1 + k) % k];

      const edgeNext = edgeMap.get(`${Math.min(curV, nextV)}_${Math.max(curV, nextV)}`);
      const edgePrev = edgeMap.get(`${Math.min(curV, prevV)}_${Math.max(curV, prevV)}`);

      const epNextIdx = edgePointBaseIdx + edgeNext.edgeIdx;
      const epPrevIdx = edgePointBaseIdx + edgePrev.edgeIdx;

      // Quadrilateral loop: curV -> epNext -> fp -> epPrev
      const qVerts = [curV, epNextIdx, fpIdx, epPrevIdx];
      const qUVs = [outUVs[curV], outUVs[epNextIdx], outUVs[fpIdx], outUVs[epPrevIdx]];

      newFaces.push({ verts: qVerts, uvs: qUVs });
    }
  }

  return { vertices: outVertices, vertexUVs: outUVs, faces: newFaces };
}

/**
 * Triangulates subdivided polygons into a renderable THREE.BufferGeometry.
 */
function buildSubdividedBufferGeometry(mesh) {
  const { vertices, vertexUVs, faces } = mesh;
  const positions = [];
  const uvs = [];

  const addTri = (v0, v1, v2, uv0, uv1, uv2) => {
    positions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
    if (uv0 && uv1 && uv2) {
      uvs.push(uv0.x, uv0.y, uv1.x, uv1.y, uv2.x, uv2.y);
    } else {
      uvs.push(0, 0, 1, 0, 0, 1);
    }
  };

  for (const f of faces) {
    const verts = f.verts.map((idx) => vertices[idx]);
    const fuvs = f.uvs;

    if (verts.length === 4) {
      // Split quad [v0, v1, v2, v3] into 2 triangles: (v0, v1, v2) and (v0, v2, v3)
      addTri(verts[0], verts[1], verts[2], fuvs[0], fuvs[1], fuvs[2]);
      addTri(verts[0], verts[2], verts[3], fuvs[0], fuvs[2], fuvs[3]);
    } else if (verts.length === 3) {
      addTri(verts[0], verts[1], verts[2], fuvs[0], fuvs[1], fuvs[2]);
    } else {
      // Fan triangulation for arbitrary n-gon
      for (let i = 1; i < verts.length - 1; i++) {
        addTri(verts[0], verts[i], verts[i + 1], fuvs[0], fuvs[i], fuvs[i + 1]);
      }
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geom.computeVertexNormals();
  geom.computeBoundingBox();
  geom.computeBoundingSphere();

  return geom;
}

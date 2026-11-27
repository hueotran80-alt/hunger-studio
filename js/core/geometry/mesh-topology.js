/**
 * Phase-1 geometry pipeline — mesh topology kernel (PURE: no THREE, no DOM).
 *
 * Builds a welded half-edge-lite topology from the plain encoded objects
 * produced by geometry-codec.js. Positions are welded within a tolerance via
 * a spatial hash grid, but UV data is kept PER LOOP CORNER (never welded
 * across UV seams). Triangle-based for v1; explicit polygon loops are honored
 * when `encoded.faces` is present.
 */

/**
 * @param {object} encoded  Encoded geometry (position required).
 * @param {{weldTolerance?:number}} [options]
 * @returns {{
 *   vertices: Array<{x:number,y:number,z:number,uvCorners:Array<{u:number,v:number,cornerIndex:number}>,faces:number[],edges:number[],group:number|null}>,
 *   edges: Array<{a:number,b:number,faces:number[],sharp:boolean,crease:number}>,
 *   faces: Array<{loops:number[],uvLoops:Array<{u:number,v:number}|null>,normal:{x:number,y:number,z:number},group:number|null,materialIndex:number}>,
 *   vertexMap: Uint32Array,
 *   cornerUVs: Array<{u:number,v:number,cornerIndex:number}|null>
 * }}
 */
export function buildTopology(encoded, options = {}) {
  if (!encoded || !encoded.position) {
    throw new TypeError('buildTopology: encoded geometry has no position array');
  }
  const weldTolerance = options.weldTolerance !== undefined ? options.weldTolerance : 1e-6;
  const pos = encoded.position;
  const posItemSize = (encoded.itemSizes && encoded.itemSizes.position) || 3;
  const vertexCount = Math.floor(pos.length / posItemSize);
  const uv = encoded.uv || null;
  const uvItemSize = (encoded.itemSizes && encoded.itemSizes.uv) || 2;
  const groups = encoded.groups || [];

  // ---- Weld positions with a spatial hash grid -----------------------------
  const cellSize = Math.max(Math.abs(weldTolerance), 1e-12);
  const tolSq = weldTolerance * weldTolerance;
  const grid = new Map(); // "cx,cy,cz" -> [weldedVertexIdx...]
  const vertices = [];
  const vertexMap = new Uint32Array(vertexCount);

  const cellKey = (cx, cy, cz) => cx + ',' + cy + ',' + cz;

  for (let i = 0; i < vertexCount; i++) {
    const x = pos[i * posItemSize];
    const y = pos[i * posItemSize + 1];
    const z = pos[i * posItemSize + 2];
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    const cz = Math.floor(z / cellSize);

    let welded = -1;
    if (weldTolerance > 0) {
      // Search the 27 neighboring cells; first match in insertion order wins
      // (deterministic).
      outer:
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
            if (!bucket) continue;
            for (const candidate of bucket) {
              const v = vertices[candidate];
              const ddx = v.x - x, ddy = v.y - y, ddz = v.z - z;
              if (ddx * ddx + ddy * ddy + ddz * ddz <= tolSq) {
                welded = candidate;
                break outer;
              }
            }
          }
        }
      }
    }
    if (welded === -1) {
      welded = vertices.length;
      vertices.push({ x, y, z, uvCorners: [], faces: [], edges: [], group: null });
      const key = cellKey(cx, cy, cz);
      let bucket = grid.get(key);
      if (!bucket) { bucket = []; grid.set(key, bucket); }
      bucket.push(welded);
    }
    vertexMap[i] = welded;
  }

  // ---- Face loops ----------------------------------------------------------
  // Explicit polygon loops win; otherwise triangles from index or sequential.
  let faceLoops; // array of arrays of ORIGINAL position indices
  if (Array.isArray(encoded.faces) && encoded.faces.length) {
    faceLoops = encoded.faces.map((f) => (Array.isArray(f) ? f : f.loops));
  } else {
    const index = encoded.index || null;
    const elementCount = index ? index.length : vertexCount;
    const triCount = Math.floor(elementCount / 3);
    faceLoops = new Array(triCount);
    for (let t = 0; t < triCount; t++) {
      const a = t * 3;
      faceLoops[t] = index
        ? [index[a], index[a + 1], index[a + 2]]
        : [a, a + 1, a + 2];
    }
  }

  // Group lookup by element offset (groups are in index/element space).
  function groupAt(elementStart) {
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (elementStart >= g.start && elementStart < g.start + g.count) {
        return { group: gi, materialIndex: g.materialIndex || 0 };
      }
    }
    return { group: null, materialIndex: 0 };
  }

  const faces = [];
  const cornerUVs = [];
  let elementOffset = 0;

  for (let fi = 0; fi < faceLoops.length; fi++) {
    const sourceLoop = faceLoops[fi];
    const { group, materialIndex } = groupAt(elementOffset);
    const loops = new Array(sourceLoop.length);
    const uvLoops = new Array(sourceLoop.length);

    for (let k = 0; k < sourceLoop.length; k++) {
      const sourceIdx = sourceLoop[k];
      const w = vertexMap[sourceIdx];
      loops[k] = w;

      let corner = null;
      if (uv && sourceIdx * uvItemSize + 1 < uv.length) {
        corner = {
          u: uv[sourceIdx * uvItemSize],
          v: uv[sourceIdx * uvItemSize + 1],
          cornerIndex: cornerUVs.length
        };
      }
      cornerUVs.push(corner);
      uvLoops[k] = corner ? { u: corner.u, v: corner.v } : null;
      if (corner) vertices[w].uvCorners.push(corner);

      const v = vertices[w];
      if (v.faces.indexOf(fi) === -1) v.faces.push(fi);
      if (v.group === null) v.group = group;
    }

    // Face normal from the first non-degenerate triple of welded positions.
    let nx = 0, ny = 0, nz = 0;
    for (let k = 1; k + 1 < loops.length; k++) {
      const a = vertices[loops[0]], b = vertices[loops[k]], c = vertices[loops[k + 1]];
      const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z;
      const e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
      nx = e1y * e2z - e1z * e2y;
      ny = e1z * e2x - e1x * e2z;
      nz = e1x * e2y - e1y * e2x;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 1e-12) { nx /= len; ny /= len; nz /= len; break; }
      nx = ny = nz = 0;
    }

    faces.push({ loops, uvLoops, normal: { x: nx, y: ny, z: nz }, group, materialIndex });
    elementOffset += sourceLoop.length;
  }

  // ---- Edges (undirected, welded) ------------------------------------------
  const edges = [];
  const edgeMap = new Map(); // "min_max" -> edgeIdx
  for (let fi = 0; fi < faces.length; fi++) {
    const loops = faces[fi].loops;
    for (let k = 0; k < loops.length; k++) {
      const a = loops[k];
      const b = loops[(k + 1) % loops.length];
      if (a === b) continue; // degenerate after welding
      const key = a < b ? a + '_' + b : b + '_' + a;
      let ei = edgeMap.get(key);
      if (ei === undefined) {
        ei = edges.length;
        edgeMap.set(key, ei);
        edges.push({ a: Math.min(a, b), b: Math.max(a, b), faces: [], sharp: false, crease: 0 });
        if (vertices[a].edges.indexOf(ei) === -1) vertices[a].edges.push(ei);
        if (vertices[b].edges.indexOf(ei) === -1) vertices[b].edges.push(ei);
      }
      const edge = edges[ei];
      if (edge.faces.indexOf(fi) === -1) edge.faces.push(fi);
    }
  }

  return { vertices, edges, faces, vertexMap, cornerUVs };
}

/**
 * Binary selection mask over topology elements.
 * @param {object} topology  Result of buildTopology.
 * @param {{mode?:'vertex'|'edge'|'face', indices?:Iterable<number>}} options
 * @returns {Uint8Array} 1 = selected, length = element count of the mode.
 */
export function selectionMask(topology, options = {}) {
  const mode = options.mode || 'vertex';
  const elements = mode === 'edge' ? topology.edges
    : mode === 'face' ? topology.faces
      : topology.vertices;
  const mask = new Uint8Array(elements.length);
  for (const idx of options.indices || []) {
    if (Number.isInteger(idx) && idx >= 0 && idx < mask.length) mask[idx] = 1;
  }
  return mask;
}

/**
 * Indices of boundary edges (exactly one adjacent face).
 * @param {object} topology
 * @returns {number[]}
 */
export function boundaryEdges(topology) {
  const result = [];
  for (let i = 0; i < topology.edges.length; i++) {
    if (topology.edges[i].faces.length === 1) result.push(i);
  }
  return result;
}

/**
 * Manifold report: edges with >2 faces are non-manifold, edges with 1 face
 * are boundary.
 * @param {object} topology
 * @returns {{nonManifoldEdges:number[], boundaryEdges:number[]}}
 */
export function manifoldCheck(topology) {
  const nonManifoldEdges = [];
  const boundary = [];
  for (let i = 0; i < topology.edges.length; i++) {
    const count = topology.edges[i].faces.length;
    if (count > 2) nonManifoldEdges.push(i);
    else if (count === 1) boundary.push(i);
  }
  return { nonManifoldEdges, boundaryEdges: boundary };
}

/**
 * Convenience helper to extract edges, boundary edges, and adjacency directly from Three.js BufferGeometry or Encoded geometry.
 * @param {object} geometry Three.js BufferGeometry or Encoded geometry
 * @returns {{
 *   edges: Array<{v0: number, v1: number, a: number, b: number, faces: number[]}>,
 *   boundaryEdges: Array<{v0: number, v1: number, a: number, b: number}>,
 *   vertexMap?: Uint32Array
 * }}
 */
export function buildMeshTopology(geometry) {
  let posAttr = null;
  let indexAttr = null;
  if (geometry && geometry.attributes && geometry.attributes.position) {
    posAttr = geometry.attributes.position;
    indexAttr = geometry.index;
  } else if (geometry && geometry.position) {
    // Encoded format fallback
    const topo = buildTopology(geometry);
    const bounds = boundaryEdges(topo);
    return {
      ...topo,
      boundaryEdges: bounds.map((ei) => {
        const e = topo.edges[ei];
        return { v0: e.a, v1: e.b, a: e.a, b: e.b };
      })
    };
  } else {
    return { edges: [], boundaryEdges: [], vertices: [] };
  }

  const vertCount = posAttr.count;
  const triCount = indexAttr ? Math.floor(indexAttr.count / 3) : Math.floor(vertCount / 3);

  // Position hashing to detect geometric boundaries even across duplicated seam vertices
  const coordKey = (x, y, z) => `${Math.round(x * 100000)},${Math.round(y * 100000)},${Math.round(z * 100000)}`;
  const pMap = new Map();
  const geomVerts = new Uint32Array(vertCount);
  for (let i = 0; i < vertCount; i++) {
    const k = coordKey(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    let uid = pMap.get(k);
    if (uid === undefined) {
      uid = i;
      pMap.set(k, uid);
    }
    geomVerts[i] = uid;
  }

  const edgeMap = new Map();
  const edges = [];
  const addEdge = (u, v, faceIdx) => {
    const gu = geomVerts[u];
    const gv = geomVerts[v];
    if (gu === gv) return;
    const key = gu < gv ? `${gu}_${gv}` : `${gv}_${gu}`;
    let entry = edgeMap.get(key);
    if (!entry) {
      entry = { v0: u, v1: v, a: u, b: v, gu, gv, faces: [] };
      edgeMap.set(key, entry);
      edges.push(entry);
    }
    entry.faces.push(faceIdx);
  };

  for (let t = 0; t < triCount; t++) {
    const i0 = indexAttr ? indexAttr.getX(t * 3 + 0) : t * 3 + 0;
    const i1 = indexAttr ? indexAttr.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = indexAttr ? indexAttr.getX(t * 3 + 2) : t * 3 + 2;

    addEdge(i0, i1, t);
    addEdge(i1, i2, t);
    addEdge(i2, i0, t);
  }

  const bEdges = [];
  for (const e of edges) {
    if (e.faces.length === 1) {
      bEdges.push({ v0: e.v0, v1: e.v1, a: e.a, b: e.b });
    }
  }

  return {
    edges: edges.map((e) => ({ v0: e.v0, v1: e.v1, a: e.a, b: e.b, faces: e.faces })),
    boundaryEdges: bEdges
  };
}

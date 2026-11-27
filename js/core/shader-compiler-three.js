/**
 * Compiles ShaderGraph IR to live Three.js GLSL (MeshStandardMaterial / MeshPhysicalMaterial onBeforeCompile)
 * with uniform-only slider updates (zero shader recompilation on parameter drag).
 * File: js/core/shader-compiler-three.js
 */

import * as THREE from 'three';
import { getShaderGraphForMaterial, setShaderGraphForMaterial } from './shader-graph.js';

const ACTIVE_SHADERS = new WeakMap(); // material -> { graph, uniforms, topologyRevision }

const GLSL_NOISE_HELPERS = `
varying vec2 vSgUv;
varying vec3 vSgPos;

float sgFade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float sgHash21(vec2 p, float seed) {
  vec3 p3 = fract(vec3(p.xyx + seed * 0.017) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 sgHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float sgValNoise(vec2 p, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = vec2(sgFade(f.x), sgFade(f.y));
  float a = sgHash21(i, seed);
  float b = sgHash21(i + vec2(1.0, 0.0), seed);
  float c = sgHash21(i + vec2(0.0, 1.0), seed);
  float d = sgHash21(i + vec2(1.0, 1.0), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float sgFbmNoise(vec2 uv, float scale, float detail, float roughness, float seed) {
  float freq = scale;
  float amp = 1.0;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= detail) break;
    sum += sgValNoise(uv * freq, seed + float(i) * 19.0) * amp;
    norm += amp;
    freq *= 2.0;
    amp *= clamp(roughness, 0.0, 1.0);
  }
  return norm > 0.0 ? clamp(sum / norm, 0.0, 1.0) : 0.5;
}
vec4 sgVoronoi(vec2 uv, float scale, float rnd) {
  vec2 p = uv * scale;
  vec2 n = floor(p);
  vec2 f = fract(p);
  float md = 8.0;
  vec3 mcol = vec3(0.5);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = sgHash22(n + g) * clamp(rnd, 0.0, 1.0);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md) {
        md = d;
        vec2 c2 = sgHash22(n + g + vec2(13.7, 29.1));
        mcol = vec3(c2.x, c2.y, fract(c2.x * 3.17 + c2.y));
      }
    }
  }
  return vec4(clamp(sqrt(md), 0.0, 1.0), mcol);
}
float sgFresnel(float cosNV, float ior) {
  float k = clamp(cosNV, 0.0, 1.0);
  float r0 = pow((1.0 - max(1.0, ior)) / (1.0 + max(1.0, ior)), 2.0);
  return clamp(r0 + (1.0 - r0) * pow(1.0 - k, 5.0), 0.0, 1.0);
}
float sgLayerWeightFacing(float cosNV, float blend) {
  float k = clamp(cosNV, 0.0, 1.0);
  float b = clamp(blend, 0.001, 0.999);
  float p = b < 0.5 ? 2.0 * b : 0.5 / (1.0 - b);
  return clamp(1.0 - pow(k, p), 0.0, 1.0);
}
vec3 sgBumpNormal(vec3 N, vec3 surfPos, float height, float strength, float dist) {
  vec3 dPosX = dFdx(surfPos);
  vec3 dPosY = dFdy(surfPos);
  float dHx = dFdx(height);
  float dHy = dFdy(height);
  vec3 r1 = cross(dPosY, N);
  vec3 r2 = cross(N, dPosX);
  float det = dot(dPosX, r1);
  if (abs(det) < 1e-10) return N;
  vec3 surfGrad = sign(det) * (dHx * r1 + dHy * r2);
  float scale = clamp(strength, 0.0, 4.0) * dist * 16.0;
  return normalize(abs(det) * N - scale * surfGrad);
}
vec3 sgNormalMapPerturb(vec3 N, vec3 surfPos, vec2 uvCoord, vec3 mapRgb, float strength) {
  vec3 dPosX = dFdx(surfPos);
  vec3 dPosY = dFdy(surfPos);
  vec2 dUvX = dFdx(uvCoord);
  vec2 dUvY = dFdy(uvCoord);
  vec3 dp2perp = cross(dPosY, N);
  vec3 dp1perp = cross(N, dPosX);
  vec3 T = dp2perp * dUvX.x + dp1perp * dUvY.x;
  vec3 B = dp2perp * dUvX.y + dp1perp * dUvY.y;
  float invMax = inversesqrt(max(dot(T, T), dot(B, B)) + 1e-8);
  vec3 nTan = mapRgb * 2.0 - 1.0;
  nTan.xy *= max(0.0, strength);
  nTan = normalize(nTan);
  return normalize(T * (nTan.x * invMax) + B * (nTan.y * invMax) + N * nTan.z);
}
`;

function hexColor(hex) {
  const c = new THREE.Color(hex || '#ffffff');
  return c;
}

/**
 * Generates uniform table + GLSL declarations and evaluation code for a ShaderGraph.
 */
export function compileShaderGraphToGLSL(graph, resolveTexFn = null) {
  const order = graph.topologicalOrder();
  const uniforms = {};
  const decls = [];
  const evalLines = [];
  const socketExpr = new Map(); // `${nodeId}:${socket}` -> { expr, type }

  const getIn = (nid, sockId, fallbackExpr, fallbackType) => {
    const lnk = graph.getInputLink(nid, sockId);
    if (!lnk) return { expr: fallbackExpr, type: fallbackType };
    const resolved = socketExpr.get(`${lnk.fromNode}:${lnk.fromSocket}`);
    return resolved || { expr: fallbackExpr, type: fallbackType };
  };

  const toVec3 = ({ expr, type }) => (type === 'vec3' ? expr : (type === 'vec2' ? `vec3(${expr}, 0.0)` : `vec3(${expr})`));
  const toFloat = ({ expr, type }) => (type === 'float' ? expr : `${expr}.x`);
  const toVec2 = ({ expr, type }) => (type === 'vec2' ? expr : (type === 'vec3' ? `${expr}.xy` : `vec2(${expr})`));

  let outStruct = {
    baseColor: 'vec3(0.8)',
    metallic: '0.0',
    roughness: '0.5',
    emission: 'vec3(0.0)',
    alpha: '1.0',
    normal: null,
  };

  for (const node of order) {
    const p = node.props || {};
    const uid = `sg_${node.id}`;
    switch (node.type) {
      case 'UVMap': {
        const uRep = `u_${uid}_rep`;
        uniforms[uRep] = { value: new THREE.Vector4(p.repeatX ?? 1, p.repeatY ?? 1, p.offsetX ?? 0, p.offsetY ?? 0) };
        decls.push(`uniform vec4 ${uRep};`);
        const vName = `v_${uid}_uv`;
        evalLines.push(`vec2 ${vName} = vSgUv * ${uRep}.xy + ${uRep}.zw;`);
        socketExpr.set(`${node.id}:uv`, { expr: vName, type: 'vec2' });
        break;
      }
      case 'ImageTexture': {
        const uTex = `u_${uid}_tex`;
        const texObj = typeof resolveTexFn === 'function' ? resolveTexFn(node) : null;
        uniforms[uTex] = { value: texObj };
        decls.push(`uniform sampler2D ${uTex};`);
        const vecIn = toVec2(getIn(node.id, 'vector', 'vSgUv', 'vec2'));
        const smp = `v_${uid}_smp`;
        if (texObj) {
          evalLines.push(`vec4 ${smp} = texture2D(${uTex}, ${vecIn});`);
        } else {
          evalLines.push(`vec4 ${smp} = vec4(1.0);`);
        }
        socketExpr.set(`${node.id}:color`, { expr: `${smp}.rgb`, type: 'vec3' });
        socketExpr.set(`${node.id}:alpha`, { expr: `${smp}.a`, type: 'float' });
        break;
      }
      case 'NoiseTexture': {
        const uParams = `u_${uid}_params`;
        uniforms[uParams] = { value: new THREE.Vector4(p.scale ?? 6.0, p.detail ?? 4, p.roughness ?? 0.5, p.seed ?? 42) };
        decls.push(`uniform vec4 ${uParams};`);
        const vecIn = toVec2(getIn(node.id, 'vector', 'vSgUv', 'vec2'));
        const fac = `v_${uid}_fac`;
        evalLines.push(`float ${fac} = sgFbmNoise(${vecIn}, ${uParams}.x, ${uParams}.y, ${uParams}.z, ${uParams}.w);`);
        socketExpr.set(`${node.id}:fac`, { expr: fac, type: 'float' });
        socketExpr.set(`${node.id}:color`, { expr: `vec3(${fac})`, type: 'vec3' });
        break;
      }
      case 'VoronoiTexture': {
        const uParams = `u_${uid}_params`;
        uniforms[uParams] = { value: new THREE.Vector2(p.scale ?? 6.0, p.randomness ?? 1.0) };
        decls.push(`uniform vec2 ${uParams};`);
        const vecIn = toVec2(getIn(node.id, 'vector', 'vSgUv', 'vec2'));
        const res = `v_${uid}_vor`;
        evalLines.push(`vec4 ${res} = sgVoronoi(${vecIn}, ${uParams}.x, ${uParams}.y);`);
        socketExpr.set(`${node.id}:distance`, { expr: `${res}.x`, type: 'float' });
        socketExpr.set(`${node.id}:color`, { expr: `${res}.yzw`, type: 'vec3' });
        break;
      }
      case 'ColorRamp': {
        const uDef = `u_${uid}_fac`;
        uniforms[uDef] = { value: p.fac ?? 0.5 };
        decls.push(`uniform float ${uDef};`);
        const facExpr = toFloat(getIn(node.id, 'fac', uDef, 'float'));
        const stops = (Array.isArray(p.stops) && p.stops.length > 0 ? p.stops : [
          { pos: 0, color: '#000000', alpha: 1 },
          { pos: 1, color: '#ffffff', alpha: 1 },
        ]).slice().sort((a, b) => a.pos - b.pos);

        const colVar = `v_${uid}_col`;
        const stopUniforms = [];
        stops.forEach((st, idx) => {
          const uPos = `u_${uid}_p${idx}`;
          const uCol = `u_${uid}_c${idx}`;
          const col = hexColor(st.color);
          uniforms[uPos] = { value: st.pos ?? 0 };
          uniforms[uCol] = { value: new THREE.Vector4(col.r, col.g, col.b, st.alpha ?? 1.0) };
          decls.push(`uniform float ${uPos}; uniform vec4 ${uCol};`);
          stopUniforms.push({ uPos, uCol });
        });
        evalLines.push(`float v_${uid}_t = clamp(${facExpr}, 0.0, 1.0);`);
        evalLines.push(`vec4 ${colVar} = ${stopUniforms[0].uCol};`);
        for (let i = 0; i < stopUniforms.length - 1; i++) {
          const a = stopUniforms[i], b = stopUniforms[i + 1];
          evalLines.push(`if (v_${uid}_t > ${a.uPos}) { float k = clamp((v_${uid}_t - ${a.uPos}) / max(1e-5, ${b.uPos} - ${a.uPos}), 0.0, 1.0); ${colVar} = mix(${a.uCol}, ${b.uCol}, k); }`);
        }
        socketExpr.set(`${node.id}:color`, { expr: `${colVar}.rgb`, type: 'vec3' });
        socketExpr.set(`${node.id}:alpha`, { expr: `${colVar}.a`, type: 'float' });
        break;
      }
      case 'Mix': {
        const uFac = `u_${uid}_fac`, uA = `u_${uid}_a`, uB = `u_${uid}_b`;
        uniforms[uFac] = { value: p.fac ?? 0.5 };
        uniforms[uA] = { value: hexColor(p.a ?? '#1e293b') };
        uniforms[uB] = { value: hexColor(p.b ?? '#e2e8f0') };
        decls.push(`uniform float ${uFac}; uniform vec3 ${uA}; uniform vec3 ${uB};`);
        const f = toFloat(getIn(node.id, 'fac', uFac, 'float'));
        const a = toVec3(getIn(node.id, 'a', uA, 'vec3'));
        const b = toVec3(getIn(node.id, 'b', uB, 'vec3'));
        const outV = `v_${uid}_mix`;
        const clampedT = p.clamp !== false ? `clamp(${f}, 0.0, 1.0)` : f;
        let expr = `mix(${a}, ${b}, ${clampedT})`;
        if (p.blendMode === 'MULTIPLY') expr = `mix(${a}, ${a} * ${b}, ${clampedT})`;
        else if (p.blendMode === 'ADD') expr = `(${a} + ${b} * ${clampedT})`;
        else if (p.blendMode === 'SCREEN') expr = `mix(${a}, vec3(1.0) - (vec3(1.0) - ${a}) * (vec3(1.0) - ${b}), ${clampedT})`;
        if (p.clamp !== false) expr = `clamp(${expr}, 0.0, 1.0)`;
        evalLines.push(`vec3 ${outV} = ${expr};`);
        socketExpr.set(`${node.id}:result`, { expr: outV, type: 'vec3' });
        break;
      }
      case 'Math': {
        const uA = `u_${uid}_a`, uB = `u_${uid}_b`, uC = `u_${uid}_c`;
        uniforms[uA] = { value: p.a ?? 0.5 };
        uniforms[uB] = { value: p.b ?? 0.5 };
        uniforms[uC] = { value: p.c ?? 0.0 };
        decls.push(`uniform float ${uA}; uniform float ${uB}; uniform float ${uC};`);
        const a = toFloat(getIn(node.id, 'a', uA, 'float'));
        const b = toFloat(getIn(node.id, 'b', uB, 'float'));
        const c = toFloat(getIn(node.id, 'c', uC, 'float'));
        const outV = `v_${uid}_val`;
        const op = p.operation || 'MULTIPLY';
        let expr = `(${a} + ${b})`;
        if (op === 'SUBTRACT') expr = `(${a} - ${b})`;
        else if (op === 'MULTIPLY') expr = `(${a} * ${b})`;
        else if (op === 'DIVIDE') expr = `(abs(${b}) > 1e-6 ? ${a} / ${b} : 0.0)`;
        else if (op === 'POWER') expr = `pow(max(0.0, ${a}), ${b})`;
        else if (op === 'SINE') expr = `sin(${a})`;
        else if (op === 'MIN') expr = `min(${a}, ${b})`;
        else if (op === 'MAX') expr = `max(${a}, ${b})`;
        else if (op === 'LESS_THAN') expr = `(${a} < ${b} ? 1.0 : 0.0)`;
        else if (op === 'MULTIPLY_ADD') expr = `(${a} * ${b} + ${c})`;
        if (p.clamp) expr = `clamp(${expr}, 0.0, 1.0)`;
        evalLines.push(`float ${outV} = ${expr};`);
        socketExpr.set(`${node.id}:value`, { expr: outV, type: 'float' });
        break;
      }
      case 'Fresnel': {
        const uIor = `u_${uid}_ior`;
        uniforms[uIor] = { value: p.ior ?? 1.45 };
        decls.push(`uniform float ${uIor};`);
        const iorExpr = toFloat(getIn(node.id, 'ior', uIor, 'float'));
        const outV = `v_${uid}_fres`;
        evalLines.push(`float ${outV} = sgFresnel(dot(normal, normalize(vViewPosition)), ${iorExpr});`);
        socketExpr.set(`${node.id}:fac`, { expr: outV, type: 'float' });
        break;
      }
      case 'LayerWeight': {
        const uBlend = `u_${uid}_blend`;
        uniforms[uBlend] = { value: p.blend ?? 0.5 };
        decls.push(`uniform float ${uBlend};`);
        const bl = toFloat(getIn(node.id, 'blend', uBlend, 'float'));
        const fVar = `v_${uid}_lwf`;
        const gVar = `v_${uid}_lwg`;
        evalLines.push(`float v_${uid}_nv = dot(normal, normalize(vViewPosition));`);
        evalLines.push(`float ${fVar} = sgFresnel(v_${uid}_nv, 1.0 / max(1e-3, 1.0 - clamp(${bl}, 0.0, 0.999)));`);
        evalLines.push(`float ${gVar} = sgLayerWeightFacing(v_${uid}_nv, ${bl});`);
        socketExpr.set(`${node.id}:fresnel`, { expr: fVar, type: 'float' });
        socketExpr.set(`${node.id}:facing`, { expr: gVar, type: 'float' });
        break;
      }
      case 'Bump': {
        const uStr = `u_${uid}_str`, uDist = `u_${uid}_dist`, uH = `u_${uid}_h`;
        uniforms[uStr] = { value: p.strength ?? 0.5 };
        uniforms[uDist] = { value: p.distance ?? 0.1 };
        uniforms[uH] = { value: p.height ?? 0.0 };
        decls.push(`uniform float ${uStr}; uniform float ${uDist}; uniform float ${uH};`);
        const hExpr = toFloat(getIn(node.id, 'height', uH, 'float'));
        const sExpr = toFloat(getIn(node.id, 'strength', uStr, 'float'));
        const outV = `v_${uid}_nrm`;
        evalLines.push(`vec3 ${outV} = sgBumpNormal(normal, -vViewPosition, ${hExpr}, ${sExpr}, ${uDist});`);
        socketExpr.set(`${node.id}:normal`, { expr: outV, type: 'vec3' });
        break;
      }
      case 'NormalMap': {
        const uStr = `u_${uid}_str`, uCol = `u_${uid}_col`;
        uniforms[uStr] = { value: p.strength ?? 1.0 };
        uniforms[uCol] = { value: hexColor(p.color ?? '#8080ff') };
        decls.push(`uniform float ${uStr}; uniform vec3 ${uCol};`);
        const cExpr = toVec3(getIn(node.id, 'color', uCol, 'vec3'));
        const sExpr = toFloat(getIn(node.id, 'strength', uStr, 'float'));
        const outV = `v_${uid}_nm`;
        evalLines.push(`vec3 ${outV} = sgNormalMapPerturb(normal, -vViewPosition, vSgUv, ${cExpr}, ${sExpr});`);
        socketExpr.set(`${node.id}:normal`, { expr: outV, type: 'vec3' });
        break;
      }
      case 'PrincipledBSDF': {
        const uBase = `u_${uid}_base`, uMet = `u_${uid}_met`, uRgh = `u_${uid}_rgh`;
        const uEmC = `u_${uid}_emc`, uEmS = `u_${uid}_ems`, uAlp = `u_${uid}_alp`;
        uniforms[uBase] = { value: hexColor(p.baseColor ?? '#cccccc') };
        uniforms[uMet] = { value: p.metallic ?? 0.0 };
        uniforms[uRgh] = { value: p.roughness ?? 0.5 };
        uniforms[uEmC] = { value: hexColor(p.emission ?? '#000000') };
        uniforms[uEmS] = { value: p.emissionStrength ?? 0.0 };
        uniforms[uAlp] = { value: p.alpha ?? 1.0 };
        decls.push(`uniform vec3 ${uBase}; uniform float ${uMet}; uniform float ${uRgh}; uniform vec3 ${uEmC}; uniform float ${uEmS}; uniform float ${uAlp};`);

        outStruct = {
          baseColor: toVec3(getIn(node.id, 'baseColor', uBase, 'vec3')),
          metallic: toFloat(getIn(node.id, 'metallic', uMet, 'float')),
          roughness: toFloat(getIn(node.id, 'roughness', uRgh, 'float')),
          emission: `(${toVec3(getIn(node.id, 'emission', uEmC, 'vec3'))} * ${toFloat(getIn(node.id, 'emissionStrength', uEmS, 'float'))})`,
          alpha: toFloat(getIn(node.id, 'alpha', uAlp, 'float')),
          normal: graph.getInputLink(node.id, 'normal') ? toVec3(getIn(node.id, 'normal', 'normal', 'vec3')) : null,
        };
        break;
      }
      default:
        break;
    }
  }

  return {
    uniforms,
    topologyRevision: graph.topologyRevision,
    headerGLSL: `${GLSL_NOISE_HELPERS}\n${decls.join('\n')}\n`,
    normalEvalGLSL: `${evalLines.filter((l) => l.includes('sgBumpNormal') || l.includes('sgNormalMapPerturb') || !l.includes('vSgPos_')).join('\n')}`,
    evalLines,
    outStruct,
  };
}

/**
 * Updates uniform values live without triggering a Three.js shader recompile when topology matches.
 */
export function updateShaderGraphUniforms(material, graph) {
  const entry = ACTIVE_SHADERS.get(material);
  if (!entry || entry.topologyRevision !== graph.topologyRevision) {
    return false;
  }
  const u = entry.uniforms;
  for (const node of graph.nodes.values()) {
    const p = node.props || {};
    const uid = `sg_${node.id}`;
    if (node.type === 'UVMap' && u[`u_${uid}_rep`]) {
      u[`u_${uid}_rep`].value.set(p.repeatX ?? 1, p.repeatY ?? 1, p.offsetX ?? 0, p.offsetY ?? 0);
    } else if (node.type === 'NoiseTexture' && u[`u_${uid}_params`]) {
      u[`u_${uid}_params`].value.set(p.scale ?? 6, p.detail ?? 4, p.roughness ?? 0.5, p.seed ?? 42);
    } else if (node.type === 'VoronoiTexture' && u[`u_${uid}_params`]) {
      u[`u_${uid}_params`].value.set(p.scale ?? 6, p.randomness ?? 1.0);
    } else if (node.type === 'ColorRamp') {
      if (u[`u_${uid}_fac`]) u[`u_${uid}_fac`].value = p.fac ?? 0.5;
      const stops = (p.stops || []).slice().sort((a, b) => a.pos - b.pos);
      stops.forEach((st, idx) => {
        if (u[`u_${uid}_p${idx}`]) u[`u_${uid}_p${idx}`].value = st.pos ?? 0;
        if (u[`u_${uid}_c${idx}`]) {
          const c = hexColor(st.color);
          u[`u_${uid}_c${idx}`].value.set(c.r, c.g, c.b, st.alpha ?? 1.0);
        }
      });
    } else if (node.type === 'Mix') {
      if (u[`u_${uid}_fac`]) u[`u_${uid}_fac`].value = p.fac ?? 0.5;
      if (u[`u_${uid}_a`]) u[`u_${uid}_a`].value.copy(hexColor(p.a));
      if (u[`u_${uid}_b`]) u[`u_${uid}_b`].value.copy(hexColor(p.b));
    } else if (node.type === 'Math') {
      if (u[`u_${uid}_a`]) u[`u_${uid}_a`].value = p.a ?? 0.5;
      if (u[`u_${uid}_b`]) u[`u_${uid}_b`].value = p.b ?? 0.5;
      if (u[`u_${uid}_c`]) u[`u_${uid}_c`].value = p.c ?? 0.0;
    } else if (node.type === 'Fresnel' && u[`u_${uid}_ior`]) {
      u[`u_${uid}_ior`].value = p.ior ?? 1.45;
    } else if (node.type === 'LayerWeight' && u[`u_${uid}_blend`]) {
      u[`u_${uid}_blend`].value = p.blend ?? 0.5;
    } else if (node.type === 'Bump') {
      if (u[`u_${uid}_str`]) u[`u_${uid}_str`].value = p.strength ?? 0.5;
      if (u[`u_${uid}_dist`]) u[`u_${uid}_dist`].value = p.distance ?? 0.1;
      if (u[`u_${uid}_h`]) u[`u_${uid}_h`].value = p.height ?? 0.0;
    } else if (node.type === 'NormalMap') {
      if (u[`u_${uid}_str`]) u[`u_${uid}_str`].value = p.strength ?? 1.0;
      if (u[`u_${uid}_col`]) u[`u_${uid}_col`].value.copy(hexColor(p.color));
    } else if (node.type === 'PrincipledBSDF') {
      if (u[`u_${uid}_base`]) u[`u_${uid}_base`].value.copy(hexColor(p.baseColor));
      if (u[`u_${uid}_met`]) u[`u_${uid}_met`].value = p.metallic ?? 0.0;
      if (u[`u_${uid}_rgh`]) u[`u_${uid}_rgh`].value = p.roughness ?? 0.5;
      if (u[`u_${uid}_emc`]) u[`u_${uid}_emc`].value.copy(hexColor(p.emission));
      if (u[`u_${uid}_ems`]) u[`u_${uid}_ems`].value = p.emissionStrength ?? 0.0;
      if (u[`u_${uid}_alp`]) u[`u_${uid}_alp`].value = p.alpha ?? 1.0;
    }
  }
  return true;
}

/**
 * Compiles `graph` and installs live `onBeforeCompile` hooks on `material`.
 */
export function applyShaderGraphToMaterial(material, graph, options = {}) {
  if (!material || !graph) return null;
  setShaderGraphForMaterial(material, graph);

  // Fast path: uniform-only update when topology didn't change
  if (updateShaderGraphUniforms(material, graph) && !options.forceRecompile) {
    return ACTIVE_SHADERS.get(material);
  }

  const compiled = compileShaderGraphToGLSL(graph, options.resolveTexture || ((n) => {
    const slot = n.props?.slot;
    if (slot === 'normal') return material.normalMap;
    if (slot === 'roughness') return material.roughnessMap;
    if (slot === 'metalness') return material.metalnessMap;
    return material.map || null;
  }));

  const cacheKey = `sg_${graph.id}_${graph.topologyRevision}`;
  material.customProgramCacheKey = () => cacheKey;
  material.onBeforeCompile = (shader) => {
    for (const [k, u] of Object.entries(compiled.uniforms)) {
      shader.uniforms[k] = u;
    }
    shader.vertexShader = `varying vec2 vSgUv;\nvarying vec3 vSgPos;\n${shader.vertexShader}`
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n\tvSgUv = uv;\n\tvSgPos = position;\n`);

    const preLines = [];
    const normalLines = [];
    for (const l of compiled.evalLines) {
      if (l.includes('sgBumpNormal') || l.includes('sgNormalMapPerturb')) {
        normalLines.push(l);
      } else {
        preLines.push(l);
      }
    }

    let frag = `${compiled.headerGLSL}\n${shader.fragmentShader}`;
    const assignBlock = [
      ...preLines,
      `diffuseColor.rgb = ${compiled.outStruct.baseColor};`,
      `diffuseColor.a *= ${compiled.outStruct.alpha};`,
      `roughnessFactor = clamp(${compiled.outStruct.roughness}, 0.04, 1.0);`,
      `metalnessFactor = clamp(${compiled.outStruct.metallic}, 0.0, 1.0);`,
      `totalEmissiveRadiance = ${compiled.outStruct.emission};`,
      ...normalLines,
      ...(compiled.outStruct.normal ? [`normal = ${compiled.outStruct.normal};`] : []),
    ].join('\n\t');

    frag = frag.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\n\t${assignBlock}`
    );
    shader.fragmentShader = frag;
  };

  ACTIVE_SHADERS.set(material, {
    graph,
    uniforms: compiled.uniforms,
    topologyRevision: graph.topologyRevision,
  });
  material.needsUpdate = true;
  return compiled;
}

/**
 * Helper used during scene load/export to rebind serialized graphs automatically.
 */
export function hydrateMaterialShaderGraphs(root) {
  if (!root) return 0;
  let count = 0;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      const g = getShaderGraphForMaterial(m);
      if (g) {
        applyShaderGraphToMaterial(m, g, { forceRecompile: true });
        count++;
      }
    }
  });
  return count;
}

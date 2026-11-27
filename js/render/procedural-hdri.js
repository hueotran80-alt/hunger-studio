/**
 * Web Blender Studio - Procedural HDRI Equirectangular Generator
 * Computes high-dynamic-range (HDR) radiance values for studio environments:
 * - Studio Softbox 3-Point
 * - Golden Sunset Sky
 * - Cyberpunk Neon City
 * - Industrial Warehouse
 * Outputs HalfFloat (Uint16Array) or Float (Float32Array) DataTexture.
 * File: js/render/procedural-hdri.js
 */

/**
 * Converts a 32-bit float to a 16-bit half-float (IEEE 754-2008)
 * Self-contained implementation without external dependencies.
 * @param {number} val
 * @returns {number} 16-bit uint representation of half float
 */
const _halfFloatBuf = new Float32Array(1);
const _halfFloatUint = new Uint32Array(_halfFloatBuf.buffer);

export function toHalfFloat(val) {
  _halfFloatBuf[0] = val;
  const x = _halfFloatUint[0];
  let bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) {
    if (e === 255 && (x & 0x007fffff) !== 0) {
      return bits | 0x7e00; // quiet NaN
    }
    return bits | 0x7c00; // +/-Infinity on overflow
  }
  if (e < 113) {
    m |= 0x0800;
    bits |= (m >> (114 - e)) + ((m >> (113 - e)) & 1);
    return bits;
  }
  bits |= ((e - 112) << 10) | (m >> 1);
  bits += m & 1;
  return bits;
}

/**
 * Evaluates procedural HDR radiance for a 3D unit direction into a reusable 3-element array.
 */
export function evaluateHdriRadianceInto(preset, dx, dy, dz, out) {
  const normKey = String(preset || 'studio-softbox').toLowerCase().replace(/_/g, '-');

  switch (normKey) {
    case 'golden-sunset': {
      let r, g, b;
      if (dy > 0) {
        const t = Math.pow(dy, 0.6);
        r = (1 - t) * 1.8 + t * 0.08;
        g = (1 - t) * 0.7 + t * 0.15;
        b = (1 - t) * 0.2 + t * 0.45;
      } else {
        const t = Math.min(1, Math.abs(dy) * 4);
        r = (1 - t) * 0.4 + t * 0.03;
        g = (1 - t) * 0.15 + t * 0.02;
        b = (1 - t) * 0.05 + t * 0.015;
      }

      const sunDx = 0.0;
      const sunDy = 0.15;
      const sunDz = 0.988;
      const dot = dx * sunDx + dy * sunDy + dz * sunDz;
      if (dot > 0.997) {
        r += 16.0;
        g += 12.0;
        b += 6.0;
      } else if (dot > 0.97) {
        const halo = Math.pow((dot - 0.97) / 0.027, 2);
        r += halo * 4.5;
        g += halo * 2.5;
        b += halo * 0.8;
      }

      out[0] = r; out[1] = g; out[2] = b;
      return out;
    }

    case 'cyberpunk-neon': {
      let r = 0.02, g = 0.025, b = 0.04;
      if (dy < 0) {
        r *= 0.6;
        g *= 0.6;
        b *= 0.7;
      }

      const c1Dx = -0.75, c1Dy = 0.5, c1Dz = 0.43;
      const dotCyan = dx * c1Dx + dy * c1Dy + dz * c1Dz;
      if (dotCyan > 0.94) {
        const intense = Math.pow((dotCyan - 0.94) / 0.06, 2) * 8.0;
        r += intense * 0.05;
        g += intense * 0.9;
        b += intense * 1.0;
      }

      const m1Dx = 0.75, m1Dy = 0.5, m1Dz = 0.43;
      const dotMagenta = dx * m1Dx + dy * m1Dy + dz * m1Dz;
      if (dotMagenta > 0.94) {
        const intense = Math.pow((dotMagenta - 0.94) / 0.06, 2) * 8.0;
        r += intense * 1.0;
        g += intense * 0.08;
        b += intense * 0.85;
      }

      if (Math.abs(dy) < 0.1) {
        const horiz = (1 - Math.abs(dy) / 0.1) * 0.25;
        r += horiz * 0.5;
        g += horiz * 0.2;
        b += horiz * 0.6;
      }

      out[0] = r; out[1] = g; out[2] = b;
      return out;
    }

    case 'industrial-warehouse': {
      let r = 0.05, g = 0.055, b = 0.06;
      if (dy < 0) {
        r = 0.03; g = 0.03; b = 0.035;
      }

      if (dy > 0.7) {
        const bay = Math.sin(dx * 8) * Math.sin(dz * 8);
        if (bay > 0.3) {
          const skylight = ((bay - 0.3) / 0.7) * 5.0;
          r += skylight * 0.85;
          g += skylight * 0.92;
          b += skylight * 1.0;
        }
      }

      const wDx = 0.94, wDy = 0.2, wDz = -0.27;
      const dotWork = dx * wDx + dy * wDy + dz * wDz;
      if (dotWork > 0.92) {
        const work = Math.pow((dotWork - 0.92) / 0.08, 2) * 4.0;
        r += work * 1.2;
        g += work * 0.85;
        b += work * 0.4;
      }

      out[0] = r; out[1] = g; out[2] = b;
      return out;
    }

    case 'studio-softbox':
    default: {
      let r = 0.04, g = 0.045, b = 0.05;
      if (dy < 0) {
        r = 0.02; g = 0.02; b = 0.025;
      }

      const keyDx = 0.5, keyDy = 0.707, keyDz = 0.5;
      const dotKey = dx * keyDx + dy * keyDy + dz * keyDz;
      if (dotKey > 0.88) {
        const intensity = Math.pow((dotKey - 0.88) / 0.12, 1.5) * 6.5;
        r += intensity * 1.0;
        g += intensity * 0.98;
        b += intensity * 0.95;
      }

      const fillDx = -0.75, fillDy = 0.5, fillDz = 0.43;
      const dotFill = dx * fillDx + dy * fillDy + dz * fillDz;
      if (dotFill > 0.86) {
        const intensity = Math.pow((dotFill - 0.86) / 0.14, 1.5) * 2.8;
        r += intensity * 0.85;
        g += intensity * 0.92;
        b += intensity * 1.0;
      }

      if (dy > 0.85 && Math.abs(dx) < 0.35) {
        const strip = Math.pow((dy - 0.85) / 0.15, 2) * 3.5;
        r += strip * 0.95;
        g += strip * 0.98;
        b += strip * 1.0;
      }

      out[0] = r; out[1] = g; out[2] = b;
      return out;
    }
  }
}

/**
 * Evaluates procedural HDR radiance for a given 3D unit direction vector (Dx, Dy, Dz).
 * @param {string} preset
 * @param {number} dx
 * @param {number} dy
 * @param {number} dz
 * @returns {[number, number, number]} [r, g, b] radiant values
 */
export function evaluateHdriRadiance(preset, dx, dy, dz) {
  return evaluateHdriRadianceInto(preset, dx, dy, dz, [0, 0, 0]);
}

/**
 * Generates procedural HDRI equirectangular pixel data matching Three.js DataTexture
 * (`flipY = false`, bottom-to-top UV convention) and `equirectUv(dir)` azimuth (`atan2(z, x)`).
 * @param {Object} [options]
 * @param {string} [options.preset='studio-softbox']
 * @param {number} [options.width=512]
 * @param {number} [options.height=256]
 * @param {'half-float'|'float'} [options.format='half-float']
 * @returns {{ width: number, height: number, format: string, data: Uint16Array|Float32Array }}
 */
export function generateProceduralHdriData(options = {}) {
  const preset = options.preset || 'studio-softbox';
  const width = Math.max(64, Math.min(2048, options.width || 512));
  const height = Math.max(32, Math.min(1024, options.height || Math.floor(width / 2)));
  const format = options.format === 'float' ? 'float' : 'half-float';

  const totalPixels = width * height;
  const isHalf = format === 'half-float';
  const buffer = isHalf ? new Uint16Array(totalPixels * 4) : new Float32Array(totalPixels * 4);

  const halfAlpha = isHalf ? toHalfFloat(1.0) : 1.0;
  const rgb = [0, 0, 0];

  for (let y = 0; y < height; y++) {
    // DataTexture has flipY=false: y=0 maps to WebGL UV v=0 (nadir, dy=-1) and y=height-1 to v=1 (zenith, dy=+1).
    // Aligns 1:1 with Three.js equirectUv(dir) and rust-scene-pack/env.rs!
    const v = (y + 0.5) / height;
    const theta = (1.0 - v) * Math.PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const phi = (u - 0.5) * 2.0 * Math.PI; // atan2(z, x) = phi

      const dx = sinTheta * Math.cos(phi);
      const dy = cosTheta;
      const dz = sinTheta * Math.sin(phi);

      evaluateHdriRadianceInto(preset, dx, dy, dz, rgb);

      const idx = (y * width + x) * 4;
      if (isHalf) {
        buffer[idx + 0] = toHalfFloat(rgb[0]);
        buffer[idx + 1] = toHalfFloat(rgb[1]);
        buffer[idx + 2] = toHalfFloat(rgb[2]);
        buffer[idx + 3] = halfAlpha;
      } else {
        buffer[idx + 0] = rgb[0];
        buffer[idx + 1] = rgb[1];
        buffer[idx + 2] = rgb[2];
        buffer[idx + 3] = 1.0;
      }
    }
  }

  return { width, height, format, data: buffer };
}

/**
 * Creates a THREE.DataTexture containing the procedural HDRI environment.
 * @param {Object} options
 * @param {string} [options.preset='studio-softbox']
 * @param {number} [options.width=512]
 * @param {number} [options.height=256]
 * @param {Object} options.THREE Three.js module
 * @returns {THREE.DataTexture}
 */
export function createProceduralHdriTexture(options = {}) {
  const THREE = options.THREE;
  if (!THREE) {
    throw new Error('THREE instance must be provided to createProceduralHdriTexture');
  }

  const { width, height, data } = generateProceduralHdriData(options);

  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.HalfFloatType
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = `ProceduralHDRI_${options.preset || 'studio-softbox'}`;

  return texture;
}

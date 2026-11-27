/**
 * Canonical PBR Material Preset definitions (pure data, DOM-free).
 * Shared between RapidStudio (main thread fallback) and Copilot Worker mirror
 * so AI-generated `studio.createPBRMaterial(presetId, overrides)` produces real
 * physical/standard PBR materials inside the isolated Worker instead of a gray stub.
 */

export const PBR_PRESET_SPECS = Object.freeze({
  car_paint_red: {
    physical: true,
    color: 0xb91c1c,
    roughness: 0.18,
    metalness: 0.85,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
  },
  velvet_royal: {
    physical: true,
    color: 0x1e1b4b,
    roughness: 0.88,
    metalness: 0.0,
    sheen: 1.0,
    sheenRoughness: 0.4,
    sheenColor: 0x818cf8,
  },
  water_pool: {
    physical: true,
    color: 0x38bdf8,
    roughness: 0.06,
    metalness: 0.0,
    transmission: 0.92,
    ior: 1.333,
    thickness: 2.0,
    transparent: true,
  },
  skin_realistic: {
    physical: true,
    color: 0xe8beac,
    roughness: 0.52,
    metalness: 0.0,
    clearcoat: 0.22,
    clearcoatRoughness: 0.32,
    sheen: 0.85,
    sheenColor: 0xff8066,
    sheenRoughness: 0.45,
  },
  skin_tan: {
    physical: true,
    color: 0xb57a58,
    roughness: 0.48,
    metalness: 0.0,
    clearcoat: 0.25,
    clearcoatRoughness: 0.28,
    sheen: 0.8,
    sheenColor: 0xcc6045,
  },
  gold_24k: {
    physical: false,
    color: 0xffd700,
    roughness: 0.15,
    metalness: 0.95,
  },
  chrome_mirror: {
    physical: false,
    color: 0xf5f6fa,
    roughness: 0.03,
    metalness: 1.0,
  },
  brushed_titanium: {
    physical: false,
    color: 0x959ea8,
    roughness: 0.32,
    metalness: 0.9,
  },
  glass_crystal: {
    physical: true,
    color: 0xffffff,
    roughness: 0.04,
    metalness: 0.0,
    transmission: 0.98,
    ior: 1.52,
    thickness: 1.5,
    transparent: true,
    opacity: 1.0,
  },
  water_surface: {
    physical: true,
    color: 0x22a6b3,
    roughness: 0.08,
    metalness: 0.05,
    transmission: 0.88,
    transparent: true,
    opacity: 0.88,
  },
  carbon_fiber: {
    physical: false,
    color: 0x202428,
    roughness: 0.28,
    metalness: 0.7,
  },
  wood_polished: {
    physical: false,
    color: 0xb57845,
    roughness: 0.38,
    metalness: 0.05,
  },
  marble_white: {
    physical: true,
    color: 0xf5f5f7,
    roughness: 0.2,
    metalness: 0.05,
    clearcoat: 0.45,
    clearcoatRoughness: 0.15,
  },
  fabric_velvet: {
    physical: true,
    color: 0x3d124d,
    roughness: 0.85,
    metalness: 0.0,
    sheen: 1.0,
    sheenColor: 0xb540e6,
    sheenRoughness: 0.5,
  },
  leather_black: {
    physical: false,
    color: 0x18181b,
    roughness: 0.45,
    metalness: 0.05,
  },
  neon_cyan: {
    physical: false,
    color: 0x00cec9,
    emissive: 0x00cec9,
    emissiveIntensity: 3.5,
    roughness: 0.2,
    metalness: 0.8,
  },
  ceramic_clay: {
    physical: true,
    color: 0xffffff,
    roughness: 0.15,
    metalness: 0.0,
    clearcoat: 0.8,
    clearcoatRoughness: 0.1,
  },
  rubber_matte: {
    physical: false,
    color: 0x222428,
    roughness: 0.92,
    metalness: 0.02,
  },
  cotton_shirt_sale: {
    physical: true,
    color: 0xe11d48,
    roughness: 0.78,
    metalness: 0.02,
    sheen: 0.9,
    sheenColor: 0xffb4c4,
    sheenRoughness: 0.55,
  },
  denim_jeans: {
    physical: true,
    color: 0x254e7a,
    roughness: 0.84,
    metalness: 0.0,
    sheen: 0.55,
    sheenColor: 0x93c5fd,
    sheenRoughness: 0.7,
  },
  phone_oled_screen: {
    physical: true,
    color: 0x111827,
    emissive: 0x38bdf8,
    emissiveIntensity: 1.4,
    roughness: 0.05,
    metalness: 0.1,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
  },
  aluminum_anodized: {
    physical: false,
    color: 0x64748b,
    roughness: 0.26,
    metalness: 0.88,
  },
  wall_pastel_cream: {
    physical: false,
    color: 0xebe4d8,
    roughness: 0.92,
    metalness: 0.0,
  },
  desk_walnut: {
    physical: false,
    color: 0x6b4423,
    roughness: 0.42,
    metalness: 0.04,
  },
  bedding_linen: {
    physical: true,
    color: 0xdbeafe,
    roughness: 0.88,
    metalness: 0.0,
    sheen: 0.75,
    sheenColor: 0xffffff,
    sheenRoughness: 0.65,
  },
  carpet_woven: {
    physical: false,
    color: 0x4b5563,
    roughness: 0.96,
    metalness: 0.0,
  },
});

export const PBR_PRESET_ALIASES = Object.freeze({
  gold: 'gold_24k',
  chrome: 'chrome_mirror',
  metal: 'chrome_mirror',
  titanium: 'brushed_titanium',
  aluminum: 'aluminum_anodized',
  glass: 'glass_crystal',
  water: 'water_surface',
  pool: 'water_pool',
  skin: 'skin_realistic',
  tan_skin: 'skin_tan',
  wood: 'wood_polished',
  walnut: 'desk_walnut',
  marble: 'marble_white',
  velvet: 'fabric_velvet',
  leather: 'leather_black',
  neon: 'neon_cyan',
  ceramic: 'ceramic_clay',
  rubber: 'rubber_matte',
  carbon: 'carbon_fiber',
  cotton: 'cotton_shirt_sale',
  denim: 'denim_jeans',
  car_paint: 'car_paint_red',
  linen: 'bedding_linen',
  carpet: 'carpet_woven',
});

export function resolvePBRPresetId(presetId) {
  if (typeof presetId !== 'string') return '';
  const key = presetId.trim().toLowerCase();
  if (!key) return '';
  if (Object.prototype.hasOwnProperty.call(PBR_PRESET_SPECS, key)) return key;
  return PBR_PRESET_ALIASES[key] || '';
}

export function buildPBRPresetMaterial(THREE, presetId, overrides = {}) {
  const resolvedId = resolvePBRPresetId(presetId);
  const spec = resolvedId ? PBR_PRESET_SPECS[resolvedId] : null;
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const usePhysical = Boolean(
    spec?.physical ||
    o.transmission !== undefined ||
    o.clearcoat !== undefined ||
    o.sheen !== undefined ||
    o.ior !== undefined ||
    o.thickness !== undefined
  );
  const params = {
    name: o.name || (resolvedId ? `Mat_${resolvedId}` : 'Material'),
    color: o.color ?? spec?.color ?? 0xcccccc,
    roughness: o.roughness ?? spec?.roughness ?? 0.5,
    metalness: o.metalness ?? spec?.metalness ?? 0.1,
  };
  if (o.emissive !== undefined || spec?.emissive !== undefined) {
    params.emissive = o.emissive ?? spec.emissive;
    params.emissiveIntensity = o.emissiveIntensity ?? spec?.emissiveIntensity ?? 1.0;
  } else if (o.emissiveIntensity !== undefined) {
    params.emissiveIntensity = o.emissiveIntensity;
  }
  if (o.opacity !== undefined || spec?.opacity !== undefined) {
    params.opacity = o.opacity ?? spec.opacity;
  }
  if (o.transparent !== undefined || spec?.transparent !== undefined || (params.opacity !== undefined && params.opacity < 1)) {
    params.transparent = Boolean(o.transparent ?? spec?.transparent ?? (params.opacity < 1));
  }
  if (usePhysical) {
    if (o.clearcoat !== undefined || spec?.clearcoat !== undefined) params.clearcoat = o.clearcoat ?? spec.clearcoat;
    if (o.clearcoatRoughness !== undefined || spec?.clearcoatRoughness !== undefined) params.clearcoatRoughness = o.clearcoatRoughness ?? spec.clearcoatRoughness;
    if (o.sheen !== undefined || spec?.sheen !== undefined) params.sheen = o.sheen ?? spec.sheen;
    if (o.sheenRoughness !== undefined || spec?.sheenRoughness !== undefined) params.sheenRoughness = o.sheenRoughness ?? spec.sheenRoughness;
    if (o.sheenColor !== undefined || spec?.sheenColor !== undefined) {
      params.sheenColor = new THREE.Color(o.sheenColor ?? spec.sheenColor);
    }
    if (o.transmission !== undefined || spec?.transmission !== undefined) params.transmission = o.transmission ?? spec.transmission;
    if (o.ior !== undefined || spec?.ior !== undefined) params.ior = o.ior ?? spec.ior;
    if (o.thickness !== undefined || spec?.thickness !== undefined) params.thickness = o.thickness ?? spec.thickness;
    return new THREE.MeshPhysicalMaterial(params);
  }
  return new THREE.MeshStandardMaterial(params);
}

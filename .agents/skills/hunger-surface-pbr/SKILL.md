---
name: hunger-surface-pbr
description: Create physically accurate, multi-zoom calibrated procedural PBR materials, UV projections, linear data maps, and crisp CanvasTexture signage natively inside Hunger 3D Studio.
---

# Hunger Surface PBR & Look-Dev

Use this skill for all PBR material authoring, off-main-thread procedural texture synthesis, physical UV projection, multi-material slot editing, and multi-zoom surface calibration in **Hunger 3D Studio**.

## 1. Procedural Worker PBR Catalog (13 Built-In Patterns)
Generate tileable, seam-continuous sRGB Albedo + Linear Sobel Normal + Linear Roughness maps off-main-thread with `await studio.applyProceduralPBR(target, options)`:

| Category | Pattern ID | Best For & Key Options |
| :--- | :--- | :--- |
| **Architectural** | `weathered_concrete` | Cast stone, aged mortar, brutalist concrete (`color1`, `color2`, `rainStreaks`, `weathering`, `scale`) |
| **Architectural** | `ashlar_stone` | Dressed stone blocks with mortar courses (`courses`, `blocksPerCourse`, `color1`, `color2`, `mortarColor`) |
| **Architectural** | `stucco_plaster` | Troweled plaster, limewash walls (`color1`, `color2`, `roughnessMin`, `roughnessMax`) |
| **Architectural** | `clay_roof_tiles` | Terracotta/ceramic barrel roof tiles (`rows`, `cols`, `color1`, `color2`) |
| **Architectural** | `roof_slates` | Overlapping slate/shingle roofing (`rows`, `cols`, `color1`, `color2`) |
| **Architectural** | `wood_grain` | Timber planks, beams, furniture (`planks`, `color1`, `color2`, `ringScale`) |
| **Architectural** | `checkered_marble` | Periodic veined marble tiles (`tiles` auto-clamped even for seam parity, `diagonal`, `veinColor`) |
| **Architectural** | `mullioned_glass` | Framed window panes & muntin grids (`rows`, `cols`, `color1` glass, `color2` mullions) |
| **Architectural** | `stained_mosaic` | Cellular leaded mosaic / decorative glass (`cells`, `color1`, `color2`, `emissiveFromMap`) |
| **Universal** | `brushed`, `carbon`, `voronoi`, `noise` | Brushed steel/aluminum (`grain`), carbon weave, cellular relief, organic grunge (`octaves`, `persistence`, `lacunarity`) |

### Key `applyProceduralPBR` Options
```js
await studio.applyProceduralPBR(target, {
  pattern: 'ashlar_stone',
  resolution: 1024,          // 1024 hero surfaces; 512 secondary trims/props (max 2048)
  repeat: [2, 2],            // or repeatX / repeatY
  uvScale: 2.0,              // physical meters/tile when auto-generating missing UVs
  normalScale: 0.85,         // 0 disables normalMap
  useDiffuseMap: true,       // false keeps solid albedo + procedural micro-normal/roughness
  useRoughnessMap: true,
  slotIndex: 0,              // optional: target ONLY one slot on multi-material meshes!
  tint: 0xffffff,            // optional color tint multiplier
  roughness: 0.85,
  metalness: 0.0,
  clearcoat: undefined,      // setting clearcoat/sheen/transmission auto-upgrades to MeshPhysicalMaterial
});
```
- **Full Property Preservation & 1-Step Undo:** `applyProceduralPBR` clones `srcMat` (or upgrades `Standard -> Physical` via `.copy()`), preserving `clearcoatNormalScale`, `normalMapType`, `alphaHash`, `depthWrite`, `depthTest`, `polygonOffset`, `aoMap`, `metalnessMap`, `emissiveMap`, and records **1 atomic Undo/Redo step** in `SceneManager`.
- **Signage & Inscriptions (Browser Main DSL / DOM only — NOT inside Copilot Worker):**
  `const signTex = studio.createSignTexture({ text, bg, color, borderColor, width: 1024, height: 256 });`

## 2. Physically-Based Surface Recipes
| Surface Class | Roughness | Metalness | Extra Physical Parameters |
| :--- | :--- | :--- | :--- |
| Matte Stone / Stucco / Plaster | `0.80 – 0.94` | `0.0` | `normalScale: 0.7 – 1.1`, subtle cavity AO |
| Glazed Terracotta / Ceramic | `0.38 – 0.58` | `0.0` | `clearcoat: 0.25`, `clearcoatRoughness: 0.3` |
| Cast Iron / Weathered Bronze | `0.35 – 0.55` | `0.82 – 0.95` | `brushed` or `noise` micro-normal |
| Polished Gold / Brass / Chrome | `0.14 – 0.26` | `0.95 – 1.0` | Low roughness, avoid oversaturated neon yellow |
| Architectural Window Glass | `0.08 – 0.22` | `0.05 – 0.15` | Dark exterior tint (`#0c121b`) or `transmission: 0.85, ior: 1.5` |
| Varnished Wood / Hardwood | `0.35 – 0.62` | `0.0` | `wood_grain` + optional `clearcoat: 0.3` |
| Fabric / Cloth / Upholstery | `0.85 – 0.96` | `0.0` | `sheen: 0.6 – 1.0`, `sheenRoughness: 0.65` |

## 3. Texture Lifecycle, Memory & Color-Space Invariants
1. **Material Sharing:** Define one canonical material per surface class and share across meshes. Never `.clone()` inside per-mesh loops unless splitting `vertexColors` (cache the split pair once).
2. **Physical UV Projection:** Run `studio.boxProjectUV(target, { metersPerTile, worldSpace: true })` on architectural/extruded meshes so tile scale stays identical across small trims and large walls.
3. **Color vs Data Map Integrity:**
   - Color maps (`map`, `emissiveMap`) use `THREE.SRGBColorSpace` and compress cleanly to JPEG on web export.
   - Data maps (`normalMap`, `roughnessMap`, `metalnessMap`, `aoMap`, `clearcoatNormalMap`) use linear space and **MUST ALWAYS export as lossless PNG** (`lossyDataMaps: false`).
4. **Lease Safety (`TextureLeaseRegistry`):** Procedural cache entries are refcounted centrally across `ProceduralTextureClient`, `MaterialStudio.upgradeToPhysicalMaterial`, `RapidStudio`, `Inspector`, and `SceneManager.disposeMaterial`. Never manually call `texture.dispose()` on a procedural texture owned by the registry, and never store runtime texture leases inside `material.userData` (keeps WBS/JSON serialization lightweight).
5. **Vertex Color Parity:** Always ensure `material.vertexColors === Boolean(geometry.attributes.color)` so WebGL never multiplies albedo by `(0, 0, 0)`.

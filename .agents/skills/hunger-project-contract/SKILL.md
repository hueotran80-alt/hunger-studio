---
name: hunger-project-contract
description: Define a deterministic, portable JSON Project Contract (dimensions, part counts, material recipes, asset provenance, shot matrix, and performance budget) before modeling in Hunger 3D Studio.
---

# Hunger Project Contract

Use this skill at the start of any reference-locked, multi-part, architectural, mechanical, or multi-agent 3D production inside **Hunger 3D Studio**. Authoring the contract first eliminates guesswork, proportion drift, blown draw-call budgets, and missing-asset surprises.

## 1. Canonical JSON Contract Schema (SI Meters, Y-Up, Right-Handed)
Before writing modeling code, produce a deterministic JSON contract adhering to this structure:

```json
{
  "projectId": "domain-asset-v1",
  "units": "meters",
  "upAxis": "Y",
  "seed": 42,
  "budgetTier": "product",
  "dimensions": {
    "width": 1.2,
    "height": 1.8,
    "depth": 0.9,
    "aspectWH": 0.667,
    "aspectDH": 0.500,
    "registers": [
      { "name": "base_plinth", "yMin": 0.0, "yMax": 0.25 },
      { "name": "main_body", "yMin": 0.25, "yMax": 1.45 },
      { "name": "crown_cap", "yMin": 1.45, "yMax": 1.80 }
    ]
  },
  "hollowInterior": {
    "enabled": false,
    "wallThickness": 0.35,
    "clearHeight": 0.0
  },
  "parts": [
    { "name": "MainHousing", "method": "addLoft", "count": 1, "symmetry": "X" },
    { "name": "FlangeBolts", "method": "addInstancedMesh", "count": 16, "symmetry": "radial" }
  ],
  "materials": [
    {
      "id": "PrimarySurface",
      "pattern": "brushed",
      "resolution": 1024,
      "color1": "#58606a",
      "color2": "#3a4048",
      "roughness": 0.42,
      "metalness": 0.85,
      "uvScale": 1.0,
      "dataMapsLosslessPNG": true
    }
  ],
  "externalAssets": [
    {
      "id": "RiggedActor",
      "url": "/models/Bot_CC0.glb",
      "license": "CC0-1.0",
      "maxBytes": 5242880,
      "required": true,
      "fallback": "error"
    }
  ],
  "shotMatrix": [
    { "id": "overview", "type": "macro_elevation", "distanceFactor": 1.4 },
    { "id": "hero_34", "type": "three_quarter", "distanceFactor": 0.9 },
    { "id": "closeup", "type": "micro_detail", "distanceMeters": 2.0 }
  ]
}
```

## 2. Reference Measurement & Proportion Lock Protocol
When the user supplies photographs, blueprints, orthographics, or concept art:
1. **Silhouette & Aspect Ratios First:** Measure outer `W:H` and `D:H` ratios and vertical register elevations (`base`, `mid`, `upper`, `roof/crown`) before adding micro-ornamentation.
2. **Exact Cardinality:** Count repeated elements explicitly (bays, columns, spokes, windows, ribs, bolts, arches, louvers) and lock those integers in `parts[].count`.
3. **Hollow vs Solid Decision:** Declare `hollowInterior.enabled` up front. Walkable/hollow structures require pierced wall contours (`holes` in `addExtrude`), finite wall thickness (`>= 0.25 m`), interior floor/vault continuity, and zero clipping roof skirts.
4. **Value & Hue Calibration:** Sample primary surface colors under neutral lighting; avoid pure `#000000` (keep albedo `>= 0x121418`) or blown `#ffffff` (keep albedo `<= 0xebebeb`) so AgX highlights and shadow detail stay legible.

## 3. Asset Provenance & Commercial Ship Policy Gate
- **Commercial Ship Boundary (`asset-ship-policy.json`):** Hunger Studio's commercial SaaS bundle ships only CC0/permissive general-purpose assets within the `<= 5 MB` per-asset cap and `<= 25 MB` per-file host ceiling. Single-project or oversized external `.glb` models stay dev-only / user-imported and are **never** hardcoded into `dist/`.
- **Explicit Fallback Policy:** Mark each external asset `required: true` (must fail explicitly with `E_ASSET` if missing) or `required: false` with a documented procedural fallback (`fallback: "procedural"`).
- **Validation Gate:** Reject any non-finite dimension (`NaN`, `Infinity`, `<= 0`), missing material ID reference, or tier budget mismatch before entering `hunger-parametric-cad`.

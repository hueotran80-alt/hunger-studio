---
name: hung-nghia-gothic-archviz
description: Project Profile for modeling Nhà thờ Giáo xứ Hưng Nghĩa (Đền thánh Thánh Tâm Chúa Giêsu, Hải Hậu, Nam Định) natively in Hunger 3D Studio by composing the 8 generic Hunger skills (hunger-orchestrator, hunger-project-contract, hunger-parametric-cad, hunger-surface-pbr, hunger-camera-look, hunger-runtime-budget-agent, hunger-multizoom-qa-delivery).
---

# Project Profile — Nhà thờ Giáo xứ Hưng Nghĩa (Hunger Web-Native)

> **Scope:** Thin, project-specific architectural reference profile only. All modeling, PBR, budgeting, and QA workflows delegate to the 8 generic skills under `.agents/skills/hunger-*` (0% engine hardcoding).

## 1. Required Generic Skills
Compose: `hunger-orchestrator` → `hunger-project-contract` → `hunger-parametric-cad` → `hunger-surface-pbr` → `hunger-camera-look` → `hunger-runtime-budget-agent` → `hunger-multizoom-qa-delivery`.

## 2. Measured Architectural Proportions & Signature Features
- **West Front (`34.0 m` wide, `W:H = 0.838` to `56 m` crosses / `60 m` flagpoles):** 7-bay articulated facade with 4-order golden central portal, 16-volute baroque scrollwork tympanum, red-and-gold welcome banner, clock dial (`10:10`), two 12-spoke golden wheel rosettes, 3D golden `"2 0 1 2"` frieze, gilded Marian Shrine (`Tòa Đức Mẹ Mân Côi` with turquoise vault, floral rose arch, pleated white robe + sky-blue mantle + 12-star halo + hanging rosary + Infant Jesus + 2 globe lamps + 2 rose urns), two flanking saint niches, 2 open balustrade tiers (turned balusters above, interlacing pointed arches below), proud S-scroll pediment cresting, and red crucifix with white Corpus + `INRI`.
- **Twin 60m Bell Towers (`X = ±12.6 m`):** Stepped fluted corner buttresses, white-mullioned windows on Stages 1–2, 3 reddish-brown louver lancets (`#7d2e24`) on Stage 3, pointed-arch belfry balustrade + twin dark arches with visible cast-bronze bells + spoked oculus on Stage 4, and 8-ribbed crocketed stone spire with sound openings & summit banners on Stage 5.
- **Hollow 5-Bay Basilica Nave & 5-Dome Triconch East Sanctuary:** Stepped `A-Ω` screen gable, terracotta barrel-clay roofs (`clay_roof_tiles`), polychrome Risen Christ side tympanums, central side gable with white Holy Spirit Dove & saint statue, festive roofline flags, 48.6m Central Crossing Dome + 3 two-story polygonal Rotunda Conch Wings with 2-tier crocketed pinnacles, 2-story open colonnette lanterns, white wrought-iron lower grilles, winged roof angels, and monumental polychrome Sacred Heart statue atop the East Apse dome; full hollow interior with 4 Crossing Triumphal Arches, 44 ironwood pews, 12 chandeliers, 14 Stations, 4 confessionals, 35-pipe organ, and 3-spire gilded Reredos.

## 3. Material & Budget Targets
- **Primary Mortar:** Cool Bùi Chu slate-charcoal `weathered_concrete` (`#6e727a` / `#40444b`, rain streaks `#1f2227`, `1024px`).
- **Exterior Windows:** Deep dark slate glass (`#0c121b`) with crisp white rectangular muntin grids (`3x6` tiles, `roughness: 0.28`).
- **Budget Tier:** `architecture` (`renderedTris <= 750k`, `drawCalls <= 350`, `textureVRAM <= 96 MB`, `GLB <= 24 MB`, lossless PNG data maps).

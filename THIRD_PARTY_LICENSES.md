# Third-Party Software & Asset Licenses

Web Blender Studio incorporates the following open-source libraries and permissively licensed 3D assets in its public distribution (`dist/`). All non-commercial (`CC-BY-NC*`), Mixamo, Ready Player Me, and unverified assets on local developer disks are excluded from `dist/` via `assets/asset-ship-policy.json` (`requireCommercialSafe: true`).

---

## 1. Vendored Software & WASM Dependencies

| Package / Component | Path | License | Notes / Attribution |
| --- | --- | --- | --- |
| Three.js (r160) | `vendor/three/` | MIT | Copyright 2010–2023 Three.js Authors |
| three-mesh-bvh | `vendor/three-mesh-bvh/` | MIT | BVH raycast/mesh acceleration (Garrett Johnson) |
| three-bvh-csg | `vendor/three-bvh-csg/` | MIT | CSG boolean operations |
| three-gpu-pathtracer | `vendor/three-gpu-pathtracer/` | MIT | GPU WebGL2 path tracing |
| Rapier Physics (`@dimforge/rapier3d-compat` 0.21.0) | `vendor/rapier/` | Apache-2.0 | See `vendor/rapier/LICENSE` |
| MediaPipe Tasks Vision (`@mediapipe/tasks-vision` 0.10.14) | `vendor/mediapipe/` | Apache-2.0 | Google MediaPipe pose/hand/face WASM & `.task` models |
| MP4Box.js | `vendor/mp4box/` | BSD-3-Clause | Copyright 2012 Telecom ParisTech / Cyril Concolato (`vendor/mp4box/LICENSE`) |
| mp4-muxer | `vendor/mp4-muxer/` | MIT | Client-side MP4 container muxer |
| Custom Rust WASM Kernels | `crates/*`, `vendor/wasm/*.wasm` | MIT | Web Blender Studio (`mesh_kernel`, `video_kernel`, `render_kernel`, `mocap_kernel`) |

---

## 2. Public-Build 3D Assets (`dist/`)

### CC0 1.0 Universal (Public Domain Dedication)

| Asset | Author / Source | License |
| --- | --- | --- |
| `/models/Mannequin_CC0.glb` | Web Blender Studio (`scripts/build_cc0_characters_blender.py`) | CC0-1.0 |
| `/models/Bot_CC0.glb` | Web Blender Studio (`scripts/build_cc0_characters_blender.py`) | CC0-1.0 |
| `/assets/characters/Mary_Statue_Sorrows.glb` | Virtual Museums of Małopolska ([Sketchfab](https://sketchfab.com/3d-models/sculpture-our-lady-of-sorrows-e601c914626e422c83ca161bb300b0f0)) | CC0-1.0 |
| Online Poly Haven Materials & HDRIs | [Poly Haven](https://polyhaven.com/license) | CC0-1.0 |

### Creative Commons Attribution (CC-BY-3.0 / CC-BY-4.0)

Attribution is preserved inside the Asset Library metadata (`assets/library/studio-catalog.json`) and listed below:

| Asset | Author | License | Source URL |
| --- | --- | --- | --- |
| `/models/LeePerrySmith.glb` | Lee Perry-Smith (Infinite-Realities) | CC-BY-3.0 | https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/LeePerrySmith |
| `/assets/characters/CesiumMan.glb` | Analytical Graphics, Inc. (Khronos glTF Sample Assets) | CC-BY-4.0 | https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CesiumMan |
| `/assets/characters/nemetona.glb` | JOJObrush | CC-BY-4.0 | https://sketchfab.com/3d-models/nemetona-naturebeauty-c338180707ce4b7c9bb4d1c6d24843c0 |
| `/assets/environments/Southwark_Stained_Glass.glb` | Thomas Flynn | CC-BY-4.0 | https://sketchfab.com/3d-models/stained-glass-window-southwark-cathedral-9f24973fc9c344539a6105a1e7357fb4 |
| `/assets/environments/Cathedral_Maya.glb` | tabitown | CC-BY-4.0 | https://sketchfab.com/3d-models/cathedral-f0d2480a1707407082fa18b51f7ba666 |
| `/assets/environments/Cathedral_Interior_Maya.glb` | tabitown | CC-BY-4.0 | https://sketchfab.com/3d-models/cathedral-f0d2480a1707407082fa18b51f7ba666 |
| `/assets/environments/Chapel_Interior_Baked.glb` | Elin | CC-BY-4.0 | https://sketchfab.com/3d-models/gallery-chapel-baked-f711193390dd4482a0bfaf10dfb3f77d |
| `/assets/environments/Gallery_Chapel.glb` | Elin | CC-BY-4.0 | https://sketchfab.com/3d-models/gallery-chapel-baked-f711193390dd4482a0bfaf10dfb3f77d |
| `/assets/environments/Church_Interior_Scan.glb` | sonnycirasuolo | CC-BY-4.0 | https://sketchfab.com/3d-models/ame-church-interior-100k-266ff61ab864449a9a7ed6c24081ef61 |
| `/assets/characters/Mary_Statue_Fatima.glb` | marlocalderon | CC-BY-4.0 | https://sketchfab.com/3d-models/our-lady-of-fatima-9212e6cdee8c46e79f21cf77aca7d8f9 |
| `/assets/characters/Mary_Statue_Grace.glb` | Austin Beaulier | CC-BY-4.0 | https://sketchfab.com/3d-models/our-lady-of-grace-statue-virgin-mary-scan-a1e63357f3fa4a8d9a310db3ae35c2fb |
| `/assets/characters/Mary_Statue_Grace_WhiteMarble.glb` | Austin Beaulier | CC-BY-4.0 | https://sketchfab.com/3d-models/our-lady-of-grace-statue-virgin-mary-scan-a1e63357f3fa4a8d9a310db3ae35c2fb |
| `/assets/characters/Mary_Statue_V2.glb` | Austin Beaulier | CC-BY-4.0 | https://sketchfab.com/3d-models/our-lady-of-grace-statue-virgin-mary-scan-a1e63357f3fa4a8d9a310db3ae35c2fb |

---

## 3. Excluded Dev-Only Assets

Assets under non-commercial (`CC-BY-NC*`, `CC-BY-NC-SA*`), Adobe Mixamo, Ready Player Me, or unverified licenses (`Church_Pew_Bench.glb`, `Church_Environment.glb`, `Michelle.glb`, `Soldier*.glb`, `readyplayer.me.glb`, `Congregation_Male*.glb`, `test_brunette.glb`, `Mary_Statue_159.glb`, `Mary_Statue_NotreDame.glb`, `AvatarSample_*`, `Choir_Singer*`, `UAL_Standard.gltf`) are strictly **Dev-Only** (`commercialSafe: false`) and are stripped from public builds (`npm run build`) automatically.

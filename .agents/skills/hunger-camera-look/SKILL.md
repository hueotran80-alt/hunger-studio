---
name: hunger-camera-look
description: Configure physically fitted 4K sun shadows, sky/studio lighting, interior fill lights, AgX post-processing, and matched camera framing for Hunger 3D Studio.
---

# Hunger Camera & Lighting Look-Dev

Use this skill to configure physically plausible sunlight, studio lighting, atmospheric skies/HDRIs, hollow interior fill lights, AgX post-processing, path-tracing looks, and reference-matched camera framing in **Hunger 3D Studio**.

## 1. Physically Fitted 4K Sun Shadows & Lighting
1. **Protect Shadow Frustum Tightness:** Always mark oversized ground/horizon planes (`> 100 m`) with `castShadow: false` (`receiveShadow: true`). Otherwise `setupSunLight()` expands the orthographic shadow frustum to the horizon and destroys shadow sharpness!
2. **Fit 4K Sun & Sky:**
   ```js
   studio.setupSunLight({
     elevation: 38,          // degrees above horizon (22-35 golden hour, 38-55 clear daylight)
     azimuth: 142,           // sun compass azimuth (cross-light 35-55 deg off camera axis for relief)
     intensity: 2.2,
     shadowMapSize: 4096,
     withSky: true,
   });
   ```
   Target shadow texel size `<= 4 cm` across hero architecture (`<= 0.5 cm` for product scale).
3. **Three-Point & Product Studio Look-Dev:**
   - Call `studio.setupProStudio({ withBackdrop: false, withTurntable: false, hdri: 'studio-softbox' })` (enable `withBackdrop: true` only when the user explicitly requests a studio cyclorama wall).
   - Procedural HDRI presets: `'studio-softbox'`, `'golden-sunset'`, `'cyberpunk-neon'`, `'industrial-warehouse'`.
   - Atmospheric fog: `studio.setAtmosphericFog(true, 'studio'|'day'|'sunset'|'cyberpunk'|'dense-mist')`.
4. **Hollow Interior Illumination:**
   - Place warm non-shadow-casting `PointLight` fill nodes (`castShadow: false`, `color: 0xffd6a5`, `intensity: 1.5–4.0`, `distance: 15–30`) along interior bays, vaults, and focal altars so interior depth reads clearly without blowing the WebGL shadow-map budget.

## 2. AgX Post-Processing & Render Engines
- **Realtime Quality Presets:**
  `studio.setRenderQuality('fast' | 'studio' | 'cinematic', { exposure: 1.0, ao: true, bloom: true })`
  - Uses `EffectComposer` + `GTAOPass` + `UnrealBloomPass` + optional `BokehPass` + `OutputPass` (**AgX** tone mapping).
  - On daylight exteriors, keep bloom threshold `>= 0.90` and strength `<= 0.25` so bright stone/plaster does not halo.
- **Path-Tracing Still / Hero Video Engines:**
  - `Three GPU Path Tracer` (`<= 200k` tris), `WebGPU Cycles X`, and `Rust CPU WASM Path Tracer` (SIMD128 BVH4, supports `> 200k` tris + temporal reprojection + AgX/ACES/Neutral).

## 3. Camera Ownership & Diagnostic Framing Rules
1. **Strict User Camera Respect:**
   - Inside AI Copilot scripts, **NEVER** move `engine.camera.position`, lock `controls.enabled = false`, or set `withTurntable: true` unless the user explicitly asks for turntable/camera placement.
   - Creating a scene camera object (`studio.addCamera({ name, x, y, z, targetX, targetY, targetZ, fov, focalLength })`) is safe and tracked cleanly by `LIVE_COMMAND_META.mutatesCamera`.
2. **Bounding-Diagonal QA Shot Formulas:** Compute bounding sphere radius `R` / diagonal `D` of the hero root:
   - **Macro Overview:** distance `≈ 1.3 – 1.5 × D`, focal length `35–50 mm`, elevated `12°–22°`.
   - **3/4 Hero & Side/Rear Massing:** distance `≈ 0.85 – 1.1 × D`, azimuth `±35°–55°` & `±135°`, cross-lit by sun.
   - **Close-Up Micro-Detail:** distance `5 – 20 m` (architecture) or `0.5 – 2.5 m` (product), focal length `50–85 mm`.
   - **Walkable Hollow Interior:** camera inside cavity at eye height `1.7 – 3.2 m`, focal length `24–32 mm`, aiming along primary axis.
3. **Reference Calibration:** Compare luminance histogram, wall albedo value, hue/saturation, and silhouette crop directly against supplied reference images before approving the final look.

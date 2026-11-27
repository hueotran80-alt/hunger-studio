/**
 * Web Blender Studio - Hunger AI Copilot Modular Skill System
 * Dynamically routes domain-agnostic 3D engineering skills into the Copilot LLM
 * system prompt based on user intent, attached reference images, live scene state,
 * and user-pinned skills — aligned 1:1 with the 8 generic `.agents/skills/hunger-*`
 * Antigravity skills while obeying the exact Copilot Worker sandbox contract.
 * File: js/ai/copilot-skills.js
 */

function normalizeIntentText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
}

export const COPILOT_SKILLS = Object.freeze([
  Object.freeze({
    id: 'cad-modeling',
    label: 'CAD',
    icon: '📐',
    title: 'Parametric CAD, Loft, Sweep & GPU Instancing',
    antigravitySkill: 'hunger-parametric-cad',
    summary: 'Watertight extrusions with holes, mitered sweeps, lathes, multi-profile lofts, curves & GPU instancing.',
    keywords: [
      /\b(build|create|model|design|construct|arch|building|house|villa|castle|tower|bridge|dome|spire|roof|facade|wall|window|door|stair|balcony|column|pillar|pillar|room|interior|hollow|furniture|sofa|table|chair|car|supercar|vehicle|ship|spaceship|rocket|robot|mech|valve|pipe|flange|gear|machine|gadget|product|bottle|vase|lamp|lantern|fence|gate|railing|loft|sweep|lathe|extrude|curve|catenary|helix|instance|instanced|array|merge|boolean|cad)\b/,
      /\b(dung|xay|tao|ve|thiet ke|kien truc|nha|biet thu|lau dai|thap|cau|mai vom|mai ngoi|mat tien|tuong|cua so|cua chinh|cau thang|ban cong|cot|phong|noi that|rong ruot|ban ghe|o to|sieu xe|tau|phi thuyen|ro bot|co khi|van|ong|banh rang|den|hang rao|cong|lan can|duong cong|vong cung|nhan ban|gop mesh)\b/,
    ],
    prompt: [
      '[SKILL: Parametric CAD & 3-Tier 3D Craftsmanship]',
      '- NEVER build hero models out of 5–15 stacked cubes/cones! Deliver 3 detail tiers: (1) accurate curved/tapered/pierced CAD silhouette grounded cleanly at y=0, (2) secondary structural assemblies (plinths, cornices, recessed door/window frames with mullions, roof eaves, ribs, chamfers, wheels/arches) computed from shared dimension constants so ZERO parts float or z-fight (offset layered trims >=0.005m), (3) tertiary micro-detail via GPU `addInstancedMesh` / `scatterOnCurve`.',
      '- Working CAD pattern (copy this exact ergonomics):',
      '  ```js',
      '  const arch = studio.sampleContour({ op: "twoCenterArc", centerX: 0, springY: 1.8, baseY: 0, width: 1.8, height: 3.1 }, 16);',
      '  const win = studio.sampleContour({ op: "roundedRect", centerX: 2.4, centerY: 2.2, width: 1.0, height: 1.4, radius: 0.08 }, 12);',
      '  const wall = studio.addExtrude({ name: "Facade", contour: [[-4,0],[4,0],[4,5],[-4,5]], holes: [arch, win], depth: 0.45, bevelSize: 0.025, uvScale: 2, creaseAngleDeg: 32, material: wallMat });',
      '  const cornice = studio.addSweep({ name: "Cornice", profile: [[0,0],[0.25,0],[0.3,0.16],[0.1,0.26],[0,0.26]], path: [[-4.1,5,0.25],[4.1,5,0.25]], closedPath: false, material: trimMat });',
      '  const dome = studio.addLathe({ name: "Dome", profile: [[2,0],[1.95,0.8],[1.4,1.8],[0.6,2.5],[0,2.7]], segments: 32, y: 5, material: roofMat });',
      '  const cols = studio.addInstancedMesh(colProto, [{ x: -3, y: 0, z: 0.4 }, { x: 3, y: 0, z: 0.4, ry: Math.PI }], { removeSource: true, name: "Columns" });',
      '  ```',
      '- Use `studio.addLoft({sections:[{contour,x,y,z,scale,twist}],samples:24,capStart:true,capEnd:true})` for spires/hulls/aerodynamic shells, `studio.addSurfaceGrid({grid,thickness:0.18})` for vaults/canopies, and `studio.mergeMeshes(parts,{removeSources:true,recomputeCreaseNormals:true,vertexAO:true})` to consolidate static same-material parts.',
    ].join('\n'),
  }),

  Object.freeze({
    id: 'surface-pbr',
    label: 'PBR',
    icon: '🎨',
    title: 'Procedural PBR, Box-Projected UVs & Multi-Slot Look-Dev',
    antigravitySkill: 'hunger-surface-pbr',
    summary: '13 tileable Worker PBR patterns, physical UV projection, cavity AO, multi-slot targeting & clean material sharing.',
    keywords: [
      /\b(material|pbr|texture|roughness|metalness|normal\s*map|bump|albedo|color|recolor|paint|stone|ashlar|concrete|plaster|stucco|brick|wood|timber|plank|marble|tile|slate|roof\s*tile|terracotta|glass|mosaic|stained|metal|steel|gold|bronze|copper|chrome|brushed|carbon|fabric|leather|plastic|ceramic|glossy|matte|shiny|emissive|glow|neon|uv|triplanar|ao|clearcoat|sheen|transmission|weathered_concrete|ashlar_stone|stucco_plaster|clay_roof_tiles|roof_slates|wood_grain|checkered_marble|mullioned_glass|stained_mosaic|voronoi|noise)\b/,
      /\b(vat lieu|chat lieu|hoa tiet|van go|van da|be tong|vua|thach cao|gach|go|da cam thach|ngoi|kinh|kim loai|vang|dong|bac|thep|nhua|vai|da thuoc|gom|bong|nham|phat sang|doi mau|to mau|son mau|phu vat lieu)\b/,
    ],
    prompt: [
      '[SKILL: Surface PBR, Procedural Maps & UVs]',
      '- Share ONE canonical material per surface class across meshes (never `.clone()` inside loops). Call `studio.boxProjectUV(target, {metersPerTile:2.0, worldSpace:true})` on planar/extruded surfaces for consistent physical texel density.',
      '- Use `await studio.applyProceduralPBR(target, {pattern, resolution, repeat:[u,v], normalScale, useDiffuseMap, useRoughnessMap, color1, color2, tint, roughness, metalness, slotIndex, clearcoat, sheen, transmission})` — ALWAYS `await` it before calling `studio.setColor` / `studio.setEmissive` on the same target.',
      '- Valid Worker patterns (13): `weathered_concrete`, `ashlar_stone`, `stucco_plaster`, `clay_roof_tiles`, `roof_slates`, `wood_grain`, `checkered_marble`, `mullioned_glass`, `stained_mosaic`, `brushed`, `carbon`, `voronoi`, `noise`.',
      '- Use `resolution: 1024` for hero surfaces and `512` for trims/props; keep albedo out of pure black/white (`#14161a`..`#eaeaea`); call `studio.bakeVertexAO(target)` + `studio.computeCreaseNormals(target, 32)` for crisp hard-surface relief.',
    ].join('\n'),
  }),

  Object.freeze({
    id: 'reference-3d',
    label: 'Ref-3D',
    icon: '🖼️',
    title: 'Reference-Locked Image-to-3D Reconstruction',
    antigravitySkill: 'hunger-project-contract',
    summary: 'Measures W:H:D ratios, register elevations, exact part counts, silhouette & palette from reference photos before modeling.',
    keywords: [
      /\b(reference|blueprint|photo|image|picture|concept\s*art|orthographic|match\s*the\s*image|based\s*on\s*image|proportion|silhouette|exact\s*match|reconstruct|replica)\b/,
      /\b(anh tham chieu|theo anh|giong anh|ban ve|ti le|ty le|hinh mau|tai tao|dung theo hinh|anh dinh kem)\b/,
    ],
    prompt: [
      '[SKILL: Reference-Locked Image-to-3D Reconstruction]',
      '- Before writing code, briefly state a compact proportion contract extracted from the reference: overall `W x H x D` (meters, Y-up), vertical registers (base/mid/upper/crown), exact visible counts (bays, arches, tiers, columns, windows, wheels, spokes), hollow vs solid volume, and 3-5 sampled surface colors.',
      '- Lock primary silhouette & W:H / D:H aspect ratios FIRST using parametric CAD (`addExtrude` with `holes`, `addSweep`, `addLoft`, `addLathe`, `addInstancedMesh`), then add architectural/mechanical details and `await studio.applyProceduralPBR(...)`.',
      '- Match material finish & lighting mood to the image (calibrated albedo value, roughness contrast, fitted 4K `setupSunLight` shadow angle) while NEVER hijacking the user viewport camera.',
    ].join('\n'),
  }),

  Object.freeze({
    id: 'camera-lighting',
    label: 'Look-Dev',
    icon: '💡',
    title: '4K Sun Shadows, Sky, HDRI & AgX Post-Processing',
    antigravitySkill: 'hunger-camera-look',
    summary: 'Physically fitted 4K sun frustum, sky dome, HDRI presets, AgX quality, interior fill lights & safe camera rules.',
    keywords: [
      /\b(light|lighting|sun|sunlight|shadow|sky|skydome|hdri|sunset|sunrise|golden\s*hour|night|daylight|dramatic|cinematic|moody|studio\s*light|three[\s-]?point|rim\s*light|fog|mist|atmosphere|bloom|agx|exposure|tone\s*map|post[\s-]?process|render\s*quality|backdrop|cyclorama|camera|focal|fov|turntable|shading|matcap|wireframe)\b/,
      /\b(anh sang|den|mat troi|bong do|bau troi|hoang hon|binh minh|ban dem|dien anh|studio|suong mu|phoi canh|camera|goc quay|xoay 360|do bong|chat luong hien thi)\b/,
    ],
    prompt: [
      '[SKILL: 4K Sun Shadows, Look-Dev & Camera Rules]',
      '- Set `castShadow = false` (`receiveShadow = true`) on large ground/horizon planes (>100m) so `studio.setupSunLight({elevation, azimuth, intensity, shadowMapSize:4096, withSky:true})` fits a sharp 4K shadow frustum tightly around the hero model.',
      '- Pair sunlight with `studio.setRenderQuality("studio"|"cinematic"|"fast")` (AgX tone mapping + GTAO + subtle Bloom), `studio.setupProStudio({withBackdrop:false, withTurntable:false, hdri:"studio-softbox"|"golden-sunset"|"cyberpunk-neon"|"industrial-warehouse"})`, or `studio.setAtmosphericFog(true, preset)`.',
      '- For hollow interiors, add warm non-shadow-casting `studio.addLight({type:"point", ...})` fill lights (`castShadow = false`) along bays/focal zones.',
      '- NEVER move `engine.camera.position` or lock `controls.enabled`; create a scene camera with `studio.addCamera({name,x,y,z,targetX,targetY,targetZ,fov,focalLength})` and only enable `setTurntable(true)` if the user explicitly asks.',
    ].join('\n'),
  }),

  Object.freeze({
    id: 'character-mocap',
    label: 'Rig/Anim',
    icon: '🦴',
    title: 'Characters, Skeletons, Posing & Animation',
    antigravitySkill: 'hunger-character-mocap',
    summary: 'CC0 rigged humanoids, articulated actors, bone-safe posing/IK, keyframe tracks & real-time studio.animate loops.',
    keywords: [
      /\b(character|human|person|mannequin|bot|actor|avatar|skeleton|rig|armature|bone|skin|skinning|pose|tpose|walk|run|idle|dance|wave|mocap|ik|keyframe|timeline|animate|animation|spin|rotate\s*continuously|orbit\s*around|windmill|propeller|pendulum|move\s*back\s*and\s*forth)\b/,
      /\b(nhan vat|con nguoi|nguoi mau|khung xuong|gan xuong|tu the|di bo|chay|nhay|vay tay|hoat canh|chuyen dong|chuyen dong lien tuc|quay tron|canh quat|coi xay gio|khung hinh)\b/,
    ],
    prompt: [
      '[SKILL: Characters, Rigging & Animation]',
      '- Load built-in CC0 rigged characters with `const actor = await studio.loadHumanWithAnimation({animation:"Walk"|"Idle"|"Run"|"TPose", showSkeleton:true, keepScene:true, x, y, z})` (ALWAYS `await`; set `keepScene:true` unless clearing the scene).',
      '- For stylized custom actors, use `studio.createArticulatedActor({name, x, y, z, rotY, shirtColor, pantsColor, hasJacketLayer})` or `await studio.createRiggedMannequin({height:1.8, skinned:true})`.',
      '- NEVER rename existing skeleton bones (renaming breaks `PropertyBinding` animation tracks and glTF export).',
      '- For real-time motion, use `studio.animate(target, (t, dt, obj) => { ... })` or timeline keyframes (`studio.insertKeyframe(obj, frame, ["position","rotation","scale"])`, `studio.playAnimation()`). Only claim animation is running if code actually creates one.',
    ].join('\n'),
  }),

  Object.freeze({
    id: 'edit-modifiers-physics',
    label: 'Mod/Phys',
    icon: '🔧',
    title: 'Edit Mode, Non-Destructive Modifiers & Rapier Physics',
    antigravitySkill: 'hunger-parametric-cad',
    summary: 'Blender-style Edit Mode ops, Catmull-Clark/Bevel/Solidify/Boolean modifier stack & Rapier rigid-body simulation.',
    keywords: [
      /\b(edit\s*mode|vertex|vertices|edge|face|inset|bevel|subdivide|subdivision|catmull|solidify|displace|smooth|mirror|decimate|screw|remesh|weld|modifier|modifiers|boolean|subtract|union|intersect|cutout|carve|physics|gravity|rigid\s*body|collider|collision|bounce|fall|drop|rapier|joint|hinge|motor|mass|friction|restitution)\b/,
      /\b(che do sua|dinh|canh|mat|vat canh|chia luoi|lam day|lam min|doi xung|giam luoi|khoet lo|cat khoi|bo sua doi|vat ly|trong luc|va cham|roi tu do|nay|khop noi|dong co)\b/,
    ],
    prompt: [
      '[SKILL: Edit Mode, Modifiers & Rapier Physics]',
      '- Edit Mode operations: `studio.enterEditMode(mesh)`, `studio.setEditSelectionMode("vertex"|"edge"|"face")`, `studio.selectFace(i)` / `selectEdge(i)`, `studio.extrude(d)`, `studio.inset(o)`, `studio.subdivide()`, `studio.bevel(w, segs)`, `studio.deleteSelection()`, `studio.exitEditMode()`.',
      '- Non-destructive modifiers: `studio.modifiers.add("bevel"|"subdivision"|"solidify"|"displace"|"smooth"|"mirror"|"array"|"decimate"|"screw"|"weld", params, mesh)` or `window.Modifiers.applyModifier(mesh, type, params)`; CSG boolean via `studio.boolean("subtract"|"union"|"intersect", meshA, meshB)`.',
      '- Rapier rigid-body physics: configure via `window.simulationManager?.setConfig(mesh, {body:"dynamic"|"fixed"|"kinematic", collider:"auto"|"box"|"sphere"|"cylinder"|"capsule"|"convex", mass, friction, restitution})` — always make the floor/ground `body: "fixed"`.',
    ].join('\n'),
  }),

  Object.freeze({
    id: 'budget-export',
    label: 'Budget/GLB',
    icon: '📦',
    title: 'Scene Budget Audit, Optimization & Commercial Export',
    antigravitySkill: 'hunger-runtime-budget-agent',
    summary: 'Commercial WebGL budgets (mobile/product/architecture), draw-call reduction, lossless-data GLB export & MP4 video export.',
    keywords: [
      /\b(budget|optimize|optimise|performance|fps|lag|slow|heavy|draw\s*call|triangle|tri\s*count|poly\s*count|vram|memory|lod|simplify|export|glb|gltf|download|video|mp4|render\s*video|inspect\s*budget|report|audit)\b/,
      /\b(toi uu|hieu nang|nang|giat|lag|ngan sach|giam da giac|giam luoi|xuat file|xuat glb|xuat mo hinh|xuat video|tai xuong|kiem tra canh|thong ke)\b/,
    ],
    prompt: [
      '[SKILL: Runtime Budget, Optimization & Export]',
      '- Audit performance with `const budget = studio.inspectSceneBudget("product"|"mobile"|"architecture")` — tier ceilings: mobile <=30k tris/40 draws/32MB VRAM, product <=50k/60/64MB, architecture <=750k/350/96MB.',
      '- To cut draw calls & VRAM: merge static same-material meshes (`studio.mergeMeshes(parts, {removeSources:true})`), convert repeated meshes to `studio.addInstancedMesh` / `studio.batchToInstances`, simplify high-poly meshes (`await studio.simplify(mesh, 0.35)`), and cap non-hero textures at `512px`.',
      '- Commercial GLB export: `const res = await studio.exportModel({binary:true, optimize:true, textureFormat:"auto", lossyDataMaps:false, maxTextureSize:1024, download:true})` (JPEG color + lossless PNG data maps, preserves multi-material groups). Deterministic MP4 video: `await studio.renderVideo({fps:30, durationSec:4, width:1280, height:720})`.',
    ].join('\n'),
  }),

  Object.freeze({
    id: 'tutor-coach',
    label: 'Tutor 1:1',
    icon: '🎓',
    title: 'Interactive 1-on-1 AI Tutor & STEM Walkthrough',
    antigravitySkill: 'hunger-orchestrator',
    summary: 'Guided step-by-step UI pointer walkthroughs, Vietnamese/English voice coaching & STEM lesson grading.',
    keywords: [
      /\b(teach|tutorial|walkthrough|guide\s*me|step\s*by\s*step|lesson|stem|grade|explain\s*how|how\s*do\s*i|coach)\b/,
      /\b(huong dan|day toi|day em|tung buoc|bai hoc|cham diem|giao vien|giai thich cach|chi toi|chi minh|lam mau)\b/,
    ],
    prompt: [
      '[SKILL: 1-on-1 Interactive AI Tutor]',
      '- When the user asks to learn step-by-step or wants UI coaching, call `await studio.tutor.guideSteps([{title, speech, pointAt, viewportMode, editSelectionMode, openPanel, demoCode}, ...], {speak:true, autoAdvance:true})` so the floating Tutor avatar flies to each UI control and explains aloud.',
      '- For STEM curriculum commands, use `studio.tutor.startLesson(lessonId)`, `studio.tutor.demo()`, or `studio.tutor.grade()`.',
    ].join('\n'),
  }),
]);

const SKILL_BY_ID = new Map(COPILOT_SKILLS.map((s) => [s.id, s]));

/**
 * Returns serializable metadata for UI skill pills, `/skill` command, and tests.
 */
export function getCopilotSkillCatalog() {
  return COPILOT_SKILLS.map(({ id, label, icon, title, antigravitySkill, summary }) => ({
    id,
    label,
    icon,
    title,
    antigravitySkill,
    summary,
  }));
}

/**
 * Resolves a skill by exact ID or case-insensitive label/alias.
 */
export function resolveCopilotSkillId(idOrAlias) {
  const norm = normalizeIntentText(idOrAlias).trim().replace(/^hunger-/, '');
  if (!norm) return null;
  if (SKILL_BY_ID.has(norm)) return norm;
  const aliasMap = {
    cad: 'cad-modeling',
    'parametric-cad': 'cad-modeling',
    modeling: 'cad-modeling',
    pbr: 'surface-pbr',
    material: 'surface-pbr',
    materials: 'surface-pbr',
    ref: 'reference-3d',
    'ref-3d': 'reference-3d',
    reference: 'reference-3d',
    'project-contract': 'reference-3d',
    light: 'camera-lighting',
    lighting: 'camera-lighting',
    lookdev: 'camera-lighting',
    'look-dev': 'camera-lighting',
    camera: 'camera-lighting',
    'camera-look': 'camera-lighting',
    rig: 'character-mocap',
    anim: 'character-mocap',
    animation: 'character-mocap',
    character: 'character-mocap',
    mocap: 'character-mocap',
    mod: 'edit-modifiers-physics',
    modifiers: 'edit-modifiers-physics',
    physics: 'edit-modifiers-physics',
    edit: 'edit-modifiers-physics',
    budget: 'budget-export',
    export: 'budget-export',
    glb: 'budget-export',
    qa: 'budget-export',
    'runtime-budget-agent': 'budget-export',
    'multizoom-qa-delivery': 'budget-export',
    tutor: 'tutor-coach',
    stem: 'tutor-coach',
    coach: 'tutor-coach',
  };
  return aliasMap[norm] || null;
}

/**
 * Deterministically selects the top 1..maxSkills most relevant Copilot skills for a turn.
 * @param {string} userPrompt
 * @param {Object} [options]
 * @param {Array} [options.images]
 * @param {string} [options.liveScene]
 * @param {string[]} [options.pinnedSkillIds]
 * @param {number} [options.maxSkills=3]
 * @returns {Array<object>}
 */
export function selectCopilotSkills(userPrompt = '', options = {}) {
  const maxSkills = Math.max(1, Math.min(4, Number(options.maxSkills) || 3));
  const images = Array.isArray(options.images) ? options.images : [];
  const liveSceneNorm = normalizeIntentText(options.liveScene || '');
  const promptNorm = normalizeIntentText(userPrompt);
  const pinnedRaw = Array.isArray(options.pinnedSkillIds) ? options.pinnedSkillIds : [];

  const chosen = [];
  const chosenSet = new Set();
  const pushSkill = (id, reason) => {
    const skill = SKILL_BY_ID.get(id);
    if (!skill || chosenSet.has(id) || chosen.length >= maxSkills) return;
    chosenSet.add(id);
    chosen.push({ ...skill, reason });
  };

  // 1. User-pinned skills always take priority
  for (const rawId of pinnedRaw) {
    const resolved = resolveCopilotSkillId(rawId);
    if (resolved) pushSkill(resolved, 'pinned');
  }

  // 2. Reference image attachment automatically activates Reference-3D + CAD + PBR
  if (images.length > 0) {
    pushSkill('reference-3d', 'image-attached');
  }

  // 3. Score remaining skills deterministically from prompt + live scene signals
  const scores = [];
  for (const skill of COPILOT_SKILLS) {
    if (chosenSet.has(skill.id)) continue;
    let score = 0;
    for (const re of skill.keywords) {
      const matches = promptNorm.match(new RegExp(re.source, 'gi'));
      if (matches) score += matches.length * 3;
    }
    // Live scene context nudges (low weight so explicit prompt intent wins)
    if (skill.id === 'edit-modifiers-physics' && (/viewport mode:\s*edit/i.test(liveSceneNorm) || /active modifiers:/i.test(liveSceneNorm))) {
      score += 1;
    }
    if (skill.id === 'cad-modeling' && images.length > 0) {
      score += 4;
    }
    if (skill.id === 'surface-pbr' && images.length > 0) {
      score += 2;
    }
    if (score > 0) {
      scores.push({ id: skill.id, score });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  for (const item of scores) {
    if (chosen.length >= maxSkills) break;
    pushSkill(item.id, 'auto');
  }

  // 4. Sensible default: if nothing matched on a build/general prompt, activate CAD + PBR basics
  if (chosen.length === 0) {
    pushSkill('cad-modeling', 'default');
  }

  return chosen;
}

/**
 * Formats selected Copilot skills into a tight, token-bounded system prompt section.
 */
export function formatCopilotSkillsForPrompt(selectedSkills = [], options = {}) {
  const maxChars = Math.max(400, Math.min(5500, Number(options.maxChars) || 3400));
  if (!Array.isArray(selectedSkills) || selectedSkills.length === 0) return '';
  const blocks = [];
  let used = 0;
  for (const skill of selectedSkills) {
    const text = String(skill?.prompt || '').trim();
    if (!text) continue;
    if (used + text.length + 2 > maxChars) {
      if (blocks.length === 0) {
        blocks.push(text.slice(0, maxChars - 1) + '…');
      }
      break;
    }
    blocks.push(text);
    used += text.length + 2;
  }
  return blocks.join('\n\n');
}

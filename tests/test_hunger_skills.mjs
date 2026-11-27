import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from '../vendor/three/three.module.js';
import {
  sample2DContour,
  buildExtrudeGeometry,
  buildSweepGeometry,
  buildLoftGeometry,
  sampleCurve3D,
  buildCurveScatterInstances,
  buildInstancedMesh,
  indexGeometry,
} from '../js/core/geometry/parametric-cad.js';
import { inspectSceneBudget } from '../js/core/scene-budget.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import {
  COPILOT_SKILLS,
  getCopilotSkillCatalog,
  resolveCopilotSkillId,
  selectCopilotSkills,
  formatCopilotSkillsForPrompt,
} from '../js/ai/copilot-skills.js';
import { AICopilot } from '../js/ai/ai-copilot.js';

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class NodeFileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onloadend?.();
      });
    }
    readAsDataURL(blob) {
      blob.arrayBuffer().then((buf) => {
        const b64 = Buffer.from(buf).toString('base64');
        this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
        this.onloadend?.();
      });
    }
  };
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SKILLS_DIR = path.join(ROOT, '.agents', 'skills');

const GENERIC_SKILLS = [
  'hunger-orchestrator',
  'hunger-project-contract',
  'hunger-parametric-cad',
  'hunger-surface-pbr',
  'hunger-character-mocap',
  'hunger-camera-look',
  'hunger-runtime-budget-agent',
  'hunger-multizoom-qa-delivery',
];

const FORBIDDEN_PATTERNS = [
  /\bbpy\./i,
  /\bbmesh\b/i,
  /hung\s*nghia/i,
  /hưng\s*nghĩa/i,
  /nhà\s*thờ/i,
  /đức\s*mẹ/i,
  /mary_statue/i,
  /build_hung_nghia/i,
];

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS: ${name}`);
  passed++;
}

console.log('=== Phase 4 Hunger 3D Studio 8-Skill Suite + Unseen Domain Fixture Tests ===');

for (const skill of GENERIC_SKILLS) {
  await test(`Skill "${skill}" exists, has valid frontmatter, 0 bpy & 0 project hardcodes`, () => {
    const file = path.join(SKILLS_DIR, skill, 'SKILL.md');
    assert.ok(fs.existsSync(file), `Missing ${file}`);
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(content.startsWith('---\n'), `${skill} must start with YAML frontmatter`);
    assert.ok(content.includes(`name: ${skill}`), `${skill} frontmatter must declare matching name`);
    assert.ok(content.includes('description:'), `${skill} frontmatter must declare description`);
    assert.ok(content.length >= 1800, `${skill} must have deep production workflow instructions (got ${content.length})`);

    for (const pat of FORBIDDEN_PATTERNS) {
      const m = content.match(pat);
      assert.equal(m, null, `Generic skill ${skill} contains forbidden token "${m?.[0]}"`);
    }

    const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      const target = match[1].trim();
      if (/^https?:\/\//i.test(target) || target.startsWith('#')) continue;
      const clean = target.split('#')[0];
      if (!clean) continue;
      const resolved = path.resolve(path.dirname(file), clean);
      assert.ok(fs.existsSync(resolved), `Dead link "${target}" inside ${skill}/SKILL.md`);
    }
  });
}

await test('Project Profile "hung-nghia-gothic-archviz" cleanly composes the generic skill suite', () => {
  const file = path.join(SKILLS_DIR, 'hung-nghia-gothic-archviz', 'SKILL.md');
  assert.ok(fs.existsSync(file), 'Project profile exists');
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('hunger-orchestrator'), 'References hunger-orchestrator');
  assert.ok(content.includes('hunger-project-contract'), 'References hunger-project-contract');
  assert.ok(content.includes('hunger-parametric-cad'), 'References hunger-parametric-cad');
  assert.ok(content.includes('hunger-multizoom-qa-delivery'), 'References hunger-multizoom-qa-delivery');
  assert.ok(content.length < 4000, 'Project profile stays concise instead of duplicating engine docs');
});

await test('Unseen Fixture A (Product tier): Industrial Flanged Valve passes CAD, budget & GLB export', async () => {
  const scene = new THREE.Scene();
  const circle = (r, segs = 24) => Array.from({ length: segs }, (_, i) => {
    const a = (i / segs) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
  const bodyGeom = buildLoftGeometry({
    sections: [
      { contour: circle(0.55), y: 0 },
      { contour: circle(0.42), y: 0.35 },
      { contour: circle(0.48), y: 0.8 },
      { contour: circle(0.32), y: 1.15 },
    ],
    samples: 24,
    capStart: true,
    capEnd: true,
    creaseAngleDeg: 32,
  }, THREE);
  const metalMat = new THREE.MeshStandardMaterial({ name: 'CastIron', color: 0x3b424c, roughness: 0.45, metalness: 0.85 });
  scene.add(new THREE.Mesh(bodyGeom, metalMat));

  const helix = sampleCurve3D({ type: 'helix', radius: 0.24, height: 0.65, turns: 5, segments: 48 }, THREE);
  assert.equal(helix.length, 49);
  const boltGeom = indexGeometry(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 12), { tolerance: 1e-4 }, THREE);
  const boltCurve = sampleCurve3D({ type: 'arch', width: 0.9, springY: 0, excess: 0.45, segments: 8 }, THREE);
  const bolts = buildCurveScatterInstances(boltCurve, { alignTangent: true });
  scene.add(buildInstancedMesh(boltGeom, metalMat, bolts, { name: 'Flange_Bolts' }, THREE));

  const budget = inspectSceneBudget(scene, { tier: 'product' });
  assert.equal(budget.status, 'ok', `Product fixture budget failed: ${JSON.stringify(budget.warnings)}`);
  const glb = await new Promise((res, rej) => new GLTFExporter().parse(scene, res, rej, { binary: true }));
  assert.ok(glb instanceof ArrayBuffer && glb.byteLength > 2000, 'Unseen Product GLB exported cleanly');
});

await test('Unseen Fixture B (Architecture tier): Suspension Pedestrian Bridge passes CAD, budget & GLB export', async () => {
  const scene = new THREE.Scene();
  const cableCurve = sampleCurve3D({ type: 'catenary', start: [-18, 8, 0], end: [18, 8, 0], sag: 4.2, segments: 16 }, THREE);
  const deckContour = [[-2.2, 2.0], [2.2, 2.0], [2.4, 2.45], [-2.4, 2.45]];
  const deckGeom = buildLoftGeometry({
    sections: [
      { contour: deckContour, z: -18, plane: 'xy' },
      { contour: deckContour, z: 0, plane: 'xy' },
      { contour: deckContour, z: 18, plane: 'xy' },
    ],
    samples: 16,
    capStart: true,
    capEnd: true,
    creaseAngleDeg: 30,
  }, THREE);
  const stoneMat = new THREE.MeshStandardMaterial({ name: 'BridgeStone', color: 0x8b8680, roughness: 0.85 });
  scene.add(new THREE.Mesh(deckGeom, stoneMat));

  const postGeom = indexGeometry(new THREE.BoxGeometry(0.14, 1.1, 0.14), { tolerance: 1e-4 }, THREE);
  const posts = buildCurveScatterInstances(cableCurve, { alignTangent: false });
  scene.add(buildInstancedMesh(postGeom, stoneMat, posts, { name: 'Bridge_Hangers' }, THREE));

  const budget = inspectSceneBudget(scene, { tier: 'architecture' });
  assert.equal(budget.status, 'ok', `Architecture fixture budget failed: ${JSON.stringify(budget.warnings)}`);
  const glb = await new Promise((res, rej) => new GLTFExporter().parse(scene, res, rej, { binary: true }));
  assert.ok(glb instanceof ArrayBuffer && glb.byteLength > 1500, 'Unseen Architecture GLB exported cleanly');
});

await test('Antigravity skills document Round 1-5 invariants (TextureLeaseRegistry, LIVE_COMMAND_META, E_BUSY, addLoft)', () => {
  const pbrDoc = fs.readFileSync(path.join(SKILLS_DIR, 'hunger-surface-pbr', 'SKILL.md'), 'utf8');
  const budgetDoc = fs.readFileSync(path.join(SKILLS_DIR, 'hunger-runtime-budget-agent', 'SKILL.md'), 'utf8');
  const cadDoc = fs.readFileSync(path.join(SKILLS_DIR, 'hunger-parametric-cad', 'SKILL.md'), 'utf8');
  const lookDoc = fs.readFileSync(path.join(SKILLS_DIR, 'hunger-camera-look', 'SKILL.md'), 'utf8');
  assert.ok(pbrDoc.includes('TextureLeaseRegistry') && pbrDoc.includes('slotIndex'), 'hunger-surface-pbr documents TextureLeaseRegistry & slotIndex');
  assert.ok(budgetDoc.includes('LIVE_COMMAND_META') && budgetDoc.includes('E_BUSY') && budgetDoc.includes('ALLOWED_NEW_NODE_TYPES'), 'hunger-runtime-budget-agent documents sandbox & export mutex contracts');
  assert.ok(cadDoc.includes('addLoft') && cadDoc.includes('addInstancedMesh') && cadDoc.includes('bakeModifiers'), 'hunger-parametric-cad documents full CAD + modifier rollback');
  assert.ok(lookDoc.includes('setupSunLight') && lookDoc.includes('castShadow: false'), 'hunger-camera-look documents 4K frustum protection');
});

await test('Copilot Modular Skill System: 8 domain-agnostic skills, 0 hardcodes, 0 Worker-missing API traps', () => {
  const catalog = getCopilotSkillCatalog();
  assert.equal(catalog.length, 8, '8 Copilot skills registered');
  assert.equal(COPILOT_SKILLS.length, 8);
  for (const skill of COPILOT_SKILLS) {
    assert.ok(skill.id && skill.label && skill.icon && skill.prompt.length > 180, `${skill.id} has complete metadata & prompt`);
    const agyFile = path.join(SKILLS_DIR, skill.antigravitySkill, 'SKILL.md');
    assert.ok(fs.existsSync(agyFile), `${skill.id} links to real Antigravity skill ${skill.antigravitySkill}`);
    for (const pat of FORBIDDEN_PATTERNS) {
      assert.equal(skill.prompt.match(pat), null, `Copilot skill ${skill.id} contains forbidden hardcode`);
    }
    assert.ok(!skill.prompt.includes('createSignTexture'), `Copilot Worker skill ${skill.id} must not cite DOM-only createSignTexture`);
    assert.ok(!skill.prompt.includes('localStorage'), `Copilot Worker skill ${skill.id} must not cite blocked localStorage`);
  }
});

await test('Copilot Skill Router routes Vietnamese/English intents, images, pinning & char budget accurately', () => {
  const cadRes = selectCopilotSkills('Dựng tòa nhà có vòm và cột nhân bản');
  assert.equal(cadRes[0].id, 'cad-modeling', 'Vietnamese CAD prompt routes to cad-modeling');

  const pbrRes = selectCopilotSkills('Áp vật liệu đá ashlar_stone và chỉnh roughness');
  assert.equal(pbrRes[0].id, 'surface-pbr', 'Vietnamese PBR prompt routes to surface-pbr');

  const imgRes = selectCopilotSkills('Build this', { images: [{ dataUrl: 'data:image/png;base64,AA==' }] });
  assert.equal(imgRes[0].id, 'reference-3d', 'attached reference image auto-prioritizes reference-3d');
  assert.ok(imgRes.some((s) => s.id === 'cad-modeling'), 'image-to-3D pairs reference-3d with cad-modeling');

  const rigRes = selectCopilotSkills('Thêm nhân vật đi bộ và gắn khung xương');
  assert.equal(rigRes[0].id, 'character-mocap', 'rig/character prompt routes to character-mocap');

  const lightRes = selectCopilotSkills('Chỉnh ánh sáng hoàng hôn 4K và AgX cinematic');
  assert.equal(lightRes[0].id, 'camera-lighting', 'lighting prompt routes to camera-lighting');

  const expRes = selectCopilotSkills('Kiểm tra budget draw call và xuất file GLB');
  assert.equal(expRes[0].id, 'budget-export', 'budget/export prompt routes to budget-export');

  const modRes = selectCopilotSkills('Thêm bevel modifier và bật vật lý trọng lực');
  assert.equal(modRes[0].id, 'edit-modifiers-physics', 'modifier/physics prompt routes to edit-modifiers-physics');

  const tutorRes = selectCopilotSkills('Hướng dẫn mình từng bước tạo hình');
  assert.equal(tutorRes[0].id, 'tutor-coach', 'tutorial prompt routes to tutor-coach');

  assert.equal(resolveCopilotSkillId('pbr'), 'surface-pbr');
  assert.equal(resolveCopilotSkillId('hunger-camera-look'), 'camera-lighting');

  const pinned = selectCopilotSkills('hello', { pinnedSkillIds: ['export', 'pbr'], maxSkills: 2 });
  assert.deepEqual(pinned.map((s) => s.id), ['budget-export', 'surface-pbr'], 'pinned skills take strict priority');

  const bounded = formatCopilotSkillsForPrompt(COPILOT_SKILLS, { maxChars: 900 });
  assert.ok(bounded.length <= 900, `formatted skill prompt obeys maxChars (${bounded.length} <= 900)`);
});

await test('AICopilot dynamically injects routed skills, 3D craftsmanship rules & Vision Critique trigger', () => {
  const copilot = new AICopilot({ studio: {} });
  assert.equal(copilot.getSkills().length, 8, 'copilot.getSkills() exposes all 8 skills');

  const sysDefault = copilot._getSystemPrompt({ userPrompt: 'Build a suspension bridge with weathered_concrete' });
  assert.ok(sysDefault.includes('=== 2. 3D CRAFTSMANSHIP & QUALITY BAR'), 'system prompt leads with 3D craftsmanship bar');
  assert.ok(sysDefault.includes('=== 4. ACTIVE SPECIALIST SKILLS ==='), 'system prompt includes skill section');
  assert.ok(sysDefault.includes('[SKILL: Parametric CAD & 3-Tier 3D Craftsmanship]'), 'CAD skill injected');
  assert.ok(sysDefault.includes('[SKILL: Surface PBR, Procedural Maps & UVs]'), 'PBR skill injected');
  assert.ok(!sysDefault.includes('createSignTexture'), 'system prompt omits DOM-only createSignTexture trap');

  const msgsImg = copilot._buildOpenAIMessages('Match this photo', [{ dataUrl: 'data:image/png;base64,AA==' }]);
  assert.ok(msgsImg[0].content.includes('[SKILL: Reference-Locked Image-to-3D Reconstruction]'), 'image turn injects reference-3d skill');

  copilot.setPinnedSkills(['rig', 'export']);
  const sysPinned = copilot._getSystemPrompt({ userPrompt: 'hello' });
  assert.ok(sysPinned.includes('[SKILL: Characters, Rigging & Animation]'), 'pinned character skill injected');
  assert.ok(sysPinned.includes('[SKILL: Runtime Budget, Optimization & Export]'), 'pinned export skill injected');

  // Verify Vision Self-Critique heuristic with mock renderer
  const prevWin = globalThis.window;
  globalThis.window = { engine: { renderer: { domElement: {} } } };
  try {
    assert.equal(copilot._shouldRunAutoVisualCritique('Xây một ngôi biệt thự cổ điển', 'studio.addExtrude({});', []), true, 'hero architecture triggers auto Vision Critique');
    assert.equal(copilot._shouldRunAutoVisualCritique('Build this', 'studio.addCube({});', [{ dataUrl: 'data:image/png;base64,AA==' }]), true, 'attached reference image triggers auto Vision Critique');
    assert.equal(copilot._shouldRunAutoVisualCritique('Xóa hết cảnh', 'studio.clearScene();', []), false, 'clearScene skips auto Vision Critique');
    assert.equal(copilot._shouldRunAutoVisualCritique('Đổi màu thành xanh', 'studio.setColor(m, 0x0000ff);', []), false, 'minor recolor skips auto Vision Critique');
  } finally {
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
  }
});

await test('CAD ergonomics: sample2DContour type/height/roundedRect, Sweep {x,y,z} path & InstancedMesh ry/position aliases', () => {
  const arch = sample2DContour({ type: 'twoCenterArc', width: 2.0, springY: 1.5, baseY: 0, height: 3.0 }, 10);
  assert.ok(arch.length >= 18, `twoCenterArc with type+height+baseY produces full arch loop (${arch.length} pts)`);
  const maxY = Math.max(...arch.map((p) => p[1]));
  assert.ok(Math.abs(maxY - 3.0) < 0.05, `twoCenterArc apex hits requested height=3.0m (got ${maxY.toFixed(3)})`);

  const rrect = sample2DContour({ op: 'roundedRect', centerX: 0, centerY: 1.5, width: 1.2, height: 1.8, radius: 0.12 }, 16);
  assert.ok(rrect.length >= 12, 'roundedRect produces smooth cornered loop');

  const wallGeom = buildExtrudeGeometry({
    contour: [[-4, 0], [4, 0], [4, 5], [-4, 5]],
    holes: [arch],
    depth: 0.4,
  }, THREE);
  assert.ok(wallGeom.attributes.position.count > 40, 'pierced wall extrude succeeds with type+height arch hole');

  const sweepGeom = buildSweepGeometry({
    profile: [[0, 0], [0.2, 0], [0.2, 0.2], [0, 0.2]],
    path: [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: 2 }],
  }, THREE);
  assert.ok(sweepGeom.attributes.position.count > 24, 'buildSweepGeometry accepts plain {x,y,z} path objects');

  const inst = buildInstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial(), [
    { x: 3, y: 1, z: -2, ry: Math.PI / 2, sx: 2, sy: 1, sz: 1 },
    { position: [5, 2, 1], rotation: [0, Math.PI, 0], scale: [1, 3, 1] },
  ], { name: 'ErgonomicInst' }, THREE);
  const m0 = new THREE.Matrix4();
  const m1 = new THREE.Matrix4();
  inst.getMatrixAt(0, m0);
  inst.getMatrixAt(1, m1);
  const p0 = new THREE.Vector3(), q0 = new THREE.Quaternion(), s0 = new THREE.Vector3();
  const p1 = new THREE.Vector3(), q1 = new THREE.Quaternion(), s1 = new THREE.Vector3();
  m0.decompose(p0, q0, s0);
  m1.decompose(p1, q1, s1);
  assert.ok(Math.abs(p0.x - 3) < 1e-4 && Math.abs(s0.x - 2) < 1e-4 && Math.abs(q0.y - Math.SQRT1_2) < 1e-3, 'ry/sx aliases decomposed accurately');
  assert.ok(Math.abs(p1.x - 5) < 1e-4 && Math.abs(s1.y - 3) < 1e-4 && Math.abs(q1.y - 1) < 1e-3, 'position/rotation/scale array aliases decomposed accurately');
});

console.log(`ALL ${passed} HUNGER SKILL SUITE & COPILOT SKILL TESTS PASSED`);

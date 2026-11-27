/**
 * Web Blender Studio - Scripting Code Editor & Console Module
 * Provides an integrated Blender-themed code editor with line numbers,
 * preset DSL scripts, keyboard shortcuts (Ctrl+Enter), and custom console output.
 * File: js/scripting/code-editor.js
 */

import { studio } from './rapid-api.js';

const SAFE_LOG_TYPES = new Set(['info', 'print', 'warn', 'error', 'success', 'system']);

function safeStringify(value, maxDepth = 4) {
  if (typeof value !== 'object' || value === null) return String(value);
  const seen = new WeakSet();
  const replacer = function (_key, val) {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
      if (val.isObject3D) {
        return {
          type: val.type || 'Object3D',
          name: val.name || '',
          position: val.position ? [val.position.x, val.position.y, val.position.z] : undefined,
        };
      }
      if (val.isBufferGeometry) return `[BufferGeometry ${val.uuid?.slice(0, 8) || ''}]`;
      if (val.isMaterial) return `[Material ${val.name || val.type || ''}]`;
    }
    return val;
  };
  try {
    const out = JSON.stringify(value, replacer);
    return out && out.length > 2000 ? `${out.slice(0, 2000)}…` : (out || String(value));
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function formatConsoleArg(value) {
  return safeStringify(value);
}

// ========================================================
// PRESET SCRIPTS REPOSITORY
// ========================================================
export const SCRIPT_PRESETS = [
  {
    id: 'city',
    name: '1. Procedural City with High-Rise Towers & Streetlights',
    description: 'Automatically generates a parametric grid of skyscraper blocks, a central tower, and urban street lighting.',
    code: `// ========================================================
// PRESET 1: PROCEDURAL CITY
// ========================================================
studio.clearScene();

// 1. Ground / Boulevard
studio.addPlane({
  x: 0, y: -0.05, z: 0,
  width: 50, height: 50,
  color: 0x1e272e,
  roughness: 0.9,
  name: "Ground_Plaza"
});

// 2. Multi-story commercial building grid
const gridSize = 3;
const spacing = 7.5;
const cityColors = [0x2c3e50, 0x34495e, 0x1f2c38, 0x243342, 0x162029];
const neonColors = [0x00d2d3, 0x54a0ff, 0x5f27cd, 0xff9f43, 0x01a3a4];

let bldgCount = 0;
for (let ix = -gridSize; ix <= gridSize; ix++) {
  for (let iz = -gridSize; iz <= gridSize; iz++) {
    // Keep central plaza and main avenue open
    if (ix === 0 && iz === 0) continue;
    
    const posX = ix * spacing + (Math.random() - 0.5) * 1.2;
    const posZ = iz * spacing + (Math.random() - 0.5) * 1.2;
    const floors = Math.floor(Math.random() * 8) + 3;
    const width = 3 + Math.random() * 1.5;
    const depth = 3 + Math.random() * 1.5;
    const color = cityColors[Math.floor(Math.random() * cityColors.length)];
    const winColor = neonColors[Math.floor(Math.random() * neonColors.length)];
    
    studio.createBuilding({
      x: posX, z: posZ,
      floors: floors,
      width: width,
      depth: depth,
      floorHeight: 1.1 + Math.random() * 0.3,
      color: color,
      windowColor: winColor,
      withAntenna: Math.random() > 0.4,
      name: \`Skyscraper_\${++bldgCount}\`
    });
  }
}

// 3. Center Landmark Tower
const centerTower = studio.createBuilding({
  x: 0, y: 0, z: 0,
  floors: 14,
  width: 4.8,
  depth: 4.8,
  floorHeight: 1.3,
  color: 0x0abde3,
  windowColor: 0x48dbfb,
  withAntenna: true,
  name: "Omega_Center_Tower"
});

// Energy halo ring around the center tower
const haloRing = studio.addTorus({
  x: 0, y: 13, z: 0,
  radius: 3.8, tube: 0.15,
  color: 0x00d2d3,
  emissive: 0x00d2d3,
  emissiveIntensity: 1.8,
  name: "Tower_Energy_Halo"
});
haloRing.rotation.x = Math.PI / 2;

// 4. Smart street lamps along the main avenue
const lampCount = 6;
for (let i = -lampCount / 2; i <= lampCount / 2; i++) {
  if (i === 0) continue;
  const offset = i * 4.5;
  
  // Lamp pole
  studio.addCylinder({
    x: offset, y: 1.2, z: 2.5,
    radiusTop: 0.05, radiusBottom: 0.08, height: 2.4,
    color: 0x222f3e, roughness: 0.4, metalness: 0.8,
    name: \`StreetLamp_Pole_\${i}\`
  });
  
  // Warm amber LED bulb
  studio.addSphere({
    x: offset, y: 2.4, z: 2.5,
    radius: 0.16,
    color: 0xfeca57,
    emissive: 0xfeca57,
    emissiveIntensity: 3.0,
    name: \`Lamp_Light_\${i}\`
  });
}

// Sky illumination
studio.addLight({ type: 'directional', x: 25, y: 35, z: 20, color: 0xfff0e0, intensity: 1.4 });
studio.addLight({ type: 'ambient', color: 0x334455, intensity: 0.6 });

print(\`✓ Completed Procedural City with \${bldgCount} skyscrapers and Omega Center Tower!\`);
`
  },
  {
    id: 'spiral',
    name: '2. Sculptural Spiral Staircase',
    description: 'Generates a rainbow-gradient spiral staircase with chrome columns, crystal railings, and floating crown blocks.',
    code: `// ========================================================
// PRESET 2: SCULPTURAL SPIRAL STAIRCASE
// ========================================================
studio.clearScene();

const totalSteps = 32;
const stepHeight = 0.22;
const stepRadius = 2.4;
const angleStep = 0.25;

// Staircase base pedestal
studio.addCylinder({
  x: 0, y: 0.15, z: 0,
  radiusTop: 3.2, radiusBottom: 3.5, height: 0.3,
  color: 0x2f3640, roughness: 0.3, metalness: 0.2,
  name: "Stair_Pedestal"
});

// Polished central chrome column
studio.addCylinder({
  x: 0, y: (totalSteps * stepHeight) / 2 + 0.5, z: 0,
  radiusTop: 0.35, radiusBottom: 0.35, height: totalSteps * stepHeight + 2,
  radialSegments: 32,
  color: 0xdcdde1, roughness: 0.1, metalness: 0.95,
  name: "Center_Chrome_Column"
});

// Spiral steps with gradient coloring
for (let i = 0; i < totalSteps; i++) {
  const angle = i * angleStep;
  const currentY = (i + 1) * stepHeight;
  
  // Compute smooth gradient color
  const hue = (i / totalSteps) * 0.75 + 0.5;
  const stepColor = new studio.THREE.Color().setHSL(hue % 1.0, 0.85, 0.5);
  
  // Step tread
  const step = studio.addCube({
    width: 2.0, height: 0.1, depth: 0.42,
    color: stepColor,
    roughness: 0.2,
    metalness: 0.3,
    emissive: stepColor,
    emissiveIntensity: 0.25,
    name: \`SpiralStep_\${i + 1}\`
  });
  
  step.position.set(Math.cos(angle) * (stepRadius * 0.45), currentY, Math.sin(angle) * (stepRadius * 0.45));
  step.rotation.y = -angle;

  // Baluster post
  const post = studio.addCylinder({
    x: Math.cos(angle) * (stepRadius * 0.85),
    y: currentY + 0.45,
    z: Math.sin(angle) * (stepRadius * 0.85),
    radiusTop: 0.025, radiusBottom: 0.025, height: 0.9,
    color: 0xf5f6fa, roughness: 0.1, metalness: 0.9,
    name: \`Baluster_\${i + 1}\`
  });

  // Glowing crystal orb atop each baluster
  studio.addSphere({
    x: post.position.x,
    y: currentY + 0.92,
    z: post.position.z,
    radius: 0.06,
    color: stepColor,
    emissive: stepColor,
    emissiveIntensity: 2.0,
    name: \`Baluster_Orb_\${i + 1}\`
  });
}

// Floating crystal torus at top of staircase
const apexCrystal = studio.addTorus({
  x: 0, y: totalSteps * stepHeight + 1.6, z: 0,
  radius: 0.8, tube: 0.2,
  color: 0x9c88ff,
  roughness: 0.1, metalness: 0.9,
  emissive: 0x8c7ae6,
  emissiveIntensity: 1.2,
  name: "Apex_Floating_Torus"
});

// Rotation and hovering animation
studio.animate(apexCrystal, (time, delta, mesh) => {
  mesh.rotation.x = time * 0.8;
  mesh.rotation.y = time * 0.5;
  mesh.position.y = (totalSteps * stepHeight + 1.6) + Math.sin(time * 2) * 0.15;
});

studio.addLight({ type: 'point', x: 0, y: totalSteps * stepHeight + 2, z: 0, color: 0xe056fd, intensity: 2.5, distance: 15 });
studio.addLight({ type: 'directional', x: 5, y: 15, z: 8, color: 0xffffff, intensity: 1.2 });

print(\`✓ Generated Sculptural Spiral Staircase with \${totalSteps} glowing spectrum steps!\`);
`
  },
  {
    id: 'gears',
    name: '3. Mechanical Gears Ring',
    description: 'Planetary gear train with parametric gear teeth and synchronized mesh animation.',
    code: `// ========================================================
// PRESET 3: MECHANICAL GEARS RING
// ========================================================
studio.clearScene();

// Parametric gear generator
function createParametricGear({ teeth = 18, radius = 3, thickness = 0.4, color = 0xd4af37, metalness = 0.85, name = "Gear" }) {
  const group = studio.addGroup(name);
  
  // Center disc
  const disc = studio.addCylinder({
    radiusTop: radius, radiusBottom: radius, height: thickness,
    radialSegments: 48,
    color: color, roughness: 0.35, metalness: metalness
  });
  group.add(disc);

  // Center shaft bore
  const hole = studio.addCylinder({
    radiusTop: radius * 0.28, radiusBottom: radius * 0.28, height: thickness + 0.08,
    radialSegments: 24,
    color: 0x2d3436, roughness: 0.5, metalness: 0.9
  });
  group.add(hole);

  // Surrounding gear teeth
  const toothWidth = (Math.PI * 2 * radius) / (teeth * 2.2);
  const toothHeight = radius * 0.24;
  for (let i = 0; i < teeth; i++) {
    const angle = (i / teeth) * Math.PI * 2;
    const tooth = studio.addCube({
      width: toothWidth, height: thickness, depth: toothHeight,
      color: color, roughness: 0.35, metalness: metalness
    });
    tooth.position.set(
      Math.cos(angle) * (radius + toothHeight * 0.4),
      0,
      Math.sin(angle) * (radius + toothHeight * 0.4)
    );
    tooth.rotation.y = -angle;
    group.add(tooth);
  }

  return group;
}

// 1. Center sun gear
const centerGear = createParametricGear({
  teeth: 24, radius: 2.8, thickness: 0.5, color: 0xf1c40f, metalness: 0.9, name: "Sun_Gear"
});
centerGear.position.set(0, 0, 0);

// 2. Orbiting planet gear ring
const planetCount = 4;
const orbitRadius = 4.8;
const planetGears = [];

for (let p = 0; p < planetCount; p++) {
  const angle = (p / planetCount) * Math.PI * 2;
  const gear = createParametricGear({
    teeth: 12, radius: 1.4, thickness: 0.45, color: 0x0984e3, metalness: 0.8, name: \`Planet_Gear_\${p + 1}\`
  });
  gear.position.set(Math.cos(angle) * orbitRadius, 0, Math.sin(angle) * orbitRadius);
  planetGears.push({ group: gear, initialAngle: angle });
}

// 3. Outer ring gear
const outerRing = studio.addTorus({
  x: 0, y: 0, z: 0,
  radius: 6.8, tube: 0.25,
  color: 0x636e72, roughness: 0.2, metalness: 0.95,
  name: "Outer_Casing_Ring"
});
outerRing.rotation.x = Math.PI / 2;

// 4. Machine base chassis
studio.addCylinder({
  x: 0, y: -0.6, z: 0,
  radiusTop: 7.2, radiusBottom: 7.5, height: 0.4,
  color: 0x1e272e, roughness: 0.7, metalness: 0.6,
  name: "Machine_Chassis"
});

// 5. Mechanical rotation animation
studio.animate((time) => {
  const speed = 0.8;
  centerGear.rotation.y = time * speed;
  planetGears.forEach((item) => {
    item.group.rotation.y = -time * speed * 2;
  });
});

studio.addLight({ type: 'directional', x: 8, y: 12, z: 10, color: 0xffffff, intensity: 1.6 });
studio.addLight({ type: 'point', x: 0, y: 3, z: 0, color: 0x00cec9, intensity: 2.0, distance: 10 });

print("✓ Running planetary gear train system with synchronized mechanical meshing animation.");
`
  },
  {
    id: 'forest',
    name: '4. Procedural Forest with Terrain',
    description: 'Generates rolling terrain hills scattered with low-poly pine trees, shade trees, and natural rocks.',
    code: `// ========================================================
// PRESET 4: PROCEDURAL FOREST WITH TERRAIN
// ========================================================
studio.clearScene();

// 1. Natural rolling terrain ground
const terrain = studio.addPlane({
  x: 0, y: 0, z: 0,
  width: 40, height: 40,
  widthSegments: 32, heightSegments: 32,
  color: 0x1e824c, roughness: 0.9, metalness: 0.05,
  name: "Terrain_Ground"
});

// Displace vertices for rolling hills
const posAttr = terrain.geometry.attributes.position;
for (let i = 0; i < posAttr.count; i++) {
  const vx = posAttr.getX(i);
  const vy = posAttr.getY(i);
  const elevation = Math.sin(vx * 0.25) * Math.cos(vy * 0.25) * 0.8 + Math.sin(vx * 0.1) * 0.5;
  posAttr.setZ(i, elevation);
}
terrain.geometry.computeVertexNormals();

// 2. Scatter randomized parametric trees
const treeCount = 40;
const treePalette = [0x27ae60, 0x2ecc71, 0x16a085, 0x1abc9c, 0x10ac84];

for (let i = 0; i < treeCount; i++) {
  const radius = 2.5 + Math.random() * 16;
  const angle = Math.random() * Math.PI * 2;
  const tx = Math.cos(angle) * radius;
  const tz = Math.sin(angle) * radius;
  
  const ty = (Math.sin(tx * 0.25) * Math.cos(tz * 0.25) * 0.8 + Math.sin(tx * 0.1) * 0.5) * 0.9;
  
  const isPine = Math.random() > 0.35;
  const foliageColor = treePalette[Math.floor(Math.random() * treePalette.length)];

  studio.createTree({
    x: tx, y: ty, z: tz,
    trunkHeight: 1.8 + Math.random() * 1.4,
    trunkRadius: 0.16 + Math.random() * 0.1,
    foliageRadius: 1.1 + Math.random() * 0.6,
    foliageColor: foliageColor,
    style: isPine ? 'lowpoly' : 'lush',
    name: \`ProceduralTree_\${i + 1}\`
  });
}

// 3. Scatter natural boulders
const rockColors = [0x7f8c8d, 0x95a5a6, 0x636e72];
for (let r = 0; r < 16; r++) {
  const rx = (Math.random() - 0.5) * 30;
  const rz = (Math.random() - 0.5) * 30;
  const rockScale = 0.4 + Math.random() * 0.7;
  
  const rock = studio.addSphere({
    x: rx, y: 0.2 * rockScale, z: rz,
    radius: rockScale,
    widthSegments: 6, heightSegments: 5,
    color: rockColors[Math.floor(Math.random() * rockColors.length)],
    roughness: 0.85, metalness: 0.1,
    flatShading: true,
    name: \`Rock_\${r + 1}\`
  });
  rock.scale.set(1.0 + Math.random() * 0.5, 0.6 + Math.random() * 0.4, 0.8 + Math.random() * 0.6);
  rock.rotation.set(Math.random(), Math.random(), Math.random());
}

// 4. Warm golden sunset lighting
studio.addLight({ type: 'directional', x: 20, y: 15, z: -18, color: 0xffaa55, intensity: 1.8 });
studio.addLight({ type: 'ambient', color: 0x487eb0, intensity: 0.7 });

print(\`✓ Generated Procedural Forest: \${treeCount} trees and 16 natural boulders.\`);
`
  },
  {
    id: 'energy_rings',
    name: '5. Animated Sci-Fi Energy Rings',
    description: 'Pulsing quantum reactor core, 3 glowing gyroscopic gimbal rings, and orbiting plasma nodes.',
    code: `// ========================================================
// PRESET 5: ANIMATED SCI-FI ENERGY RINGS
// ========================================================
studio.clearScene();

// 1. Central nuclear energy core
const coreReactor = studio.addSphere({
  x: 0, y: 3.5, z: 0,
  radius: 1.2,
  color: 0x00f2fe,
  emissive: 0x00f2fe,
  emissiveIntensity: 2.2,
  roughness: 0.1,
  name: "Quantum_Core"
});

// 2. Three gyroscopic energy rings
const rings = [];
const ringConfigs = [
  { radius: 2.5, tube: 0.12, color: 0x4facfe, tiltX: 0.5, tiltZ: 0.2, speedX: 1.2, speedY: 0.8 },
  { radius: 3.4, tube: 0.10, color: 0x00c6ff, tiltX: -0.4, tiltZ: 0.6, speedX: -0.9, speedY: 1.4 },
  { radius: 4.3, tube: 0.08, color: 0xfa709a, tiltX: 0.8, tiltZ: -0.3, speedX: 0.6, speedY: -1.1 }
];

ringConfigs.forEach((cfg, idx) => {
  const ring = studio.addTorus({
    x: 0, y: 3.5, z: 0,
    radius: cfg.radius,
    tube: cfg.tube,
    radialSegments: 24,
    tubularSegments: 64,
    color: cfg.color,
    emissive: cfg.color,
    emissiveIntensity: 1.5,
    name: \`Energy_Ring_\${idx + 1}\`
  });
  ring.rotation.set(cfg.tiltX, 0, cfg.tiltZ);
  rings.push({ mesh: ring, cfg });
});

// 3. Orbiting plasma node satellites
const orbs = [];
const orbCount = 6;
for (let i = 0; i < orbCount; i++) {
  const orb = studio.addSphere({
    radius: 0.22,
    color: 0xfee140,
    emissive: 0xfa709a,
    emissiveIntensity: 2.5,
    name: \`Plasma_Node_\${i + 1}\`
  });
  orbs.push({ mesh: orb, index: i, orbitDist: 3.8 + (i % 2) * 0.8 });
}

// 4. Ground launchpad base
studio.addCylinder({
  x: 0, y: 0.3, z: 0,
  radiusTop: 3.8, radiusBottom: 4.2, height: 0.6,
  radialSegments: 32,
  color: 0x1e272e, roughness: 0.3, metalness: 0.9,
  name: "Launchpad_Base"
});

studio.addTorus({
  x: 0, y: 0.62, z: 0,
  radius: 3.2, tube: 0.15,
  color: 0x00f2fe,
  emissive: 0x00f2fe,
  emissiveIntensity: 1.8,
  name: "Emitter_Coil"
}).rotation.x = Math.PI / 2;

// 5. Radiant center point light
const coreLight = studio.addLight({
  type: 'point',
  x: 0, y: 3.5, z: 0,
  color: 0x00f2fe,
  intensity: 3.0,
  distance: 25,
  name: "Core_Glow_Light"
});

// 6. Multi-layered orbital animation
studio.animate((time) => {
  // Energy pulse effect
  const pulse = 1.0 + Math.sin(time * 4) * 0.12;
  coreReactor.scale.set(pulse, pulse, pulse);
  coreLight.intensity = 2.5 + Math.sin(time * 6) * 1.0;

  // Rotate 3 gyroscopic rings
  rings.forEach(({ mesh, cfg }) => {
    mesh.rotation.x += cfg.speedX * 0.015;
    mesh.rotation.y += cfg.speedY * 0.02;
    mesh.rotation.z += (cfg.speedX + cfg.speedY) * 0.008;
  });

  // Undulating orbiting plasma satellites
  orbs.forEach(({ mesh, index, orbitDist }) => {
    const angle = time * 1.8 + (index * (Math.PI * 2 / orbCount));
    mesh.position.x = Math.cos(angle) * orbitDist;
    mesh.position.z = Math.sin(angle) * orbitDist;
    mesh.position.y = 3.5 + Math.sin(time * 3 + index) * 1.4;
  });
});

print("✓ Activated Sci-Fi Reactor Core with 3 gyroscopic gimbal rings and plasma nodes!");
`
  },
  {
    id: 'scanned_head',
    name: '6. 4K Laser-Scanned Human Portrait (3D Head)',
    description: 'Loads a 4K laser-scanned human head model with Albedo skin map, Tangent Normal map, Subsurface Scattering PBR, and studio portrait lighting.',
    code: `// ========================================================
// PRESET 6: 4K LASER-SCANNED HUMAN PORTRAIT (PBR SKIN)
// ========================================================
studio.clearScene();

const THREE = studio.THREE;
const scene = studio.scene;

// 1. Studio display pedestal
studio.addCylinder({
  y: 0.1, radiusTop: 2.0, radiusBottom: 2.2, height: 0.2,
  color: 0x181c22, roughness: 0.35, metalness: 0.8,
  name: "Pedestal_Base"
});
studio.addTorus({
  y: 0.21, radius: 1.95, tube: 0.02,
  color: 0x00cec9, emissive: 0x00cec9, emissiveIntensity: 2.0,
  name: "Pedestal_Rune"
});

// 2. Three-point studio portrait lighting
const keyLight = new THREE.DirectionalLight(0xfff5ea, 3.5);
keyLight.position.set(2.2, 3.5, 2.8);
keyLight.castShadow = true;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xcce2ff, 1.8);
fillLight.position.set(-2.5, 2.5, 1.8);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xffeedd, 4.5);
rimLight.position.set(-1.0, 3.5, -2.5);
scene.add(rimLight);

scene.add(new THREE.AmbientLight(0x3a424e, 0.8));

// 3. Load 4K skin & normal maps
const textureLoader = new THREE.TextureLoader();
const mapColor = textureLoader.load('/models/Map-COL.jpg');
const mapNormal = textureLoader.load('/models/Infinite-Level_02_Tangent_SmoothUV.jpg');
const mapSpec = textureLoader.load('/models/Map-SPEC.jpg');

const scannedSkinMaterial = new THREE.MeshPhysicalMaterial({
  map: mapColor,
  normalMap: mapNormal,
  normalScale: new THREE.Vector2(1.2, 1.2),
  roughnessMap: mapSpec,
  roughness: 0.52,
  metalness: 0.0,
  clearcoat: 0.25,
  clearcoatRoughness: 0.30,
  sheen: 0.85,
  sheenColor: new THREE.Color(0xff8866),
  sheenRoughness: 0.4
});

// 4. Load 3D Laser-Scanned Human Head Geometry
print("Loading 3D laser-scanned data and 4K skin textures...");
const headModel = await studio.loadGLTF('/models/LeePerrySmith.glb', {
  x: 0, y: 1.25, z: 0,
  scale: 0.24,
  name: 'Scanned_Human_Head'
});
if (headModel) {
  headModel.traverse((child) => {
    if (child.isMesh) {
      child.geometry.computeVertexNormals();
      child.material = scannedSkinMaterial;
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  if (window.engine && window.engine.camera && window.engine.controls) {
    window.engine.camera.position.set(0.35, 1.35, 1.45);
    window.engine.controls.target.set(0, 1.25, 0);
    window.engine.controls.update();
  }

  print("✓ Loaded 4K Laser-Scanned Human Portrait with PBR Subsurface Scattering!");
}
`
  },
  {
    id: 'realistic_character',
    name: '7. Anatomical Full-Body Human Character',
    description: 'Loads a full-body anatomical human character model with articulated hands, face, hair, outfit, and Skeletal Rigging.',
    code: `// ========================================================
// PRESET 7: FULL-BODY HUMAN CHARACTER
// ========================================================
studio.clearScene();

const THREE = studio.THREE;
const scene = studio.scene;

// 1. Portrait studio pedestal
studio.addCylinder({
  y: 0.05, radiusTop: 2.2, radiusBottom: 2.4, height: 0.1,
  color: 0x1e2229, roughness: 0.35, metalness: 0.75,
  name: "Studio_Pedestal"
});
studio.addTorus({
  y: 0.105, radius: 2.2, tube: 0.02,
  color: 0xe67e22, roughness: 0.25, metalness: 0.9,
  name: "Pedestal_Trim"
});

// 2. Three-point portrait lighting
const keyLight = new THREE.DirectionalLight(0xfff5ea, 3.2);
keyLight.position.set(2.5, 3.8, 3.0);
keyLight.castShadow = true;
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xcce2ff, 1.8);
fillLight.position.set(-2.8, 2.6, 2.0);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xffeedd, 4.2);
rimLight.position.set(-1.2, 3.8, -2.8);
scene.add(rimLight);

scene.add(new THREE.AmbientLight(0x404856, 0.9));

// 3. Load full-body rigged character
print("Loading full-body rigged character model...");
const human = await studio.createRealisticHuman({
  type: 'female',
  x: 0, y: 0.1, z: 0,
  scale: 1.0,
  name: 'Realistic_Human_Model'
});

// 4. Enhance skin specular sheen & subsurface scattering look
human.traverse((child) => {
  if (child.isMesh) {
    child.castShadow = true;
    child.receiveShadow = true;
    if (child.material) {
      child.material.side = THREE.DoubleSide;
      const matName = (child.material.name || '').toLowerCase();
      if (matName.includes('skin') || matName.includes('body') || matName.includes('head') || matName.includes('face')) {
        child.material.roughness = 0.50;
        child.material.metalness = 0.02;
        if (child.material.isMeshPhysicalMaterial) {
          child.material.clearcoat = 0.25;
          child.material.clearcoatRoughness = 0.28;
          child.material.sheen = 0.75;
          child.material.sheenColor = new THREE.Color(0xff8866);
        }
      }
    }
  }
});

// 5. Frame camera on portrait subject
if (window.engine && window.engine.camera && window.engine.controls) {
  window.engine.camera.position.set(0.40, 1.45, 1.35);
  window.engine.controls.target.set(0, 1.30, 0);
  window.engine.controls.update();
}

print("✓ Completed Full-Body anatomical Character with outfit and skeleton rig!");
`
  },
  {
    name: '8. Build Rigged Mannequin, Two-Bone IK & Pose Presets',
    description: 'Create an anatomical rigging Mannequin, apply Combat Guard / Military Salute poses, and enable Two-Bone IK limb handles.',
    code: `// ========================================================
// Web Blender Studio - Rigged Mannequin & Two-Bone IK Demo
// ========================================================
studio.clearScene();

// 1. Create Showcase Platform
const platform = studio.addCylinder({
  x: 0, y: 0.05, z: 0,
  radiusTop: 2.2, radiusBottom: 2.4, height: 0.1,
  color: 0x2c3e50, roughness: 0.4, metalness: 0.8,
  name: "Mannequin_Platform"
});

const ring = studio.addTorus({
  x: 0, y: 0.11, z: 0,
  radius: 2.1, tube: 0.04,
  color: 0x00cec9, emissive: 0x00cec9, emissiveIntensity: 2.0,
  name: "Neon_Ring"
});

// 2. Build Procedural Articulated Mannequin Rig
const mannequin = studio.createRiggedMannequin({
  height: 1.8,
  x: 0, y: 0.1, z: 0,
  name: "Rigged_Mannequin"
});

// 3. Apply Combat Fighting Guard Pose
studio.setPose(mannequin, 'combat_guard');

// 4. Enable Two-Bone IK with interactive Viewport target gizmos
studio.setIKEnabled(true, mannequin);

// 5. Frame camera on character
if (window.engine && window.engine.camera && window.engine.controls) {
  window.engine.camera.position.set(0, 1.4, 3.2);
  window.engine.controls.target.set(0, 1.0, 0);
  window.engine.controls.update();
}

print("✓ Built rigged Mannequin, applied Combat Guard pose, and enabled Two-Bone IK!");
print("👉 Try dragging the cyan hand targets or green foot targets in the 3D Viewport!");
`
  }
];

// ========================================================
// SCRIPT CODE EDITOR COMPONENT
// ========================================================
export class ScriptCodeEditor {
  /**
   * @param {HTMLElement|string} container - Parent container element or selector
   * @param {Object} options - Options { studio, defaultPresetIndex, onExecute }
   */
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.studio = options.studio || studio;
    this.defaultPresetIndex = options.defaultPresetIndex !== undefined ? options.defaultPresetIndex : 0;
    this.onExecute = options.onExecute || null;

    this.logs = [];
    this.maxLogs = 200;

    this._initDOM();
    this._attachEvents();

    // Load initial preset
    if (SCRIPT_PRESETS[this.defaultPresetIndex]) {
      this.loadPreset(this.defaultPresetIndex);
    }
  }

  /**
   * Build complete Blender-themed UI inside container
   */
  _initDOM() {
    if (!this.container) {
      console.warn("[ScriptCodeEditor]: No container element provided.");
      return;
    }

    this.container.innerHTML = `
      <div class="blender-script-panel">
        <!-- Top Toolbar -->
        <div class="script-toolbar">
          <div class="script-toolbar-group script-title-group">
            <svg class="script-icon" viewBox="0 0 24 24" width="16" height="16">
              <path fill="currentColor" d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
            </svg>
            <span class="script-title">Blender Scripting DSL</span>
          </div>

          <!-- Presets Selector -->
          <div class="script-toolbar-group script-preset-group">
            <label class="script-label" for="script-preset-select">Preset Script:</label>
            <select id="script-preset-select" class="script-select">
              ${SCRIPT_PRESETS.map((p, idx) => `<option value="${idx}">${p.name}</option>`).join('')}
            </select>
          </div>

          <!-- Action Buttons -->
          <div class="script-toolbar-group script-action-buttons">
            <button id="btn-run-script" class="script-btn script-btn-primary" title="Run Script (Ctrl + Enter)">
              <svg viewBox="0 0 24 24" width="14" height="14"><polygon fill="currentColor" points="5,3 19,12 5,21"/></svg>
              <span>Run (Ctrl+Enter)</span>
            </button>
            <button id="btn-stop-script" class="script-btn script-btn-danger" title="Stop Animation">
              <svg viewBox="0 0 24 24" width="14" height="14"><rect fill="currentColor" x="5" y="5" width="14" height="14" rx="2"/></svg>
              <span>Stop</span>
            </button>
            <button id="btn-reset-scene" class="script-btn" title="Remove objects created by scripts">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
              <span>Reset Scene</span>
            </button>
            <button id="btn-clear-code" class="script-btn" title="Clear code editor">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
              <span>Clear Code</span>
            </button>
            <button id="btn-copy-code" class="script-btn" title="Copy all script code">
              <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
              <span>Copy</span>
            </button>
          </div>
        </div>

        <!-- Editor Work Area -->
        <div class="script-editor-workspace">
          <!-- Code Editor Pane -->
          <div class="script-editor-container">
            <div class="script-editor-gutter" id="script-gutter">1</div>
            <textarea id="script-code-area" class="script-code-area" spellcheck="false" placeholder="// Enter DSL / Blender Script here...&#10;// studio.addCube({ x: 0, y: 1, z: 0, color: 0x3498db });"></textarea>
          </div>

          <!-- Bottom Console Output -->
          <div class="script-console-container">
            <div class="script-console-header">
              <div class="script-console-title">
                <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V8h16v10zm-2-1h-6v-2h6v2zM7.5 17l-1.41-1.41L8.67 13l-2.58-2.59L7.5 9l4 4-4 4z"/></svg>
                <span>Console Output</span>
                <span id="script-console-count" class="script-badge">0</span>
              </div>
              <div class="script-console-actions">
                <button id="btn-clear-console" class="script-btn-icon" title="Clear Console log">
                  <svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                </button>
              </div>
            </div>
            <div id="script-console-output" class="script-console-output">
              <div class="console-line line-info">
                <span class="console-time">${this._formatTime()}</span>
                <span class="console-tag tag-info">[INFO]</span>
                <span class="console-msg">Scripting DSL ready. Click 'Run (Ctrl+Enter)' to generate 3D objects.</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this._injectStyles();

    // Cache elements
    this.codeArea = this.container.querySelector('#script-code-area');
    this.gutter = this.container.querySelector('#script-gutter');
    this.presetSelect = this.container.querySelector('#script-preset-select');
    this.consoleOutput = this.container.querySelector('#script-console-output');
    this.consoleCountBadge = this.container.querySelector('#script-console-count');
    this.btnRun = this.container.querySelector('#btn-run-script');
    this.btnStop = this.container.querySelector('#btn-stop-script');
    this.btnReset = this.container.querySelector('#btn-reset-scene');
    this.btnClear = this.container.querySelector('#btn-clear-code');
    this.btnCopy = this.container.querySelector('#btn-copy-code');
    this.btnClearConsole = this.container.querySelector('#btn-clear-console');
  }

  /**
   * Inject dedicated Blender-compliant CSS styles
   */
  _injectStyles() {
    if (document.getElementById('blender-scripting-styles')) return;

    const style = document.createElement('style');
    style.id = 'blender-scripting-styles';
    style.textContent = `
      .blender-script-panel {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        background-color: var(--b-bg-darker, #202020);
        color: var(--b-text-primary, #e6e6e6);
        font-family: var(--b-font-main, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
        overflow: hidden;
      }

      /* Toolbar */
      .script-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: var(--b-header-height, 32px);
        background-color: var(--b-bg-header, #303030);
        border-bottom: 1px solid var(--b-border-dark, #161616);
        padding: 0 8px;
        gap: 12px;
        flex-shrink: 0;
      }

      .script-toolbar-group {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .script-title-group {
        font-weight: 600;
        font-size: var(--b-font-size-md, 12px);
        color: var(--b-text-highlight, #ffffff);
      }

      .script-icon {
        color: var(--b-active-orange, #e28522);
      }

      .script-label {
        font-size: var(--b-font-size-sm, 11px);
        color: var(--b-text-secondary, #a3a3a3);
      }

      .script-select {
        background-color: var(--b-bg-input, #1d1d1d);
        border: 1px solid var(--b-border-base, #202020);
        color: var(--b-text-primary, #e6e6e6);
        font-size: var(--b-font-size-sm, 11px);
        padding: 2px 8px;
        border-radius: var(--b-radius-sm, 3px);
        outline: none;
        cursor: pointer;
        max-width: 280px;
      }

      .script-select:focus {
        border-color: var(--b-accent-blue, #4772b3);
      }

      /* Buttons */
      .script-btn {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        background-color: var(--b-bg-subtle, #383838);
        border: 1px solid var(--b-border-light, #3d3d3d);
        color: var(--b-text-primary, #e6e6e6);
        font-size: var(--b-font-size-sm, 11px);
        padding: 3px 8px;
        border-radius: var(--b-radius-sm, 3px);
        cursor: pointer;
        user-select: none;
        transition: background-color 0.15s, border-color 0.15s;
      }

      .script-btn:hover {
        background-color: var(--b-bg-hover, #404040);
        color: #ffffff;
      }

      .script-btn:active {
        transform: translateY(1px);
      }

      .script-btn-primary {
        background-color: var(--b-accent-blue, #4772b3);
        border-color: #5884c7;
        color: #ffffff;
        font-weight: 500;
      }

      .script-btn-primary:hover {
        background-color: #5884c7;
      }

      .script-btn-danger {
        background-color: #c0392b;
        border-color: #e74c3c;
        color: #ffffff;
      }

      .script-btn-danger:hover {
        background-color: #e74c3c;
      }

      .script-btn-icon {
        background: none;
        border: none;
        color: var(--b-text-muted, #737373);
        cursor: pointer;
        padding: 3px;
        border-radius: 2px;
        display: inline-flex;
        align-items: center;
      }

      .script-btn-icon:hover {
        color: #ffffff;
        background-color: var(--b-bg-hover, #404040);
      }

      /* Workspace split */
      .script-editor-workspace {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow: hidden;
      }

      /* Editor container */
      .script-editor-container {
        display: flex;
        flex: 1;
        min-height: 160px;
        background-color: #1a1a1a;
        overflow: hidden;
        position: relative;
      }

      .script-editor-gutter {
        width: 42px;
        padding: 10px 4px 10px 0;
        background-color: #161616;
        color: #555555;
        font-family: var(--b-font-mono, Consolas, monospace);
        font-size: 12px;
        line-height: 19px;
        text-align: right;
        user-select: none;
        border-right: 1px solid #262626;
        overflow: hidden;
        white-space: pre-wrap;
      }

      .script-code-area {
        flex: 1;
        background: transparent;
        border: none;
        color: #e0e0e0;
        font-family: var(--b-font-mono, "JetBrains Mono", Consolas, monospace);
        font-size: 12px;
        line-height: 19px;
        padding: 10px 12px;
        resize: none;
        outline: none;
        white-space: pre;
        tab-size: 2;
        overflow-y: auto;
        overflow-x: auto;
      }

      /* Console Panel */
      .script-console-container {
        height: 150px;
        background-color: #181818;
        border-top: 1px solid #282828;
        display: flex;
        flex-direction: column;
        flex-shrink: 0;
      }

      .script-console-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 10px;
        background-color: #242424;
        border-bottom: 1px solid #2d2d2d;
        height: 24px;
        font-size: 11px;
      }

      .script-console-title {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 500;
        color: var(--b-text-secondary, #a3a3a3);
      }

      .script-badge {
        background-color: #383838;
        color: #ffffff;
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 10px;
        font-weight: 600;
      }

      .script-console-output {
        flex: 1;
        overflow-y: auto;
        padding: 6px 10px;
        font-family: var(--b-font-mono, Consolas, monospace);
        font-size: 11px;
        line-height: 1.5;
        background-color: #141414;
      }

      .console-line {
        display: flex;
        align-items: flex-start;
        gap: 6px;
        margin-bottom: 3px;
        word-break: break-all;
      }

      .console-time {
        color: #555555;
        flex-shrink: 0;
      }

      .console-tag {
        font-weight: 600;
        flex-shrink: 0;
      }

      .console-msg {
        flex: 1;
        color: #d1d8e0;
      }

      .line-info .console-tag { color: #3498db; }
      .line-success .console-tag { color: #2ecc71; }
      .line-success .console-msg { color: #2ecc71; }
      .line-warn .console-tag { color: #f1c40f; }
      .line-warn .console-msg { color: #f39c12; }
      .line-error .console-tag { color: #e74c3c; }
      .line-error .console-msg { color: #ff6b6b; font-weight: 500; }
      .line-print .console-tag { color: #00cec9; }
      .line-print .console-msg { color: #ffffff; }
    `;

    document.head.appendChild(style);
  }

  /**
   * Bind event listeners
   */
  _attachEvents() {
    if (!this.codeArea) return;

    // Line number syncing and key features
    this.codeArea.addEventListener('input', () => this._updateGutter());
    this.codeArea.addEventListener('scroll', () => {
      if (this.gutter) {
        this.gutter.scrollTop = this.codeArea.scrollTop;
      }
    });

    // Smart key bindings: Tab, Shift+Tab, Ctrl+Enter, Auto-closing
    this.codeArea.addEventListener('keydown', (e) => {
      // Ctrl+Enter or Cmd+Enter: Run
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.execute();
        return;
      }

      // Tab / Shift+Tab indent
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = this.codeArea.selectionStart;
        const end = this.codeArea.selectionEnd;
        const val = this.codeArea.value;

        if (e.shiftKey) {
          // Unindent
          if (start === end) {
            // Find start of line
            const lineStart = val.lastIndexOf('\n', start - 1) + 1;
            if (val.substr(lineStart, 2) === '  ') {
              this.codeArea.value = val.substring(0, lineStart) + val.substring(lineStart + 2);
              this.codeArea.selectionStart = this.codeArea.selectionEnd = Math.max(lineStart, start - 2);
            }
          }
        } else {
          // Indent 2 spaces
          this.codeArea.value = val.substring(0, start) + '  ' + val.substring(end);
          this.codeArea.selectionStart = this.codeArea.selectionEnd = start + 2;
        }
        this._updateGutter();
        return;
      }

      // Auto-closing brackets & quotes
      const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" };
      if (pairs[e.key]) {
        const start = this.codeArea.selectionStart;
        const end = this.codeArea.selectionEnd;
        if (start === end) {
          const val = this.codeArea.value;
          e.preventDefault();
          this.codeArea.value = val.substring(0, start) + e.key + pairs[e.key] + val.substring(end);
          this.codeArea.selectionStart = this.codeArea.selectionEnd = start + 1;
          this._updateGutter();
        }
      }
    });

    // Preset selection change
    this.presetSelect?.addEventListener('change', (e) => {
      this.loadPreset(parseInt(e.target.value, 10));
    });

    // Buttons
    this.btnRun?.addEventListener('click', () => this.execute());
    this.btnStop?.addEventListener('click', () => {
      this.studio.stopAnimations();
      this.log("warn", "Stopped all animations.");
    });
    this.btnReset?.addEventListener('click', () => {
      this.studio.clearScene();
      this.log("info", "Cleared all DSL objects from the Scene.");
    });
    this.btnClear?.addEventListener('click', () => {
      this.setCode('');
      this.log("info", "Cleared source code in Editor.");
    });
    this.btnCopy?.addEventListener('click', () => this.copyCode());
    this.btnClearConsole?.addEventListener('click', () => this.clearConsole());
  }

  /**
   * Update line numbers column in sync with textarea
   */
  _updateGutter() {
    if (!this.codeArea || !this.gutter) return;
    const lines = this.codeArea.value.split('\n').length;
    let numbers = '';
    for (let i = 1; i <= lines; i++) {
      numbers += i + '\n';
    }
    this.gutter.textContent = numbers;
    this.gutter.scrollTop = this.codeArea.scrollTop;
  }

  /**
   * Load code from preset
   */
  loadPreset(index) {
    const preset = SCRIPT_PRESETS[index];
    if (preset) {
      this.setCode(preset.code);
      if (this.presetSelect) this.presetSelect.value = index;
      this.log("info", `Loaded preset script: "${preset.name}"`);
    }
  }

  /**
   * Set editor code
   */
  setCode(code) {
    if (this.codeArea) {
      this.codeArea.value = code;
      this._updateGutter();
    }
  }

  /**
   * Get current editor code
   */
  getCode() {
    return this.codeArea ? this.codeArea.value : '';
  }

  /**
   * Copy code to clipboard
   */
  copyCode() {
    const code = this.getCode();
    if (!code) return;
    navigator.clipboard?.writeText(code).then(() => {
      this.log("success", "Copied source code to Clipboard.");
    }).catch(() => {
      this.log("warn", "Could not copy automatically via Clipboard API.");
    });
  }

  /**
   * Execute current script inside DSL sandbox
   */
  async execute() {
    if (this._isExecuting) {
      this.log("warn", "A script is already running. Please wait until it completes.");
      return;
    }
    const code = this.getCode().trim();
    if (!code) {
      this.log("warn", "Editor is empty. Pick a Preset Script or enter DSL code!");
      return;
    }

    // Friendly intercept: Check if user pasted terminal CLI command into browser JS editor
    if (/^\s*(python|bash|sh|cmd|powershell)\s+/i.test(code) || /studio-cli\.py/i.test(code)) {
      this.log("error", "⚠️ Terminal (CLI) command detected. This editor is for 3D JavaScript DSL code!");
      this.log("info", "👉 Option 1 (Easiest): Choose '6. Realistic Human Portrait' or '7. Full-Body Rigged Character' in the 'Presets' dropdown above and click 'Run (Ctrl+Enter)'!");
      this.log("info", "👉 Option 2: To run a CLI command, open your system terminal and run: python studio-cli.py exec ...");
      return;
    }

    this._isExecuting = true;
    if (this.btnRun) this.btnRun.disabled = true;
    this.log("info", "Compiling and executing script...");
    const startTime = performance.now();

    // Sandbox execution context
    const customPrint = (...args) => {
      const msg = args.map(formatConsoleArg).join(' ');
      this.log("print", msg);
    };

    const sandboxedConsole = {
      log: (...args) => {
        const msg = args.map(formatConsoleArg).join(' ');
        this.log("info", msg);
      },
      warn: (...args) => {
        const msg = args.map(formatConsoleArg).join(' ');
        this.log("warn", msg);
      },
      error: (...args) => {
        const msg = args.map(formatConsoleArg).join(' ');
        this.log("error", msg);
      }
    };

    const sm = this.studio?._sceneManager || (typeof window !== 'undefined' ? window.sceneManager : null);
    sm?.beginBatch?.('Execute DSL Script');
    try {
      // Ensure THREE and scene are globally available without colliding with const declarations
      if (typeof window !== 'undefined') {
        window.THREE = this.studio.THREE;
        window.scene = this.studio.scene;
        window.studio = this.studio;
        window.bpy = this.studio.bpy;
      }

      // Build AsyncFunction to support top-level await and Promise-based asset loaders
      // Do not declare THREE/scene as parameter names to prevent SyntaxError if user writes `const THREE = ...`
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const runFn = new AsyncFunction('studio', 'bpy', 'print', 'console', `
        "use strict";
        ${code}
      `);

      await runFn(
        this.studio,
        this.studio.bpy,
        customPrint,
        sandboxedConsole
      );

      const elapsed = Math.round(performance.now() - startTime);
      const objectsCreated = this.studio.getCreatedObjects().length;
      this.log("success", `✓ Executed successfully in ${elapsed}ms (${objectsCreated} managed objects).`);

      if (this.onExecute) {
        this.onExecute({ code, elapsed, objectsCreated });
      }
      window.dispatchEvent(new CustomEvent('blender:scriptExecuted', { detail: { code, elapsed, objectsCreated } }));
    } catch (err) {
      console.error("[Script DSL Error]:", err);
      this.log("error", `Execution error: ${err.message}`);
    } finally {
      try { sm?.endBatch?.(); } catch (_) {}
      this._isExecuting = false;
      if (this.btnRun) this.btnRun.disabled = false;
    }
  }

  /**
   * Add message to Console Output
   */
  log(type = 'info', message = '') {
    if (!this.consoleOutput) return;

    const rawType = String(type ?? 'info');
    let safeType = SAFE_LOG_TYPES.has(rawType) ? rawType : 'info';
    let safeMessage = message;
    if (!SAFE_LOG_TYPES.has(rawType) && (message === undefined || message === '')) {
      safeMessage = rawType;
      safeType = 'info';
    }

    const time = this._formatTime();
    const tag = `[${safeType.toUpperCase()}]`;

    const row = document.createElement('div');
    row.className = `console-line line-${safeType}`;

    const timeEl = document.createElement('span');
    timeEl.className = 'console-time';
    timeEl.textContent = String(time);

    const tagEl = document.createElement('span');
    tagEl.className = `console-tag tag-${safeType}`;
    tagEl.textContent = tag;

    const msgEl = document.createElement('span');
    msgEl.className = 'console-msg';
    msgEl.textContent = String(safeMessage ?? '');

    row.append(timeEl, document.createTextNode(' '), tagEl, document.createTextNode(' '), msgEl);

    this.consoleOutput.appendChild(row);
    this.consoleOutput.scrollTop = this.consoleOutput.scrollHeight;

    this.logs.push({ type, message, time });
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
      if (this.consoleOutput.firstChild) {
        this.consoleOutput.removeChild(this.consoleOutput.firstChild);
      }
    }

    if (this.consoleCountBadge) {
      this.consoleCountBadge.textContent = this.logs.length;
    }
  }

  /**
   * Clear Console Output
   */
  clearConsole() {
    if (this.consoleOutput) {
      this.consoleOutput.innerHTML = '';
    }
    this.logs = [];
    if (this.consoleCountBadge) {
      this.consoleCountBadge.textContent = '0';
    }
  }

  _formatTime() {
    const now = new Date();
    return [
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0')
    ].join(':');
  }

  _escapeHTML(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

/**
 * Convenient helper to mount editor into any element
 */
export function initCodeEditor(container, options = {}) {
  return new ScriptCodeEditor(container, options);
}

// Expose globally
if (typeof window !== 'undefined') {
  window.ScriptCodeEditor = ScriptCodeEditor;
  window.initCodeEditor = initCodeEditor;
  window.SCRIPT_PRESETS = SCRIPT_PRESETS;
}

export default ScriptCodeEditor;

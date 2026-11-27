/**
 * Hunger Motion — Curated Beta Templates (Unity Humanoid, VRM / VTuber, TikTok Dance)
 * File: js/animation/motion-templates.js
 *
 * Each template bundles a verified commercial-safe CC0/CC-BY character rig,
 * curated reference motion video, retargeting stabilization defaults, camera framing,
 * and target export preset so first-time users reach their first exported animation
 * in under 2 minutes (KPI target <= 10 min).
 */

export const MOTION_TEMPLATES = Object.freeze({
  unity_humanoid: Object.freeze({
    id: 'unity_humanoid',
    name: 'Unity Humanoid',
    badge: 'Game Dev · GLB/FBX',
    icon: '🎮',
    tagline: 'Full-body locomotion with Foot-Lock IK ready for Unity Humanoid & Godot.',
    characterUrl: 'models/Mannequin_CC0.glb',
    fallbackCharacterUrl: 'models/Mannequin_CC0.glb',
    characterName: 'Mannequin_CC0',
    videoUrl: 'models/aerobics_exercise.webm',
    videoLabel: 'Full-Body Locomotion (aerobics_exercise.webm)',
    exportTarget: 'glb',
    settings: Object.freeze({
      modelTier: 'full',
      maxFrames: 180,
      frameStep: 1,
      subjectMode: 'auto',
      autoAlign: true,
      groundFeet: true,
      rootMotion: true,
      footLock: true,
      trackHands: true,
      trackFace: false,
      camComp: true,
      smoothing: 40,
      depthStability: 55,
      yawOffset: 0,
      cameraPreset: 'three-quarter',
      renderRes: '1280x720',
      renderFps: 30,
      includeAudio: false,
    }),
    exportNote: 'Exports single self-contained .glb or Binary FBX 7.4 compatible with Unity Humanoid Avatar & Godot AnimationPlayer.',
  }),

  vrm_avatar: Object.freeze({
    id: 'vrm_avatar',
    name: 'VRM / VTuber',
    badge: 'VRM · Face + Hands',
    icon: '🧑‍🎤',
    tagline: 'Upper-body, 21-pt hands & 52 ARKit face blendshapes mapped to VRM/J_Bip rigs.',
    characterUrl: 'assets/characters/nemetona.glb',
    fallbackCharacterUrl: 'models/Mannequin_CC0.glb',
    characterName: 'Nemetona_VRM_Ready',
    videoUrl: 'models/sample_human_motion.webm',
    videoLabel: 'Expressive Performance (sample_human_motion.webm)',
    exportTarget: 'glb',
    settings: Object.freeze({
      modelTier: 'full',
      maxFrames: 180,
      frameStep: 1,
      subjectMode: 'auto',
      autoAlign: true,
      groundFeet: true,
      rootMotion: true,
      footLock: true,
      trackHands: true,
      trackFace: true,
      camComp: false,
      smoothing: 35,
      depthStability: 50,
      yawOffset: 0,
      cameraPreset: 'three-quarter',
      renderRes: '1280x720',
      renderFps: 30,
      includeAudio: true,
    }),
    exportNote: 'Supports drag-and-drop .vrm avatars (J_Bip_* 18/18 bone mapping + ARKit blendshapes) and exports animated .glb.',
  }),

  tiktok_dance: Object.freeze({
    id: 'tiktok_dance',
    name: 'TikTok Dance 9:16',
    badge: 'Creator · MP4 + Audio',
    icon: '🎵',
    tagline: 'Fast footwork shuffle dance with anti-slide Foot-Lock IK & 9:16 vertical MP4 export.',
    characterUrl: 'models/Bot_CC0.glb',
    fallbackCharacterUrl: 'models/Mannequin_CC0.glb',
    characterName: 'Bot_CC0',
    videoUrl: 'models/shuffle_dance.mp4',
    videoLabel: 'Shuffle Dance (shuffle_dance.mp4)',
    exportTarget: 'mp4',
    settings: Object.freeze({
      modelTier: 'full',
      maxFrames: 240,
      frameStep: 1,
      subjectMode: 'auto',
      autoAlign: true,
      groundFeet: true,
      rootMotion: true,
      footLock: true,
      trackHands: true,
      trackFace: false,
      camComp: true,
      smoothing: 25,
      depthStability: 60,
      yawOffset: 0,
      cameraPreset: 'front',
      renderRes: '1080x1920',
      renderFps: 30,
      includeAudio: true,
    }),
    exportNote: 'Pre-configured for 1080×1920 (9:16) TikTok/Shorts MP4 with original music track & 1-click GLB export.',
  }),
});

const TEMPLATE_ALIASES = Object.freeze({
  unity: 'unity_humanoid',
  'unity-humanoid': 'unity_humanoid',
  unity_humanoid: 'unity_humanoid',
  vrm: 'vrm_avatar',
  vtuber: 'vrm_avatar',
  'vrm-avatar': 'vrm_avatar',
  vrm_avatar: 'vrm_avatar',
  tiktok: 'tiktok_dance',
  dance: 'tiktok_dance',
  'tiktok-dance': 'tiktok_dance',
  tiktok_dance: 'tiktok_dance',
});

export function listMotionTemplates() {
  return [
    MOTION_TEMPLATES.unity_humanoid,
    MOTION_TEMPLATES.vrm_avatar,
    MOTION_TEMPLATES.tiktok_dance,
  ];
}

export function getMotionTemplate(id) {
  const key = TEMPLATE_ALIASES[String(id || '').trim().toLowerCase()];
  return key ? MOTION_TEMPLATES[key] : null;
}

export function resolveTemplateFromSearch(search = '') {
  try {
    const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    const raw = params.get('template') || params.get('preset') || '';
    return getMotionTemplate(raw);
  } catch (_) {
    return null;
  }
}

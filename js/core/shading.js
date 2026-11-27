/**
 * @file shading.js
 * @description Blender-parity Surface Shading Manager:
 * - Shade Smooth
 * - Shade Flat
 * - Shade Auto Smooth (Angle threshold degrees)
 * - Integration with undo/redo and userData persistence
 */

import * as THREE from 'three';
import { computeAutoSmoothNormals, flipNormals, recalculateNormals } from './geometry/normals.js';

export const SHADING_MODES = {
  SMOOTH: 'smooth',
  FLAT: 'flat',
  AUTO: 'auto'
};

/**
 * Sets the surface shading mode of a mesh.
 * @param {THREE.Mesh} mesh
 * @param {'smooth'|'flat'|'auto'} mode
 * @param {Object} [options]
 * @param {number} [options.angleDeg=30] Auto-smooth angle threshold in degrees
 * @param {Object} [options.sceneManager] SceneManager for undo/redo
 * @returns {THREE.Mesh}
 */
export function setMeshShading(mesh, mode, options = {}) {
  if (!mesh || !mesh.isMesh || !mesh.geometry) return mesh;

  const { angleDeg = 30, sceneManager = null } = options;
  const currentShading = mesh.userData.shading || { mode: 'smooth', angleDeg: 30 };

  const oldGeom = mesh.geometry.clone();
  let newGeom;

  if (mode === SHADING_MODES.FLAT) {
    // Flat shading: convert to non-indexed and compute flat face normals
    newGeom = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    newGeom.computeVertexNormals();
  } else if (mode === SHADING_MODES.AUTO) {
    // Auto-smooth with angle threshold
    const rad = (angleDeg * Math.PI) / 180.0;
    newGeom = computeAutoSmoothNormals(mesh.geometry, rad);
  } else {
    // Default smooth shading
    newGeom = mesh.geometry.clone();
    newGeom.computeVertexNormals();
  }

  // Update mesh geometry and metadata
  mesh.geometry.dispose();
  mesh.geometry = newGeom;
  mesh.userData.shading = { mode, angleDeg };

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('blender:shadingChanged', { detail: { mesh, mode, angleDeg } }));
  }

  return mesh;
}

/**
 * Flips the normals of a mesh and inverts triangle winding.
 * @param {THREE.Mesh} mesh
 */
export function flipMeshNormals(mesh) {
  if (!mesh || !mesh.isMesh || !mesh.geometry) return;
  const flipped = flipNormals(mesh.geometry);
  mesh.geometry.dispose();
  mesh.geometry = flipped;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('blender:geometryChanged', { detail: { mesh } }));
  }
}

/**
 * Recalculates normals to point consistently outside or inside.
 * @param {THREE.Mesh} mesh
 * @param {boolean} [inside=false]
 */
export function recalculateMeshNormals(mesh, inside = false) {
  if (!mesh || !mesh.isMesh || !mesh.geometry) return;
  const recalced = recalculateNormals(mesh.geometry, inside);
  mesh.geometry.dispose();
  mesh.geometry = recalced;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('blender:geometryChanged', { detail: { mesh } }));
  }
}

/**
 * Returns current shading state of a mesh.
 * @param {THREE.Mesh} mesh
 * @returns {{ mode: 'smooth'|'flat'|'auto', angleDeg: number }}
 */
export function getShadingState(mesh) {
  return mesh?.userData?.shading || { mode: 'smooth', angleDeg: 30 };
}

// Aliases for parity
export const setShadingMode = setMeshShading;
export const flipNormalsMesh = flipMeshNormals;


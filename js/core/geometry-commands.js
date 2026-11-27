/**
 * Command history cho geometry/modifier (nền móng Phase 1).
 * File: js/core/geometry-commands.js
 *
 * Undo/redo khôi phục snapshot tức thì (descriptor + geometry đã evaluate),
 * KHÔNG tính lại stack nặng. Geometry snapshot là adopt (không clone) để tránh
 * tốn bộ nhớ main-thread; history byte-budget chịu trách nhiệm eviction.
 */

export class ModifierStackCommand {
  constructor({ mesh, before, after, description = 'Modifier stack', onApply = null }) {
    this.mesh = mesh;
    this.before = before;
    this.after = after;
    this.description = description;
    this.onApply = onApply;
    this.isGeometry = true;
  }

  execute() { this._apply(this.after); }
  undo() { this._apply(this.before); }

  _apply(snap) {
    const mesh = this.mesh;
    mesh.userData.modifierStack = (snap.descriptors || []).map((d) => ({ ...d, params: { ...(d.params || {}) } }));
    if (snap.baseGeometry) mesh.userData.baseGeometry = snap.baseGeometry;
    mesh.geometry = snap.geometry;
    this.onApply?.(mesh, snap);
  }

  get bytes() {
    const g = this.after?.geometry;
    if (!g?.attributes?.position) return 0;
    let total = 0;
    for (const attr of Object.values(g.attributes)) total += attr.array?.byteLength || 0;
    total += g.index?.array?.byteLength || 0;
    return total;
  }
}

/** Gộp nhiều command thành một bước undo (vd shading + material nhiều object). */
export class CompositeCommand {
  constructor(commands, description = 'Composite') {
    this.commands = commands;
    this.description = description;
  }
  execute() { for (const c of this.commands) c.execute?.(); }
  undo() { for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i].undo?.(); }
  get bytes() { return this.commands.reduce((s, c) => s + (c.bytes || 0), 0); }
}

/**
 * Gắn normals authoritative nếu có; chỉ computeVertexNormals khi thiếu.
 * Khắc phục MeshEditCommand cũ phá custom normals bằng compute vô điều kiện.
 */
export function applyAuthoritativeNormals(geometry, normals) {
  if (normals && normals.count === geometry.attributes.position.count) {
    geometry.setAttribute('normal', normals);
  } else if (!geometry.attributes.normal) {
    geometry.computeVertexNormals();
  }
  return geometry;
}
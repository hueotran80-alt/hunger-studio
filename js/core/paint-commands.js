/**
 * Undo/Redo Commands for Vertex Paint and Texture Paint
 * File: js/core/paint-commands.js
 */

export class VertexColorCommand {
  constructor(mesh, prevColors, nextColors, prevFlags, nextFlags, onUpdate = null, label = 'Vertex Paint') {
    this.mesh = mesh;
    this.prevColors = new Float32Array(prevColors);
    this.nextColors = new Float32Array(nextColors);
    this.prevFlags = Array.isArray(prevFlags) ? [...prevFlags] : null;
    this.nextFlags = Array.isArray(nextFlags) ? [...nextFlags] : null;
    this.onUpdate = onUpdate;
    this.name = label;
    this.id = `cmd_vc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  _apply(colors, flags, flagTargetVal) {
    const geo = this.mesh?.geometry;
    if (!geo) return;
    let attr = geo.attributes.color;
    const itemSize = attr ? attr.itemSize : 3;
    if (!attr || attr.array.length !== colors.length) {
      attr = new (this.mesh.geometry.attributes.position.constructor)(colors.slice(), itemSize);
      geo.setAttribute('color', attr);
    } else {
      attr.array.set(colors);
      attr.needsUpdate = true;
    }
    const mats = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
    mats.forEach((m, i) => {
      if (!m) return;
      const flag = flags ? flags[i] : flagTargetVal;
      if (typeof flag === 'boolean' && m.vertexColors !== flag) {
        m.vertexColors = flag;
        m.needsUpdate = true;
      }
    });
    if (this.onUpdate) this.onUpdate(this.mesh);
  }

  execute() {
    this._apply(this.nextColors, this.nextFlags, true);
  }

  undo() {
    this._apply(this.prevColors, this.prevFlags, false);
  }
}

export class TexturePaintCommand {
  /**
   * @param {import('./paint-mode.js').PaintLayerStack} layerStack
   * @param {string} slot - 'baseColor' | 'roughness' | 'metalness' | 'bump' | 'ao'
   * @param {string} layerId
   * @param {Map<string, {x:number,y:number,w:number,h:number,before:Uint8ClampedArray,after:Uint8ClampedArray}>} tiles
   */
  constructor(layerStack, slot, layerId, tiles, onUpdate = null, label = 'Texture Paint') {
    this.layerStack = layerStack;
    this.slot = slot;
    this.layerId = layerId;
    this.tiles = new Map();
    for (const [k, t] of tiles.entries()) {
      this.tiles.set(k, {
        x: t.x,
        y: t.y,
        w: t.w,
        h: t.h,
        before: new Uint8ClampedArray(t.before),
        after: new Uint8ClampedArray(t.after),
      });
    }
    this.onUpdate = onUpdate;
    this.name = label;
    this.id = `cmd_tp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  _apply(useAfter) {
    const slotData = this.layerStack?.getSlot(this.slot);
    const layer = slotData?.layers?.find((l) => l.id === this.layerId);
    if (!layer) return;
    for (const tile of this.tiles.values()) {
      const src = useAfter ? tile.after : tile.before;
      layer.writeRect(tile.x, tile.y, tile.w, tile.h, src);
    }
    this.layerStack.compositeSlot(this.slot);
    if (this.onUpdate) this.onUpdate(this.slot, layer);
  }

  execute() {
    this._apply(true);
  }

  undo() {
    this._apply(false);
  }
}

export class PaintLayerStateCommand {
  constructor(layerStack, slot, beforeState, afterState, onUpdate = null, label = 'Paint Layer Change') {
    this.layerStack = layerStack;
    this.slot = slot;
    this.beforeState = beforeState;
    this.afterState = afterState;
    this.onUpdate = onUpdate;
    this.name = label;
    this.id = `cmd_pl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }

  execute() {
    this.layerStack.restoreSlotSnapshot(this.slot, this.afterState);
    if (this.onUpdate) this.onUpdate(this.slot);
  }

  undo() {
    this.layerStack.restoreSlotSnapshot(this.slot, this.beforeState);
    if (this.onUpdate) this.onUpdate(this.slot);
  }
}

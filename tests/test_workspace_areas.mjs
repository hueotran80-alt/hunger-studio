/**
 * Unit tests for Blender-style Corner-Drag Workspace BSP Tree & Gesture Classifier
 * Chạy: node --import ./tests/three-resolve-hooks.mjs tests/test_workspace_areas.mjs
 */
import assert from 'node:assert/strict';
import {
  createLeafArea,
  splitLeafInTree,
  joinLeavesInTree,
  canJoinLeaves,
  swapLeavesInTree,
  listLeafNodes,
  computeNormalizedRects,
  classifyCornerDrag,
  findFirstJoinableNeighbor,
  updateSplitRatio,
} from '../js/ui/workspace-areas.js';

const failures = [];
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`✗ ${name}\n  ${err.stack || err.message}`);
  }
}

await test('Single leaf split vertical -> 2 normalized rects side by side', async () => {
  const root = createLeafArea({ id: 'a1' });
  const res = splitLeafInTree(root, 'a1', 'vertical', 0.6, false);
  assert.ok(res && res.newLeaf);
  const leaves = listLeafNodes(res.node);
  assert.equal(leaves.length, 2);
  const rects = computeNormalizedRects(res.node);
  const r1 = rects.get('a1');
  const r2 = rects.get(res.newLeaf.id);
  assert.ok(Math.abs(r1.w - 0.6) < 1e-6);
  assert.ok(Math.abs(r2.w - 0.4) < 1e-6);
  assert.ok(Math.abs(r1.right - r2.x) < 1e-6);
});

await test('Recursive split + swap leaves preserves geometry bounds', async () => {
  const root = createLeafArea({ id: 'left' });
  const r1 = splitLeafInTree(root, 'left', 'vertical', 0.5, false, { id: 'right' });
  const r2 = splitLeafInTree(r1.node, 'right', 'horizontal', 0.4, false, { id: 'br' });
  const leaves = listLeafNodes(r2.node);
  assert.equal(leaves.length, 3);

  const swapped = swapLeavesInTree(r2.node, 'left', 'br');
  const rects = computeNormalizedRects(swapped);
  assert.ok(Math.abs(rects.get('br').w - 0.5) < 1e-6);
  assert.ok(Math.abs(rects.get('br').h - 1.0) < 1e-6);
  assert.ok(Math.abs(rects.get('left').h - 0.6) < 1e-6);
});

await test('Direct sibling join & aligned 3-column chain join both succeed', async () => {
  const root = createLeafArea({ id: 'c1' });
  const s1 = splitLeafInTree(root, 'c1', 'vertical', 0.3, false, { id: 'c2' });
  const s2 = splitLeafInTree(s1.node, 'c2', 'vertical', 0.5, false, { id: 'c3' });

  // Direct sibling join: c2 + c3
  const joinedDirect = joinLeavesInTree(s2.node, 'c2', 'c3');
  assert.equal(listLeafNodes(joinedDirect).length, 2);
  assert.ok(Math.abs(computeNormalizedRects(joinedDirect).get('c2').w - 0.7) < 1e-4);

  // Chain join across nesting boundary: c1 (0..0.3) absorbs c2 (0.3..0.65)
  const joinedChain = joinLeavesInTree(s2.node, 'c1', 'c2');
  assert.ok(joinedChain);
  assert.equal(listLeafNodes(joinedChain).length, 2);
  const rects = computeNormalizedRects(joinedChain);
  assert.ok(Math.abs(rects.get('c1').w - 0.65) < 1e-4);
  assert.ok(Math.abs(rects.get('c3').w - 0.35) < 1e-4);

  // Reverse chain join: c2 absorbs c1
  const joinedChainRev = joinLeavesInTree(s2.node, 'c2', 'c1');
  assert.ok(joinedChainRev);
  const revRects = computeNormalizedRects(joinedChainRev);
  assert.ok(Math.abs(revRects.get('c2').w - 0.65) < 1e-4);
  assert.ok(Math.abs(revRects.get('c3').w - 0.35) < 1e-4);
});

await test('T-junction unaligned areas reject invalid join', async () => {
  const root = createLeafArea({ id: 'left' });
  const s1 = splitLeafInTree(root, 'left', 'vertical', 0.5, false, { id: 'rt' });
  const s2 = splitLeafInTree(s1.node, 'rt', 'horizontal', 0.5, false, { id: 'rb' });
  assert.equal(canJoinLeaves(s2.node, 'left', 'rt'), null);
  assert.ok(canJoinLeaves(s2.node, 'rt', 'rb'));
  assert.equal(findFirstJoinableNeighbor(s2.node, 'rt'), 'rb');
});

await test('Corner drag classifier handles small deadzone, inward split, outward join, and bottom-dock collapse', async () => {
  const root = createLeafArea({ id: 'a1' });
  const domRects = new Map([
    ['a1', { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }],
  ]);

  // Below drag threshold
  const none = classifyCornerDrag({
    root,
    sourceLeafId: 'a1',
    corner: 'tr',
    startX: 995,
    startY: 5,
    curX: 988,
    curY: 8,
    domRects,
  });
  assert.equal(none.action, 'none');

  // Top-right corner dragged horizontally inward -> vertical split (Left | Right)
  const splitV = classifyCornerDrag({
    root,
    sourceLeafId: 'a1',
    corner: 'tr',
    startX: 995,
    startY: 5,
    curX: 650,
    curY: 12,
    domRects,
  });
  assert.equal(splitV.action, 'split');
  assert.equal(splitV.direction, 'vertical');
  assert.equal(splitV.insertNewFirst, false);
  assert.ok(Math.abs(splitV.ratio - 0.65) < 1e-6);

  // Top-right corner dragged vertically downward -> horizontal split (Top / Bottom)
  const splitH = classifyCornerDrag({
    root,
    sourceLeafId: 'a1',
    corner: 'tr',
    startX: 995,
    startY: 5,
    curX: 985,
    curY: 300,
    domRects,
  });
  assert.equal(splitH.action, 'split');
  assert.equal(splitH.direction, 'horizontal');
  assert.equal(splitH.insertNewFirst, true);
  assert.ok(Math.abs(splitH.ratio - 0.5) < 1e-6);

  // Dragging bottom-right corner down into visible #bottom-dock -> close-bottom-dock
  const dockJoin = classifyCornerDrag({
    root,
    sourceLeafId: 'a1',
    corner: 'br',
    startX: 995,
    startY: 595,
    curX: 920,
    curY: 680,
    domRects,
    bottomDockRect: { left: 0, top: 604, right: 1000, bottom: 850, width: 1000, height: 246 },
  });
  assert.equal(dockJoin.action, 'close-bottom-dock');
  assert.equal(dockJoin.arrow, 'down');

  // Two panes split vertically: dragging Right pane top-left corner left into Left pane -> join
  const splitTree = splitLeafInTree(root, 'a1', 'vertical', 0.5, false, { id: 'a2' }).node;
  const twoRects = new Map([
    ['a1', { left: 0, top: 0, right: 498, bottom: 600, width: 498, height: 600 }],
    ['a2', { left: 502, top: 0, right: 1000, bottom: 600, width: 498, height: 600 }],
  ]);
  const join = classifyCornerDrag({
    root: splitTree,
    sourceLeafId: 'a2',
    corner: 'tl',
    startX: 505,
    startY: 5,
    curX: 300,
    curY: 40,
    domRects: twoRects,
  });
  assert.equal(join.action, 'join');
  assert.equal(join.keepLeafId, 'a2');
  assert.equal(join.removeLeafId, 'a1');
  assert.equal(join.arrow, 'left');
});

await test('updateSplitRatio clamps extremes cleanly', async () => {
  const s = splitLeafInTree(createLeafArea({ id: 'a' }), 'a', 'vertical', 0.5, false, { id: 'b' }).node;
  const clampedLow = updateSplitRatio(s, s.id, 0.01);
  assert.ok(clampedLow.ratio >= 0.08);
  const clampedHigh = updateSplitRatio(s, s.id, 0.99);
  assert.ok(clampedHigh.ratio <= 0.92);
});

if (failures.length > 0) {
  console.error(`\nFailed (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nWorkspace area BSP tests: all passed.');

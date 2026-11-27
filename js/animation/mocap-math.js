/**
 * Module toán thuần dùng chung cho pipeline Mocap (không DOM, không Three.js).
 * File: js/animation/mocap-math.js
 *
 * Trước đây các hàm này bị viết trùng lặp rải rác trong:
 * - `js/ui/mocap-ui.js`        (binary search frame theo thời gian + skeleton 2D)
 * - `js/animation/camera-framing.js` (median)
 * - `js/animation/mocap-filters.js`  (median, clamp)
 * - `js/animation/mocap-retargeter.js` (median thủ công của midHip)
 * Giờ mọi nơi import từ đây để hành vi luôn nhất quán và test được bằng Node.
 */

/** Kẹp giá trị vào khoảng [lo, hi]. */
export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Trung vị (median) — bỏ giá trị không phải số trước khi sort.
 * @param {Array<number>} values
 * @returns {number|null} null khi không còn giá trị hợp lệ nào.
 */
export function median(values) {
  const arr = (Array.isArray(values) ? values : [])
    .filter((v) => Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = arr.length >> 1;
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/**
 * Tìm chỉ số frame có mốc thời gian gần `time` nhất bằng tìm kiếm nhị phân.
 * Yêu cầu `times` đã tăng dần (đúng thứ tự của mocapFrames).
 *
 * @param {Array<{time?: number}>|Array<number>} frames Mảng frame (dùng field `time`) hoặc mảng thời gian.
 * @param {number} time Giây cần khớp.
 * @returns {number} -1 nếu mảng rỗng.
 */
export function closestFrameIndexByTime(frames, time) {
  const n = Array.isArray(frames) ? frames.length : 0;
  if (n === 0) return -1;
  const at = (i) => (typeof frames[i] === 'number' ? frames[i] : (frames[i]?.time || 0));
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(mid) < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(at(lo - 1) - time) < Math.abs(at(lo) - time)) return lo - 1;
  return lo;
}

/**
 * Cặp chỉ số landmark MediaPipe Pose nối thành khung xương 2D để vẽ overlay.
 * (Trước đây là `this.boneConnections` trong MocapUI.)
 */
export const POSE_BONE_CONNECTIONS = Object.freeze([
  // Shoulders & Torso
  [11, 12], [11, 23], [12, 24], [23, 24],
  // Left Arm & Hand
  [11, 13], [13, 15], [15, 19],
  // Right Arm & Hand
  [12, 14], [14, 16], [16, 20],
  // Left Leg & Foot
  [23, 25], [25, 27], [27, 31],
  // Right Leg & Foot
  [24, 26], [26, 28], [28, 32],
  // Head
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10], [11, 0], [12, 0],
]);

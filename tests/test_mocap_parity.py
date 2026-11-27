"""Parity tests: the browser (JS) mocap pipeline vs the Python server engine.

Giai đoạn 1 moved pose tracking into the browser. The post-processing must stay
bit-for-bit compatible with `mocap_engine.py`, otherwise the same video would
produce different animations depending on where it was processed.

Run: .venv/bin/python -m unittest tests.test_mocap_parity -v
Skipped automatically when Node or MediaPipe/OpenCV are unavailable.
"""
import base64
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

NODE = shutil.which('node')


def _load_engine():
    try:
        import mocap_engine  # noqa: WPS433 (import inside helper on purpose)
        return mocap_engine
    except Exception as exc:  # pragma: no cover - depends on optional deps
        raise unittest.SkipTest(f'mocap_engine không import được: {exc}')


def _run_node(script):
    proc = subprocess.run(
        [NODE, '--input-type=module', '-e', script],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        raise AssertionError(f'node failed ({proc.returncode}): {proc.stderr[-2000:]}')
    return json.loads(proc.stdout)


def _series(n=60):
    """Deterministic, reproducible 3-axis signal (sine + sawtooth + noise)."""
    frames = []
    for i in range(n):
        frames.append([
            0.5 + 0.12 * ((i * 37) % 11 - 5) / 5.0,
            0.2 * ((i % 9) / 9.0) - 0.05,
            1.4 + 0.05 * ((i * 13) % 7),
        ])
    return frames


@unittest.skipUnless(NODE, 'node không có trong PATH')
class MocapParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine_module = _load_engine()

    def test_one_euro_filter_matches_python(self):
        series = _series()
        np = self.engine_module.np
        py_filter = self.engine_module.OneEuroFilter(freq=30.0, min_cutoff=1.2, beta=0.05)
        expected = [
            np.asarray(py_filter.filter(np.array(vec, dtype='float64'), freq=30.0)).tolist()
            for vec in series
        ]

        payload = base64.b64encode(json.dumps(series).encode()).decode()
        script = f"""
import {{ OneEuroFilter }} from './js/animation/mocap-filters.js';
const series = JSON.parse(Buffer.from('{payload}', 'base64').toString('utf8'));
const f = new OneEuroFilter({{ freq: 30, minCutoff: 1.2, beta: 0.05 }});
console.log(JSON.stringify(series.map((v) => f.filter(v, 30))));
"""
        actual = _run_node(script)

        self.assertEqual(len(actual), len(expected))
        worst = 0.0
        for row_a, row_e in zip(actual, expected):
            for a, e in zip(row_a, row_e):
                worst = max(worst, abs(a - e))
        self.assertLess(worst, 1e-6, f'JS và Python lệch {worst:.3e} sau 1-Euro filter')

    def test_bone_length_enforcement_matches_python(self):
        series = _series(24)
        joints = ('leftShoulder', 'leftElbow', 'leftWrist', 'leftHandIndex',
                  'leftHip', 'leftKnee', 'leftAnkle', 'leftFoot')
        raw = []
        for i, vec in enumerate(series):
            frame = {}
            for k, joint in enumerate(joints):
                frame[joint] = [
                    vec[0] * (0.6 + 0.05 * k) + 0.01 * (i % 3),
                    vec[1] - 0.1 * k,
                    vec[2] * (0.4 + 0.02 * k),
                ]
            raw.append(frame)

        py_raw = [
            {joint: self.engine_module.np.array(frame[joint], dtype='float32') for joint in frame}
            for frame in raw
        ]
        py_out = self.engine_module.VideoMocapEngine._enforce_bone_lengths(
            self.engine_module.VideoMocapEngine.__new__(self.engine_module.VideoMocapEngine),
            [dict(f) for f in py_raw],
        )
        expected = [
            {joint: [float(v) for v in frame[joint]] for joint in frame}
            for frame in py_out
        ]

        payload = base64.b64encode(json.dumps(raw).encode()).decode()
        script = f"""
import {{ enforceBoneLengths }} from './js/animation/mocap-filters.js';
const series = JSON.parse(Buffer.from('{payload}', 'base64').toString('utf8'));
console.log(JSON.stringify(enforceBoneLengths(series)));
"""
        actual = _run_node(script)

        worst = 0.0
        for row_a, row_e in zip(actual, expected):
            for joint in row_e:
                for a, e in zip(row_a[joint], row_e[joint]):
                    worst = max(worst, abs(a - e))
        self.assertLess(worst, 1e-4, f'độ dài xương lệch {worst:.3e} so với Python')

    def test_frame_schema_matches_server(self):
        series = _series(3)
        joints = ('nose', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow',
                  'leftWrist', 'rightWrist', 'leftHandIndex', 'rightHandIndex',
                  'leftHip', 'rightHip', 'leftKnee', 'rightKnee',
                  'leftAnkle', 'rightAnkle', 'leftFoot', 'rightFoot')
        raw = [{joint: series[i] for joint in joints} for i in range(3)]

        payload = base64.b64encode(json.dumps(raw).encode()).decode()
        script = f"""
import {{ buildMocapFrames }} from './js/animation/mocap-filters.js';
const series = JSON.parse(Buffer.from('{payload}', 'base64').toString('utf8'));
console.log(JSON.stringify(buildMocapFrames(series, {{ fps: 30 }})));
"""
        frames = _run_node(script)

        self.assertEqual(len(frames), 3)
        spine = frames[1]['spine']
        mid_hip = frames[1]['midHip']
        neck = frames[1]['neck']
        for axis in range(3):
            self.assertAlmostEqual(
                spine[axis], mid_hip[axis] + (neck[axis] - mid_hip[axis]) * 0.65, places=4
            )
        self.assertAlmostEqual(frames[2]['time'], round(2 / 30, 5), places=5)


if __name__ == '__main__':
    unittest.main()

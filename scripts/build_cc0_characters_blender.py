#!/usr/bin/env python3
"""
Generate two studio-grade, 100% original CC0-1.0 rigged humanoid characters
using Blender 4.5+ headless CLI:
  - Smooth lofted anatomical body fused seamlessly with limbs via Voxel Remesh
  - Razor-clean `bisect_plane` material seams (zero jagged sawtooth borders)
  - Smooth Subsurf + Shrinkwrap + Solidify contoured apparel & ceramic armor shells

Outputs:
  1. models/Mannequin_CC0.glb — Studio Sculpt Athlete (~1.72 m, 56 bones,
     articulated 5-finger hands, 8 ARKit facial blendshapes, Idle + Walk clips)
  2. models/Bot_CC0.glb       — Autonomous Cyber Droid (~1.76 m, 56 bones,
     contoured pearl-ceramic armor + curved cyan visor/core, Walk + Idle clips)
"""

import math
import os
import sys
import bpy
import bmesh
from mathutils import Euler, Matrix, Quaternion, Vector

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT_MANNEQUIN = os.path.join(ROOT_DIR, 'models', 'Mannequin_CC0.glb')
OUT_BOT = os.path.join(ROOT_DIR, 'models', 'Bot_CC0.glb')


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    render_dir = None
    i = 0
    while i < len(argv):
        if argv[i] == '--render-dir' and i + 1 < len(argv):
            render_dir = argv[i + 1]
            i += 2
        else:
            i += 1
    return render_dir


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 30
    scene.frame_start = 1
    scene.frame_end = 60


def make_material(
    name,
    base_color,
    metallic=0.0,
    roughness=0.45,
    coat=0.0,
    coat_roughness=0.12,
    sheen=0.0,
    emission=None,
    emission_strength=0.0,
):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (*base_color, 1.0)
        bsdf.inputs['Metallic'].default_value = metallic
        bsdf.inputs['Roughness'].default_value = roughness
        if 'Coat Weight' in bsdf.inputs:
            bsdf.inputs['Coat Weight'].default_value = coat
        if 'Coat Roughness' in bsdf.inputs:
            bsdf.inputs['Coat Roughness'].default_value = coat_roughness
        if 'Sheen Weight' in bsdf.inputs:
            bsdf.inputs['Sheen Weight'].default_value = sheen
        if emission is not None and emission_strength > 0.0:
            if 'Emission Color' in bsdf.inputs:
                bsdf.inputs['Emission Color'].default_value = (*emission, 1.0)
            if 'Emission Strength' in bsdf.inputs:
                bsdf.inputs['Emission Strength'].default_value = emission_strength
    return mat


# ---------------------------------------------------------------------------
# Smooth Loft & Capsule Primitives for Clean Lump-Free Anatomical Base
# ---------------------------------------------------------------------------

def add_loft(bm, rings, segs=28, axis='z', cap_start=True, cap_end=True):
    """
    Smooth asymmetric anatomical loft.
      axis='z': (cx, cy, cz, rx, ry_front, ry_back, super_p)  (-Y is front!)
      axis='x': (cx, cy, cz, ry_front, ry_back, rz_top, rz_bot, super_p)
      axis='y': (cx, cy, cz, rx, rz_top, rz_bot, super_p)
    """
    created = []
    for ring in rings:
        rv = []
        if axis == 'z':
            cx, cy, cz, rx, ryf, ryb = ring[:6]
            p = ring[6] if len(ring) > 6 else 2.0
            for i in range(segs):
                a = 2.0 * math.pi * i / segs
                ca, sa = math.cos(a), math.sin(a)
                sx = math.copysign(abs(ca) ** (2.0 / p), ca)
                sy = math.copysign(abs(sa) ** (2.0 / p), sa)
                ry = ryf if sy < 0 else ryb
                rv.append(bm.verts.new((cx + sx * rx, cy + sy * ry, cz)))
        elif axis == 'x':
            cx, cy, cz, ryf, ryb, rzt, rzb = ring[:7]
            p = ring[7] if len(ring) > 7 else 2.0
            for i in range(segs):
                a = 2.0 * math.pi * i / segs
                ca, sa = math.cos(a), math.sin(a)
                sy = math.copysign(abs(ca) ** (2.0 / p), ca)
                sz = math.copysign(abs(sa) ** (2.0 / p), sa)
                ry = ryf if sy < 0 else ryb
                rz = rzt if sz >= 0 else rzb
                rv.append(bm.verts.new((cx, cy + sy * ry, cz + sz * rz)))
        elif axis == 'y':
            cx, cy, cz, rx, rzt, rzb = ring[:6]
            p = ring[6] if len(ring) > 6 else 2.0
            for i in range(segs):
                a = 2.0 * math.pi * i / segs
                ca, sa = math.cos(a), math.sin(a)
                sx = math.copysign(abs(ca) ** (2.0 / p), ca)
                sz = math.copysign(abs(sa) ** (2.0 / p), sa)
                rz = rzt if sz >= 0 else rzb
                rv.append(bm.verts.new((cx + sx * rx, cy, cz + sz * rz)))
        created.append(rv)

    for r in range(len(created) - 1):
        r0, r1 = created[r], created[r + 1]
        for i in range(segs):
            ni = (i + 1) % segs
            try:
                bm.faces.new((r0[i], r0[ni], r1[ni], r1[i]))
            except ValueError:
                pass

    if cap_start and created:
        r0 = created[0]
        vc = bm.verts.new(sum((v.co for v in r0), Vector()) / len(r0))
        for i in range(segs):
            ni = (i + 1) % segs
            try:
                bm.faces.new((vc, r0[ni], r0[i]))
            except ValueError:
                pass
    if cap_end and created:
        rl = created[-1]
        vc = bm.verts.new(sum((v.co for v in rl), Vector()) / len(rl))
        for i in range(segs):
            ni = (i + 1) % segs
            try:
                bm.faces.new((vc, rl[i], rl[ni]))
            except ValueError:
                pass


def add_ellipsoid(bm, center, radii, u_segs=18, v_segs=12, rot_euler=(0, 0, 0)):
    res = bmesh.ops.create_uvsphere(bm, u_segments=u_segs, v_segments=v_segs, radius=1.0)
    rot = Euler(rot_euler, 'XYZ').to_matrix()
    cx, cy, cz = center
    rx, ry, rz = radii
    for v in res['verts']:
        p = Vector((v.co.x * rx, v.co.y * ry, v.co.z * rz))
        v.co = (rot @ p) + Vector((cx, cy, cz))
    return res['verts']


def add_tapered_limb(bm, p0, p1, r0, r1, rx_scale=1.0, ry_scale=1.0, segs=18, rings=6):
    a, b = Vector(p0), Vector(p1)
    axis = b - a
    length = axis.length
    if length < 1e-6:
        return
    z_dir = axis.normalized()
    up_ref = Vector((0, 1, 0)) if abs(z_dir.y) < 0.9 else Vector((0, 0, 1))
    x_dir = up_ref.cross(z_dir).normalized()
    y_dir = z_dir.cross(x_dir).normalized()

    samples = []
    for k in range(3):
        ang = (k / 3.0) * (math.pi * 0.5)
        samples.append((-math.cos(ang) * r0, math.sin(ang) * r0))
    for k in range(1, rings):
        t = k / rings
        samples.append((t * length, r0 * (1.0 - t) + r1 * t))
    for k in range(4):
        ang = (k / 3.0) * (math.pi * 0.5)
        samples.append((length + math.sin(ang) * r1, math.cos(ang) * r1))

    ring_verts = []
    for d, rad in samples:
        rad = max(0.001, rad)
        c = a + z_dir * d
        rv = [
            bm.verts.new(c + x_dir * (math.cos(2 * math.pi * i / segs) * rad * rx_scale) + y_dir * (math.sin(2 * math.pi * i / segs) * rad * ry_scale))
            for i in range(segs)
        ]
        ring_verts.append(rv)

    for r in range(len(ring_verts) - 1):
        rA, rB = ring_verts[r], ring_verts[r + 1]
        for i in range(segs):
            ni = (i + 1) % segs
            try:
                bm.faces.new((rA[i], rA[ni], rB[ni], rB[i]))
            except ValueError:
                pass
    for end_ring, rev in ((ring_verts[0], True), (ring_verts[-1], False)):
        vc = bm.verts.new(sum((v.co for v in end_ring), Vector()) / len(end_ring))
        for i in range(segs):
            ni = (i + 1) % segs
            try:
                bm.faces.new((vc, end_ring[ni], end_ring[i]) if rev else (vc, end_ring[i], end_ring[ni]))
            except ValueError:
                pass


def bisect_mesh_planes(obj, planes):
    """
    Slice clean laser-straight edge loops across `obj` at each (plane_co, plane_no)
    so material zone transitions NEVER have jagged sawtooth triangles!
    """
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    for plane_co, plane_no in planes:
        geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(
            bm,
            geom=geom,
            plane_co=Vector(plane_co),
            plane_no=Vector(plane_no).normalized(),
            clear_inner=False,
            clear_outer=False,
        )
    bm.to_mesh(obj.data)
    bm.free()
    for p in obj.data.polygons:
        p.use_smooth = True


def build_clean_anatomical_body(name, scale=1.0, athletic_width=1.0, voxel_size=0.0072, target_faces=14500, bisect_planes=None):
    """
    Build a genuinely sleek, lump-free, Unreal-Quinn / Mixamo-Y-Bot proportioned
    sculpted humanoid using continuous anatomical lofts fused cleanly with limbs
    via Voxel Remesh + Smooth + Decimate + laser-straight bisect cuts.
    """
    s = scale
    aw = athletic_width
    bm = bmesh.new()

    # 1. Sleek Continuous Pelvis -> Waist -> Ribcage -> Chest -> Neck Loft (ZERO lumpy spheres!)
    torso_rings = [
        (0.0, 0.006 * s, 0.835 * s, 0.128 * s, 0.090 * s, 0.104 * s, 2.05),
        (0.0, 0.008 * s, 0.895 * s, 0.168 * s, 0.102 * s, 0.126 * s, 2.05),  # smooth athletic hip & glute flow
        (0.0, 0.006 * s, 0.955 * s, 0.156 * s, 0.098 * s, 0.112 * s, 2.05),  # iliac hip crest
        (0.0, 0.004 * s, 1.025 * s, 0.128 * s, 0.088 * s, 0.092 * s, 2.05),  # lean athletic waist
        (0.0, 0.003 * s, 1.095 * s, 0.130 * s, 0.092 * s, 0.094 * s, 2.08),
        (0.0, 0.000 * s, 1.185 * s, 0.148 * s * aw, 0.102 * s, 0.104 * s, 2.12),  # lower ribcage / lats
        (0.0, -0.004 * s, 1.280 * s, 0.170 * s * aw, 0.118 * s, 0.112 * s, 2.18), # athletic chest taper
        (0.0, -0.005 * s, 1.365 * s, 0.184 * s * aw, 0.120 * s, 0.114 * s, 2.22), # broad sculpted pectorals
        (0.0, -0.002 * s, 1.425 * s, 0.172 * s * aw, 0.096 * s, 0.102 * s, 2.15), # clavicle / shoulder plane
        (0.0, 0.002 * s, 1.460 * s, 0.082 * s, 0.068 * s, 0.074 * s, 2.00),  # trapezius neck base
        (0.0, 0.000 * s, 1.505 * s, 0.052 * s, 0.052 * s, 0.056 * s, 2.00),  # sculpted neck
        (0.0, -0.004 * s, 1.555 * s, 0.050 * s, 0.054 * s, 0.056 * s, 2.00),
    ]
    add_loft(bm, torso_rings, segs=32, axis='z')

    # 2. Clean Classical Sculpted Mannequin Head (smooth cranium, jawline, nose bridge, subtle brow — ZERO lumpy cheeks!)
    head_rings = [
        (0.0, -0.036 * s, 1.534 * s, 0.024 * s, 0.034 * s, 0.018 * s, 2.0),   # sculpted chin
        (0.0, -0.024 * s, 1.554 * s, 0.048 * s, 0.062 * s, 0.042 * s, 2.05),  # lower jaw
        (0.0, -0.014 * s, 1.582 * s, 0.066 * s, 0.078 * s, 0.066 * s, 2.05),  # jaw angle
        (0.0, -0.008 * s, 1.612 * s, 0.074 * s, 0.086 * s, 0.082 * s, 2.02),  # smooth cheek plane
        (0.0, -0.006 * s, 1.644 * s, 0.077 * s, 0.090 * s, 0.092 * s, 2.00),  # brow / temple
        (0.0, -0.002 * s, 1.678 * s, 0.077 * s, 0.089 * s, 0.096 * s, 2.00),  # forehead
        (0.0, 0.004 * s, 1.706 * s, 0.066 * s, 0.074 * s, 0.084 * s, 2.00),   # upper cranium
        (0.0, 0.008 * s, 1.724 * s, 0.034 * s, 0.038 * s, 0.046 * s, 2.00),   # crown
    ]
    add_loft(bm, head_rings, segs=30, axis='z')
    # Subtle classical nose ridge & smooth sculpted ears
    add_ellipsoid(bm, (0, -0.093 * s, 1.610 * s), (0.009 * s, 0.014 * s, 0.019 * s), rot_euler=(-0.16, 0, 0))
    for sign in (1.0, -1.0):
        add_ellipsoid(bm, (sign * 0.075 * s, 0.002 * s, 1.616 * s), (0.010 * s, 0.016 * s, 0.025 * s))

    # 3. Sleek Sculpted Arms (continuous loft along ±X, smooth deltoid shoulder transition)
    for sign in (1.0, -1.0):
        arm_rings = [
            (sign * 0.145 * s, 0.006 * s, 1.418 * s, 0.066 * s, 0.066 * s, 0.066 * s, 0.060 * s, 2.05),
            (sign * 0.205 * s, 0.010 * s, 1.422 * s, 0.060 * s, 0.060 * s, 0.062 * s, 0.056 * s, 2.05),  # deltoid cap
            (sign * 0.310 * s, 0.015 * s, 1.420 * s, 0.049 * s, 0.051 * s, 0.050 * s, 0.048 * s, 2.00),  # bicep/tricep
            (sign * 0.450 * s, 0.022 * s, 1.418 * s, 0.041 * s, 0.043 * s, 0.042 * s, 0.040 * s, 2.00),  # elbow
            (sign * 0.525 * s, 0.018 * s, 1.417 * s, 0.043 * s, 0.044 * s, 0.043 * s, 0.041 * s, 2.00),  # forearm belly
            (sign * 0.625 * s, 0.012 * s, 1.416 * s, 0.034 * s, 0.035 * s, 0.033 * s, 0.032 * s, 2.00),
            (sign * 0.708 * s, 0.006 * s, 1.415 * s, 0.027 * s, 0.028 * s, 0.023 * s, 0.022 * s, 2.05),  # oval wrist
        ]
        if sign < 0:
            arm_rings = list(reversed(arm_rings))
        add_loft(bm, arm_rings, segs=24, axis='x')

    # 4. Sleek Sculpted Legs & Grounded Shoes (continuous anatomical loft)
    for sign in (1.0, -1.0):
        lx = sign * 0.095 * s
        leg_rings = [
            (lx, 0.016 * s, 0.072 * s, 0.037 * s, 0.040 * s, 0.040 * s, 2.0),   # ankle
            (lx, 0.014 * s, 0.185 * s, 0.042 * s, 0.044 * s, 0.048 * s, 2.0),   # achilles taper
            (lx, 0.012 * s, 0.335 * s, 0.056 * s, 0.054 * s, 0.068 * s, 2.05),  # sculpted calf
            (lx, 0.002 * s, 0.435 * s, 0.052 * s, 0.054 * s, 0.056 * s, 2.0),   # below knee
            (lx, -0.008 * s, 0.490 * s, 0.055 * s, 0.062 * s, 0.055 * s, 2.05), # patella knee
            (lx, -0.004 * s, 0.620 * s, 0.072 * s, 0.078 * s, 0.074 * s, 2.05), # sculpted quad/hamstring
            (lx, 0.002 * s, 0.765 * s, 0.082 * s, 0.088 * s, 0.090 * s, 2.05),  # upper thigh
            (lx * 0.92, 0.005 * s, 0.865 * s, 0.080 * s, 0.086 * s, 0.096 * s, 2.0),   # smooth hip taper
            (lx * 0.72, 0.006 * s, 0.935 * s, 0.062 * s, 0.068 * s, 0.076 * s, 2.0),   # seamless blend inside pelvis
        ]
        add_loft(bm, leg_rings, segs=26, axis='z')

        # Aerodynamic sculpted shoe base grounded cleanly at Z = 0.000
        shoe_rings = [
            (lx, 0.064 * s, 0.032 * s, 0.040 * s, 0.034 * s, 0.032 * s, 2.2),
            (lx, 0.016 * s, 0.042 * s, 0.045 * s, 0.044 * s, 0.042 * s, 2.2),
            (lx, -0.048 * s, 0.032 * s, 0.046 * s, 0.032 * s, 0.032 * s, 2.2),
            (lx, -0.112 * s, 0.024 * s, 0.048 * s, 0.022 * s, 0.024 * s, 2.2),
            (lx, -0.156 * s, 0.019 * s, 0.034 * s, 0.015 * s, 0.019 * s, 2.1),
            (lx, -0.172 * s, 0.016 * s, 0.018 * s, 0.010 * s, 0.014 * s, 2.0),
        ]
        add_loft(bm, shoe_rings, segs=22, axis='y')

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)

    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    rem = obj.modifiers.new(name='VoxelRemesh', type='REMESH')
    rem.mode = 'VOXEL'
    rem.voxel_size = voxel_size * s
    rem.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=rem.name)

    sm = obj.modifiers.new(name='Smooth', type='SMOOTH')
    sm.factor = 0.65
    sm.iterations = 8
    bpy.ops.object.modifier_apply(modifier=sm.name)

    cur_faces = len(obj.data.polygons)
    if cur_faces > target_faces:
        dec = obj.modifiers.new(name='Decimate', type='DECIMATE')
        dec.ratio = max(0.08, target_faces / cur_faces)
        bpy.ops.object.modifier_apply(modifier=dec.name)

    # Flat grounded outsole at exact Z = 0.000
    min_z = min(v.co.z for v in obj.data.vertices)
    for v in obj.data.vertices:
        v.co.z -= min_z
        if v.co.z < 0.006 * s:
            v.co.z = 0.0

    # Apply laser-straight bisect cuts BEFORE material assignment!
    if bisect_planes:
        bisect_mesh_planes(obj, bisect_planes)

    for p in obj.data.polygons:
        p.use_smooth = True
    obj.select_set(False)
    return obj


def build_sculpted_hand_object(name, side_sign, scale=1.0, voxel_size=0.0032, target_faces=1650):
    s = scale
    sign = side_sign
    bm = bmesh.new()

    add_tapered_limb(
        bm,
        (sign * 0.695 * s, 0.006 * s, 1.415 * s),
        (sign * 0.790 * s, 0.001 * s, 1.413 * s),
        0.024 * s,
        0.036 * s,
        rx_scale=0.50,
        ry_scale=1.18,
    )
    add_ellipsoid(bm, (sign * 0.748 * s, 0.002 * s, 1.414 * s), (0.044 * s, 0.039 * s, 0.014 * s))
    add_ellipsoid(bm, (sign * 0.734 * s, -0.022 * s, 1.404 * s), (0.023 * s, 0.019 * s, 0.013 * s))

    tpts = [
        (sign * 0.728 * s, -0.020 * s, 1.405 * s, 0.013 * s),
        (sign * 0.758 * s, -0.044 * s, 1.395 * s, 0.011 * s),
        (sign * 0.782 * s, -0.060 * s, 1.389 * s, 0.0098 * s),
        (sign * 0.802 * s, -0.072 * s, 1.385 * s, 0.0078 * s),
    ]
    for k in range(3):
        add_tapered_limb(bm, tpts[k][:3], tpts[k + 1][:3], tpts[k][3], tpts[k + 1][3], segs=12, rings=3)

    fdefs = [
        (-0.027 * s, 0.036 * s, 0.024 * s, 0.020 * s, 0.0090 * s),
        (-0.009 * s, 0.040 * s, 0.026 * s, 0.021 * s, 0.0092 * s),
        (0.009 * s, 0.036 * s, 0.024 * s, 0.020 * s, 0.0086 * s),
        (0.026 * s, 0.029 * s, 0.020 * s, 0.017 * s, 0.0076 * s),
    ]
    for y_off, l1, l2, l3, r0 in fdefs:
        x0 = 0.784 * s
        pts = [
            (sign * x0, y_off, 1.413 * s, r0),
            (sign * (x0 + l1), y_off, 1.411 * s, r0 * 0.90),
            (sign * (x0 + l1 + l2), y_off, 1.409 * s, r0 * 0.80),
            (sign * (x0 + l1 + l2 + l3), y_off, 1.407 * s, r0 * 0.64),
        ]
        for k in range(3):
            add_tapered_limb(bm, pts[k][:3], pts[k + 1][:3], pts[k][3], pts[k + 1][3], segs=10, rings=2)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    rem = obj.modifiers.new(name='VoxelRemesh', type='REMESH')
    rem.mode = 'VOXEL'
    rem.voxel_size = voxel_size * s
    rem.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=rem.name)

    sm = obj.modifiers.new(name='Smooth', type='SMOOTH')
    sm.factor = 0.55
    sm.iterations = 3
    bpy.ops.object.modifier_apply(modifier=sm.name)

    cur_faces = len(obj.data.polygons)
    if cur_faces > target_faces:
        dec = obj.modifiers.new(name='Decimate', type='DECIMATE')
        dec.ratio = max(0.10, target_faces / cur_faces)
        bpy.ops.object.modifier_apply(modifier=dec.name)

    for p in obj.data.polygons:
        p.use_smooth = True
    obj.select_set(False)
    return obj


# ---------------------------------------------------------------------------
# Razor-Clean Contoured Armor & Apparel Shells (Subsurf + Shrinkwrap + Solidify)
# ---------------------------------------------------------------------------

def build_shrinkwrapped_shell(
    target_body,
    name,
    bm,
    materials,
    mat_index,
    subsurf=2,
    wrap_offset=0.002,
    thickness=0.006,
    region_tag='body',
    shrinkwrap=True,
):
    """
    Create a sleek, razor-clean quad-topology armor shell, visor, hair cap, or
    accent plate, shrinkwrap it smoothly onto the sculpted anatomical body, and
    solidify outward. Produces ZERO jagged sawtooth edges!
    """
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for m in materials:
        mesh.materials.append(m)

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    if subsurf > 0:
        sub = obj.modifiers.new(name='Subsurf', type='SUBSURF')
        sub.levels = subsurf
        sub.render_levels = subsurf
        bpy.ops.object.modifier_apply(modifier=sub.name)

    if shrinkwrap and target_body is not None:
        sw = obj.modifiers.new(name='Shrinkwrap', type='SHRINKWRAP')
        sw.target = target_body
        sw.wrap_method = 'NEAREST_SURFACEPOINT'
        sw.wrap_mode = 'OUTSIDE_SURFACE'
        sw.offset = wrap_offset
        bpy.ops.object.modifier_apply(modifier=sw.name)

    if thickness > 0.0:
        sol = obj.modifiers.new(name='Solidify', type='SOLIDIFY')
        sol.thickness = thickness
        sol.offset = 1.0
        sol.use_even_offset = True
        sol.use_rim = True
        bpy.ops.object.modifier_apply(modifier=sol.name)

    for p in obj.data.polygons:
        p.material_index = mat_index
        p.use_smooth = True

    obj.select_set(False)
    obj['region_tag'] = region_tag
    return obj


def make_open_cylinder_shell_bm(center, r_bot, r_top, z_bot, z_top, segs=28, rings=6, angle_start=0.0, angle_end=2.0 * math.pi, axis='z', y_scale=1.0):
    """Build an open smooth curved wrap shell (full sleeve or curved front/side shield)."""
    bm = bmesh.new()
    full_circle = abs((angle_end - angle_start) - 2.0 * math.pi) < 1e-3
    n_u = segs if full_circle else segs + 1
    grid = []
    for ri in range(rings + 1):
        t = ri / rings
        r = r_bot * (1.0 - t) + r_top * t
        pos_ax = z_bot * (1.0 - t) + z_top * t
        row = []
        for ui in range(n_u):
            frac = ui / segs
            ang = angle_start + frac * (angle_end - angle_start)
            ca, sa = math.cos(ang), math.sin(ang)
            if axis == 'z':
                co = (center[0] + ca * r, center[1] + sa * r * y_scale, pos_ax)
            elif axis == 'x':
                co = (pos_ax, center[1] + ca * r, center[2] + sa * r * y_scale)
            else:
                co = (center[0] + ca * r, pos_ax, center[2] + sa * r * y_scale)
            row.append(bm.verts.new(co))
        grid.append(row)

    for ri in range(rings):
        for ui in range(segs):
            u1 = (ui + 1) % n_u
            try:
                bm.faces.new((grid[ri][ui], grid[ri][u1], grid[ri + 1][u1], grid[ri + 1][ui]))
            except ValueError:
                pass
    return bm


def make_curved_shield_bm(center, width, height, radius, y_center_offset=0.0, facing_dir=-1.0, nx=8, nz=6):
    """Smooth rounded-corner curved chest/visor/knee shield wrapping around an arc."""
    bm = bmesh.new()
    cx, cy, cz = center
    arc_half = width / max(0.02, 2.0 * radius)
    grid = []
    for iz in range(nz + 1):
        tz = (iz / nz) * 2.0 - 1.0  # -1..1
        z = cz + tz * (height * 0.5)
        # Taper corners smoothly into an aerodynamic hex/oval shield
        row_scale = math.sqrt(max(0.18, 1.0 - 0.55 * (tz * tz)))
        row = []
        for ix in range(nx + 1):
            tx = (ix / nx) * 2.0 - 1.0
            ang = tx * arc_half * row_scale
            x = cx + math.sin(ang) * radius
            y = cy + y_center_offset + facing_dir * math.cos(ang) * radius
            row.append(bm.verts.new((x, y, z)))
        grid.append(row)
    for iz in range(nz):
        for ix in range(nx):
            bm.faces.new((grid[iz][ix], grid[iz][ix + 1], grid[iz + 1][ix + 1], grid[iz + 1][ix]))
    return bm


# ---------------------------------------------------------------------------
# 56-Bone Mixamo / Unity / Godot Standard Humanoid Armature
# ---------------------------------------------------------------------------

def get_humanoid_bone_spec(scale=1.0):
    s = scale
    specs = [
        ('Hips', None, (0.0, 0.005 * s, 0.945 * s), (0.0, 0.006 * s, 1.070 * s), True),
        ('Spine', 'Hips', (0.0, 0.006 * s, 1.070 * s), (0.0, 0.004 * s, 1.205 * s), True),
        ('Spine1', 'Spine', (0.0, 0.004 * s, 1.205 * s), (0.0, 0.000 * s, 1.345 * s), True),
        ('Spine2', 'Spine1', (0.0, 0.000 * s, 1.345 * s), (0.0, 0.000 * s, 1.460 * s), True),
        ('Neck', 'Spine2', (0.0, 0.000 * s, 1.460 * s), (0.0, -0.004 * s, 1.545 * s), True),
        ('Head', 'Neck', (0.0, -0.004 * s, 1.545 * s), (0.0, -0.012 * s, 1.720 * s), True),
    ]
    for side, sign in (('Left', 1.0), ('Right', -1.0)):
        sh_head = (sign * 0.050 * s, -0.006 * s, 1.415 * s)
        arm_head = (sign * 0.182 * s, 0.010 * s, 1.422 * s)
        elb_head = (sign * 0.455 * s, 0.022 * s, 1.418 * s)
        wri_head = (sign * 0.710 * s, 0.006 * s, 1.415 * s)
        hand_tail = (sign * 0.790 * s, 0.001 * s, 1.413 * s)

        specs.append((f'{side}Shoulder', 'Spine2', sh_head, arm_head, True))
        specs.append((f'{side}Arm', f'{side}Shoulder', arm_head, elb_head, True))
        specs.append((f'{side}ArmTwist', f'{side}Arm', (sign * 0.318 * s, 0.016 * s, 1.420 * s), (sign * 0.435 * s, 0.021 * s, 1.418 * s), True))
        specs.append((f'{side}ForeArm', f'{side}Arm', elb_head, wri_head, True))
        specs.append((f'{side}ForeArmTwist', f'{side}ForeArm', (sign * 0.585 * s, 0.014 * s, 1.416 * s), (sign * 0.695 * s, 0.007 * s, 1.415 * s), True))
        specs.append((f'{side}Hand', f'{side}ForeArm', wri_head, hand_tail, True))

        t1 = (sign * 0.730 * s, -0.020 * s, 1.405 * s)
        t2 = (sign * 0.758 * s, -0.044 * s, 1.395 * s)
        t3 = (sign * 0.782 * s, -0.060 * s, 1.389 * s)
        t4 = (sign * 0.802 * s, -0.072 * s, 1.385 * s)
        specs.append((f'{side}HandThumb1', f'{side}Hand', t1, t2, True))
        specs.append((f'{side}HandThumb2', f'{side}HandThumb1', t2, t3, True))
        specs.append((f'{side}HandThumb3', f'{side}HandThumb2', t3, t4, True))

        for fname, y_off, l1, l2, l3 in (
            ('Index', -0.027 * s, 0.036 * s, 0.024 * s, 0.020 * s),
            ('Middle', -0.009 * s, 0.040 * s, 0.026 * s, 0.021 * s),
            ('Ring', 0.009 * s, 0.036 * s, 0.024 * s, 0.020 * s),
            ('Pinky', 0.026 * s, 0.029 * s, 0.020 * s, 0.017 * s),
        ):
            x0 = 0.786 * s
            p1 = (sign * x0, y_off, 1.413 * s)
            p2 = (sign * (x0 + l1), y_off, 1.411 * s)
            p3 = (sign * (x0 + l1 + l2), y_off, 1.409 * s)
            p4 = (sign * (x0 + l1 + l2 + l3), y_off, 1.407 * s)
            specs.append((f'{side}Hand{fname}1', f'{side}Hand', p1, p2, True))
            specs.append((f'{side}Hand{fname}2', f'{side}Hand{fname}1', p2, p3, True))
            specs.append((f'{side}Hand{fname}3', f'{side}Hand{fname}2', p3, p4, True))

        hip_j = (sign * 0.095 * s, 0.004 * s, 0.895 * s)
        knee_j = (sign * 0.095 * s, -0.010 * s, 0.485 * s)
        ankle_j = (sign * 0.095 * s, 0.016 * s, 0.088 * s)
        toe_j = (sign * 0.095 * s, -0.098 * s, 0.024 * s)
        toe_tip = (sign * 0.095 * s, -0.155 * s, 0.018 * s)

        specs.append((f'{side}UpLeg', 'Hips', hip_j, knee_j, True))
        specs.append((f'{side}Leg', f'{side}UpLeg', knee_j, ankle_j, True))
        specs.append((f'{side}Foot', f'{side}Leg', ankle_j, toe_j, True))
        specs.append((f'{side}ToeBase', f'{side}Foot', toe_j, toe_tip, True))
    return specs


def build_armature(arm_name, bone_specs):
    arm_data = bpy.data.armatures.new(arm_name)
    arm_obj = bpy.data.objects.new(arm_name, arm_data)
    bpy.context.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode='EDIT')

    ebones = {}
    for name, parent_name, head, tail, deform in bone_specs:
        eb = arm_data.edit_bones.new(name)
        eb.head = Vector(head)
        eb.tail = Vector(tail)
        eb.roll = 0.0
        eb.use_deform = deform
        if parent_name and parent_name in ebones:
            eb.parent = ebones[parent_name]
            eb.use_connect = False
        ebones[name] = eb

    bpy.ops.object.mode_set(mode='OBJECT')
    return arm_obj


# ---------------------------------------------------------------------------
# Region-Scoped Anatomical Skinning + Topology Laplacian Smoothing
# ---------------------------------------------------------------------------

def point_to_segment_dist_and_t(pt, a, b):
    ab = b - a
    l2 = ab.length_squared
    if l2 < 1e-10:
        return (pt - a).length, 0.0
    t = max(0.0, min(1.0, (pt - a).dot(ab) / l2))
    return (pt - (a + ab * t)).length, t


def classify_body_vertex_bones(co, scale):
    s = scale
    x, z = co.x, co.z
    if z > 1.525 * s:
        return ['Head', 'Neck']
    if z > 1.445 * s and abs(x) < 0.095 * s:
        return ['Spine2', 'Neck', 'Head']
    if z > 1.24 * s and x > 0.215 * s:
        return ['LeftArm', 'LeftArmTwist', 'LeftForeArm', 'LeftForeArmTwist', 'LeftHand']
    if z > 1.24 * s and x < -0.215 * s:
        return ['RightArm', 'RightArmTwist', 'RightForeArm', 'RightForeArmTwist', 'RightHand']
    if z > 1.24 * s and x > 0.135 * s:
        return ['Spine2', 'LeftShoulder', 'LeftArm']
    if z > 1.24 * s and x < -0.135 * s:
        return ['Spine2', 'RightShoulder', 'RightArm']
    if z < 0.855 * s:
        side = 'Left' if x >= 0.0 else 'Right'
        if z < 0.135 * s:
            return [f'{side}Leg', f'{side}Foot', f'{side}ToeBase']
        return ['Hips', f'{side}UpLeg', f'{side}Leg', f'{side}Foot']
    if z < 1.00 * s:
        if x > 0.03 * s:
            return ['Hips', 'Spine', 'LeftUpLeg']
        if x < -0.03 * s:
            return ['Hips', 'Spine', 'RightUpLeg']
        return ['Hips', 'Spine']
    return ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'LeftShoulder', 'RightShoulder']


def classify_hand_vertex_bones(co, side, scale):
    s = scale
    ax, y = abs(co.x), co.y
    if ax < 0.715 * s:
        return [f'{side}ForeArm', f'{side}ForeArmTwist', f'{side}Hand']
    if y < -0.020 * s and ax < 0.812 * s and co.z < 1.408 * s:
        return [f'{side}Hand', f'{side}HandThumb1', f'{side}HandThumb2', f'{side}HandThumb3']
    if ax < 0.782 * s:
        return [f'{side}Hand', f'{side}ForeArmTwist']
    if y < -0.018 * s:
        fname = 'Index'
    elif y < 0.000 * s:
        fname = 'Middle'
    elif y < 0.018 * s:
        fname = 'Ring'
    else:
        fname = 'Pinky'
    return [f'{side}Hand', f'{side}Hand{fname}1', f'{side}Hand{fname}2', f'{side}Hand{fname}3']


def assign_weights_to_part(mesh_obj, bone_specs, scale=1.0, region_tag='body', smooth_iters=4, sharpness=4.5):
    mesh = mesh_obj.data
    bone_segs = {
        name: (Vector(head), Vector(tail))
        for name, _p, head, tail, deform in bone_specs
        if deform
    }
    fixed_map = {
        'head_rigid': ['Head'],
        'chest_plate': ['Spine1', 'Spine2'],
        'pelvis_plate': ['Hips', 'Spine'],
        'left_shoulder_plate': ['LeftShoulder', 'LeftArm'],
        'right_shoulder_plate': ['RightShoulder', 'RightArm'],
        'left_upperarm_plate': ['LeftArm', 'LeftArmTwist'],
        'right_upperarm_plate': ['RightArm', 'RightArmTwist'],
        'left_forearm_plate': ['LeftForeArm', 'LeftForeArmTwist'],
        'right_forearm_plate': ['RightForeArm', 'RightForeArmTwist'],
        'left_thigh_plate': ['LeftUpLeg'],
        'right_thigh_plate': ['RightUpLeg'],
        'left_knee_plate': ['LeftUpLeg', 'LeftLeg'],
        'right_knee_plate': ['RightUpLeg', 'RightLeg'],
        'left_shin_plate': ['LeftLeg'],
        'right_shin_plate': ['RightLeg'],
        'left_foot_plate': ['LeftLeg', 'LeftFoot', 'LeftToeBase'],
        'right_foot_plate': ['RightLeg', 'RightFoot', 'RightToeBase'],
    }
    n_verts = len(mesh.vertices)
    if region_tag in fixed_map and len(fixed_map[region_tag]) == 1:
        vg = mesh_obj.vertex_groups.new(name=fixed_map[region_tag][0])
        vg.add(list(range(n_verts)), 1.0, 'REPLACE')
        return

    weights = [None] * n_verts
    used_bones = set()
    for vi, v in enumerate(mesh.vertices):
        co = v.co
        if region_tag in fixed_map:
            cand = fixed_map[region_tag]
        elif region_tag == 'left_hand':
            cand = classify_hand_vertex_bones(co, 'Left', scale)
        elif region_tag == 'right_hand':
            cand = classify_hand_vertex_bones(co, 'Right', scale)
        else:
            cand = classify_body_vertex_bones(co, scale)

        scores = []
        for bname in cand:
            if bname not in bone_segs:
                continue
            a, b = bone_segs[bname]
            dist, t = point_to_segment_dist_and_t(co, a, b)
            span_f = 0.88 if 0.04 < t < 0.96 else 1.14
            if 'Twist' in bname:
                span_f *= 1.10
            if bname.endswith('ToeBase') and co.y > -0.068 * scale:
                span_f *= 3.8
            if bname.endswith('Leg') and co.z < 0.072 * scale:
                span_f *= 4.0
            eff_d = max(0.004 * scale, dist * span_f)
            scores.append((bname, 1.0 / (eff_d ** sharpness)))

        scores.sort(key=lambda item: item[1], reverse=True)
        top = scores[:4]
        tot = sum(w for _, w in top) or 1.0
        wdict = {bn: w / tot for bn, w in top}
        weights[vi] = wdict
        used_bones.update(wdict.keys())

    if smooth_iters > 0 and len(mesh.edges) > 0:
        adj = [[] for _ in range(n_verts)]
        for e in mesh.edges:
            u, wv = e.vertices[0], e.vertices[1]
            if mesh.vertices[u].co.z < 0.86 * scale and (mesh.vertices[u].co.x * mesh.vertices[wv].co.x < 0):
                continue
            adj[u].append(wv)
            adj[wv].append(u)
        alpha = 0.42
        for _ in range(smooth_iters):
            nxt = [None] * n_verts
            for vi in range(n_verts):
                nbs = adj[vi]
                if not nbs:
                    nxt[vi] = weights[vi]
                    continue
                acc = {}
                for bn, w in weights[vi].items():
                    acc[bn] = acc.get(bn, 0.0) + w * (1.0 - alpha)
                inv_n = alpha / len(nbs)
                for nb in nbs:
                    for bn, w in weights[nb].items():
                        acc[bn] = acc.get(bn, 0.0) + w * inv_n
                top = sorted(acc.items(), key=lambda it: it[1], reverse=True)[:4]
                tot = sum(w for _, w in top) or 1.0
                pruned = {bn: w / tot for bn, w in top if w / tot >= 0.006}
                tot2 = sum(pruned.values()) or 1.0
                nxt[vi] = {bn: w / tot2 for bn, w in pruned.items()}
                used_bones.update(nxt[vi].keys())
            weights = nxt

    vg_map = {bn: (mesh_obj.vertex_groups.get(bn) or mesh_obj.vertex_groups.new(name=bn)) for bn in used_bones}
    for vi, wdict in enumerate(weights):
        for bn, val in wdict.items():
            if val > 1e-4:
                vg_map[bn].add([vi], val, 'REPLACE')


def join_and_bind(parts, arm_obj, final_name, bone_specs, scale=1.0):
    valid_parts = [p for p in parts if p is not None and len(p.data.vertices) > 0]
    for obj in valid_parts:
        tag = obj.get('region_tag', 'body')
        sm_it = 1 if ('plate' in tag or 'rigid' in tag) else 4
        sharp = 5.5 if ('plate' in tag or 'hand' in tag) else 4.2
        assign_weights_to_part(obj, bone_specs, scale=scale, region_tag=tag, smooth_iters=sm_it, sharpness=sharp)

    bpy.ops.object.select_all(action='DESELECT')
    for obj in valid_parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = valid_parts[0]
    bpy.ops.object.join()

    joined = bpy.context.view_layer.objects.active
    joined.name = final_name
    joined.data.name = f'{final_name}_Mesh'

    for name, _p, _h, _t, deform in bone_specs:
        if deform and name not in joined.vertex_groups:
            joined.vertex_groups.new(name=name)

    joined.parent = arm_obj
    mod = joined.modifiers.new(name='Armature', type='ARMATURE')
    mod.object = arm_obj
    mod.use_vertex_groups = True
    return joined


# ---------------------------------------------------------------------------
# ARKit Core Facial Shape Keys
# ---------------------------------------------------------------------------

def add_arkit_shape_keys(mesh_obj, scale=1.0):
    mesh = mesh_obj.data
    s = scale
    mesh_obj.shape_key_add(name='Basis', from_mix=False)

    mouth_c = Vector((0.0, -0.082 * s, 1.576 * s))
    jaw_c = Vector((0.0, -0.060 * s, 1.552 * s))
    eye_l = Vector((0.032 * s, -0.078 * s, 1.630 * s))
    eye_r = Vector((-0.032 * s, -0.078 * s, 1.630 * s))
    brow_c = Vector((0.0, -0.080 * s, 1.652 * s))
    cheek_l = Vector((0.052 * s, -0.062 * s, 1.604 * s))
    cheek_r = Vector((-0.052 * s, -0.062 * s, 1.604 * s))

    def gauss(dist, radius):
        r = dist / max(1e-5, radius)
        return math.exp(-r * r * 2.2)

    for kname in ('jawOpen', 'eyeBlinkLeft', 'eyeBlinkRight', 'mouthSmileLeft', 'mouthSmileRight', 'browInnerUp', 'mouthFunnel', 'cheekPuff'):
        sk = mesh_obj.shape_key_add(name=kname, from_mix=False)
        for i, v in enumerate(mesh.vertices):
            co = v.co
            if co.z < 1.52 * s or co.y > -0.015 * s:
                continue
            d = Vector((0.0, 0.0, 0.0))
            if kname == 'jawOpen' and co.z < 1.584 * s:
                w = gauss((co - jaw_c).length, 0.048 * s)
                d.z -= 0.016 * s * w
                d.y += 0.004 * s * w
            elif kname == 'eyeBlinkLeft':
                w = gauss((co - eye_l).length, 0.022 * s)
                d.z += (-0.007 if co.z >= eye_l.z else 0.004) * s * w
            elif kname == 'eyeBlinkRight':
                w = gauss((co - eye_r).length, 0.022 * s)
                d.z += (-0.007 if co.z >= eye_r.z else 0.004) * s * w
            elif kname == 'mouthSmileLeft':
                w = gauss((co - Vector((0.026 * s, -0.080 * s, 1.576 * s))).length, 0.028 * s)
                d += Vector((0.005, 0.003, 0.007)) * s * w
            elif kname == 'mouthSmileRight':
                w = gauss((co - Vector((-0.026 * s, -0.080 * s, 1.576 * s))).length, 0.028 * s)
                d += Vector((-0.005, 0.003, 0.007)) * s * w
            elif kname == 'browInnerUp':
                w = gauss((co - brow_c).length, 0.032 * s)
                d.z += 0.008 * s * w
            elif kname == 'mouthFunnel':
                w = gauss((co - mouth_c).length, 0.026 * s)
                d.y -= 0.008 * s * w
                d.x -= co.x * 0.16 * w
            elif kname == 'cheekPuff':
                wl = gauss((co - cheek_l).length, 0.036 * s)
                wr = gauss((co - cheek_r).length, 0.036 * s)
                d.x += (0.010 * wl - 0.010 * wr) * s
                d.y -= 0.006 * (wl + wr) * s
            if d.length_squared > 1e-12:
                sk.data[i].co = co + d


# ---------------------------------------------------------------------------
# World-Space Delta Keyframing (Natural Walk & Idle Clips)
# ---------------------------------------------------------------------------

def set_pose_world_rot(arm_obj, bone_name, world_euler_deg, frame):
    pb = arm_obj.pose.bones.get(bone_name)
    if not pb:
        return
    pb.rotation_mode = 'QUATERNION'
    rx, ry, rz = (math.radians(a) for a in world_euler_deg)
    q_world = Euler((rx, ry, rz), 'XYZ').to_quaternion()
    rest_rot = pb.bone.matrix_local.to_3x3().to_quaternion()
    pb.rotation_quaternion = rest_rot.inverted() @ q_world @ rest_rot
    pb.keyframe_insert(data_path='rotation_quaternion', frame=frame)


def set_pose_world_loc(arm_obj, bone_name, world_delta_xyz, frame):
    pb = arm_obj.pose.bones.get(bone_name)
    if not pb:
        return
    pb.location = pb.bone.matrix_local.to_3x3().inverted() @ Vector(world_delta_xyz)
    pb.keyframe_insert(data_path='location', frame=frame)


def reset_pose(arm_obj):
    for pb in arm_obj.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Quaternion((1.0, 0.0, 0.0, 0.0))
        pb.location = (0.0, 0.0, 0.0)
        pb.scale = (1.0, 1.0, 1.0)


def create_walk_action(arm_obj, name='Walk', n_frames=30):
    act = bpy.data.actions.new(name=name)
    if not arm_obj.animation_data:
        arm_obj.animation_data_create()
    arm_obj.animation_data.action = act
    reset_pose(arm_obj)

    for f in range(0, n_frames + 1, 2):
        t = (f / n_frames) * 2.0 * math.pi
        s1, c1 = math.sin(t), math.cos(t)

        set_pose_world_loc(arm_obj, 'Hips', (0.012 * s1, 0.0, 0.022 * abs(s1) - 0.014), f + 1)
        set_pose_world_rot(arm_obj, 'Hips', (-2.5, 2.2 * s1, 6.0 * c1), f + 1)
        set_pose_world_rot(arm_obj, 'Spine', (-1.5, -1.2 * s1, -3.5 * c1), f + 1)
        set_pose_world_rot(arm_obj, 'Spine1', (-1.0, -1.0 * s1, -3.5 * c1), f + 1)
        set_pose_world_rot(arm_obj, 'Spine2', (-0.5, 0.0, -2.5 * c1), f + 1)
        set_pose_world_rot(arm_obj, 'Neck', (1.5, 0.0, 2.0 * c1), f + 1)
        set_pose_world_rot(arm_obj, 'Head', (2.0, 0.0, 2.5 * c1), f + 1)

        l_hip, r_hip = -26.0 * s1, 26.0 * s1
        l_knee = max(4.0, 44.0 * max(0.0, -c1) + 10.0 * max(0.0, -s1))
        r_knee = max(4.0, 44.0 * max(0.0, c1) + 10.0 * max(0.0, s1))
        set_pose_world_rot(arm_obj, 'LeftUpLeg', (l_hip, 0.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'LeftLeg', (l_knee, 0.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'LeftFoot', (10.0 * s1 - 8.0 * max(0.0, -c1), 0.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'RightUpLeg', (r_hip, 0.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'RightLeg', (r_knee, 0.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'RightFoot', (-10.0 * s1 - 8.0 * max(0.0, c1), 0.0, 0.0), f + 1)

        l_fwd, r_fwd = -22.0 * s1, 22.0 * s1
        set_pose_world_rot(arm_obj, 'LeftShoulder', (0.0, 5.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'RightShoulder', (0.0, -5.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'LeftArm', (-l_fwd, 74.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'RightArm', (-r_fwd, -74.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'LeftForeArm', (-18.0 - 12.0 * max(0.0, -s1), 0.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'RightForeArm', (-18.0 - 12.0 * max(0.0, s1), 0.0, 0.0), f + 1)

    track = arm_obj.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, act)
    strip.name = name
    arm_obj.animation_data.action = None
    reset_pose(arm_obj)
    return act


def create_idle_action(arm_obj, name='Idle', n_frames=60):
    act = bpy.data.actions.new(name=name)
    if not arm_obj.animation_data:
        arm_obj.animation_data_create()
    arm_obj.animation_data.action = act
    reset_pose(arm_obj)

    for f in range(0, n_frames + 1, 5):
        t = (f / n_frames) * 2.0 * math.pi
        br, sw = math.sin(t), math.sin(t * 0.5)
        set_pose_world_loc(arm_obj, 'Hips', (0.008 * sw, 0.0, 0.004 * br), f + 1)
        set_pose_world_rot(arm_obj, 'Hips', (0.0, 1.2 * sw, 1.5 * sw), f + 1)
        set_pose_world_rot(arm_obj, 'Spine', (-1.0 * br, 0.0, -1.0 * sw), f + 1)
        set_pose_world_rot(arm_obj, 'Spine2', (-1.5 * br, 0.0, -1.0 * sw), f + 1)
        set_pose_world_rot(arm_obj, 'Head', (1.2 * br, 1.5 * sw, 2.0 * sw), f + 1)
        set_pose_world_rot(arm_obj, 'LeftShoulder', (0.0, 5.0 - 1.2 * br, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'RightShoulder', (0.0, -5.0 + 1.2 * br, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'LeftArm', (-4.0, 72.0 - 1.5 * br, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'RightArm', (-4.0, -72.0 + 1.5 * br, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'LeftForeArm', (-14.0, 0.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'RightForeArm', (-14.0, 0.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'LeftUpLeg', (-2.0, -2.5, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'RightUpLeg', (-2.0, 2.5, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'LeftLeg', (4.0, 0.0, 0.0), f + 1)
        set_pose_world_rot(arm_obj, 'RightLeg', (4.0, 0.0, 0.0), f + 1)

    track = arm_obj.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, act)
    strip.name = name
    arm_obj.animation_data.action = None
    reset_pose(arm_obj)
    return act


# ---------------------------------------------------------------------------
# CHARACTER 1: Studio Sculpt Humanoid -> models/Mannequin_CC0.glb (1.72 m)
# ---------------------------------------------------------------------------

def build_studio_athlete_character():
    reset_scene()
    s = 1.0
    bone_specs = get_humanoid_bone_spec(scale=s)
    arm_obj = build_armature('Armature', bone_specs)

    mat_alabaster = make_material('Studio_Alabaster', (0.85, 0.80, 0.75), metallic=0.02, roughness=0.34, coat=0.14)
    mat_suit = make_material('Athlete_Graphite', (0.068, 0.080, 0.105), metallic=0.08, roughness=0.50, coat=0.08, sheen=0.28)
    mat_yoke = make_material('Athlete_SlateVest', (0.15, 0.175, 0.215), metallic=0.22, roughness=0.38, coat=0.18)
    mat_amber = make_material('Hunger_Amber', (0.95, 0.44, 0.06), metallic=0.35, roughness=0.24, coat=0.45)
    mat_hair = make_material('Studio_Hair', (0.048, 0.040, 0.036), metallic=0.04, roughness=0.34, coat=0.22)
    mat_sole = make_material('Trainer_Midsole', (0.90, 0.91, 0.94), metallic=0.0, roughness=0.40)
    mat_shoe = make_material('Trainer_Upper', (0.10, 0.115, 0.145), metallic=0.06, roughness=0.46)

    mats = [mat_alabaster, mat_suit, mat_yoke, mat_amber, mat_hair, mat_sole, mat_shoe]

    # Laser-straight horizontal bisect planes for crisp collar, waist, cuff, ankle, and sneaker sole cuts!
    cuts = [
        ((0, 0, 1.466 * s), (0, 0, 1)),   # neck / collar cut
        ((0, 0, 1.028 * s), (0, 0, 1)),   # waist seam
        ((0, 0, 0.098 * s), (0, 0, 1)),   # sneaker ankle collar
        ((0, 0, 0.026 * s), (0, 0, 1)),   # crisp white sneaker midsole line!
    ]
    body_obj = build_clean_anatomical_body(
        'Athlete_SculptBody',
        scale=s,
        athletic_width=1.0,
        voxel_size=0.0072,
        target_faces=14000,
        bisect_planes=cuts,
    )
    for m in mats:
        body_obj.data.materials.append(m)

    for poly in body_obj.data.polygons:
        c = poly.center
        ax = abs(c.x)
        if c.z > 1.466 * s and ax < 0.12 * s:
            poly.material_index = 0  # Smooth sculpted porcelain head & neck
        elif c.z < 0.026 * s:
            poly.material_index = 5  # Crisp white trainer sole
        elif c.z < 0.098 * s:
            poly.material_index = 6  # Dark graphite trainer upper
        else:
            poly.material_index = 1  # Seamless matte graphite athletic suit
    body_obj['region_tag'] = 'body'

    parts = [body_obj]

    # Razor-clean shrinkwrapped athletic tech-vest (zero armpit triangle jag!)
    bm_vest = make_open_cylinder_shell_bm((0, -0.003 * s, 0), 0.145 * s, 0.178 * s, 1.040 * s, 1.448 * s, segs=32, rings=6, y_scale=0.72)
    vest_obj = build_shrinkwrapped_shell(body_obj, 'Athlete_TechVest', bm_vest, mats, mat_index=2, subsurf=1, wrap_offset=0.0012, thickness=0.004 * s, region_tag='chest_plate')
    parts.append(vest_obj)

    # Razor-clean sculpted modern swept hair cap (smooth quad dome shrinkwrapped onto cranium!)
    bm_hair = bmesh.new()
    hair_rings = [
        (0.0, 0.026 * s, 1.590 * s, 0.077 * s, 0.020 * s, 0.078 * s, 2.0),
        (0.0, 0.014 * s, 1.630 * s, 0.082 * s, 0.056 * s, 0.095 * s, 2.0),
        (0.0, 0.002 * s, 1.668 * s, 0.084 * s, 0.094 * s, 0.102 * s, 2.0),
        (0.0, -0.004 * s, 1.698 * s, 0.080 * s, 0.096 * s, 0.098 * s, 2.0),
        (0.0, 0.004 * s, 1.724 * s, 0.060 * s, 0.072 * s, 0.078 * s, 2.0),
        (0.0, 0.010 * s, 1.738 * s, 0.026 * s, 0.032 * s, 0.036 * s, 2.0),
    ]
    add_loft(bm_hair, hair_rings, segs=28, axis='z')
    parts.append(build_shrinkwrapped_shell(body_obj, 'Athlete_Hair', bm_hair, mats, mat_index=4, subsurf=1, wrap_offset=0.0, thickness=0.0, region_tag='head_rigid', shrinkwrap=False))

    # Razor-clean Collar Ring + Waistband Trim + Chest Emblem (shrinkwrapped smooth quad shells!)
    bm_collar = make_open_cylinder_shell_bm((0, 0.0, 0), 0.072 * s, 0.062 * s, 1.452 * s, 1.490 * s, segs=28, rings=3)
    parts.append(build_shrinkwrapped_shell(body_obj, 'Athlete_Collar', bm_collar, mats, mat_index=2, subsurf=1, wrap_offset=0.001, thickness=0.005 * s, region_tag='body'))

    bm_belt = make_open_cylinder_shell_bm((0, 0.004 * s, 0), 0.135 * s, 0.132 * s, 1.016 * s, 1.044 * s, segs=32, rings=2, y_scale=0.75)
    parts.append(build_shrinkwrapped_shell(body_obj, 'Athlete_WaistTrim', bm_belt, mats, mat_index=3, subsurf=1, wrap_offset=0.001, thickness=0.004 * s, region_tag='pelvis_plate'))

    bm_emblem = make_curved_shield_bm((0, 0.010 * s, 1.330 * s), width=0.14 * s, height=0.032 * s, radius=0.135 * s, nx=10, nz=3)
    parts.append(build_shrinkwrapped_shell(vest_obj, 'Athlete_ChestStripe', bm_emblem, mats, mat_index=3, subsurf=1, wrap_offset=0.0018, thickness=0.0035 * s, region_tag='chest_plate'))

    for side, sign in (('Left', 1.0), ('Right', -1.0)):
        low = side.lower()
        lx = sign * 0.095 * s

        # Razor-clean Forearm Amber Band
        x_a, x_b = (0.560 * s, 0.592 * s) if sign > 0 else (-0.592 * s, -0.560 * s)
        bm_fband = make_open_cylinder_shell_bm((0, 0.015 * s, 1.416 * s), 0.044 * s, 0.042 * s, x_a, x_b, segs=24, rings=2, axis='x')
        parts.append(build_shrinkwrapped_shell(body_obj, f'Athlete_{side}ArmBand', bm_fband, mats, mat_index=3, subsurf=1, wrap_offset=0.001, thickness=0.0035 * s, region_tag=f'{low}_forearm_plate'))

        # Razor-clean Sculpted Knee Pad
        bm_kpad = make_curved_shield_bm((lx, 0.012 * s, 0.492 * s), width=0.072 * s, height=0.076 * s, radius=0.072 * s, nx=8, nz=6)
        parts.append(build_shrinkwrapped_shell(body_obj, f'Athlete_{side}KneePad', bm_kpad, mats, mat_index=2, subsurf=1, wrap_offset=0.0015, thickness=0.005 * s, region_tag=f'{low}_knee_plate'))

        # Razor-clean Outer-Thigh Amber Accent Strip
        ang_c = 0.0 if sign > 0 else math.pi
        bm_tstrip = make_open_cylinder_shell_bm((lx, 0.0, 0), 0.088 * s, 0.094 * s, 0.590 * s, 0.785 * s, segs=8, rings=6, angle_start=ang_c - 0.16, angle_end=ang_c + 0.16)
        parts.append(build_shrinkwrapped_shell(body_obj, f'Athlete_{side}ThighStripe', bm_tstrip, mats, mat_index=3, subsurf=1, wrap_offset=0.001, thickness=0.0035 * s, region_tag=f'{low}_thigh_plate'))

        # Articulated 5-Finger Sculpted Hands
        hand_obj = build_sculpted_hand_object(f'Athlete_{side}Hand', sign, scale=s)
        for m in mats:
            hand_obj.data.materials.append(m)
        for p in hand_obj.data.polygons:
            p.material_index = 0
        hand_obj['region_tag'] = f'{low}_hand'
        parts.append(hand_obj)

    char_mesh = join_and_bind(parts, arm_obj, 'Mannequin_CC0_Body', bone_specs, scale=s)
    add_arkit_shape_keys(char_mesh, scale=s)

    create_idle_action(arm_obj, 'IdleDance', n_frames=60)
    create_walk_action(arm_obj, 'Walk', n_frames=30)
    return arm_obj, char_mesh


# ---------------------------------------------------------------------------
# CHARACTER 2: Autonomous Cyber Droid -> models/Bot_CC0.glb (1.76 m)
# ---------------------------------------------------------------------------

def build_cyber_droid_character():
    reset_scene()
    s = 1.76 / 1.72
    bone_specs = get_humanoid_bone_spec(scale=s)
    arm_obj = build_armature('Armature', bone_specs)

    mat_carbon = make_material('Droid_CarbonExo', (0.032, 0.038, 0.048), metallic=0.45, roughness=0.46)
    mat_ceramic = make_material('Droid_PearlCeramic', (0.86, 0.89, 0.93), metallic=0.08, roughness=0.18, coat=0.72)
    mat_titanium = make_material('Droid_Titanium', (0.28, 0.32, 0.38), metallic=0.88, roughness=0.26)
    mat_gunmetal = make_material('Droid_Gunmetal', (0.11, 0.13, 0.17), metallic=0.84, roughness=0.32)
    mat_visor = make_material('Droid_VisorGlass', (0.012, 0.032, 0.055), metallic=0.25, roughness=0.04, coat=1.0)
    mat_cyan = make_material(
        'Droid_CyanEnergy',
        (0.05, 0.86, 1.0),
        metallic=0.10,
        roughness=0.14,
        emission=(0.04, 0.84, 1.0),
        emission_strength=3.0,
    )
    mat_amber = make_material(
        'Droid_AmberTrim',
        (0.96, 0.48, 0.06),
        metallic=0.30,
        roughness=0.24,
        emission=(0.95, 0.44, 0.05),
        emission_strength=1.2,
    )

    mats = [mat_carbon, mat_ceramic, mat_titanium, mat_gunmetal, mat_visor, mat_cyan, mat_amber]

    # Laser-straight cuts for inner mechanical joints
    cuts = [
        ((0, 0, 1.545 * s), (0, 0, 1)),
        ((0, 0, 1.460 * s), (0, 0, 1)),
        ((0, 0, 1.135 * s), (0, 0, 1)),
        ((0, 0, 1.005 * s), (0, 0, 1)),
        ((0, 0, 0.530 * s), (0, 0, 1)),
        ((0, 0, 0.445 * s), (0, 0, 1)),
        ((0, 0, 0.115 * s), (0, 0, 1)),
        ((0, 0, 0.024 * s), (0, 0, 1)),
    ]
    body_obj = build_clean_anatomical_body(
        'Droid_ExoBody',
        scale=s,
        athletic_width=1.04,
        voxel_size=0.0074,
        target_faces=13000,
        bisect_planes=cuts,
    )
    for m in mats:
        body_obj.data.materials.append(m)

    for poly in body_obj.data.polygons:
        c = poly.center
        ax = abs(c.x)
        if c.z > 1.545 * s:
            poly.material_index = 2  # Titanium inner skull
        elif (1.460 * s <= c.z <= 1.545 * s and ax < 0.095 * s) or (1.005 * s <= c.z <= 1.135 * s) or (0.445 * s <= c.z <= 0.530 * s):
            poly.material_index = 3  # Gunmetal mechanical joints
        elif c.z < 0.024 * s:
            poly.material_index = 3  # Armored outsole
        elif c.z < 0.115 * s:
            poly.material_index = 1  # Pearl ceramic armored boot
        else:
            poly.material_index = 0  # Carbon exo-frame
    body_obj['region_tag'] = 'body'

    parts = [body_obj]

    # 1. Razor-Clean Aerodynamic Ceramic Helmet + Curved Glass Visor + Glowing Cyan Optic Strip
    bm_helm = bmesh.new()
    helm_rings = [
        (0.0, -0.022 * s, 1.546 * s, 0.048 * s, 0.066 * s, 0.048 * s, 2.2),
        (0.0, -0.012 * s, 1.586 * s, 0.072 * s, 0.088 * s, 0.078 * s, 2.25),
        (0.0, -0.006 * s, 1.630 * s, 0.083 * s, 0.096 * s, 0.098 * s, 2.25),
        (0.0, -0.002 * s, 1.674 * s, 0.085 * s, 0.096 * s, 0.105 * s, 2.2),
        (0.0, 0.005 * s, 1.708 * s, 0.070 * s, 0.078 * s, 0.090 * s, 2.1),
        (0.0, 0.010 * s, 1.730 * s, 0.036 * s, 0.040 * s, 0.048 * s, 2.0),
    ]
    add_loft(bm_helm, helm_rings, segs=32, axis='z')
    # Side Titanium Audio Pods
    for sign in (1.0, -1.0):
        add_ellipsoid(bm_helm, (sign * 0.086 * s, 0.002 * s, 1.628 * s), (0.014 * s, 0.025 * s, 0.028 * s))
    helm_obj = build_shrinkwrapped_shell(body_obj, 'Droid_Helmet', bm_helm, mats, mat_index=1, subsurf=1, wrap_offset=0.0, thickness=0.0, region_tag='head_rigid', shrinkwrap=False)
    parts.append(helm_obj)

    # Curved Wrap-Around Dark Glass Visor & Razor-Crisp Glowing Cyan Optic Bar (shrinkwrapped cleanly onto helmet!)
    bm_visor = make_curved_shield_bm((0, -0.002 * s, 1.632 * s), width=0.155 * s, height=0.056 * s, radius=0.098 * s, nx=14, nz=4)
    visor_obj = build_shrinkwrapped_shell(helm_obj, 'Droid_Visor', bm_visor, mats, mat_index=4, subsurf=1, wrap_offset=0.0018, thickness=0.004 * s, region_tag='head_rigid')
    parts.append(visor_obj)

    bm_optic = make_curved_shield_bm((0, -0.002 * s, 1.634 * s), width=0.118 * s, height=0.013 * s, radius=0.104 * s, nx=12, nz=2)
    parts.append(build_shrinkwrapped_shell(visor_obj, 'Droid_CyanOptic', bm_optic, mats, mat_index=5, subsurf=1, wrap_offset=0.0018, thickness=0.003 * s, region_tag='head_rigid'))

    # 2. Razor-Clean Contoured Ceramic Chest Carapace + Back Pack + Cyan Core + Pelvis Belt
    bm_chest = make_open_cylinder_shell_bm((0, -0.003 * s, 0), 0.156 * s, 0.186 * s, 1.158 * s, 1.430 * s, segs=32, rings=6, y_scale=0.72)
    chest_obj = build_shrinkwrapped_shell(body_obj, 'Droid_ChestArmor', bm_chest, mats, mat_index=1, subsurf=1, wrap_offset=0.002, thickness=0.0085 * s, region_tag='chest_plate')
    parts.append(chest_obj)

    bm_core_ring = make_curved_shield_bm((0, -0.004 * s, 1.338 * s), width=0.064 * s, height=0.052 * s, radius=0.132 * s, nx=8, nz=4)
    parts.append(build_shrinkwrapped_shell(chest_obj, 'Droid_ChestCoreHousing', bm_core_ring, mats, mat_index=2, subsurf=1, wrap_offset=0.0015, thickness=0.005 * s, region_tag='chest_plate'))

    bm_core_glow = make_curved_shield_bm((0, -0.004 * s, 1.338 * s), width=0.036 * s, height=0.030 * s, radius=0.138 * s, nx=8, nz=4)
    parts.append(build_shrinkwrapped_shell(chest_obj, 'Droid_ChestCoreGlow', bm_core_glow, mats, mat_index=5, subsurf=1, wrap_offset=0.006, thickness=0.003 * s, region_tag='chest_plate'))

    bm_pelvis = make_open_cylinder_shell_bm((0, 0.005 * s, 0), 0.155 * s, 0.148 * s, 0.878 * s, 0.996 * s, segs=32, rings=4, y_scale=0.76)
    parts.append(build_shrinkwrapped_shell(body_obj, 'Droid_PelvisArmor', bm_pelvis, mats, mat_index=1, subsurf=1, wrap_offset=0.002, thickness=0.008 * s, region_tag='pelvis_plate'))

    # 3. Side-Symmetric Razor-Clean Contoured Limb Armor Shells + Articulated 5-Finger Hands
    for side, sign in (('Left', 1.0), ('Right', -1.0)):
        low = side.lower()
        lx = sign * 0.095 * s

        # Ergonomic Shoulder Pauldron (curved smooth cap hugging deltoid)
        xa, xb = (0.165 * s, 0.280 * s) if sign > 0 else (-0.280 * s, -0.165 * s)
        bm_pauld = make_open_cylinder_shell_bm((0, 0.010 * s, 1.422 * s), 0.068 * s, 0.058 * s, xa, xb, segs=24, rings=4, axis='x')
        parts.append(build_shrinkwrapped_shell(body_obj, f'Droid_{side}Pauldron', bm_pauld, mats, mat_index=1, subsurf=1, wrap_offset=0.0025, thickness=0.0085 * s, region_tag=f'{low}_shoulder_plate'))

        # Titanium Upper-Arm Sleeve
        xa, xb = (0.295 * s, 0.415 * s) if sign > 0 else (-0.415 * s, -0.295 * s)
        bm_uarm = make_open_cylinder_shell_bm((0, 0.015 * s, 1.420 * s), 0.054 * s, 0.046 * s, xa, xb, segs=22, rings=3, axis='x')
        parts.append(build_shrinkwrapped_shell(body_obj, f'Droid_{side}UpperArmShell', bm_uarm, mats, mat_index=2, subsurf=1, wrap_offset=0.0015, thickness=0.006 * s, region_tag=f'{low}_upperarm_plate'))

        # Ceramic Forearm Gauntlet + Cyan Strip
        xa, xb = (0.495 * s, 0.680 * s) if sign > 0 else (-0.680 * s, -0.495 * s)
        bm_gaunt = make_open_cylinder_shell_bm((0, 0.014 * s, 1.416 * s), 0.046 * s, 0.032 * s, xa, xb, segs=24, rings=4, axis='x')
        gaunt_obj = build_shrinkwrapped_shell(body_obj, f'Droid_{side}Gauntlet', bm_gaunt, mats, mat_index=1, subsurf=1, wrap_offset=0.002, thickness=0.0075 * s, region_tag=f'{low}_forearm_plate')
        parts.append(gaunt_obj)

        # Contoured Ceramic Thigh Armor
        bm_thigh = make_open_cylinder_shell_bm((lx, 0.0, 0), 0.072 * s, 0.090 * s, 0.555 * s, 0.830 * s, segs=26, rings=5)
        parts.append(build_shrinkwrapped_shell(body_obj, f'Droid_{side}ThighArmor', bm_thigh, mats, mat_index=1, subsurf=1, wrap_offset=0.002, thickness=0.008 * s, region_tag=f'{low}_thigh_plate'))

        # Titanium Knee Guard Shield
        bm_knee = make_curved_shield_bm((lx, 0.012 * s, 0.490 * s), width=0.078 * s, height=0.082 * s, radius=0.074 * s, nx=8, nz=6)
        parts.append(build_shrinkwrapped_shell(body_obj, f'Droid_{side}KneeGuard', bm_knee, mats, mat_index=2, subsurf=1, wrap_offset=0.0025, thickness=0.0075 * s, region_tag=f'{low}_knee_plate'))

        # Contoured Ceramic Shin Greave + Glowing Cyan Front Telemetry Strip
        bm_shin = make_open_cylinder_shell_bm((lx, 0.010 * s, 0), 0.046 * s, 0.062 * s, 0.145 * s, 0.425 * s, segs=26, rings=5)
        shin_obj = build_shrinkwrapped_shell(body_obj, f'Droid_{side}ShinGreave', bm_shin, mats, mat_index=1, subsurf=1, wrap_offset=0.002, thickness=0.008 * s, region_tag=f'{low}_shin_plate')
        parts.append(shin_obj)

        bm_scyan = make_curved_shield_bm((lx, 0.010 * s, 0.285 * s), width=0.018 * s, height=0.140 * s, radius=0.072 * s, nx=4, nz=6)
        parts.append(build_shrinkwrapped_shell(shin_obj, f'Droid_{side}ShinCyan', bm_scyan, mats, mat_index=5, subsurf=1, wrap_offset=0.0015, thickness=0.003 * s, region_tag=f'{low}_shin_plate'))

        # Articulated 5-Finger Mecha Hands
        hand_obj = build_sculpted_hand_object(f'Droid_{side}Hand', sign, scale=s)
        for m in mats:
            hand_obj.data.materials.append(m)
        for p in hand_obj.data.polygons:
            p.material_index = 1 if (abs(p.center.x) < 0.785 * s and p.center.z > 1.415 * s) else 2
        hand_obj['region_tag'] = f'{low}_hand'
        parts.append(hand_obj)

    char_mesh = join_and_bind(parts, arm_obj, 'Bot_CC0_Body', bone_specs, scale=s)
    create_walk_action(arm_obj, 'Walk', n_frames=30)
    create_idle_action(arm_obj, 'Idle', n_frames=60)
    return arm_obj, char_mesh


# ---------------------------------------------------------------------------
# Export & Fast Studio Preview Renderer
# ---------------------------------------------------------------------------

def export_glb(out_path):
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format='GLB',
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_materials='EXPORT',
        export_skins=True,
        export_all_influences=False,
        export_morph=True,
        export_morph_normal=True,
        export_animations=True,
        export_animation_mode='NLA_TRACKS',
        export_nla_strips=True,
        export_nla_strips_merged_animation_name='Animation',
        export_optimize_animation_size=True,
        export_def_bones=True,
    )
    size_kb = os.path.getsize(out_path) / 1024.0
    print(f'[cc0-builder] Exported {out_path} ({size_kb:.1f} KB)')


def render_preview(out_png, arm_obj, pose_action=None, frame=1, cam_loc=(1.42, -2.55, 1.24), look_at=(0.0, 0.0, 0.88)):
    scene = bpy.context.scene
    for eng in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE', 'CYCLES'):
        try:
            scene.render.engine = eng
            break
        except Exception:
            continue
    if hasattr(scene, 'eevee') and hasattr(scene.eevee, 'taa_render_samples'):
        scene.eevee.taa_render_samples = 8
    scene.render.resolution_x = 640
    scene.render.resolution_y = 820

    prev_mutes = []
    if arm_obj.animation_data:
        for tr in arm_obj.animation_data.nla_tracks:
            prev_mutes.append((tr, tr.mute))
            tr.mute = True
        arm_obj.animation_data.action = pose_action
    if pose_action is None:
        reset_pose(arm_obj)
    scene.frame_set(frame)

    created_objs = []
    world = bpy.data.worlds.new('PreviewWorld')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.06, 0.072, 0.095, 1.0)
        bg.inputs[1].default_value = 0.85

    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=2.2, depth=0.02, location=(0, 0, -0.01))
    floor = bpy.context.active_object
    floor.data.materials.append(make_material('StudioFloor', (0.11, 0.125, 0.155), roughness=0.62))
    created_objs.append(floor)

    def add_area(name, loc, target, energy, size, color):
        ld = bpy.data.lights.new(name, type='AREA')
        ld.energy = energy
        ld.size = size
        ld.color = color
        lo = bpy.data.objects.new(name, ld)
        bpy.context.collection.objects.link(lo)
        lo.location = Vector(loc)
        lo.rotation_euler = (Vector(target) - lo.location).to_track_quat('-Z', 'Y').to_euler()
        created_objs.append(lo)

    add_area('Key', (2.1, -2.5, 2.7), (0, 0, 1.0), 280, 2.0, (1.0, 0.97, 0.93))
    add_area('Fill', (-2.4, -1.9, 1.6), (0, 0, 1.0), 120, 2.5, (0.76, 0.88, 1.0))
    add_area('Rim', (-1.5, 2.6, 2.3), (0, 0, 1.15), 250, 1.8, (0.85, 0.93, 1.0))

    cam_data = bpy.data.cameras.new('PreviewCam')
    cam_data.lens = 58
    cam_obj = bpy.data.objects.new('PreviewCam', cam_data)
    bpy.context.collection.objects.link(cam_obj)
    cam_obj.location = Vector(cam_loc)
    cam_obj.rotation_euler = (Vector(look_at) - cam_obj.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam_obj
    created_objs.append(cam_obj)

    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    scene.render.filepath = out_png
    bpy.ops.render.render(write_still=True)
    print(f'[cc0-builder] Rendered preview {out_png}')

    for o in created_objs:
        bpy.data.objects.remove(o, do_unlink=True)
    if arm_obj.animation_data:
        arm_obj.animation_data.action = None
        for tr, m in prev_mutes:
            tr.mute = m


def main():
    render_dir = parse_args()

    arm1, mesh1 = build_studio_athlete_character()
    keys1 = len(mesh1.data.shape_keys.key_blocks) - 1 if mesh1.data.shape_keys else 0
    print(f'[cc0-builder] Mannequin_CC0: verts={len(mesh1.data.vertices)}, polys={len(mesh1.data.polygons)}, bones={len(arm1.data.bones)}, shapeKeys={keys1}')
    export_glb(OUT_MANNEQUIN)
    if render_dir:
        render_preview(os.path.join(render_dir, 'mannequin_v3_rest.png'), arm1, pose_action=None, cam_loc=(1.40, -2.55, 1.24))
        render_preview(os.path.join(render_dir, 'mannequin_v3_walk.png'), arm1, pose_action=bpy.data.actions.get('Walk'), frame=9, cam_loc=(-1.45, -2.40, 1.20))

    arm2, mesh2 = build_cyber_droid_character()
    print(f'[cc0-builder] Bot_CC0: verts={len(mesh2.data.vertices)}, polys={len(mesh2.data.polygons)}, bones={len(arm2.data.bones)}')
    export_glb(OUT_BOT)
    if render_dir:
        render_preview(os.path.join(render_dir, 'bot_v3_rest.png'), arm2, pose_action=None, cam_loc=(1.45, -2.60, 1.28))
        render_preview(os.path.join(render_dir, 'bot_v3_walk.png'), arm2, pose_action=bpy.data.actions.get('Walk'), frame=9, cam_loc=(-1.50, -2.45, 1.24))


if __name__ == '__main__':
    main()

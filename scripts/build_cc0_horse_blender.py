#!/usr/bin/env python3
"""
Generate a seamless, studio-grade, 100% original CC0-1.0 rigged 3D Horse
(`models/Horse_CC0.glb`) in Blender 4.5+ headless CLI:
  - Continuous sculpted equine anatomy fused via Blender Voxel Remesh + Smooth
    (zero pieced-together primitives or joint seams; deep brisket covering the
    front elbows, muscular croup/flank web wrapping the stifle, sculpted equine
    head with cheek jowls, brow ridges, flared nostrils, curved ears, multi-lock
    draped mane, and arched flowing tail).
  - Rich linear-PBR bay/chestnut coat with smooth procedural vertex-color
    shading (`COLOR_0`: warm bay flanks/neck, darker chestnut back/bay leg points,
    natural dark muzzle & ear tips, soft off-white facial blaze & socks with zero
    bloom blowout).
  - Anatomically accurate 34-bone Quadruped Skeleton & region-scoped smooth
    skinning with topology Laplacian smoothing (zero leg cross-bleed or rump pinch).
  - Biomechanically grounded Muybridge 4-beat `Gallop`, 2-beat `Trot`, and
    breathing `Idle` clips with coordinated shoulder/elbow swing + exact sagittal
    2-bone IK (front carpus bending FORWARD, hind hock bending BACKWARD).

Coordinates: Blender Z-up facing -Y (exports to glTF +Y up facing +Z, hooves at Y = 0).

Usage:
  blender --background --factory-startup --python-exit-code 1 \
    --python scripts/build_cc0_horse_blender.py
  blender --background --factory-startup --python-exit-code 1 \
    --python scripts/build_cc0_horse_blender.py -- --render-dir /tmp/horse_previews
"""

import math
import os
import sys
import bpy
import bmesh
from mathutils import Euler, Matrix, Quaternion, Vector

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT_HORSE = os.path.join(ROOT_DIR, 'models', 'Horse_CC0.glb')


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


def make_material(name, base_color, metallic=0.0, roughness=0.62, coat=0.0, use_vertex_color=False):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Metallic'].default_value = metallic
        bsdf.inputs['Roughness'].default_value = roughness
        if 'Coat Weight' in bsdf.inputs:
            bsdf.inputs['Coat Weight'].default_value = coat
        if 'Sheen Weight' in bsdf.inputs:
            bsdf.inputs['Sheen Weight'].default_value = 0.0
        if 'Specular IOR Level' in bsdf.inputs:
            bsdf.inputs['Specular IOR Level'].default_value = 0.28 if coat == 0.0 else 0.55
        if use_vertex_color:
            vc = nt.nodes.new('ShaderNodeVertexColor')
            vc.layer_name = 'Col'
            nt.links.new(vc.outputs['Color'], bsdf.inputs['Base Color'])
        else:
            bsdf.inputs['Base Color'].default_value = (*base_color, 1.0)
    return mat


def smoothstep(edge0, edge1, x):
    if abs(edge1 - edge0) < 1e-8:
        return 1.0 if x >= edge1 else 0.0
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def lerp_rgb(a, b, t):
    t = max(0.0, min(1.0, t))
    return (
        a[0] * (1.0 - t) + b[0] * t,
        a[1] * (1.0 - t) + b[1] * t,
        a[2] * (1.0 - t) + b[2] * t,
    )


# ---------------------------------------------------------------------------
# Smooth Sculpt Primitives (Pre-Voxel-Remesh)
# ---------------------------------------------------------------------------

def add_loft(bm, rings, segs=28, axis='y', cap_start=True, cap_end=True):
    """
    Smooth asymmetric anatomical loft.
      axis='y': (cx, cy, cz, rx, rz_top, rz_bot, p)
      axis='z': (cx, cy, cz, rx, ry_front, ry_back, p)
    """
    created = []
    for ring in rings:
        rv = []
        if axis == 'y':
            cx, cy, cz, rx, rzt, rzb = ring[:6]
            p = ring[6] if len(ring) > 6 else 2.0
            for i in range(segs):
                a = 2.0 * math.pi * i / segs
                ca, sa = math.cos(a), math.sin(a)
                sx = math.copysign(abs(ca) ** (2.0 / p), ca)
                sz = math.copysign(abs(sa) ** (2.0 / p), sa)
                rz = rzt if sz >= 0 else rzb
                rv.append(bm.verts.new((cx + sx * rx, cy, cz + sz * rz)))
        elif axis == 'z':
            cx, cy, cz, rx, ryf, ryb = ring[:6]
            p = ring[6] if len(ring) > 6 else 2.0
            for i in range(segs):
                a = 2.0 * math.pi * i / segs
                ca, sa = math.cos(a), math.sin(a)
                sx = math.copysign(abs(ca) ** (2.0 / p), ca)
                sy = math.copysign(abs(sa) ** (2.0 / p), sa)
                ry = ryf if sy < 0 else ryb
                rv.append(bm.verts.new((cx + sx * rx, cy + sy * ry, cz)))
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


def add_tapered_capsule(bm, p0, p1, r0, r1, rx_scale=1.0, ry_scale=1.0, segs=18, rings=6):
    a, b = Vector(p0), Vector(p1)
    axis = b - a
    length = axis.length
    if length < 1e-6:
        return
    z_dir = axis.normalized()
    up_ref = Vector((1, 0, 0)) if abs(z_dir.x) < 0.9 else Vector((0, 1, 0))
    y_dir = z_dir.cross(up_ref).normalized()
    x_dir = y_dir.cross(z_dir).normalized()

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
        rad = max(0.002, rad)
        c = a + z_dir * d
        rv = [
            bm.verts.new(
                c
                + x_dir * (math.cos(2 * math.pi * i / segs) * rad * rx_scale)
                + y_dir * (math.sin(2 * math.pi * i / segs) * rad * ry_scale)
            )
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


def add_ellipsoid(bm, center, radii, u_segs=16, v_segs=10, rot_euler=(0, 0, 0)):
    res = bmesh.ops.create_uvsphere(bm, u_segments=u_segs, v_segments=v_segs, radius=1.0)
    rot = Euler(rot_euler, 'XYZ').to_matrix()
    cx, cy, cz = center
    rx, ry, rz = radii
    for v in res['verts']:
        p = Vector((v.co.x * rx, v.co.y * ry, v.co.z * rz))
        v.co = (rot @ p) + Vector((cx, cy, cz))
    return res['verts']


def bisect_mesh_planes(obj, planes):
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


# ---------------------------------------------------------------------------
# Anatomically Accurate 34-Bone Equine Skeleton (Blender Z-up, Facing -Y!)
# ---------------------------------------------------------------------------

def get_horse_joints():
    """
    Real thoroughbred / mustang equine proportions (~1.54 m at withers, ~1.92 m poll).
    Blender coords: Z-up, facing -Y (front), tail toward +Y (back), Left = +X, Right = -X.
    """
    return {
        # Spine & Head
        'pelvis':   Vector((0.0,  0.54, 1.32)),
        'spine':    Vector((0.0,  0.22, 1.29)),
        'spine1':   Vector((0.0, -0.10, 1.31)),
        'chest':    Vector((0.0, -0.44, 1.37)),  # high withers / chest hub
        'neck':     Vector((0.0, -0.62, 1.44)),
        'neck1':    Vector((0.0, -0.82, 1.64)),
        'head':     Vector((0.0, -0.96, 1.82)),  # poll
        'muzzle':   Vector((0.0, -1.29, 1.54)),  # nose tip
        'jaw':      Vector((0.0, -1.03, 1.67)),
        'jaw_tip':  Vector((0.0, -1.24, 1.51)),
        # Gracefully arched horse tail dock -> cascading plume
        'tail1':    Vector((0.0,  0.75, 1.33)),
        'tail2':    Vector((0.0,  0.92, 1.25)),
        'tail3':    Vector((0.0,  1.03, 0.99)),
        'tail4':    Vector((0.0,  1.05, 0.69)),
        'tail_tip': Vector((0.0,  1.03, 0.41)),
        # Front Limb (Left +X; mirror for Right -X)
        # Shoulder & elbow sit INSIDE the deep muscular brisket/chest (zero stick-out!)
        'f_scap':   Vector((0.11, -0.42, 1.38)),  # top of shoulder blade
        'f_shldr':  Vector((0.135, -0.60, 1.15)), # point of shoulder (-Y forward)
        'f_elbow':  Vector((0.132, -0.49, 0.94)), # elbow tucked flush inside brisket!
        'f_knee':   Vector((0.130, -0.50, 0.51)), # carpus (horse knee — bends FORWARD -Y!)
        'f_fetl':   Vector((0.128, -0.48, 0.16)), # fetlock
        'f_hoof':   Vector((0.128, -0.55, 0.00)), # hoof grounded at Z = 0
        # Hind Limb (Left +X; mirror for Right -X)
        'b_hip':    Vector((0.135,  0.54, 1.28)), # hip joint
        'b_stifle': Vector((0.145,  0.37, 0.95)), # stifle tucked smoothly in flank web
        'b_hock':   Vector((0.132,  0.62, 0.54)), # hock (pointed BACKWARD +Y!)
        'b_fetl':   Vector((0.128,  0.58, 0.16)), # fetlock
        'b_hoof':   Vector((0.128,  0.50, 0.00)), # hoof grounded at Z = 0
    }


def mirror_x(v, sign):
    return Vector((v.x * sign, v.y, v.z))


def get_horse_bone_specs():
    J = get_horse_joints()
    specs = [
        ('Pelvis', None, J['pelvis'], J['spine'], True),
        ('Spine', 'Pelvis', J['spine'], J['spine1'], True),
        ('Spine1', 'Spine', J['spine1'], J['chest'], True),
        ('Chest', 'Spine1', J['chest'], J['neck'], True),
        ('Neck', 'Chest', J['neck'], J['neck1'], True),
        ('Neck1', 'Neck', J['neck1'], J['head'], True),
        ('Head', 'Neck1', J['head'], J['muzzle'], True),
        ('Jaw', 'Head', J['jaw'], J['jaw_tip'], True),
        ('LeftEar', 'Head', Vector((0.060, -0.94, 1.87)), Vector((0.095, -0.97, 2.02)), True),
        ('RightEar', 'Head', Vector((-0.060, -0.94, 1.87)), Vector((-0.095, -0.97, 2.02)), True),
        ('Tail1', 'Pelvis', J['tail1'], J['tail2'], True),
        ('Tail2', 'Tail1', J['tail2'], J['tail3'], True),
        ('Tail3', 'Tail2', J['tail3'], J['tail4'], True),
        ('Tail4', 'Tail3', J['tail4'], J['tail_tip'], True),
    ]
    for side, sign in (('Left', 1.0), ('Right', -1.0)):
        specs.append((f'Front{side}Scapula', 'Chest', mirror_x(J['f_scap'], sign), mirror_x(J['f_shldr'], sign), True))
        specs.append((f'Front{side}UpperArm', f'Front{side}Scapula', mirror_x(J['f_shldr'], sign), mirror_x(J['f_elbow'], sign), True))
        specs.append((f'Front{side}ForeArm', f'Front{side}UpperArm', mirror_x(J['f_elbow'], sign), mirror_x(J['f_knee'], sign), True))
        specs.append((f'Front{side}Paw', f'Front{side}ForeArm', mirror_x(J['f_knee'], sign), mirror_x(J['f_fetl'], sign), True))
        specs.append((f'Front{side}Toe', f'Front{side}Paw', mirror_x(J['f_fetl'], sign), mirror_x(J['f_hoof'], sign), True))

        specs.append((f'Back{side}Thigh', 'Pelvis', mirror_x(J['b_hip'], sign), mirror_x(J['b_stifle'], sign), True))
        specs.append((f'Back{side}Shin', f'Back{side}Thigh', mirror_x(J['b_stifle'], sign), mirror_x(J['b_hock'], sign), True))
        specs.append((f'Back{side}Hock', f'Back{side}Shin', mirror_x(J['b_hock'], sign), mirror_x(J['b_fetl'], sign), True))
        specs.append((f'Back{side}Paw', f'Back{side}Hock', mirror_x(J['b_fetl'], sign), mirror_x(J['b_hoof'], sign), True))
        specs.append((f'Back{side}Toe', f'Back{side}Paw', mirror_x(J['b_hoof'], sign), mirror_x(J['b_hoof'] + Vector((0, -0.09, 0.01)), sign), True))
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
# Seamless Voxel-Remeshed Sculpted Mustang Horse Body (Deep Brisket & Haunches)
# ---------------------------------------------------------------------------

def build_seamless_horse_body(mats):
    J = get_horse_joints()
    bm = bmesh.new()

    # 1. Deep Athletic Barrel, High Withers, Muscular Brisket & Rounded Croup
    barrel_rings = [
        (0.0,  0.81, 1.28, 0.11, 0.10, 0.13, 2.0),   # rounded croup tail-head
        (0.0,  0.72, 1.30, 0.21, 0.18, 0.23, 2.0),   # smooth rounded upper rump
        (0.0,  0.58, 1.30, 0.245, 0.21, 0.27, 2.0),  # powerful muscular hindquarters
        (0.0,  0.40, 1.28, 0.245, 0.20, 0.27, 2.0),  # hip crest & athletic flank
        (0.0,  0.18, 1.25, 0.235, 0.19, 0.27, 2.0),  # athletic lumbar / belly tuck
        (0.0, -0.08, 1.23, 0.250, 0.22, 0.30, 2.0),  # deep ribcage / barrel
        (0.0, -0.34, 1.24, 0.240, 0.27, 0.32, 2.05), # deep heart girth & high withers
        (0.0, -0.52, 1.21, 0.215, 0.23, 0.29, 2.05), # smooth broad athletic chest
        (0.0, -0.66, 1.18, 0.145, 0.14, 0.16, 2.00), # sleek breastbone curve
    ]
    add_loft(bm, barrel_rings, segs=32, axis='y')

    # Subtle sternum bridge smoothly blending chest into upper arms (no bulbous bulge!)
    add_ellipsoid(bm, (0.0, -0.51, 1.03), (0.165, 0.165, 0.125))

    # 2. Arched Muscular Equine Neck (high crest flowing smoothly from withers to poll)
    neck_pts = [
        (Vector((0.0, -0.42, 1.33)), 0.220),
        (Vector((0.0, -0.57, 1.44)), 0.185),
        (Vector((0.0, -0.72, 1.58)), 0.155),
        (Vector((0.0, -0.86, 1.72)), 0.124),
        (Vector((0.0, -0.96, 1.82)), 0.098),
    ]
    for k in range(len(neck_pts) - 1):
        add_tapered_capsule(
            bm, neck_pts[k][0], neck_pts[k + 1][0],
            neck_pts[k][1], neck_pts[k + 1][1],
            rx_scale=0.66, ry_scale=1.22, segs=22, rings=5,
        )
    # Muscular neck crest ridge (gives noble arched silhouette!)
    add_tapered_capsule(bm, (0.0, -0.44, 1.47), (0.0, -0.92, 1.84), 0.080, 0.052, rx_scale=0.66, ry_scale=1.0, segs=16, rings=5)

    # 3. Sculpted Noble Equine Head (cranium, smooth cheek jowl, gentle brow, tapered nose bridge, soft muzzle)
    add_ellipsoid(bm, (0.0, -0.97, 1.81), (0.095, 0.115, 0.102))  # cranium / forehead
    for sign in (1.0, -1.0):
        # Blended cheek jowl (natural horse jaw contour without bulbous bumps)
        add_ellipsoid(bm, (sign * 0.044, -0.99, 1.70), (0.052, 0.085, 0.080))
        # Subtle supraorbital brow framing eye naturally
        add_ellipsoid(bm, (sign * 0.068, -1.045, 1.792), (0.022, 0.036, 0.017))
        # Soft flared nostril wing
        add_ellipsoid(bm, (sign * 0.032, -1.26, 1.562), (0.021, 0.028, 0.021))
    # Tapered nasal bridge
    add_tapered_capsule(bm, (0.0, -0.99, 1.79), (0.0, -1.29, 1.55), 0.085, 0.046, rx_scale=0.82, ry_scale=1.06, segs=22, rings=6)
    # Soft velvety upper lip & lower chin
    add_ellipsoid(bm, (0.0, -1.30, 1.545), (0.046, 0.050, 0.042))
    add_tapered_capsule(bm, (0.0, -1.03, 1.66), (0.0, -1.25, 1.505), 0.066, 0.035, rx_scale=0.78, ry_scale=0.90, segs=16, rings=4)
    add_ellipsoid(bm, (0.0, -1.255, 1.50), (0.035, 0.037, 0.029))
    # Alert curved equine ears
    for sign in (1.0, -1.0):
        add_tapered_capsule(bm, (sign * 0.058, -0.935, 1.86), (sign * 0.088, -0.96, 1.96), 0.032, 0.020, rx_scale=0.88, ry_scale=0.62, segs=14, rings=3)
        add_tapered_capsule(bm, (sign * 0.088, -0.96, 1.96), (sign * 0.095, -0.985, 2.025), 0.020, 0.007, rx_scale=0.85, ry_scale=0.58, segs=12, rings=3)

    # 4. Sculpted Muscular 4 Legs (silky continuous muscle transition — ZERO holes or lumpy bulges!)
    for sign in (1.0, -1.0):
        fs = mirror_x(J['f_scap'], sign)
        fsh = mirror_x(J['f_shldr'], sign)
        fel = mirror_x(J['f_elbow'], sign)
        fkn = mirror_x(J['f_knee'], sign)
        ffe = mirror_x(J['f_fetl'], sign)
        fho = mirror_x(J['f_hoof'], sign)

        # Sleek shoulder + triceps smoothly flush with barrel (no bulbous lumps!)
        add_ellipsoid(bm, (sign * 0.130, -0.48, 1.18), (0.092, 0.150, 0.160))
        add_ellipsoid(bm, (sign * 0.128, -0.49, 1.02), (0.084, 0.130, 0.125))
        add_tapered_capsule(bm, fs, fsh, 0.092, 0.086, rx_scale=0.84, ry_scale=1.12)
        add_tapered_capsule(bm, fsh, fel, 0.088, 0.080, rx_scale=0.86, ry_scale=1.12)
        add_tapered_capsule(bm, fel, fkn, 0.074, 0.041, rx_scale=0.86, ry_scale=1.08)  # muscular forearm taper
        add_ellipsoid(bm, fkn, (0.041, 0.045, 0.045))                                 # crisp carpus knee
        add_tapered_capsule(bm, fkn, ffe, 0.032, 0.029, rx_scale=0.88, ry_scale=1.06)  # slender cannon bone
        add_ellipsoid(bm, ffe, (0.036, 0.039, 0.035))                                 # fetlock
        add_tapered_capsule(bm, ffe, fho + Vector((0, 0, 0.055)), 0.030, 0.041)        # sloped pastern
        add_tapered_capsule(bm, fho + Vector((0, -0.01, 0.068)), fho + Vector((0, -0.02, 0.008)), 0.046, 0.056, rx_scale=0.95, ry_scale=1.10)

        # Hind leg: solid continuous haunch -> stifle -> gaskin -> hock (ZERO hollow triangle gap!)
        bhi = mirror_x(J['b_hip'], sign)
        bst = mirror_x(J['b_stifle'], sign)
        bhk = mirror_x(J['b_hock'], sign)
        bfe = mirror_x(J['b_fetl'], sign)
        bho = mirror_x(J['b_hoof'], sign)

        add_ellipsoid(bm, (sign * 0.135, 0.56, 1.21), (0.118, 0.205, 0.195))  # smooth rounded haunch
        add_ellipsoid(bm, (sign * 0.132, 0.48, 1.01), (0.105, 0.195, 0.165))  # solid thigh & stifle fill (zero hollow!)
        add_tapered_capsule(bm, (sign * 0.132, 0.56, 1.12), bhk + Vector((0, 0.01, 0.05)), 0.115, 0.050, rx_scale=0.82, ry_scale=1.22)  # solid gaskin/hamstring core
        add_tapered_capsule(bm, bhi, bst, 0.115, 0.098, rx_scale=0.84, ry_scale=1.15)
        add_tapered_capsule(bm, bst, bhk, 0.090, 0.045, rx_scale=0.84, ry_scale=1.18)  # muscular gaskin
        add_ellipsoid(bm, bhk + Vector((0, 0.016, 0.01)), (0.040, 0.053, 0.047))      # crisp angular hock point
        add_tapered_capsule(bm, bhk, bfe, 0.034, 0.030, rx_scale=0.86, ry_scale=1.08)  # slender hind cannon
        add_ellipsoid(bm, bfe, (0.036, 0.039, 0.035))                                 # fetlock
        add_tapered_capsule(bm, bfe, bho + Vector((0, 0, 0.055)), 0.030, 0.041)       # pastern
        add_tapered_capsule(bm, bho + Vector((0, -0.01, 0.068)), bho + Vector((0, -0.02, 0.008)), 0.046, 0.056, rx_scale=0.95, ry_scale=1.10)

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new('Horse_Body_Mesh')
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new('Horse_Body', mesh)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

    # Fuse EVERY anatomical muscle seamlessly with Voxel Remesh -> Silky Smooth -> Clean Decimate
    rem = obj.modifiers.new(name='VoxelRemesh', type='REMESH')
    rem.mode = 'VOXEL'
    rem.voxel_size = 0.0085
    rem.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=rem.name)

    sm = obj.modifiers.new(name='Smooth', type='SMOOTH')
    sm.factor = 0.72
    sm.iterations = 18
    bpy.ops.object.modifier_apply(modifier=sm.name)

    cur_faces = len(obj.data.polygons)
    target_faces = 17500
    if cur_faces > target_faces:
        dec = obj.modifiers.new(name='Decimate', type='DECIMATE')
        dec.ratio = max(0.08, target_faces / cur_faces)
        bpy.ops.object.modifier_apply(modifier=dec.name)

    # Ground hooves flat onto exact Z = 0.000
    min_z = min(v.co.z for v in obj.data.vertices)
    for v in obj.data.vertices:
        v.co.z -= min_z
        if v.co.z < 0.006:
            v.co.z = 0.0

    # Razor-straight cut for glossy dark hooves at Z = 0.070
    bisect_mesh_planes(obj, [
        ((0, 0, 0.070), (0, 0, 1)),
    ])

    for m in mats:
        obj.data.materials.append(m)

    # Paint rich procedural equine bay coat vertex colors (`Col`, linear RGB -> zero bloom blowout!)
    # Rich warm bay chestnut coat + dark mahogany dorsal/belly shading + dark bay lower-leg points
    # + velvety dark muzzle & ear tips + natural soft cream-white blaze & fetlock socks!
    vcol = obj.data.color_attributes.new(name='Col', type='BYTE_COLOR', domain='CORNER')
    c_bay_mid   = (0.115, 0.038, 0.015)  # rich warm mahogany bay (renders warm chestnut in sRGB!)
    c_bay_warm  = (0.165, 0.058, 0.022)  # sunlit golden-bay flank/neck highlight
    c_bay_dark  = (0.042, 0.016, 0.008)  # deep espresso bay points (legs, dorsal, ear tips, muzzle)
    c_bay_muzz  = (0.024, 0.016, 0.014)  # velvety dark horse nose
    c_cream     = (0.60,  0.57,  0.53)   # natural off-white socks & nose blaze (never blooms!)

    verts = obj.data.vertices
    for poly in obj.data.polygons:
        c = poly.center
        if c.z < 0.070:
            poly.material_index = 2  # glossy dark hooves
        else:
            poly.material_index = 0  # vertex-colored bay coat
        poly.use_smooth = True

        for loop_idx in poly.loop_indices:
            vi = obj.data.loops[loop_idx].vertex_index
            co = verts[vi].co
            n = verts[vi].normal
            x, y, z = co.x, co.y, co.z

            # Base warm bay with subtle organic flank/shoulder warmth & dorsal/underside shading
            warm_t = smoothstep(0.92, 1.38, z) * smoothstep(0.35, 0.95, abs(n.x))
            rgb = lerp_rgb(c_bay_mid, c_bay_warm, warm_t * 0.62)

            # Darker rich spine/croup ridge & belly underside AO
            dorsal_t = smoothstep(1.36, 1.56, z) * smoothstep(0.55, 0.98, n.z) * smoothstep(-0.75, -0.30, y)
            belly_ao = smoothstep(1.04, 0.88, z) * smoothstep(-0.20, -0.90, n.z)
            rgb = lerp_rgb(rgb, c_bay_dark, min(0.75, dorsal_t * 0.48 + belly_ao * 0.55))

            # Classic Thoroughbred / Mustang dark bay lower-leg "points" (knees/hocks -> fetlocks)
            leg_dark = smoothstep(0.64, 0.34, z)
            rgb = lerp_rgb(rgb, c_bay_dark, leg_dark * 0.85)

            # Dark velvety ear tips
            ear_dark = smoothstep(1.90, 2.01, z)
            rgb = lerp_rgb(rgb, c_bay_dark, ear_dark * 0.88)

            # Velvety dark muzzle & nostrils
            muzzle_dark = smoothstep(-1.14, -1.27, y) * smoothstep(1.66, 1.55, z)
            rgb = lerp_rgb(rgb, c_bay_muzz, muzzle_dark * 0.85)

            # Soft white ankle socks on lower fetlocks/pasterns (Z < 0.20, gentle organic top fade)
            sock_t = smoothstep(0.205, 0.165, z) * smoothstep(0.068, 0.075, z)
            rgb = lerp_rgb(rgb, c_cream, sock_t)

            # Clean noble white facial blaze strictly along top bridge of nose
            if y < -0.99 and z > 1.57 and n.z > 0.30:
                w_fade = 1.0 - smoothstep(0.012, 0.028, abs(x))
                y_fade = smoothstep(-0.99, -1.04, y) * smoothstep(-1.28, -1.22, y)
                blaze_t = w_fade * y_fade * smoothstep(0.30, 0.55, n.z)
                rgb = lerp_rgb(rgb, c_cream, blaze_t)

            vcol.data[loop_idx].color = (rgb[0], rgb[1], rgb[2], 1.0)

    obj.select_set(False)
    obj['region_tag'] = 'horse_body'
    return obj


def build_mane_tail_eyes(mats):
    J = get_horse_joints()
    parts = []

    # 1. Lush Multi-Lock Draped Mane + Forelock (rich noble silhouette from BOTH sides!)
    bm_m = bmesh.new()
    mane_spine = [
        (Vector((0.00, -0.41, 1.53)), 0.056),
        (Vector((0.00, -0.54, 1.65)), 0.072),
        (Vector((0.00, -0.68, 1.78)), 0.078),
        (Vector((0.00, -0.82, 1.90)), 0.068),
        (Vector((0.00, -0.94, 1.95)), 0.050),
        (Vector((0.00, -1.07, 1.87)), 0.028),  # sculpted forelock
    ]
    for k in range(len(mane_spine) - 1):
        add_tapered_capsule(
            bm_m, mane_spine[k][0], mane_spine[k + 1][0],
            mane_spine[k][1], mane_spine[k + 1][1],
            rx_scale=0.66, ry_scale=1.48, segs=14, rings=3,
        )
    # Layered flowing mane locks draping gracefully (fuller on right, wispy accents on left!)
    for frac in (0.10, 0.25, 0.40, 0.56, 0.72, 0.88):
        y0 = -0.44 - frac * 0.48
        z0 = 1.54 + frac * 0.38
        p_top = Vector((0.0, y0, z0))
        p_tip_r = Vector((-0.105 - 0.02 * math.sin(frac * 5.0), y0 + 0.07, z0 - 0.18 - 0.04 * (1.0 - frac)))
        add_tapered_capsule(bm_m, p_top, p_tip_r, 0.040, 0.012, rx_scale=0.75, ry_scale=1.25, segs=10, rings=3)
        p_tip_l = Vector((0.078 + 0.015 * math.cos(frac * 4.5), y0 + 0.05, z0 - 0.13 - 0.03 * (1.0 - frac)))
        add_tapered_capsule(bm_m, p_top, p_tip_l, 0.032, 0.010, rx_scale=0.72, ry_scale=1.20, segs=10, rings=3)
    bmesh.ops.recalc_face_normals(bm_m, faces=bm_m.faces)
    m_mesh = bpy.data.meshes.new('Horse_Mane_Mesh')
    bm_m.to_mesh(m_mesh)
    bm_m.free()
    m_obj = bpy.data.objects.new('Horse_Mane', m_mesh)
    bpy.context.collection.objects.link(m_obj)
    bpy.context.view_layer.objects.active = m_obj
    m_obj.select_set(True)
    rem = m_obj.modifiers.new('Voxel', 'REMESH')
    rem.mode = 'VOXEL'
    rem.voxel_size = 0.008
    bpy.ops.object.modifier_apply(modifier=rem.name)
    sm = m_obj.modifiers.new('Smooth', 'SMOOTH')
    sm.factor = 0.58
    sm.iterations = 4
    bpy.ops.object.modifier_apply(modifier=sm.name)
    dec = m_obj.modifiers.new('Dec', 'DECIMATE')
    dec.ratio = min(1.0, 1600 / max(1, len(m_obj.data.polygons)))
    bpy.ops.object.modifier_apply(modifier=dec.name)
    for m in mats:
        m_obj.data.materials.append(m)
    for p in m_obj.data.polygons:
        p.material_index = 1
        p.use_smooth = True
    m_obj.select_set(False)
    m_obj['region_tag'] = 'mane'
    parts.append(m_obj)

    # 2. Lush Arched Multi-Strand Flowing Horse Tail (follows arched Tail1..Tail4 curve!)
    bm_t = bmesh.new()
    tpts = [
        (J['tail1'] + Vector((0, -0.03, 0.00)), 0.056),
        (J['tail2'], 0.078),
        (J['tail3'], 0.098),
        (J['tail4'], 0.088),
        (J['tail_tip'], 0.024),
    ]
    for k in range(len(tpts) - 1):
        add_tapered_capsule(
            bm_t, tpts[k][0], tpts[k + 1][0],
            tpts[k][1], tpts[k + 1][1],
            rx_scale=0.86, ry_scale=1.18, segs=16, rings=4,
        )
    # Layered side tail plumes for lush equine horsehair silhouette
    for sign in (1.0, -1.0):
        add_tapered_capsule(
            bm_t,
            J['tail2'] + Vector((sign * 0.025, 0.01, -0.03)),
            J['tail4'] + Vector((sign * 0.048, 0.02, -0.06)),
            0.054, 0.034, rx_scale=0.78, ry_scale=1.15, segs=12, rings=4,
        )
    bmesh.ops.recalc_face_normals(bm_t, faces=bm_t.faces)
    t_mesh = bpy.data.meshes.new('Horse_Tail_Mesh')
    bm_t.to_mesh(t_mesh)
    bm_t.free()
    t_obj = bpy.data.objects.new('Horse_Tail', t_mesh)
    bpy.context.collection.objects.link(t_obj)
    bpy.context.view_layer.objects.active = t_obj
    t_obj.select_set(True)
    rem = t_obj.modifiers.new('Voxel', 'REMESH')
    rem.mode = 'VOXEL'
    rem.voxel_size = 0.0085
    bpy.ops.object.modifier_apply(modifier=rem.name)
    sm = t_obj.modifiers.new('Smooth', 'SMOOTH')
    sm.factor = 0.58
    sm.iterations = 4
    bpy.ops.object.modifier_apply(modifier=sm.name)
    dec = t_obj.modifiers.new('Dec', 'DECIMATE')
    dec.ratio = min(1.0, 1600 / max(1, len(t_obj.data.polygons)))
    bpy.ops.object.modifier_apply(modifier=dec.name)
    for m in mats:
        t_obj.data.materials.append(m)
    for p in t_obj.data.polygons:
        p.material_index = 1
        p.use_smooth = True
    t_obj.select_set(False)
    t_obj['region_tag'] = 'tail'
    parts.append(t_obj)

    # 3. Expressive Glossy Equine Eyes (tucked naturally beneath brow ridges)
    bm_e = bmesh.new()
    for sign in (1.0, -1.0):
        add_ellipsoid(bm_e, (sign * 0.080, -1.055, 1.768), (0.017, 0.022, 0.019), u_segs=14, v_segs=10)
    bmesh.ops.recalc_face_normals(bm_e, faces=bm_e.faces)
    e_mesh = bpy.data.meshes.new('Horse_Eyes_Mesh')
    bm_e.to_mesh(e_mesh)
    bm_e.free()
    e_obj = bpy.data.objects.new('Horse_Eyes', e_mesh)
    bpy.context.collection.objects.link(e_obj)
    for m in mats:
        e_obj.data.materials.append(m)
    for p in e_obj.data.polygons:
        p.material_index = 3  # glossy dark eye
        p.use_smooth = True
    e_obj['region_tag'] = 'head_rigid'
    parts.append(e_obj)

    return parts


# ---------------------------------------------------------------------------
# Region-Scoped Smooth Skinning (ZERO Cross-Leg Bleed or Crippled Deformation!)
# ---------------------------------------------------------------------------

def point_to_seg_dist(pt, a, b):
    ab = b - a
    l2 = ab.length_squared
    if l2 < 1e-10:
        return (pt - a).length, 0.0
    t = max(0.0, min(1.0, (pt - a).dot(ab) / l2))
    return (pt - (a + ab * t)).length, t


def classify_horse_vertex(co):
    x, y, z = co.x, co.y, co.z
    # Ears
    if z > 1.855 and abs(x) > 0.045:
        return ['Head', 'LeftEar' if x > 0 else 'RightEar']
    # Head & Jaw
    if y < -0.92 and z > 1.44:
        return ['Neck1', 'Head', 'Jaw']
    # Neck
    if y < -0.54 and z > 1.32:
        return ['Chest', 'Neck', 'Neck1', 'Head']
    # Free legs strictly isolated below brisket/flank line (Z < 0.87)
    if z < 0.87:
        side = 'Left' if x >= 0.0 else 'Right'
        if y < 0.02:
            return [f'Front{side}UpperArm', f'Front{side}ForeArm', f'Front{side}Paw', f'Front{side}Toe']
        else:
            return [f'Back{side}Thigh', f'Back{side}Shin', f'Back{side}Hock', f'Back{side}Paw', f'Back{side}Toe']
    # Smooth shoulder / haunch transition bridges (keep ribcage & upper croup 100% crease-free!)
    if y < -0.34 and z < 1.18 and abs(x) > 0.085:
        side = 'Left' if x >= 0.0 else 'Right'
        return ['Spine1', 'Chest', f'Front{side}Scapula', f'Front{side}UpperArm', f'Front{side}ForeArm']
    if y > 0.32 and z < 1.16 and abs(x) > 0.085:
        side = 'Left' if x >= 0.0 else 'Right'
        return ['Pelvis', 'Spine', f'Back{side}Thigh', f'Back{side}Shin']
    # Core barrel spine & rounded croup (strictly exclude Tail1 & leg bones!)
    return ['Pelvis', 'Spine', 'Spine1', 'Chest', 'Neck']


def skin_and_join_horse(parts, arm_obj, bone_specs):
    bone_segs = {name: (Vector(h), Vector(t)) for name, _p, h, t, d in bone_specs if d}

    for obj in parts:
        mesh = obj.data
        tag = obj.get('region_tag', 'horse_body')
        n_verts = len(mesh.vertices)

        # Ensure every part has the same `Col` attribute so bpy.ops.object.join() preserves it cleanly
        if 'Col' not in mesh.color_attributes:
            vc = mesh.color_attributes.new(name='Col', type='BYTE_COLOR', domain='CORNER')
            for i in range(len(vc.data)):
                vc.data[i].color = (1.0, 1.0, 1.0, 1.0)

        if tag == 'head_rigid':
            vg = obj.vertex_groups.new(name='Head')
            vg.add(list(range(n_verts)), 1.0, 'REPLACE')
            continue

        weights = [None] * n_verts
        used = set()
        for vi, v in enumerate(mesh.vertices):
            co = v.co
            if tag == 'mane':
                cand = ['Chest', 'Neck', 'Neck1', 'Head']
            elif tag == 'tail':
                cand = ['Pelvis', 'Tail1', 'Tail2', 'Tail3', 'Tail4']
            else:
                cand = classify_horse_vertex(co)

            scores = []
            for bn in cand:
                a, b = bone_segs[bn]
                dist, t = point_to_seg_dist(co, a, b)
                span_f = 0.88 if 0.04 < t < 0.96 else 1.15
                if bn.endswith('Toe') and co.z > 0.16:
                    span_f *= 3.5
                scores.append((bn, 1.0 / (max(0.008, dist * span_f) ** 4.2)))
            scores.sort(key=lambda it: it[1], reverse=True)
            top = scores[:4]
            tot = sum(w for _, w in top) or 1.0
            wd = {bn: w / tot for bn, w in top}
            weights[vi] = wd
            used.update(wd.keys())

        # Topology Laplacian weight smoothing (10 iterations, strictly blocked across L/R leg gap!)
        if len(mesh.edges) > 0:
            adj = [[] for _ in range(n_verts)]
            for e in mesh.edges:
                u, wv = e.vertices[0], e.vertices[1]
                if mesh.vertices[u].co.z < 1.02 and (mesh.vertices[u].co.x * mesh.vertices[wv].co.x < 0):
                    continue
                adj[u].append(wv)
                adj[wv].append(u)
            alpha = 0.50
            for _ in range(14):
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
                    used.update(nxt[vi].keys())
                weights = nxt

        vg_map = {bn: (obj.vertex_groups.get(bn) or obj.vertex_groups.new(name=bn)) for bn in used}
        for vi, wd in enumerate(weights):
            for bn, val in wd.items():
                if val > 1e-4:
                    vg_map[bn].add([vi], val, 'REPLACE')

    bpy.ops.object.select_all(action='DESELECT')
    for obj in parts:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()

    joined = bpy.context.view_layer.objects.active
    joined.name = 'Horse_CC0_Body'
    joined.data.name = 'Horse_CC0_Body_Mesh'
    joined.data.validate(verbose=False)

    for name, _p, _h, _t, deform in bone_specs:
        if deform and name not in joined.vertex_groups:
            joined.vertex_groups.new(name=name)

    joined.parent = arm_obj
    mod = joined.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm_obj
    mod.use_vertex_groups = True
    return joined


# ---------------------------------------------------------------------------
# Biomechanically Accurate Sagittal 2-Bone IK Horse Gallop & Trot Solver!
# ---------------------------------------------------------------------------

def solve_sagittal_2bone(root_yz, target_yz, l1, l2, bend_sign):
    """
    Solve exact 2-bone IK in the sagittal (Y, Z) plane where -Y is FORWARD and +Z is UP.
    `bend_sign = -1` bends middle joint toward -Y (FORWARD — horse FRONT CARPUS / knee!).
    `bend_sign = +1` bends middle joint toward +Y (BACKWARD — horse HIND HOCK!).
    """
    dy = target_yz[0] - root_yz[0]
    dz = target_yz[1] - root_yz[1]
    dist = math.hypot(dy, dz)
    max_d = (l1 + l2) * 0.992
    min_d = abs(l1 - l2) + 0.04
    d = max(min_d, min(max_d, dist))

    cos_a = max(-1.0, min(1.0, (l1 * l1 + d * d - l2 * l2) / (2.0 * l1 * d)))
    sin_a = math.sqrt(max(0.0, 1.0 - cos_a * cos_a))

    uy, uz = dy / max(1e-6, dist), dz / max(1e-6, dist)
    # When u = (0, -1), (-uz, uy) = (+1, 0) -> points +Y (BACKWARD)
    py, pz = (-uz) * bend_sign, uy * bend_sign

    mid_y = root_yz[0] + (uy * cos_a + py * sin_a) * l1
    mid_z = root_yz[1] + (uz * cos_a + pz * sin_a) * l1
    return (mid_y, mid_z)


def set_bone_world_direction(arm_obj, bone_name, target_dir_world, frame, blend=1.0):
    """Rotate `bone_name` so its tail aligns cleanly along `target_dir_world` using pure swing."""
    pb = arm_obj.pose.bones.get(bone_name)
    if not pb:
        return
    pb.rotation_mode = 'QUATERNION'
    bpy.context.view_layer.update()
    parent_mat = pb.parent.matrix.to_3x3() if pb.parent else Matrix.Identity(3)
    rest_rel = (
        pb.parent.bone.matrix_local.to_3x3().inverted() @ pb.bone.matrix_local.to_3x3()
        if pb.parent
        else pb.bone.matrix_local.to_3x3()
    )
    base_world_rot = (parent_mat @ rest_rel).to_quaternion().normalized()
    cur_dir = (base_world_rot @ Vector((0, 1, 0))).normalized()
    tgt = Vector(target_dir_world).normalized()
    q_swing_world = cur_dir.rotation_difference(tgt)
    if blend < 0.999:
        q_swing_world = Quaternion((1, 0, 0, 0)).slerp(q_swing_world, blend)
    q_local = base_world_rot.inverted() @ q_swing_world @ base_world_rot
    pb.rotation_quaternion = q_local.normalized()
    pb.keyframe_insert(data_path='rotation_quaternion', frame=frame)


def set_bone_world_euler(arm_obj, bone_name, world_euler_deg, frame):
    pb = arm_obj.pose.bones.get(bone_name)
    if not pb:
        return
    pb.rotation_mode = 'QUATERNION'
    rx, ry, rz = (math.radians(a) for a in world_euler_deg)
    q_world = Euler((rx, ry, rz), 'XYZ').to_quaternion()
    rest_rot = pb.bone.matrix_local.to_3x3().to_quaternion()
    pb.rotation_quaternion = (rest_rot.inverted() @ q_world @ rest_rot).normalized()
    pb.keyframe_insert(data_path='rotation_quaternion', frame=frame)


def set_bone_world_loc(arm_obj, bone_name, world_delta_xyz, frame):
    pb = arm_obj.pose.bones.get(bone_name)
    if not pb:
        return
    pb.location = pb.bone.matrix_local.to_3x3().inverted() @ Vector(world_delta_xyz)
    pb.keyframe_insert(data_path='location', frame=frame)


def reset_pose(arm_obj):
    for pb in arm_obj.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Quaternion((1, 0, 0, 0))
        pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)


def hoof_stride_yz(phase01, base_y, stride_len, lift_h, stance_frac=0.36):
    """
    Real equine hoof trajectory in (Y, Z) where -Y is FORWARD and +Z is UP:
      - Stance [0, stance_frac]: hoof plants firmly on Z = 0 and glides backward.
      - Swing [stance_frac, 1.0]: hoof lifts smoothly in a bell arc and folds cleanly forward.
    """
    p = phase01 % 1.0
    half = stride_len * 0.5
    if p < stance_frac:
        u = p / stance_frac
        y = base_y - half + u * stride_len
        z = 0.0
        in_stance = True
        swing_u = 0.0
    else:
        u = (p - stance_frac) / (1.0 - stance_frac)
        ease = 0.5 - 0.5 * math.cos(u * math.pi)
        y = base_y + half - ease * stride_len
        z = lift_h * (math.sin(u * math.pi) ** 1.35)
        in_stance = False
        swing_u = u
    return y, z, in_stance, swing_u


def create_equine_gait_action(
    arm_obj,
    name='Gallop',
    n_frames=24,
    stride_len=0.74,
    lift_f=0.28,
    lift_b=0.24,
    stance_frac=0.38,
    phases=None,
    bounce=0.052,
    spine_flex=6.0,
):
    """
    Bake a biomechanically grounded equine gait (Gallop or Trot) with coordinated
    shoulder-elbow reach (so the elbow NEVER pokes out backward!) and exact sagittal
    2-bone IK to ground-hugging hoof arcs.
    """
    J = get_horse_joints()
    if phases is None:
        # True Muybridge right-lead 4-beat gallop phase offsets:
        phases = {'BackLeft': 0.00, 'BackRight': 0.18, 'FrontLeft': 0.48, 'FrontRight': 0.68}

    l_f_fore = (J['f_knee'] - J['f_elbow']).length
    l_f_can = (J['f_fetl'] - J['f_knee']).length
    l_b_shin = (J['b_hock'] - J['b_stifle']).length
    l_b_can = (J['b_fetl'] - J['b_hock']).length

    act = bpy.data.actions.new(name=name)
    if not arm_obj.animation_data:
        arm_obj.animation_data_create()
    arm_obj.animation_data.action = act
    reset_pose(arm_obj)

    for f in range(n_frames + 1):
        t01 = f / n_frames
        ang = t01 * 2.0 * math.pi
        frame = f + 1

        # 1. Pelvis bounce, pitch wave & spine gather/extension synchronized with gallop
        pelvis_dz = bounce * math.sin(ang - 0.55) - bounce * 0.22
        pelvis_pitch = spine_flex * 0.72 * math.cos(ang - 0.3)
        set_bone_world_loc(arm_obj, 'Pelvis', (0.0, 0.0, pelvis_dz), frame)
        set_bone_world_euler(arm_obj, 'Pelvis', (pelvis_pitch, 0.0, 0.0), frame)

        sp_flex = -spine_flex * math.cos(ang - 0.2)
        set_bone_world_euler(arm_obj, 'Spine', (sp_flex * 0.52, 0.0, 0.0), frame)
        set_bone_world_euler(arm_obj, 'Spine1', (sp_flex * 0.52, 0.0, 0.0), frame)
        set_bone_world_euler(arm_obj, 'Chest', (-pelvis_pitch * 0.65, 0.0, 0.0), frame)

        # Expressive counter-balancing neck stretch & head nod + alert ears
        neck_nod = 8.5 * math.cos(ang - 0.9)
        set_bone_world_euler(arm_obj, 'Neck', (neck_nod * 0.62, 0.0, 0.0), frame)
        set_bone_world_euler(arm_obj, 'Neck1', (neck_nod * 0.52, 0.0, 0.0), frame)
        set_bone_world_euler(arm_obj, 'Head', (-neck_nod * 0.72, 0.0, 0.0), frame)
        set_bone_world_euler(arm_obj, 'Jaw', (1.2 + 1.2 * math.sin(ang), 0.0, 0.0), frame)
        set_bone_world_euler(arm_obj, 'LeftEar', (4.0 * math.sin(ang), 0.0, 3.0 * math.cos(ang)), frame)
        set_bone_world_euler(arm_obj, 'RightEar', (4.0 * math.sin(ang + 0.4), 0.0, -3.0 * math.cos(ang)), frame)

        # Gracefully arched & streaming 4-bone tail wave (positive +X lifts behind rump;
        # distal joints curve gently downward in an S-plume rather than sticking straight!)
        tail_base_lifts = (24.0, 12.0, -4.0, -8.0)
        for idx, tname in enumerate(('Tail1', 'Tail2', 'Tail3', 'Tail4')):
            lag = idx * 0.65
            lift = tail_base_lifts[idx] + 9.0 * math.sin(ang - lag)
            swish = 5.0 * math.sin(ang * 0.5 - lag)
            set_bone_world_euler(arm_obj, tname, (lift, swish, 0.0), frame)

        bpy.context.view_layer.update()

        # 2. Front Legs: Coordinated Scapula + Humerus forward reach (keeps elbow flush in chest!)
        #    + Exact 2-Bone IK (Elbow -> Knee[FORWARD -Y bend!] -> Fetlock) + Hoof
        for side in ('Left', 'Right'):
            ph = (t01 + phases[f'Front{side}']) % 1.0
            hy, hz, in_stance, swing_u = hoof_stride_yz(ph, J['f_fetl'].y - 0.03, stride_len, lift_f, stance_frac)

            # Smooth normalized reach: -1 (foot forward at touchdown) -> +1 (foot back at push-off)
            reach_norm = (hy - (J['f_fetl'].y - 0.03)) / max(0.01, stride_len * 0.5)
            # Negative X rotation swings humerus & elbow FORWARD (-Y) as hoof reaches forward!
            # Keeps shoulder->elbow->forearm flowing in one sleek athletic curve with ZERO elbow spike!
            scap_deg = 8.0 * reach_norm
            hum_deg = 16.0 * reach_norm - (7.0 * math.sin(swing_u * math.pi) if not in_stance else 0.0)
            set_bone_world_euler(arm_obj, f'Front{side}Scapula', (scap_deg, 0.0, 0.0), frame)
            set_bone_world_euler(arm_obj, f'Front{side}UpperArm', (hum_deg, 0.0, 0.0), frame)
            bpy.context.view_layer.update()

            pb_fore = arm_obj.pose.bones[f'Front{side}ForeArm']
            elbow_w = pb_fore.head.copy()
            fetl_tgt = (hy, max(0.145, hz + 0.145))
            # Horse FRONT CARPUS (knee) bends FORWARD (-Y -> bend_sign = -1.0)
            knee_yz = solve_sagittal_2bone((elbow_w.y, elbow_w.z), fetl_tgt, l_f_fore, l_f_can, bend_sign=-1.0)

            dir_fore = Vector((0.0, knee_yz[0] - elbow_w.y, knee_yz[1] - elbow_w.z))
            set_bone_world_direction(arm_obj, f'Front{side}ForeArm', dir_fore, frame)

            dir_can = Vector((0.0, fetl_tgt[0] - knee_yz[0], fetl_tgt[1] - knee_yz[1])).normalized()
            set_bone_world_direction(arm_obj, f'Front{side}Paw', dir_can, frame)

            if in_stance:
                dir_toe = (dir_can * 0.74 + Vector((0.0, -0.45, -0.89)) * 0.26).normalized()
            else:
                tuck = math.sin(swing_u * math.pi)
                fold_q = Quaternion(Vector((1, 0, 0)), math.radians(-24.0 * tuck))
                dir_toe = (fold_q @ dir_can).normalized()
            set_bone_world_direction(arm_obj, f'Front{side}Toe', dir_toe, frame)

        # 3. Hind Legs: Smooth thigh drive + Exact 2-Bone IK (Stifle -> Hock[BACKWARD +Y] -> Fetlock)
        for side in ('Left', 'Right'):
            ph = (t01 + phases[f'Back{side}']) % 1.0
            hy, hz, in_stance, swing_u = hoof_stride_yz(ph, J['b_fetl'].y - 0.03, stride_len * 0.94, lift_b, stance_frac)

            reach_norm = (hy - (J['b_fetl'].y - 0.03)) / max(0.01, stride_len * 0.47)
            thigh_deg = 15.0 * reach_norm
            set_bone_world_euler(arm_obj, f'Back{side}Thigh', (thigh_deg, 0.0, 0.0), frame)
            bpy.context.view_layer.update()

            pb_shin = arm_obj.pose.bones[f'Back{side}Shin']
            stifle_w = pb_shin.head.copy()
            fetl_tgt = (hy, max(0.145, hz + 0.145))
            # Horse HIND HOCK bends BACKWARD (+Y -> bend_sign = +1.0)
            hock_yz = solve_sagittal_2bone((stifle_w.y, stifle_w.z), fetl_tgt, l_b_shin, l_b_can, bend_sign=+1.0)

            dir_shin = Vector((0.0, hock_yz[0] - stifle_w.y, hock_yz[1] - stifle_w.z))
            set_bone_world_direction(arm_obj, f'Back{side}Shin', dir_shin, frame)

            dir_can = Vector((0.0, fetl_tgt[0] - hock_yz[0], fetl_tgt[1] - hock_yz[1])).normalized()
            set_bone_world_direction(arm_obj, f'Back{side}Hock', dir_can, frame)

            if in_stance:
                dir_pas = (dir_can * 0.74 + Vector((0.0, -0.45, -0.89)) * 0.26).normalized()
            else:
                tuck = math.sin(swing_u * math.pi)
                fold_q = Quaternion(Vector((1, 0, 0)), math.radians(-20.0 * tuck))
                dir_pas = (fold_q @ dir_can).normalized()
            set_bone_world_direction(arm_obj, f'Back{side}Paw', dir_pas, frame)
            set_bone_world_direction(arm_obj, f'Back{side}Toe', dir_pas, frame)

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
        frame = f + 1
        set_bone_world_euler(arm_obj, 'Spine', (1.2 * br, 0, 0), frame)
        set_bone_world_euler(arm_obj, 'Neck', (2.5 * br, 3.0 * sw, 0), frame)
        set_bone_world_euler(arm_obj, 'Head', (-2.0 * br, 4.0 * sw, 0), frame)
        set_bone_world_euler(arm_obj, 'LeftEar', (5.0 * sw, 0, 4.0 * br), frame)
        set_bone_world_euler(arm_obj, 'RightEar', (-4.0 * sw, 0, -4.0 * br), frame)
        for idx, tn in enumerate(('Tail1', 'Tail2', 'Tail3', 'Tail4')):
            set_bone_world_euler(arm_obj, tn, (2.0 * br, 7.0 * math.sin(t - idx * 0.5), 0), frame)
    track = arm_obj.animation_data.nla_tracks.new()
    track.name = name
    strip = track.strips.new(name, 1, act)
    strip.name = name
    arm_obj.animation_data.action = None
    reset_pose(arm_obj)
    return act


# ---------------------------------------------------------------------------
# Export & Fast Multi-Frame Verification Render
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
        export_animations=True,
        export_animation_mode='NLA_TRACKS',
        export_nla_strips=True,
        export_optimize_animation_size=True,
        export_def_bones=True,
    )
    print(f'[horse-builder] Exported {out_path} ({os.path.getsize(out_path) / 1024.0:.1f} KB)')


def render_preview(out_png, arm_obj, pose_action=None, frame=1, cam_loc=(3.0, -1.65, 1.38), look_at=(0.0, -0.05, 0.96)):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 2
    scene.render.resolution_x = 640
    scene.render.resolution_y = 480

    prev_mutes = []
    if arm_obj.animation_data:
        for tr in arm_obj.animation_data.nla_tracks:
            prev_mutes.append((tr, tr.mute))
            tr.mute = True
        arm_obj.animation_data.action = pose_action
    if pose_action is None:
        reset_pose(arm_obj)
    scene.frame_set(frame)

    created = []
    world = bpy.data.worlds.new('HorsePreviewWorld')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    if bg:
        bg.inputs[0].default_value = (0.06, 0.072, 0.095, 1.0)
        bg.inputs[1].default_value = 0.85

    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=3.2, depth=0.02, location=(0, 0, -0.01))
    floor = bpy.context.active_object
    floor.data.materials.append(make_material('StudioFloor', (0.12, 0.135, 0.16), roughness=0.65))
    created.append(floor)

    def add_area(name, loc, target, energy, size, color):
        ld = bpy.data.lights.new(name, type='AREA')
        ld.energy = energy
        ld.size = size
        ld.color = color
        lo = bpy.data.objects.new(name, ld)
        bpy.context.collection.objects.link(lo)
        lo.location = Vector(loc)
        lo.rotation_euler = (Vector(target) - lo.location).to_track_quat('-Z', 'Y').to_euler()
        created.append(lo)

    add_area('Key', (3.2, -2.5, 3.0), (0, 0, 1.0), 420, 2.5, (1.0, 0.96, 0.90))
    add_area('Fill', (-3.0, -2.0, 1.8), (0, 0, 1.0), 180, 3.0, (0.78, 0.88, 1.0))
    add_area('Rim', (-1.8, 3.0, 2.6), (0, 0, 1.1), 300, 2.2, (0.88, 0.94, 1.0))

    cam_data = bpy.data.cameras.new('PreviewCam')
    cam_data.lens = 52
    cam_obj = bpy.data.objects.new('PreviewCam', cam_data)
    bpy.context.collection.objects.link(cam_obj)
    cam_obj.location = Vector(cam_loc)
    cam_obj.rotation_euler = (Vector(look_at) - cam_obj.location).to_track_quat('-Z', 'Y').to_euler()
    scene.camera = cam_obj
    created.append(cam_obj)

    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    scene.render.filepath = out_png
    bpy.ops.render.render(write_still=True)
    print(f'[horse-builder] Rendered {out_png}')

    for o in created:
        bpy.data.objects.remove(o, do_unlink=True)
    if arm_obj.animation_data:
        arm_obj.animation_data.action = None
        for tr, m in prev_mutes:
            tr.mute = m


def main():
    render_dir = parse_args()
    reset_scene()

    # 4 clean materials (NO sheen bloom halo! Coat uses smooth linear vertex colors `Col`)
    mat_coat = make_material('Horse_BayCoat', (1.0, 1.0, 1.0), metallic=0.0, roughness=0.64, coat=0.0, use_vertex_color=True)
    mat_mane = make_material('Horse_DarkMane', (0.018, 0.012, 0.009), metallic=0.0, roughness=0.72, coat=0.0)
    mat_hoof = make_material('Horse_Hoof', (0.025, 0.022, 0.020), metallic=0.04, roughness=0.30, coat=0.35)
    mat_eye  = make_material('Horse_Eye', (0.010, 0.008, 0.006), metallic=0.02, roughness=0.05, coat=0.85)
    mats = [mat_coat, mat_mane, mat_hoof, mat_eye]

    bone_specs = get_horse_bone_specs()
    arm_obj = build_armature('Armature', bone_specs)

    body = build_seamless_horse_body(mats)
    extras = build_mane_tail_eyes(mats)
    horse_mesh = skin_and_join_horse([body, *extras], arm_obj, bone_specs)
    print(f'[horse-builder] Horse_CC0: verts={len(horse_mesh.data.vertices)}, polys={len(horse_mesh.data.polygons)}, bones={len(arm_obj.data.bones)}')

    # Bake Gallop (4-beat Muybridge), Trot (2-beat diagonal), and Idle
    gallop = create_equine_gait_action(
        arm_obj,
        name='Gallop',
        n_frames=24,
        stride_len=0.74,
        lift_f=0.28,
        lift_b=0.24,
        stance_frac=0.38,
        phases={'BackLeft': 0.00, 'BackRight': 0.18, 'FrontLeft': 0.48, 'FrontRight': 0.68},
        bounce=0.050,
        spine_flex=5.8,
    )
    create_equine_gait_action(
        arm_obj,
        name='Trot',
        n_frames=24,
        stride_len=0.54,
        lift_f=0.18,
        lift_b=0.16,
        stance_frac=0.48,
        phases={'BackLeft': 0.00, 'FrontRight': 0.00, 'BackRight': 0.50, 'FrontLeft': 0.50},
        bounce=0.030,
        spine_flex=2.5,
    )
    create_idle_action(arm_obj, name='Idle', n_frames=60)

    export_glb(OUT_HORSE)

    if render_dir:
        render_preview(os.path.join(render_dir, 'horse_v4_rest.png'), arm_obj, pose_action=None, frame=1, cam_loc=(3.80, -2.15, 1.48), look_at=(0.0, -0.10, 1.02))
        render_preview(os.path.join(render_dir, 'horse_v4_gallop_f01.png'), arm_obj, pose_action=gallop, frame=1, cam_loc=(4.25, -0.25, 1.25), look_at=(0.0, -0.08, 0.98))
        render_preview(os.path.join(render_dir, 'horse_v4_gallop_f07.png'), arm_obj, pose_action=gallop, frame=7, cam_loc=(4.25, -0.25, 1.25), look_at=(0.0, -0.08, 0.98))
        render_preview(os.path.join(render_dir, 'horse_v4_gallop_f13.png'), arm_obj, pose_action=gallop, frame=13, cam_loc=(4.25, -0.25, 1.25), look_at=(0.0, -0.08, 0.98))
        render_preview(os.path.join(render_dir, 'horse_v4_gallop_f19.png'), arm_obj, pose_action=gallop, frame=19, cam_loc=(4.25, -0.25, 1.25), look_at=(0.0, -0.08, 0.98))


if __name__ == '__main__':
    main()

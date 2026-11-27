"""Headless Blender script: converts a .blend file to .glb + JSON report.

Invoked by blend_converter.py:
    blender -b input.blend --factory-startup --python scripts/blend_to_glb.py -- out.glb report.json [--apply-modifiers]
"""

import json
import os
import sys


def parse_args():
    argv = sys.argv
    if "--" not in argv:
        raise RuntimeError("Expected '-- out.glb report.json' arguments")
    args = argv[argv.index("--") + 1 :]
    if len(args) < 2:
        raise RuntimeError("Usage: ... -- <out_glb> <report_json> [--apply-modifiers]")
    return {
        "out_glb": os.path.abspath(args[0]),
        "report_json": os.path.abspath(args[1]),
        "apply_modifiers": "--apply-modifiers" in args[2:],
    }


def collect_report(bpy):
    scene = bpy.context.scene
    meshes = [o for o in scene.objects if o.type == "MESH"]
    armatures = [o for o in scene.objects if o.type == "ARMATURE"]
    lights = [o for o in scene.objects if o.type == "LIGHT"]
    cameras = [o for o in scene.objects if o.type == "CAMERA"]
    curves = [o for o in scene.objects if o.type in ("CURVE", "FONT", "SURFACE")]
    warnings = []

    for obj in scene.objects:
        for mod in getattr(obj, "modifiers", []):
            if mod.type == "NODES":
                warnings.append(f"{obj.name}: Geometry Nodes modifier may require Apply Modifiers.")
            elif mod.type in ("FLUID", "CLOTH", "SOFT_BODY"):
                warnings.append(f"{obj.name}: Physics simulation modifier ({mod.type}) is not exported dynamically to glTF.")

    for mat in bpy.data.materials:
        if not mat.use_nodes or not mat.node_tree:
            continue
        for node in mat.node_tree.nodes:
            if node.type in ("TEX_NOISE", "TEX_VORONOI", "TEX_MUSGRAVE", "TEX_WAVE", "SHADER_TO_RGB"):
                warnings.append(f"Material '{mat.name}': procedural node '{node.type}' cannot map 1:1 to glTF PBR without baking.")
                break

    return {
        "blenderVersion": ".".join(str(v) for v in bpy.app.version),
        "sceneName": scene.name,
        "meshCount": len(meshes),
        "armatureCount": len(armatures),
        "lightCount": len(lights),
        "cameraCount": len(cameras),
        "curveCount": len(curves),
        "actionCount": len(bpy.data.actions),
        "warnings": warnings[:25],
    }


def main():
    import bpy  # noqa: F401 - available inside Blender

    opts = parse_args()
    report = collect_report(bpy)

    export_kwargs = {
        "filepath": opts["out_glb"],
        "export_format": "GLB",
        "export_apply": bool(opts["apply_modifiers"]),
        "export_animations": True,
        "export_skins": True,
        "export_morph": True,
        "export_lights": True,
        "export_cameras": True,
        "export_materials": "EXPORT",
        "export_texcoords": True,
        "export_normals": True,
    }

    # Filter kwargs dynamically across Blender 3.x / 4.x operator RNA properties.
    try:
        rna_props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
        filtered = {k: v for k, v in export_kwargs.items() if k in rna_props}
    except Exception:
        filtered = export_kwargs

    bpy.ops.export_scene.gltf(**filtered)

    with open(opts["report_json"], "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()

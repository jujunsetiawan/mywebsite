"""Build the Act II night-office scene (Jun's desk at 03:07) and save it as a .blend.

Usage (headless only; script arguments go after ``--``):

    $env:JFILM_LIBRARY = "C:\\Users\\Jun\\jfilm-library"
    blender -b --factory-startup -P pipeline/build_act2_scene.py -- --out pipeline/out/scenes
        [--name act2_desk_0307.blend] [--samples 64] [--allow-version-mismatch]

The scene is assembled fully by script: CC0 library assets (Poly Haven, fetched
by ``pipeline/fetch_assets.py`` into ``$JFILM_LIBRARY``) are appended with
absolute file paths so the licence gate can match them against
``licenses/assets.yaml``; everything else (monitor, keyboard, mouse, mug,
chairs, partitions, window wall, Kia's sticky note) is procedural and
references no file. The sticky-note text uses the Inter font bundled with
Blender (OFL-1.1, listed in licenses/assets.yaml) and is converted to a mesh,
so the saved file references no font.

Contents: open-plan office (carpet, plaster walls, ceiling), hero desk plus dark
colleague desks (instanced), desk props, wall clock at 03:07, desk lamp (off),
emissive-only monitor as the warm key light (#F2D3A8, no text), cold coffee,
curtain wall with procedural rain on the glass, a layered night exterior (lit
city in three depth bands, warm haze, dim Mt. Fuji, overcast procedural sky),
and two cameras: ``CAM_16x9`` (1920x1080) and ``CAM_9x16`` (portrait sensor,
1080x1920).

Exit codes: 0 ok, 1 usage / JFILM_LIBRARY unset / library asset missing,
3 version mismatch, 4 build or save failed, 5 bad pipeline/BLENDER_VERSION.
"""

from __future__ import annotations

import math
import os
import sys
import traceback
from pathlib import Path
from typing import NoReturn

PIPELINE_DIR = Path(__file__).resolve().parent
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))

from lib import licence_gate as lg  # noqa: E402
from lib import toolchain as tc  # noqa: E402

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402

PROG = "build_act2_scene.py"
DEFAULT_NAME = "act2_desk_0307.blend"
SCENE_TAG = "act2_desk_0307"

# ------------------------------------------------------------------ Palette
MONITOR_HEX = "#F2D3A8"
COFFEE_HEX = "#4A2F1E"
WALNUT_HEX = "#3A2A1C"
NIGHT_HEX = "#0F2226"
ZENITH_HEX = "#050C12"
HORIZON_HEX = "#12232A"
CITY_HAZE_HEX = "#8E6E56"  # sodium/LED light pollution under the cloud deck (restrained)
TEAL_AMBIENT_HEX = "#4E8A92"
NOTE_PINK_HEX = "#F29BB4"
INK_HEX = "#1E2547"

# Clock time shown on the wall clock.
CLOCK_H, CLOCK_M, CLOCK_S = 3, 7, 41

# ------------------------------------------------------------------ Layout (metres)
# X right, Y forward (towards the window wall), Z up. Jun sits at y < 0 facing +Y.
DESK_METAL_TOP_Z = 0.788  # metal_office_desk top surface
DESK_SLAB_T = 0.022  # walnut-tinted top laid on every desk
DESK_TOP_Z = DESK_METAL_TOP_Z + DESK_SLAB_T
# Exterior: Jun's office is high up; street level is EXTERIOR_GROUND_Z below the floor.
EXTERIOR_GROUND_Z = -60.0
EYE_Z = 1.21
# Light balance (tuned on 16-sample previews).
SKY_STRENGTH = 3.0
WINDOW_GLOW_W = 140.0
SCREEN_EMISSION = 0.9
MONITOR_KEY_W = 22.0
FUJI_DIST, FUJI_PEAK_ELEV_DEG = 9000.0, 6.0  # art-directed (real Fuji would be ~2 deg)
ROOM_X = (-5.0, 5.0)
ROOM_Y = (-3.0, 8.0)  # y = 8 is the window wall
CEILING_Z = 2.8
SILL_Z, HEAD_Z = 0.85, 2.62
COLUMN_CENTRE = (-0.05, 2.55)
COLUMN_SIZE = 0.5
CLOCK_Z = 1.78

# Library assets: id -> blend file relative to $JFILM_LIBRARY.
LIB_FILES = {
    "polyhaven-metal_office_desk": "polyhaven/metal_office_desk/metal_office_desk_2k.blend",
    "polyhaven-wall_clock": "polyhaven/wall_clock/wall_clock_2k.blend",
    "polyhaven-desk_lamp_arm_01": "polyhaven/desk_lamp_arm_01/desk_lamp_arm_01_1k.blend",
    "polyhaven-office_notepads": "polyhaven/office_notepads/office_notepads_1k.blend",
    "polyhaven-binder_notebook": "polyhaven/binder_notebook/binder_notebook_1k.blend",
    "polyhaven-stationery_supplies": "polyhaven/stationery_supplies/stationery_supplies_1k.blend",
    "polyhaven-potted_plant_04": "polyhaven/potted_plant_04/potted_plant_04_1k.blend",
    "polyhaven-potted_plant_02": "polyhaven/potted_plant_02/potted_plant_02_1k.blend",
    "polyhaven-drawer_cabinet": "polyhaven/drawer_cabinet/drawer_cabinet_1k.blend",
    "polyhaven-dirty_carpet": "polyhaven/dirty_carpet/dirty_carpet_2k.blend",
    "polyhaven-ceiling_interior": "polyhaven/ceiling_interior/ceiling_interior_1k.blend",
    "polyhaven-painted_plaster_wall": "polyhaven/painted_plaster_wall/painted_plaster_wall_1k.blend",
    "ambientcg-Facade009": "ambientcg/Facade009/Facade009_1K-JPG.blend",
    "ambientcg-Facade005": "ambientcg/Facade005/Facade005_1K-JPG.blend",
    "ambientcg-Wood094": "ambientcg/Wood094/Wood094_1K-JPG.blend",
}
# Real-world tile size (m) of the library surface materials (polyhaven_info.json;
# ambientCG sizes estimated from the texture: Facade009 shows 16 storeys of ~3.5 m).
TILE_M = {
    "dirty_carpet": 0.6,
    "ceiling_interior": 2.0,
    "painted_plaster_wall": 2.0,
    "Facade009": 56.0,
    "Facade005": 30.0,
    "Wood094": 1.2,
}
# Sky: kloppenheim_07_puresky was checked (2026-11-20) and rejected for this frame: it
# has a moon behind thin cloud (peak luminance 14.8 at px 1227,294 of 2048x1024) and
# visible stars in a clear patch. The world is a procedural overcast gradient instead.


def log(message: str) -> None:
    print(f"[build_act2_scene] {message}", flush=True)


def fail(code: int, message: str) -> NoReturn:
    print(f"[build_act2_scene] ERROR: {message}", file=sys.stderr, flush=True)
    sys.exit(code)


def add_build_arguments(parser) -> None:
    """Parser ``extend`` hook: output file name inside ``--out``."""
    parser.add_argument(
        "--name",
        default=DEFAULT_NAME,
        help="output .blend file name inside --out (default %(default)s)",
    )


# ================================================================== helpers


def srgb(hex_colour: str, alpha: float = 1.0) -> tuple[float, float, float, float]:
    """``#RRGGBB`` (sRGB) -> linear RGBA for shader sockets."""
    h = hex_colour.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i : i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (out[0], out[1], out[2], alpha)


def _tree(idblock):
    if getattr(idblock, "node_tree", None) is None and hasattr(idblock, "use_nodes"):
        idblock.use_nodes = True
    return idblock.node_tree


def _principled(mat):
    return next(n for n in _tree(mat).nodes if n.type == "BSDF_PRINCIPLED")


def mat_principled(name, hex_colour, roughness=0.5, metallic=0.0, **inputs):
    mat = bpy.data.materials.new(name)
    bsdf = _principled(mat)
    bsdf.inputs["Base Color"].default_value = srgb(hex_colour)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    for key, value in inputs.items():
        bsdf.inputs[key.replace("_", " ")].default_value = value
    mat["jfilm_source"] = "procedural"
    return mat


def mat_emission_only(name, hex_colour, strength):
    """Pure emission shader (no BSDF, no texture): the monitor screen."""
    mat = bpy.data.materials.new(name)
    tree = _tree(mat)
    for node in list(tree.nodes):
        if node.type != "OUTPUT_MATERIAL":
            tree.nodes.remove(node)
    out = next(n for n in tree.nodes if n.type == "OUTPUT_MATERIAL")
    emit = tree.nodes.new("ShaderNodeEmission")
    emit.inputs["Color"].default_value = srgb(hex_colour)
    emit.inputs["Strength"].default_value = strength
    tree.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    mat["jfilm_source"] = "procedural"
    return mat


def mat_paper(name, hex_colour, translucency=0.45):
    """Thin paper: diffuse mixed with translucency so a lit screen glows through."""
    mat = bpy.data.materials.new(name)
    tree = _tree(mat)
    for node in list(tree.nodes):
        if node.type != "OUTPUT_MATERIAL":
            tree.nodes.remove(node)
    out = next(n for n in tree.nodes if n.type == "OUTPUT_MATERIAL")
    diffuse = tree.nodes.new("ShaderNodeBsdfPrincipled")
    diffuse.inputs["Base Color"].default_value = srgb(hex_colour)
    diffuse.inputs["Roughness"].default_value = 0.85
    trans = tree.nodes.new("ShaderNodeBsdfTranslucent")
    trans.inputs["Color"].default_value = srgb(hex_colour)
    mix = tree.nodes.new("ShaderNodeMixShader")
    mix.inputs["Fac"].default_value = translucency
    tree.links.new(diffuse.outputs[0], mix.inputs[1])
    tree.links.new(trans.outputs[0], mix.inputs[2])
    tree.links.new(mix.outputs[0], out.inputs["Surface"])
    mat["jfilm_source"] = "procedural"
    return mat


class NB:
    """Tiny shader-node builder: ``nb.math('MULTIPLY', a, b)`` accepts sockets or numbers."""

    def __init__(self, tree):
        self.tree = tree

    def node(self, bl_idname, **props):
        node = self.tree.nodes.new(bl_idname)
        for key, value in props.items():
            setattr(node, key, value)
        return node

    def feed(self, socket, value) -> None:
        if isinstance(value, bpy.types.NodeSocket):
            self.tree.links.new(value, socket)
        else:
            socket.default_value = value

    def math(self, op, a, b=None, c=None, *, clamp=False):
        node = self.node("ShaderNodeMath", operation=op, use_clamp=clamp)
        for i, value in enumerate((a, b, c)):
            if value is not None:
                self.feed(node.inputs[i], value)
        return node.outputs[0]

    def vmath(self, op, a, b=None):
        node = self.node("ShaderNodeVectorMath", operation=op)
        self.feed(node.inputs[0], a)
        if b is not None:
            self.feed(node.inputs[1], b)
        return node.outputs["Value"] if op in {"DOT_PRODUCT", "LENGTH", "DISTANCE"} else node.outputs["Vector"]

    def map_range(self, value, from_min, from_max, to_min=0.0, to_max=1.0):
        node = self.node("ShaderNodeMapRange", clamp=True)
        for name, v in (("Value", value), ("From Min", from_min), ("From Max", from_max),
                        ("To Min", to_min), ("To Max", to_max)):
            self.feed(node.inputs[name], v)
        return node.outputs["Result"]

    def sep(self, vector):
        node = self.node("ShaderNodeSeparateXYZ")
        self.feed(node.inputs[0], vector)
        return node.outputs

    def combine(self, x, y, z):
        node = self.node("ShaderNodeCombineXYZ")
        for i, v in enumerate((x, y, z)):
            self.feed(node.inputs[i], v)
        return node.outputs[0]

    def noise(self, vector, scale, detail=2.0, roughness=0.5):
        node = self.node("ShaderNodeTexNoise")
        self.feed(node.inputs["Vector"], vector)
        node.inputs["Scale"].default_value = scale
        node.inputs["Detail"].default_value = detail
        node.inputs["Roughness"].default_value = roughness
        return node.outputs["Fac"]

    def voronoi(self, vector, scale):
        node = self.node("ShaderNodeTexVoronoi", voronoi_dimensions="3D", feature="F1")
        self.feed(node.inputs["Vector"], vector)
        node.inputs["Scale"].default_value = scale
        return node.outputs["Distance"], node.outputs["Color"]

    def white_noise(self, vector):
        node = self.node("ShaderNodeTexWhiteNoise", noise_dimensions="3D")
        self.feed(node.inputs["Vector"], vector)
        return node.outputs["Value"]

    def ramp(self, value, stops):
        """``stops``: [(position, linear RGBA)]."""
        node = self.node("ShaderNodeValToRGB")
        self.feed(node.inputs["Fac"], value)
        elements = node.color_ramp.elements
        while len(elements) < len(stops):
            elements.new(0.5)
        for element, (pos, rgba) in zip(elements, stops):
            element.position, element.color = pos, rgba
        return node.outputs["Color"]

    def output(self):
        return next(n for n in self.tree.nodes if n.type in {"OUTPUT_MATERIAL", "OUTPUT_WORLD"})


def _fresh_material(name):
    mat = bpy.data.materials.new(name)
    tree = _tree(mat)
    for node in list(tree.nodes):
        if node.type != "OUTPUT_MATERIAL":
            tree.nodes.remove(node)
    mat["jfilm_source"] = "procedural"
    return mat, NB(tree)


def mat_rain_glass():
    """Window glass with rain: droplets (two Voronoi scales) + winding rivulets.

    Height drives a bump on the OUTSIDE face only (one-sided bump keeps the
    refraction offset, so city lights smear through drops). Fully procedural.
    """
    mat, nb = _fresh_material("PROC_window_glass_rain")
    obj = nb.node("ShaderNodeTexCoord").outputs["Object"]  # metres on the glass

    def drops(scale, r_min, r_span):
        dist, colour = nb.voronoi(obj, scale)
        radius = nb.math("MULTIPLY_ADD", nb.sep(colour)[0], r_span, r_min)
        return nb.math("POWER", nb.map_range(dist, 0.0, radius, 1.0, 0.0), 0.6)

    big, small = drops(55.0, 0.10, 0.28), drops(190.0, 0.08, 0.22)
    # Rivulets: thin bands of a noise field stretched vertically, broken into runs.
    stretched = nb.vmath("MULTIPLY", obj, (14.0, 14.0, 0.45))
    field = nb.noise(stretched, 1.0, 3.0, 0.55)
    band = nb.map_range(nb.math("ABSOLUTE", nb.math("SUBTRACT", field, 0.5)), 0.0, 0.009, 1.0, 0.0)
    runs = nb.map_range(nb.noise(nb.vmath("MULTIPLY", obj, (3.0, 3.0, 0.7)), 1.0, 1.0), 0.52, 0.6)
    streak = nb.math("MULTIPLY", band, runs)
    height = nb.math("MAXIMUM", nb.math("MAXIMUM", big, small), nb.math("MULTIPLY", streak, 0.4))

    # Outer face = object y > 0 (shading normals flip towards the ray, so they can't tell).
    outside = nb.math("GREATER_THAN", nb.sep(obj)[1], 0.0)
    bump = nb.node("ShaderNodeBump")
    nb.feed(bump.inputs["Strength"], outside)
    bump.inputs["Distance"].default_value = 0.006
    nb.feed(bump.inputs["Height"], height)

    bsdf = nb.node("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = srgb("#DDE6E8")
    bsdf.inputs["Transmission Weight"].default_value = 1.0
    bsdf.inputs["IOR"].default_value = 1.45
    # Faint film between drops softens the city; the drops themselves stay clear.
    nb.feed(bsdf.inputs["Roughness"], nb.map_range(height, 0.0, 0.3, 0.012, 0.0))
    nb.feed(bsdf.inputs["Normal"], bump.outputs["Normal"])
    nb.feed(nb.output().inputs["Surface"], bsdf.outputs["BSDF"])
    mat["jfilm_note"] = "procedural rain: droplets + rivulets (bump on outside face), no image file"
    return mat


def mat_haze(name, hex_colour, strength, max_alpha, z_full, z_zero, power=1.6):
    """Emissive fog card: opaque-ish at ``z_full`` fading to clear at ``z_zero`` (object z)."""
    mat, nb = _fresh_material(name)
    z = nb.sep(nb.node("ShaderNodeTexCoord").outputs["Object"])[2]
    alpha = nb.math("MULTIPLY", nb.math("POWER", nb.map_range(z, z_full, z_zero, 1.0, 0.0), power), max_alpha)
    emit = nb.node("ShaderNodeEmission")
    emit.inputs["Color"].default_value = srgb(hex_colour)
    emit.inputs["Strength"].default_value = strength
    clear = nb.node("ShaderNodeBsdfTransparent")
    mix = nb.node("ShaderNodeMixShader")
    nb.feed(mix.inputs["Fac"], alpha)
    nb.feed(mix.inputs[1], clear.outputs[0])
    nb.feed(mix.inputs[2], emit.outputs[0])
    nb.feed(nb.output().inputs["Surface"], mix.outputs[0])
    if hasattr(mat, "blend_method"):
        mat.blend_method = "BLEND"
    return mat


def mat_mountain(name, base_hex, snow_hex, strength, z_base, z_peak, snow_from=None):
    """Unlit silhouette (emission only); optional dim snow cap with gullies above ``snow_from``."""
    mat, nb = _fresh_material(name)
    co = nb.node("ShaderNodeTexCoord").outputs["Object"]
    x, _, z = nb.sep(co)
    t = nb.map_range(z, z_base, z_peak)
    emit = nb.node("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = strength
    if snow_from is None:
        emit.inputs["Color"].default_value = srgb(base_hex)
    else:
        gullies = nb.noise(nb.vmath("MULTIPLY", co, (1 / 60.0, 1 / 60.0, 1 / 600.0)), 1.0, 4.0, 0.6)
        jitter = nb.math("MULTIPLY", nb.math("SUBTRACT", gullies, 0.5), 0.22)
        snowline = nb.math("ADD", t, jitter)
        nb.feed(emit.inputs["Color"], nb.ramp(snowline, [
            (0.0, srgb(base_hex)), (snow_from, srgb(base_hex)),
            (snow_from + 0.05, srgb(snow_hex)), (1.0, srgb(snow_hex)),
        ]))
    nb.feed(nb.output().inputs["Surface"], emit.outputs[0])
    return mat


def build_sky_world(scene, strength=1.0):
    """Overcast night: zenith #050C12 -> horizon #12232A, warm haze at the horizon,
    low-contrast cloud texture. Procedural, so no stars and no moon by construction."""
    world = bpy.data.worlds.new("World_Overcast_Night")
    scene.world = world
    tree = _tree(world)
    for node in list(tree.nodes):
        if node.type != "OUTPUT_WORLD":
            tree.nodes.remove(node)
    nb = NB(tree)
    direction = nb.vmath("NORMALIZE", nb.node("ShaderNodeTexCoord").outputs["Generated"])
    elev = nb.sep(direction)[2]
    haze_horizon = tuple(0.75 * a + 0.25 * b for a, b in zip(srgb(HORIZON_HEX), srgb(CITY_HAZE_HEX)))
    colour = nb.ramp(nb.map_range(elev, -0.05, 0.6), [
        (0.0, haze_horizon), (0.12, haze_horizon), (0.2, srgb(HORIZON_HEX)), (1.0, srgb(ZENITH_HEX)),
    ])
    clouds = nb.noise(nb.vmath("MULTIPLY", direction, (1.0, 1.0, 2.5)), 2.2, 8.0, 0.62)
    cloud_gain = nb.map_range(clouds, 0.3, 0.7, 0.7, 1.3)
    bg = nb.node("ShaderNodeBackground")
    nb.feed(bg.inputs["Color"], colour)
    nb.feed(bg.inputs["Strength"], nb.math("MULTIPLY", cloud_gain, strength))
    nb.feed(nb.output().inputs["Surface"], bg.outputs[0])
    world["jfilm_source"] = "procedural (HDRI kloppenheim_07_puresky rejected: moon + stars)"
    world["jfilm_strength"] = strength
    return world


def adapt_facade009(mat, emission_strength):
    """Night city facade: keep ~half of the lit windows (per-bay random mask, varies per
    building via Object Info random), warm the cold whites slightly."""
    nb = NB(mat.node_tree)
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    socket = bsdf.inputs["Emission Color"]
    src = socket.links[0].from_socket
    uv = nb.node("ShaderNodeTexCoord").outputs["UV"]
    rnd = nb.node("ShaderNodeObjectInfo").outputs["Random"]
    u, v, _ = nb.sep(uv)
    cell = nb.combine(nb.math("FLOOR", nb.math("MULTIPLY", u, 9.0)), nb.math("FLOOR", nb.math("MULTIPLY", v, 16.0)),
                      nb.math("MULTIPLY", rnd, 97.0))
    keep = nb.math("GREATER_THAN", nb.white_noise(cell), 0.5)
    tinted = nb.vmath("MULTIPLY", src, (1.0, 0.86, 0.68))
    nb.feed(socket, nb.vmath("MULTIPLY", tinted, nb.combine(keep, keep, keep)))
    bsdf.inputs["Emission Strength"].default_value = emission_strength
    mat["jfilm_note"] = "ambientCG Facade009, lit-window mask + warm tint (night 03:07)"


def adapt_facade005(mat, emission_strength):
    """Glass curtain wall at night: darken the daytime reflections, add sparse lit cells."""
    nb = NB(mat.node_tree)
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    base = bsdf.inputs["Base Color"]
    src = base.links[0].from_socket
    nb.feed(base, nb.vmath("MULTIPLY", src, (0.16, 0.18, 0.2)))
    uv = nb.node("ShaderNodeTexCoord").outputs["UV"]
    rnd = nb.node("ShaderNodeObjectInfo").outputs["Random"]
    u, v, _ = nb.sep(uv)
    cell = nb.combine(nb.math("FLOOR", nb.math("MULTIPLY", u, 22.0)), nb.math("FLOOR", nb.math("MULTIPLY", v, 30.0)),
                      nb.math("MULTIPLY", rnd, 53.0))
    lit = nb.math("GREATER_THAN", nb.white_noise(cell), 0.86)
    warm = nb.math("GREATER_THAN", nb.white_noise(nb.vmath("ADD", cell, (0.5, 7.0, 3.0))), 0.4)
    colour = nb.node("ShaderNodeMix", data_type="RGBA")
    nb.feed(colour.inputs["Factor"], warm)
    nb.feed(next(s for s in colour.inputs if s.name == "A" and s.type == "RGBA"), srgb("#C9DDE4"))
    nb.feed(next(s for s in colour.inputs if s.name == "B" and s.type == "RGBA"), srgb("#F2C99A"))
    result = next(s for s in colour.outputs if s.type == "RGBA")
    nb.feed(bsdf.inputs["Emission Color"], nb.vmath("MULTIPLY", result, nb.combine(lit, lit, lit)))
    bsdf.inputs["Emission Strength"].default_value = emission_strength
    mat["jfilm_note"] = "ambientCG Facade005 darkened to night glass + sparse procedural lit cells"


def tint_to_walnut(mat):
    """Keep Wood094's grain (luminance) but take the hue/value of walnut #3A2A1C."""
    nb = NB(mat.node_tree)
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    base = bsdf.inputs["Base Color"]
    src = base.links[0].from_socket
    bw = nb.node("ShaderNodeRGBToBW")
    nb.feed(bw.inputs[0], src)
    grain = nb.math("MULTIPLY", bw.outputs[0], 2.2)
    nb.feed(base, nb.vmath("MULTIPLY", srgb(WALNUT_HEX)[:3], nb.combine(grain, grain, grain)))
    mat["jfilm_note"] = "ambientCG Wood094 tinted to walnut #3A2A1C"


def get_collection(name, parent=None):
    col = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if parent is not None and col.name not in parent.children:
        parent.children.link(col)
    return col


def mesh_object(name, bm, collection, location=(0, 0, 0), material=None, smooth=False):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        for poly in me.polygons:
            poly.use_smooth = True
    obj = bpy.data.objects.new(name, me)
    obj.location = location
    if material is not None:
        me.materials.append(material)
    collection.objects.link(obj)
    obj["jfilm_source"] = "procedural"
    return obj


def box(name, size, location, collection, material=None, bevel=0.0, world_uv_tile=None):
    """Axis-aligned box centred on ``location`` (size = full extents)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    if world_uv_tile:
        _world_uv(bm, Vector(location), world_uv_tile)
    obj = mesh_object(name, bm, collection, location, material)
    if bevel > 0:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = "ANGLE"
    return obj


def _world_uv(bm, offset: Vector, tile: float, shift=(0.0, 0.0)) -> None:
    """Box-project UVs in world metres / ``tile`` so textures keep real scale."""
    uv = bm.loops.layers.uv.verify()
    for face in bm.faces:
        n = face.normal
        axis = max(range(3), key=lambda i: abs(n[i]))
        a, b = [(1, 2), (0, 2), (0, 1)][axis]
        for loop in face.loops:
            co = loop.vert.co + offset
            loop[uv].uv = (co[a] / tile + shift[0], co[b] / tile + shift[1])


def cylinder(name, radius, depth, location, collection, material=None, segments=32, smooth=True):
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius, depth=depth
    )
    return mesh_object(name, bm, collection, location, material, smooth)


def look_at(obj, target) -> None:
    direction = Vector(target) - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def local_min_z(obj) -> float:
    # From mesh data: bound_box is not reliable before the first depsgraph evaluation.
    return min(v.co.z for v in obj.data.vertices)


def place_on(obj, x, y, top_z, rot_z_deg=0.0) -> None:
    """Stand ``obj`` (Z-up asset) on a surface at height ``top_z``."""
    obj.rotation_euler = (0.0, 0.0, math.radians(rot_z_deg))
    obj.location = (x, y, top_z - local_min_z(obj) * obj.scale.z)


# ================================================================== library


class Library:
    """Appends objects/collections/materials from the CC0 asset library."""

    def __init__(self, root: Path):
        self.root = root
        self.cache: dict = {}

    def path(self, asset_id: str) -> str:
        return str(self.root / LIB_FILES[asset_id])

    def missing_files(self) -> list[str]:
        return [f"{aid}: {self.path(aid)}" for aid in LIB_FILES if not os.path.isfile(self.path(aid))]

    def collection(self, asset_id: str, name: str):
        """Append a whole collection once (not linked to the scene; used for instancing)."""
        key = (asset_id, "COL", name)
        if key not in self.cache:
            with bpy.data.libraries.load(self.path(asset_id), link=False) as (src, dst):
                if name not in src.collections:
                    raise RuntimeError(f"{asset_id}: collection {name!r} not in {self.path(asset_id)}")
                dst.collections = [name]
            col = dst.collections[0]
            col.name = f"LIB_{name}"
            for obj in col.all_objects:
                obj["jfilm_asset_id"] = asset_id
            self.cache[key] = col
        return self.cache[key]

    def objects(self, asset_id: str, names: list[str], collection):
        """Append individual objects (fresh copies each call) and link them to ``collection``."""
        with bpy.data.libraries.load(self.path(asset_id), link=False) as (src, dst):
            missing = [n for n in names if n not in src.objects]
            if missing:
                raise RuntimeError(f"{asset_id}: objects {missing} not in {self.path(asset_id)}")
            dst.objects = list(names)
        result = {}
        for name, obj in zip(names, dst.objects):
            collection.objects.link(obj)
            obj["jfilm_asset_id"] = asset_id
            result[name] = obj
        return result

    def material(self, asset_id: str, name: str):
        key = (asset_id, "MAT", name)
        if key not in self.cache:
            with bpy.data.libraries.load(self.path(asset_id), link=False) as (src, dst):
                dst.materials = [name]
            mat = dst.materials[0]
            mat["jfilm_asset_id"] = asset_id
            self.cache[key] = mat
        return self.cache[key]


def instance(name, collection_src, location, rot_z_deg, parent_col, asset_id=None):
    empty = bpy.data.objects.new(name, None)
    empty.instance_type = "COLLECTION"
    empty.instance_collection = collection_src
    empty.location = location
    empty.rotation_euler = (0.0, 0.0, math.radians(rot_z_deg))
    empty.empty_display_size = 0.2
    if asset_id:
        empty["jfilm_asset_id"] = asset_id
    else:
        empty["jfilm_source"] = "procedural"
    parent_col.objects.link(empty)
    return empty


# ================================================================== scene parts


class Mats:
    """Procedural materials shared across the scene."""

    def __init__(self):
        self.plastic_dark = mat_principled("PROC_plastic_dark", "#1B1D20", 0.45)
        self.plastic_mid = mat_principled("PROC_plastic_keys", "#2A2C30", 0.55)
        self.screen_off = mat_principled("PROC_screen_off", "#060708", 0.12, Specular_IOR_Level=0.6)
        # Low enough that the screen itself reads warm #F2D3A8, not clipped white;
        # the desk key comes mostly from the matching area light in build_hero_desk.
        self.screen_on = mat_emission_only("PROC_screen_emissive", MONITOR_HEX, SCREEN_EMISSION)
        self.metal_dark = mat_principled("PROC_metal_dark", "#2E3134", 0.35, metallic=1.0)
        self.aluminium = mat_principled("PROC_window_frame", "#3B4045", 0.4, metallic=1.0)
        self.fabric = mat_principled("PROC_partition_fabric", "#2C3A3D", 0.95)
        self.fabric_chair = mat_principled("PROC_chair_fabric", "#1A1C1F", 0.9)
        self.ceramic = mat_principled("PROC_mug_ceramic", "#CFC8BC", 0.18, Coat_Weight=0.4)
        self.coffee = mat_principled("PROC_cold_coffee", COFFEE_HEX, 0.08, Specular_IOR_Level=0.6)
        self.note = mat_paper("PROC_sticky_note_pink", NOTE_PINK_HEX)
        self.ink = mat_principled("PROC_note_ink", INK_HEX, 0.6)
        self.glass = mat_principled(
            "PROC_window_glass", "#DDE6E8", 0.03, Transmission_Weight=1.0, IOR=1.5
        )
        self.light_panel_off = mat_principled("PROC_ceiling_panel_off", "#232629", 0.7)
        self.walnut = mat_principled("PROC_walnut_trim", WALNUT_HEX, 0.5)


def build_room(lib: Library, mats: Mats, col) -> None:
    carpet = lib.material("polyhaven-dirty_carpet", "dirty_carpet")
    plaster = lib.material("polyhaven-painted_plaster_wall", "painted_plaster_wall")
    ceiling = lib.material("polyhaven-ceiling_interior", "ceiling_interior")
    (x0, x1), (y0, y1) = ROOM_X, ROOM_Y
    w, d = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    t = 0.2  # wall thickness

    box("Floor", (w, d, 0.02), (cx, cy, -0.01), col, carpet, world_uv_tile=TILE_M["dirty_carpet"])
    box("Ceiling", (w, d, 0.02), (cx, cy, CEILING_Z + 0.01), col, ceiling,
        world_uv_tile=TILE_M["ceiling_interior"])
    tile = TILE_M["painted_plaster_wall"]
    box("Wall_Left", (t, d, CEILING_Z), (x0 - t / 2, cy, CEILING_Z / 2), col, plaster, world_uv_tile=tile)
    box("Wall_Right", (t, d, CEILING_Z), (x1 + t / 2, cy, CEILING_Z / 2), col, plaster, world_uv_tile=tile)
    box("Wall_Back", (w, t, CEILING_Z), (cx, y0 - t / 2, CEILING_Z / 2), col, plaster, world_uv_tile=tile)

    # Structural column carrying the wall clock, just behind the hero monitor.
    ccx, ccy = COLUMN_CENTRE
    box("Column_Clock", (COLUMN_SIZE, COLUMN_SIZE, CEILING_Z), (ccx, ccy, CEILING_Z / 2), col, plaster,
        world_uv_tile=tile)

    # Recessed ceiling panels, all switched off (night, only Jun is here).
    for ix in (-3.0, 0.0, 3.0):
        for iy in (-0.5, 2.5, 5.5):
            box(f"CeilingPanel_{ix:+.0f}_{iy:+.0f}", (0.6, 0.6, 0.02), (ix, iy, CEILING_Z - 0.005), col,
                mats.light_panel_off)


def build_window_wall(lib: Library, mats: Mats, col) -> None:
    """Curtain wall at y = ROOM_Y[1]: sill, header, mullions, one rain-covered glass plane.

    The view outside (city, haze, Mt. Fuji) is built by ``build_exterior``.
    """
    plaster = lib.material("polyhaven-painted_plaster_wall", "painted_plaster_wall")
    (x0, x1), y = ROOM_X, ROOM_Y[1]
    w, cx, t = x1 - x0, (x0 + x1) / 2, 0.2
    tile = TILE_M["painted_plaster_wall"]
    box("Window_Sill_Wall", (w, t, SILL_Z), (cx, y + t / 2, SILL_Z / 2), col, plaster, world_uv_tile=tile)
    box("Window_Header_Wall", (w, t, CEILING_Z - HEAD_Z), (cx, y + t / 2, (HEAD_Z + CEILING_Z) / 2), col,
        plaster, world_uv_tile=tile)
    box("Window_Sill_Ledge", (w, 0.28, 0.03), (cx, y - 0.02, SILL_Z + 0.015), col, mats.aluminium)
    h = HEAD_Z - SILL_Z
    zc = (SILL_Z + HEAD_Z) / 2
    n_bays = 8
    for i in range(n_bays + 1):
        x = x0 + i * w / n_bays
        box(f"Window_Mullion_{i:02d}", (0.06, 0.14, h), (x, y + 0.05, zc), col, mats.aluminium, bevel=0.004)
    box("Window_Transom_Low", (w, 0.12, 0.05), (cx, y + 0.05, SILL_Z + 0.025), col, mats.aluminium)
    box("Window_Transom_High", (w, 0.12, 0.05), (cx, y + 0.05, HEAD_Z - 0.025), col, mats.aluminium)
    glass = box("Window_Glass", (w, 0.012, h), (cx, y + 0.06, zc), col, mat_rain_glass())
    glass["jfilm_note"] = "rain-covered glass (procedural droplets + rivulets)"


# ------------------------------------------------------------------ exterior


def city_block(name, size, base_xy, base_z, facade, roof, tile, col, rng):
    """Building box standing on ``base_z``: facade on the sides, dark roof on top."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], (v.co.z + 0.5) * size[2]))
    loc = Vector((base_xy[0], base_xy[1], base_z))
    _world_uv(bm, loc, tile, shift=(rng.random(), round(rng.random() * 4) / 16.0))
    for face in bm.faces:
        face.material_index = 1 if face.normal.z > 0.5 else 0
    obj = mesh_object(name, bm, col, loc)
    obj.data.materials.append(facade)
    obj.data.materials.append(roof)
    return obj


def vertical_card(name, x_profile, z_base, y, col, material):
    """Silhouette card facing -Y: ``x_profile`` = [(x, z_top)], filled down to ``z_base``."""
    bm = bmesh.new()
    tops = [bm.verts.new((x, 0.0, z)) for x, z in x_profile]
    bots = [bm.verts.new((x, 0.0, z_base)) for x, _ in x_profile]
    for i in range(len(x_profile) - 1):
        bm.faces.new((bots[i], bots[i + 1], tops[i + 1], tops[i]))
    return mesh_object(name, bm, col, (0.0, y, 0.0), material)


def build_exterior(lib: Library, col) -> None:
    """Layered night view through the window: city blocks in three depth bands, warm
    haze cards between them, two dim ridge lines and an art-directed Mt. Fuji."""
    import random

    rng = random.Random(307)
    f009 = lib.material("ambientcg-Facade009", "Facade009_1K-JPG_NORMAL")
    adapt_facade009(f009, emission_strength=2.2)
    f005 = lib.material("ambientcg-Facade005", "Facade005_1K-JPG_NORMAL")
    adapt_facade005(f005, emission_strength=2.0)
    roof = mat_principled("PROC_roof_dark", "#0A0D10", 0.8)
    g = EXTERIOR_GROUND_Z

    ground = mat_principled("PROC_ground_dark", "#07090B", 0.9)
    bm = bmesh.new()
    for x, y in ((-30000, 20), (30000, 20), (30000, 12000), (-30000, 12000)):
        bm.verts.new((x, y, 0.0))
    bm.faces.new(bm.verts)
    mesh_object("Ext_Ground", bm, col, (0, 0, g), ground)

    # (label, y range, x half-range, count, width range, top-z range, Facade005 share)
    bands = [
        ("A", (70, 160), 160, 7, (18, 40), (-20, 45), 0.3),
        ("B", (220, 480), 480, 18, (20, 60), (-45, 28), 0.35),
        ("C", (650, 1300), 1400, 40, (30, 90), (-58, 14), 0.5),
    ]
    for label, (y0, y1), half_x, count, (w0, w1), (t0, t1), share in bands:
        for i in range(count):
            x = rng.uniform(-half_x, half_x)
            y = rng.uniform(y0, y1)
            w, d = rng.uniform(w0, w1), rng.uniform(w0, w1)
            top = rng.uniform(t0, t1)
            use_005 = rng.random() < share
            city_block(f"Ext_City{label}_{i:02d}", (w, d, top - g), (x, y), g, f005 if use_005 else f009, roof,
                       TILE_M["Facade005" if use_005 else "Facade009"], col, rng)

    def card(name, y, material, z_top=1500.0, half_w=30000.0):
        return vertical_card(name, [(-half_w, z_top), (half_w, z_top)], g - 10, y, col, material)

    # Warm city haze between the bands (strongest at street level).
    card("Ext_Haze_AB", 200, mat_haze("PROC_haze_near", CITY_HAZE_HEX, 0.10, 0.30, g, g + 90))
    card("Ext_Haze_BC", 600, mat_haze("PROC_haze_mid", CITY_HAZE_HEX, 0.12, 0.45, g, g + 110))
    card("Ext_Haze_C", 1450, mat_haze("PROC_haze_far", CITY_HAZE_HEX, 0.14, 0.75, g, g + 160))

    # Ridges: low hills at 5.5 km, darker than the sky, with cool haze in front of Fuji.
    def ridge(seed, n, base_h, amp, half_w):
        r = random.Random(seed)
        phase = [r.uniform(0, 6.28) for _ in range(3)]
        pts = []
        for i in range(n + 1):
            x = -half_w + 2 * half_w * i / n
            s = x / half_w
            h = base_h + amp * (0.5 * math.sin(3.1 * s + phase[0]) + 0.3 * math.sin(7.3 * s + phase[1])
                                + 0.2 * math.sin(17.0 * s + phase[2]))
            pts.append((x, h))
        return pts

    ridge_mat = mat_mountain("PROC_ridge_far", "#0A151A", None, 1.0, g, 400.0)
    vertical_card("Ext_Ridge", ridge(11, 160, 160.0, 110.0, 30000.0), g - 10, 5500.0, col, ridge_mat)
    card("Ext_Haze_Fuji", 7000, mat_haze("PROC_haze_fuji", HORIZON_HEX, 0.9, 0.55, g, 500.0, power=1.2))

    # Mt. Fuji: concave cone with a flattened crater rim, peak at FUJI_PEAK_ELEV_DEG.
    peak = EYE_Z + FUJI_DIST * math.tan(math.radians(FUJI_PEAK_ELEV_DEG))
    half_base = (peak - g) * 4.2
    r = random.Random(3776)
    profile = []
    n = 240
    for i in range(n + 1):
        s = -1.0 + 2.0 * i / n
        t = max(0.0, 1.0 - abs(s))
        h = t ** 1.75
        h = min(h, 0.965) + (0.006 * math.sin(i * 0.9) if t > 0.97 else 0.0)  # crater rim
        h += 0.008 * (r.random() - 0.5) * t
        profile.append((s * half_base, g + h * (peak - g)))
    fuji_mat = mat_mountain("PROC_fuji", "#0C171C", "#34454D", 1.0, g, peak, snow_from=0.72)
    fuji = vertical_card("Ext_MtFuji", profile, g - 10, FUJI_DIST, col, fuji_mat)
    fuji["jfilm_note"] = (f"art-directed: peak {FUJI_PEAK_ELEV_DEG} deg above eye level at {FUJI_DIST:.0f} m "
                          "(real Fuji from Tokyo ~2 deg)")


def build_monitor(name, col, mats: Mats, screen_mat, location, rot_z_deg=0.0):
    """Slim 24" monitor on a stand. Returns (root empty, screen object, panel front y offset)."""
    root = bpy.data.objects.new(name, None)
    root.location = location
    root.rotation_euler = (0.0, 0.0, math.radians(rot_z_deg))
    root["jfilm_source"] = "procedural"
    col.objects.link(root)
    pw, ph, pd = 0.556, 0.335, 0.022
    bottom = 0.10
    zc = bottom + ph / 2
    parts = [
        box(f"{name}_Base", (0.24, 0.19, 0.012), (0, 0.06, 0.006), col, mats.metal_dark, bevel=0.004),
        box(f"{name}_Neck", (0.05, 0.025, bottom + 0.12), (0, 0.075, (bottom + 0.12) / 2), col,
            mats.metal_dark, bevel=0.004),
        box(f"{name}_Back", (0.30, 0.04, 0.20), (0, pd / 2 + 0.02, zc), col, mats.plastic_dark, bevel=0.01),
        box(f"{name}_Panel", (pw, pd, ph), (0, 0, zc), col, mats.plastic_dark, bevel=0.003),
    ]
    # Active area: thin bezels on top/sides, a 2 cm chin at the bottom.
    sw, sh = pw - 0.014, ph - 0.03
    screen = box(f"{name}_Screen", (sw, 0.001, sh), (0, -pd / 2 - 0.0006, bottom + 0.022 + sh / 2), col,
                 screen_mat)
    parts.append(screen)
    for part in parts:
        part.parent = root
    return root, screen, (pw, ph, pd, bottom)


def build_keyboard(col, mats: Mats, location, rot_z_deg=0.0):
    kb = box("Keyboard", (0.44, 0.135, 0.016), location, col, mats.plastic_dark, bevel=0.003)
    kb.rotation_euler = (math.radians(1.5), 0, math.radians(rot_z_deg))
    key = box("Keyboard_Keys", (0.0165, 0.0165, 0.008), (-0.196, -0.048, 0.010), col, mats.plastic_mid)
    key.parent = kb
    arr_x = key.modifiers.new("ArrayX", "ARRAY")
    arr_x.count, arr_x.use_relative_offset, arr_x.use_constant_offset = 22, False, True
    arr_x.constant_offset_displace = (0.0187, 0, 0)
    arr_y = key.modifiers.new("ArrayY", "ARRAY")
    arr_y.count, arr_y.use_relative_offset, arr_y.use_constant_offset = 6, False, True
    arr_y.constant_offset_displace = (0, 0.0193, 0)
    bev = key.modifiers.new("Bevel", "BEVEL")  # after the arrays: one bevel per key
    bev.width, bev.segments, bev.limit_method = 0.002, 2, "ANGLE"
    return kb


def build_mouse(col, mats: Mats, location, rot_z_deg=0.0):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=12, radius=0.5)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -0.05], context="VERTS")
    for v in bm.verts:
        v.co = Vector((v.co.x * 0.062, v.co.y * 0.112 * (1.0 - 0.15 * v.co.y), max(v.co.z, 0.0) * 0.07))
    return mesh_object("Mouse", bm, col, location, mats.plastic_dark, smooth=True)


def build_mug(name, col, mats: Mats, location, coffee=True):
    r, h, wall = 0.041, 0.096, 0.0045
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=40, radius1=r, radius2=r, depth=h)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, h / 2))
    top = max(bm.faces, key=lambda f: f.calc_center_median().z)
    bmesh.ops.inset_individual(bm, faces=[top], thickness=wall)
    ret = bmesh.ops.extrude_face_region(bm, geom=[top])
    new_verts = [e for e in ret["geom"] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=new_verts, vec=(0, 0, -(h - 0.008)))
    bmesh.ops.delete(bm, geom=[top], context="FACES")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mug = mesh_object(name, bm, col, location, mats.ceramic, smooth=True)
    # No subdivision: it lifted the base ring off the desk (mug looked like it floated).
    bevel = mug.modifiers.new("Bevel", "BEVEL")
    bevel.width, bevel.segments, bevel.limit_method = 0.0015, 2, "ANGLE"
    # Handle: torus segment on +X.
    bm = bmesh.new()
    seg, ring = 24, 10
    R, rr = 0.026, 0.0055
    verts = []
    for i in range(seg + 1):
        a = math.radians(-100 + 200 * i / seg)
        row = []
        for j in range(ring):
            b = 2 * math.pi * j / ring
            x = (R + rr * math.cos(b)) * math.cos(a)
            z = (R + rr * math.cos(b)) * math.sin(a)
            y = rr * math.sin(b)
            row.append(bm.verts.new((x * 0.75, y, z)))
        verts.append(row)
    for i in range(seg):
        for j in range(ring):
            bm.faces.new((verts[i][j], verts[i][(j + 1) % ring], verts[i + 1][(j + 1) % ring], verts[i + 1][j]))
    handle = mesh_object(f"{name}_Handle", bm, col, (r - 0.004, 0, h * 0.52), mats.ceramic, smooth=True)
    handle.parent = mug
    if coffee:
        # Barely touched: high level so the seated POV sees the cold surface over the rim.
        surface = cylinder(f"{name}_ColdCoffee", r - wall - 0.0004, 0.002, (0, 0, h * 0.8), col, mats.coffee)
        surface.parent = mug
    return mug


def build_chair_collection(mats: Mats):
    """Generic task chair (procedural), kept out of the scene and instanced."""
    col = bpy.data.collections.new("PROC_task_chair")
    box("Chair_Seat", (0.48, 0.46, 0.07), (0, 0, 0.47), col, mats.fabric_chair, bevel=0.02)
    back = box("Chair_Back", (0.45, 0.06, 0.55), (0, 0.25, 0.83), col, mats.fabric_chair, bevel=0.025)
    back.rotation_euler = (math.radians(-8), 0, 0)
    cylinder("Chair_Gaslift", 0.024, 0.32, (0, 0, 0.27), col, mats.metal_dark, segments=16)
    box("Chair_BackSpine", (0.05, 0.03, 0.42), (0, 0.24, 0.55), col, mats.metal_dark, bevel=0.008)
    for k in range(5):
        leg = box(f"Chair_Leg_{k}", (0.32, 0.04, 0.03), (0, 0, 0.075), col, mats.metal_dark, bevel=0.008)
        a = 2 * math.pi * k / 5
        leg.rotation_euler = (0, 0, a)
        leg.location = (0.15 * math.cos(a), 0.15 * math.sin(a), 0.075)
        cylinder(f"Chair_Caster_{k}", 0.025, 0.03, (0.3 * math.cos(a), 0.3 * math.sin(a), 0.03), col,
                 mats.plastic_dark, segments=12).rotation_euler = (math.pi / 2, 0, a + math.pi / 2)
    for side in (-1, 1):
        box(f"Chair_Arm_{side:+d}", (0.05, 0.26, 0.03), (side * 0.27, 0.0, 0.68), col, mats.plastic_dark,
            bevel=0.01)
        box(f"Chair_ArmPost_{side:+d}", (0.03, 0.04, 0.2), (side * 0.27, 0.05, 0.58), col, mats.metal_dark)
    return col


def build_monitor_off_collection(mats: Mats):
    col = bpy.data.collections.new("PROC_monitor_off")
    build_monitor("MonitorOff", col, mats, mats.screen_off, (0, 0, 0))
    kb = build_keyboard(col, mats, (0.0, -0.33, 0.01))
    kb.name = "KeyboardOff"
    return col


def set_clock_time(clock_col, hours: int, minutes: int, seconds: int) -> None:
    """Rotate the Poly Haven wall_clock hands (pivot at origin, dial facing -Y)."""
    targets = {
        "hours": (hours % 12 + minutes / 60.0) * 30.0,
        "minute": (minutes + seconds / 60.0) * 6.0,
        "second": seconds * 6.0,
    }
    done = []
    for obj in clock_col.all_objects:
        for key, target in targets.items():
            if f"_{key}_hand" in obj.name:
                tip = max(obj.data.vertices, key=lambda v: v.co.x ** 2 + v.co.z ** 2)
                current = math.degrees(math.atan2(tip.co.x, tip.co.z))
                # +rotation about Y turns the hand clockwise as seen from the front (-Y).
                obj.rotation_euler = (0.0, math.radians(target - current), 0.0)
                done.append(key)
    if sorted(done) != sorted(targets):
        raise RuntimeError(f"wall clock hands not found (got {done})")


def switch_lamp_off(lamp_col) -> None:
    for obj in lamp_col.all_objects:
        if obj is None:  # the source collection holds a dangling entry
            continue
        if obj.name.startswith(("wdg_", "hlp_")):
            obj.hide_render = True
            obj.hide_viewport = True
        for slot in getattr(obj, "material_slots", []):
            mat = slot.material
            if mat is None or mat.node_tree is None:
                continue
            for node in mat.node_tree.nodes:
                if node.type == "BSDF_PRINCIPLED":
                    node.inputs["Emission Strength"].default_value = 0.0
                elif node.type == "EMISSION":
                    node.inputs["Strength"].default_value = 0.0
            _mute_base_colour(mat, saturation=0.35, value=0.55)
    lamp_col["jfilm_note"] = "desk lamp switched off (emission 0); red paint desaturated for the grade"


def _mute_base_colour(mat, saturation: float, value: float) -> None:
    """Insert a Hue/Saturation node in front of Principled Base Color (once per material)."""
    if mat.get("jfilm_muted"):
        return
    tree = mat.node_tree
    for bsdf in [n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"]:
        socket = bsdf.inputs["Base Color"]
        hsv = tree.nodes.new("ShaderNodeHueSaturation")
        hsv.inputs["Saturation"].default_value = saturation
        hsv.inputs["Value"].default_value = value
        if socket.is_linked:
            link = socket.links[0]
            tree.links.new(link.from_socket, hsv.inputs["Color"])
        else:
            hsv.inputs["Color"].default_value = socket.default_value
        tree.links.new(hsv.outputs["Color"], socket)
    mat["jfilm_muted"] = True


def build_furniture(lib: Library, mats: Mats, col):
    """Desks (instanced), chairs, partitions, cabinets, floor plants, wall clock."""
    # Assembly: library desk + walnut-tinted Wood094 top (instanced as one collection).
    desk_col = bpy.data.collections.new("ASM_desk_walnut")
    desk_col.children.link(lib.collection("polyhaven-metal_office_desk", "metal_office_desk"))
    wood = lib.material("ambientcg-Wood094", "Wood094_1K-JPG_NORMAL")
    tint_to_walnut(wood)
    slab = box("Desk_WalnutTop", (2.02, 0.94, DESK_SLAB_T), (0.0, 0.01, DESK_METAL_TOP_Z + DESK_SLAB_T / 2),
               desk_col, wood, bevel=0.003, world_uv_tile=TILE_M["Wood094"])
    slab["jfilm_asset_id"] = "ambientcg-Wood094"
    chair_col = build_chair_collection(mats)
    monitor_off_col = build_monitor_off_collection(mats)

    # (x, desk origin y, rotation). rot 0: sitter on -Y side; 180: sitter on +Y side.
    desks = [
        ("Desk_Hero", 0.0, 0.448, 0),
        ("Desk_R0_L", -2.2, 0.448, 0),
        ("Desk_R0_R", 2.2, 0.448, 0),
        ("Desk_R1_L", -2.2, 1.47, 180),
        ("Desk_R1_R", 2.2, 1.47, 180),
        ("Desk_R2_L", -2.2, 4.0, 0),
        ("Desk_R2_C", 0.0, 4.0, 0),
        ("Desk_R2_R", 2.2, 4.0, 0),
        ("Desk_R3_L", -2.2, 5.0, 180),
        ("Desk_R3_C", 0.0, 5.0, 180),
        ("Desk_R3_R", 2.2, 5.0, 180),
    ]
    chair_jitter = [0, 12, -9, 20, -15, 6, -22, 10, 14, -6, 25]
    for (name, x, y, rot), jitter in zip(desks, chair_jitter):
        instance(name, desk_col, (x, y, 0.0), rot, col, "polyhaven-metal_office_desk")
        sign = 1 if rot == 0 else -1
        chair_y = y - sign * (0.9 if name != "Desk_Hero" else 0.78)
        instance(f"Chair_{name[5:]}", chair_col, (x + 0.05 * sign, chair_y, 0.0), rot + 180 + jitter, col)
        if name != "Desk_Hero":
            instance(f"MonitorOff_{name[5:]}", monitor_off_col, (x, y + sign * 0.112, DESK_TOP_Z), rot, col)

    # Low fabric partitions with a walnut cap.
    def partition(name, length, centre, along_x=True, height=1.0):
        t = 0.04
        size = (length, t, height) if along_x else (t, length, height)
        box(name, size, (centre[0], centre[1], height / 2), col, mats.fabric, bevel=0.006)
        cap = (length, t + 0.012, 0.022) if along_x else (t + 0.012, length, 0.022)
        box(f"{name}_Cap", cap, (centre[0], centre[1], height + 0.011), col, mats.walnut, bevel=0.004)

    partition("Partition_R01_L", 2.05, (-2.2, 0.985))
    partition("Partition_R01_C", 2.05, (0.0, 0.985))
    partition("Partition_R01_R", 2.05, (2.2, 0.985))
    partition("Partition_Side_HeroL", 0.95, (-1.1, 0.49), along_x=False, height=1.12)
    partition("Partition_Side_HeroR", 0.95, (1.1, 0.49), along_x=False, height=1.12)
    for i, x in enumerate((-2.2, 0.0, 2.2)):
        partition(f"Partition_R23_{i}", 2.05, (x, 4.5))

    # Background storage along the left wall, plants by the window corners.
    cab_col = lib.collection("polyhaven-drawer_cabinet", "drawer_cabinet")
    instance("Cabinet_A", cab_col, (ROOM_X[0] + 0.27, 2.2, 0.0), -90, col, "polyhaven-drawer_cabinet")
    instance("Cabinet_B", cab_col, (ROOM_X[0] + 0.27, 3.4, 0.0), -90, col, "polyhaven-drawer_cabinet")
    plant_col = lib.collection("polyhaven-potted_plant_02", "potted_plant_02")
    instance("FloorPlant_R", plant_col, (ROOM_X[1] - 0.5, ROOM_Y[1] - 0.5, 0.0), 30, col,
             "polyhaven-potted_plant_02")
    instance("FloorPlant_L", plant_col, (ROOM_X[0] + 0.5, ROOM_Y[1] - 0.6, 0.0), 160, col,
             "polyhaven-potted_plant_02")

    clock_col = lib.collection("polyhaven-wall_clock", "wall_clock")
    set_clock_time(clock_col, CLOCK_H, CLOCK_M, CLOCK_S)
    cx, cy = COLUMN_CENTRE
    instance("WallClock_0307", clock_col, (cx, cy - COLUMN_SIZE / 2, CLOCK_Z), 0, col, "polyhaven-wall_clock")


def build_hero_desk(lib: Library, mats: Mats, col):
    """Jun's desk: emissive monitor, keyboard, mouse, cold coffee, props, Kia's note."""
    T = DESK_TOP_Z
    root, screen, (pw, ph, pd, bottom) = build_monitor("Monitor_Hero", col, mats, mats.screen_on,
                                                       (0.05, 0.56, T), rot_z_deg=-2.0)
    screen["jfilm_note"] = "emissive-only screen, warm key light #F2D3A8, no UI text"
    build_sticky_note(col, mats, root, pw, pd, bottom)

    kb = build_keyboard(col, mats, (0.02, 0.20, T + 0.008), rot_z_deg=1.5)
    kb.name = "Keyboard_Hero"
    build_mouse(col, mats, (0.34, 0.17, T), 0).rotation_euler = (0, 0, math.radians(-8))
    mug = build_mug("Mug_ColdCoffee", col, mats, (0.22, 0.47, T))
    mug.rotation_euler = (0.0, 0.0, math.radians(-35))  # handle towards Jun's right hand

    # Key light: matches the screen (same size/colour), invisible to the camera.
    key = bpy.data.lights.new("Monitor_Key", "AREA")
    key.shape = "RECTANGLE"
    key.size, key.size_y = pw - 0.02, ph - 0.04
    key.energy = MONITOR_KEY_W
    key.color = srgb(MONITOR_HEX)[:3]
    key_obj = bpy.data.objects.new("Monitor_Key", key)
    key_obj.parent = root
    # 9 mm proud of the panel: clear of Kia's curled note (it lifts up to ~6 mm).
    key_obj.location = (0.0, -pd / 2 - 0.009, bottom + 0.022 + (ph - 0.03) / 2)
    key_obj.rotation_euler = (math.radians(-90), 0.0, 0.0)  # light -Z -> -Y (towards Jun)
    key_obj.visible_camera = False
    key_obj["jfilm_source"] = "procedural"
    col.objects.link(key_obj)

    pads = lib.objects(
        "polyhaven-office_notepads",
        ["office_notepads_yellow_pad", "office_notepads_sticky_stack", "office_notepads_note_stack"],
        col,
    )
    place_on(pads["office_notepads_yellow_pad"], -0.46, 0.26, T, 14)
    place_on(pads["office_notepads_sticky_stack"], -0.24, 0.50, T, -9)
    place_on(pads["office_notepads_note_stack"], 0.66, 0.30, T, -22)

    binder = lib.objects("polyhaven-binder_notebook", ["binder_notebook_closed"], col)
    place_on(binder["binder_notebook_closed"], 0.72, 0.64, T, 78)

    stat = lib.objects(
        "polyhaven-stationery_supplies",
        ["stationery_supplies_pencilcup", "stationery_supplies_pen_blue", "stationery_supplies_pencil_used",
         "stationery_supplies_eraser"],
        col,
    )
    place_on(stat["stationery_supplies_pencilcup"], -0.58, 0.64, T)
    place_on(stat["stationery_supplies_pen_blue"], -0.30, 0.16, T, 34)
    place_on(stat["stationery_supplies_pencil_used"], 0.52, 0.48, T, -61)
    place_on(stat["stationery_supplies_eraser"], -0.37, 0.43, T, 17)

    lamp_col = lib.collection("polyhaven-desk_lamp_arm_01", "desk_lamp_arm_01")
    switch_lamp_off(lamp_col)
    # Back-left corner, head folded away over the desk's back edge (not towards Jun).
    instance("DeskLamp_Off", lamp_col, (-0.82, 0.78, T), -55, col, "polyhaven-desk_lamp_arm_01")


def build_colleague_props(lib: Library, mats: Mats, col):
    """Personal props on the dark colleague desks."""
    T = DESK_TOP_Z
    plant_col = lib.collection("polyhaven-potted_plant_04", "potted_plant_04")
    instance("DeskPlant_R0_L", plant_col, (-2.85, 0.70, T), 20, col, "polyhaven-potted_plant_04")
    instance("DeskPlant_R1_R", plant_col, (1.55, 1.25, T), 75, col, "polyhaven-potted_plant_04")
    instance("DeskPlant_R2_C", plant_col, (0.70, 4.25, T), -40, col, "polyhaven-potted_plant_04")
    instance("DeskPlant_R3_L", plant_col, (-1.6, 4.8, T), 10, col, "polyhaven-potted_plant_04")

    binder = lib.objects("polyhaven-binder_notebook", ["binder_notebook"], col)
    place_on(binder["binder_notebook"], 2.0, 0.30, T, 6)
    a4 = lib.objects("polyhaven-office_notepads", ["office_notepads_a4_stack", "office_notepads_yellow_pad"], col)
    place_on(a4["office_notepads_a4_stack"], -1.75, 1.60, T, 170)
    place_on(a4["office_notepads_yellow_pad"], 2.75, 0.32, T, -12)
    cup = lib.objects("polyhaven-stationery_supplies", ["stationery_supplies_pencilcup"], col)
    place_on(cup["stationery_supplies_pencilcup"], -2.75, 1.25, T)
    build_mug("Mug_Colleague_R1_L", col, mats, (-1.65, 1.25, T), coffee=False)
    build_mug("Mug_Colleague_R2_R", col, mats, (2.55, 4.25, T), coffee=False)


INTER_ASSET_ID = "blender-bundled-inter"


def inter_font_path() -> str:
    """Inter shipped with the running (pinned) Blender: <DATAFILES>/fonts/Inter.woff2."""
    path = os.path.join(bpy.utils.system_resource("DATAFILES"), "fonts", "Inter.woff2")
    if not os.path.isfile(path):
        raise RuntimeError(f"Inter font not found in this Blender install: {path}")
    return os.path.normpath(path)


def build_sticky_note(col, mats: Mats, monitor_root, pw, pd, bottom) -> None:
    """Kia's pink sticky note on the lower-right monitor bezel, overlapping the screen corner.

    Lettering: Inter (OFL-1.1, bundled with Blender; ``licenses/assets.yaml`` entry
    ``blender-bundled-inter``) converted to mesh; the font datablock is removed
    afterwards, so the saved .blend references no font file.
    """
    size = 0.076

    def curl(y: float) -> float:
        """Glued at the top; the bottom edge lifts ~4 mm off the panel."""
        t = min(max((size / 2 - y) / size, 0.0), 1.0)
        return 0.004 * t ** 2.2

    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=8, size=size / 2)
    for v in bm.verts:
        v.co.z = curl(v.co.y)
    note = mesh_object("KiaNote", bm, col, material=mats.note)
    note.parent = monitor_root
    note.location = (pw / 2 - 0.028, -pd / 2 - 0.0016, bottom + 0.05)
    note.rotation_euler = (math.radians(90), math.radians(-5), 0.0)
    note["jfilm_note"] = "Kia's note: 'jangan lupa makan :) \u2014 K' (epics.md wording)"

    font_path = inter_font_path()
    font = bpy.data.fonts.load(font_path, check_existing=True)
    curve = bpy.data.curves.new("KiaNoteTextCurve", "FONT")
    curve.font = font
    curve.body = "jangan lupa\nmakan :)\n\u2014 K"
    curve.size = 0.0172  # Inter runs ~17% narrower than the old Bfont; keeps the same line width
    curve.offset = 0.00045  # thicker strokes: felt-tip pen, legible at 1080p
    curve.shear = 0.22
    curve.space_line = 1.05
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    tmp = bpy.data.objects.new("KiaNoteTextTmp", curve)
    col.objects.link(tmp)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(tmp.evaluated_get(depsgraph))
    mesh.name = "KiaNote_Handwriting"
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.curves.remove(curve)
    for font in list(bpy.data.fonts):
        if font.users == 0:
            bpy.data.fonts.remove(font)
    # Bake a slight tilt + offset, then follow the paper's curl so no line sinks behind it.
    tilt = math.radians(3)
    for v in mesh.vertices:
        x, y = v.co.x, v.co.y
        x, y = x * math.cos(tilt) - y * math.sin(tilt), x * math.sin(tilt) + y * math.cos(tilt) + 0.004
        v.co = (x, y, curl(y) + 0.0005)
    text = bpy.data.objects.new("KiaNote_Handwriting", mesh)
    mesh.materials.append(mats.ink)
    col.objects.link(text)
    text.parent = note
    text["jfilm_source"] = "procedural lettering: Inter (OFL-1.1, bundled with Blender) converted to mesh"
    text["jfilm_asset_id"] = INTER_ASSET_ID
    text["jfilm_font_file"] = font_path


def build_lighting(scene, mats: Mats, col) -> None:
    """Night: the monitor is the key; a cool city glow through the window; nothing else on."""
    build_sky_world(scene, strength=SKY_STRENGTH)

    # Teal night ambience: sky + city glow entering through the curtain wall.
    glow = bpy.data.lights.new("City_Glow_Window", "AREA")
    glow.shape = "RECTANGLE"
    glow.size, glow.size_y = ROOM_X[1] - ROOM_X[0], HEAD_Z - SILL_Z
    glow.energy = WINDOW_GLOW_W
    glow.color = srgb(TEAL_AMBIENT_HEX)[:3]
    obj = bpy.data.objects.new("City_Glow_Window", glow)
    obj.location = (0.0, ROOM_Y[1] - 0.15, (SILL_Z + HEAD_Z) / 2)
    look_at(obj, (0.0, 0.0, (SILL_Z + HEAD_Z) / 2))
    obj.visible_camera = False
    col.objects.link(obj)

    # Screen spill bouncing off Jun himself back onto the desk front (very low).
    bounce = bpy.data.lights.new("Screen_Bounce_Jun", "AREA")
    bounce.size, bounce.size_y = 0.5, 0.6
    bounce.shape = "RECTANGLE"
    bounce.energy = 0.8
    bounce.color = srgb(MONITOR_HEX)[:3]
    obj = bpy.data.objects.new("Screen_Bounce_Jun", bounce)
    obj.location = (0.05, -0.12, 1.05)
    look_at(obj, (0.05, 0.6, 0.95))
    obj.visible_camera = False
    col.objects.link(obj)


def build_cameras(scene, col) -> None:
    """First-person seated POV (eye ~1.2 m). Each aspect is its own camera."""
    specs = {
        # name: (location, target, lens mm, sensor fit, sensor w, sensor h, resolution)
        # 16:9: monitor right of centre, lamp/colleague desks left, window band across the back.
        # 26 mm (was 22): less edge stretch; Jun leans back (eye 55 cm behind the desk edge)
        # so clock top (+14 deg) and the whole mug (-23 deg) fit the 42.5 deg vertical FOV.
        "CAM_16x9": ((0.03, -0.55, 1.22), (-0.25, 2.0, 1.03), 26.0, "HORIZONTAL", 36.0, 20.25, (1920, 1080)),
        # 9:16: leaning back a little; clock / monitor / coffee stacked on the centre line.
        "CAM_9x16": ((0.11, -0.42, 1.25), (0.105, 1.6, 0.95), 28.0, "VERTICAL", 20.25, 36.0, (1080, 1920)),
    }
    for name, (loc, target, lens, fit, sw, sh, res) in specs.items():
        data = bpy.data.cameras.new(name)
        data.lens = lens
        data.sensor_fit = fit
        data.sensor_width = sw
        data.sensor_height = sh
        data.clip_start = 0.05
        data.clip_end = 20000.0  # Fuji card sits at FUJI_DIST
        cam = bpy.data.objects.new(name, data)
        cam.location = loc
        look_at(cam, target)
        cam["jfilm_resolution"] = list(res)
        col.objects.link(cam)
    scene.camera = bpy.data.objects["CAM_16x9"]


def configure_scene(scene, samples: int) -> None:
    scene.name = SCENE_TAG
    scene.render.engine = "CYCLES"
    scene.cycles.device = "GPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 1920, 1080
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene["jfilm_scene"] = SCENE_TAG


def clear_startup_scene() -> None:
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for child in list(bpy.context.scene.collection.children):
        bpy.data.collections.remove(child)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)


def scene_references() -> list:
    """External files the scene depends on, as licence-gate references."""
    refs = []
    for img in bpy.data.images:
        if img.source in {"FILE", "SEQUENCE", "TILED"} and img.packed_file is None and img.filepath:
            refs.append(lg.Reference("image", img.name, bpy.path.abspath(img.filepath)))
    for lib_ in bpy.data.libraries:
        refs.append(lg.Reference("library", lib_.name, bpy.path.abspath(lib_.filepath)))
    for font in bpy.data.fonts:
        path = font.filepath if font.filepath == "<builtin>" else bpy.path.abspath(font.filepath)
        refs.append(lg.Reference("font", font.name, path))
    return refs


# ================================================================== main


def main(argv: list[str]) -> int:
    args = tc.parse_args(argv, prog=PROG, extend=add_build_arguments)

    try:
        pinned = tc.read_pinned_version()
    except (OSError, ValueError) as exc:
        fail(tc.EXIT_CONFIG, f"cannot read pinned version: {exc}")
    running = tc.format_version(bpy.app.version)
    log(f"Blender version: {bpy.app.version_string} (running {running}, pinned {pinned})")
    ok, message = tc.check_version(running, pinned, args.allow_version_mismatch)
    if message:
        print(f"[build_act2_scene] {message}", file=sys.stderr, flush=True)
    if not ok:
        sys.exit(tc.EXIT_VERSION_MISMATCH)

    root = lg.library_root()
    if root is None:
        fail(tc.EXIT_USAGE, lg.LIBRARY_MISSING_HINT)
    lib = Library(root.resolve())
    missing = lib.missing_files()
    if missing:
        fail(
            tc.EXIT_USAGE,
            "asset library incomplete; run `python pipeline/fetch_assets.py` first. Missing:\n    "
            + "\n    ".join(missing),
        )
    if not args.name.lower().endswith(".blend"):
        fail(tc.EXIT_USAGE, f"--name must end in .blend, got {args.name!r}")

    clear_startup_scene()
    scene = bpy.context.scene
    configure_scene(scene, args.samples)
    mats = Mats()
    top = scene.collection
    cols = {k: get_collection(k, top) for k in ("Room", "Window", "Exterior", "Furniture", "HeroDesk", "Props",
                                                  "Lights", "Cameras")}
    build_room(lib, mats, cols["Room"])
    log("room built")
    build_window_wall(lib, mats, cols["Window"])
    build_exterior(lib, cols["Exterior"])
    log("window + exterior built")
    build_furniture(lib, mats, cols["Furniture"])
    log("furniture built")
    build_hero_desk(lib, mats, cols["HeroDesk"])
    build_colleague_props(lib, mats, cols["Props"])
    log("props built")
    build_lighting(scene, mats, cols["Lights"])
    build_cameras(scene, cols["Cameras"])

    # Library images must keep absolute paths into $JFILM_LIBRARY for the licence gate.
    refs = scene_references()
    relative = [r for r in refs if not os.path.isabs(r.path) and not r.path.startswith("<")]
    if relative:
        fail(tc.EXIT_RENDER_FAILED, "non-absolute file references: " + ", ".join(r.path for r in relative))
    problems = lg.check(refs, library_root=root)
    log(f"{len(refs)} external file references; licence pre-check: "
        + ("all listed" if not problems else f"{len(problems)} problem(s)"))
    for problem in problems:
        print(f"[build_act2_scene] WARNING licence: {problem}", file=sys.stderr, flush=True)

    out_dir = tc.ensure_out_dir(args.out)
    out_file = out_dir / args.name
    result = bpy.ops.wm.save_as_mainfile(filepath=str(out_file), relative_remap=False, compress=True)
    if "FINISHED" not in result or not out_file.is_file():
        fail(tc.EXIT_RENDER_FAILED, f"saving {out_file} failed ({sorted(result)})")
    log(f"Saved {out_file} ({out_file.stat().st_size / 1e6:.1f} MB)")
    return tc.EXIT_OK


if __name__ == "__main__":
    try:
        code = main(sys.argv)
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 - any unexpected failure must be non-zero
        traceback.print_exc()
        code = tc.EXIT_RENDER_FAILED
    sys.exit(code)

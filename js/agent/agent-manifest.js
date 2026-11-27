/** Public API contracts and a historical live-DOM control catalogue.
 * Metadata does not install handlers or prove their behavior. Main supplies ctx.ui.
 */
import { AgentError, ERROR_CODES } from './agent-core.js';
import { CONTROL_SELECTOR, PANELS } from './agent-ui.js';

export const SHORTCUTS = Object.freeze([
  ['Tab', 'Toggle Object / Edit Mode', 'engine'],
  ['Ctrl+Z', 'Undo; engine also accepts Cmd+Z', 'engine'],
  ['Ctrl+Shift+Z', 'Redo; engine also accepts Cmd+Shift+Z', 'engine'],
  ['Ctrl+Y', 'Redo; engine also accepts Cmd+Y', 'engine'],
  ['G', 'Translate tool; app starts modal grab when possible', 'engine+app'],
  ['R', 'Rotate tool; app starts modal rotate when possible', 'engine+app'],
  ['S', 'Scale tool; app starts modal scale when possible', 'engine+app'],
  ['Shift+D', 'Duplicate active object and activate translate', 'engine'],
  ['X', 'Delete selected objects; bypasses AgentUI confirmation', 'engine', true],
  ['Delete', 'Delete selected objects; bypasses AgentUI confirmation', 'engine', true],
  ['Escape', 'Exit camera view, otherwise clear selection', 'engine'],
  ['F', 'Frame active object', 'engine'],
  ['Period', 'Frame active object using the period key', 'engine'],
  ['0 / Numpad0', 'Toggle active camera view', 'engine'],
  ['Alt+0', 'Toggle active camera view', 'engine'],
  ['Numpad1', 'Front view', 'engine'], ['Ctrl+Numpad1', 'Back view', 'engine'],
  ['Alt+1', 'Front view', 'engine'], ['Ctrl+Alt+1', 'Back view', 'engine'],
  ['Numpad3', 'Right view', 'engine'], ['Ctrl+Numpad3', 'Left view', 'engine'],
  ['Alt+3', 'Right view', 'engine'], ['Ctrl+Alt+3', 'Left view', 'engine'],
  ['Numpad7', 'Top view', 'engine'], ['Ctrl+Numpad7', 'Bottom view', 'engine'],
  ['Alt+7', 'Top view', 'engine'], ['Ctrl+Alt+7', 'Bottom view', 'engine'],
  ['Numpad4 / Numpad6', 'Orbit view left / right', 'engine'],
  ['Numpad8 / Numpad2', 'Orbit view up / down', 'engine'],
  ['Numpad+ / Numpad-', 'Zoom in / out', 'engine'],
  ['Shift+A', 'Toggle Add menu dropdown', 'app'], ['Alt+A', 'Deselect all', 'app'],
  ['N', 'Toggle right sidebar', 'app'], ['T', 'Toggle left toolbar', 'app'],
  ['H', 'Hide active object', 'app'], ['Alt+H', 'Unhide all registered objects', 'app'],
  ['Z', 'Cycle solid / wireframe / material / rendered shading', 'app'],
  ['Shift+F12', 'Render viewport to PNG; bare F12 belongs to browser DevTools', 'app'],
  ['F3', 'Toggle AI copilot', 'app'], ['Ctrl+Space', 'Toggle AI copilot', 'app']
].map(([keys, description, source, requiresConfirm = false]) => Object.freeze({
  keys, description, source: source.split('+').map(s => `js/${s === 'engine' ? 'core/engine' : 'app'}.js`),
  requiresConfirm, agentCallable: !requiresConfirm,
  pitfalls: 'Mode, focus and modal transforms affect dispatch. Global viewport shortcuts are blocked while typing, while a dialog is open, and Tab is not hijacked from focused controls. Bare F12 opens DevTools; use Shift+F12. Destructive shortcuts bypass ui.click confirmation; do not automate them.'
})));
export const shortcuts = SHORTCUTS;

export const ERROR_CONTRACT = Object.freeze({
  direct: 'Public agent methods resolve {ok:true,data} or {ok:false,error:{code,message,hint,toolId}}. Internal ctx tools (including AgentUI and AgentManifest docs) return raw results or throw AgentError.',
  codes: ERROR_CODES,
  success: { type: 'object', required: ['ok', 'data'], properties: { ok: { const: true }, data: {} } },
  failure: { type: 'object', required: ['ok', 'error'], properties: {
    ok: { const: false }, error: { type: 'object', required: ['code', 'message', 'hint', 'toolId'], properties: {
      code: { type: 'string', enum: [...ERROR_CODES] }, message: { type: 'string' }, hint: { type: 'string' }, toolId: { type: ['string', 'null'] }
    } }
  } }
});
const str = description => ({ type: 'string', description });
const num = description => ({ type: 'number', description });
const bool = description => ({ type: 'boolean', description });
const en = (values, description) => ({ type: 'string', enum: values, description });
const arr = (items, description) => ({ type: 'array', items, description });
const obj = (properties, required = [], description = '') => ({ type: 'object', properties, required, additionalProperties: false, description });
const vector = (length, description) => ({ type: 'array', items: { type: 'number' }, minItems: length, maxItems: length, description });
const scalarVector = (length, description) => ({ anyOf: [num(description), vector(length, description)] });
const bounded = (min, max, description, integer = false) => ({ type: integer ? 'integer' : 'number', minimum: min, maximum: max, description });
const idSchema = { ...str('Stable scene agentId from scene.tree/find, not a DOM id or Three.js UUID.'), minLength: 1 };
const color = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'RGB hex color (#rrggbb).' };
const p = (name, schema, required = true) => ({ name, required, ...schema });
const opt = (name, schema) => p(name, schema, false);
const callback = { 'x-js-type': 'function', description: 'Browser JavaScript callback; cannot be supplied as JSON.' };
const files = { 'x-js-type': 'File[]|FileList', description: 'Browser File objects, not paths, base64 strings or JSON objects.' };
const channel = bounded(0, 3, 'UV channel: 0 is uv, 1–3 are uv1–uv3.', true);
const margin = bounded(0, 0.49, 'UV-space chart padding; default 0.02.');
const space = en(['local', 'world'], 'Coordinate space; default local.');
const faceIndices = arr({ type: 'integer', minimum: 0 }, 'Triangle face indices, not vertex indices.');
const region = { anyOf: [
  faceIndices,
  obj({ faceIndices, meshAgentId: idSchema, mode: { type: ['string', 'null'] }, faceCount: { type: 'integer', minimum: 0 } }, ['faceIndices']),
  obj({ mode: { const: 'box' }, space, min: vector(3, 'Box minimum.'), max: vector(3, 'Box maximum.') }, ['mode', 'min', 'max']),
  obj({ mode: { const: 'sphere' }, space, center: vector(3, 'Sphere center.'), radius: { type: 'number', minimum: 0 } }, ['mode', 'center', 'radius']),
  obj({ mode: { const: 'normal' }, space, normal: vector(3, 'Nonzero direction.'), angleLimit: bounded(0, 180, 'Angular tolerance in degrees; default 30.') }, ['mode', 'normal']),
  obj({ mode: { const: 'normal' }, space, direction: vector(3, 'Alias for normal; do not pass both.'), angleLimit: bounded(0, 180, 'Angular tolerance in degrees.') }, ['mode', 'direction']),
  obj({ mode: { const: 'byName' }, name: { ...str('Named face region, mesh, group or material name.'), minLength: 1 } }, ['mode', 'name'])
], description: '3D face-region descriptor or selection returned by uv.selectRegion; not a rectangle in UV space.' };
const pbr = obj({
  baseColor: color, emissive: color, metalness: bounded(0, 1, 'Metallic fraction.'), roughness: bounded(0, 1, 'Roughness.'),
  emissiveIntensity: { type: 'number', minimum: 0 }, clearcoat: bounded(0, 1, 'Clearcoat amount.'), clearcoatRoughness: bounded(0, 1, 'Clearcoat roughness.'),
  transmission: bounded(0, 1, 'Transmission amount.'), ior: bounded(1, 2.333, 'Index of refraction.'),
  sheen: bounded(0, 1, 'Sheen amount.'), sheenRoughness: bounded(0, 1, 'Sheen roughness.'), opacity: bounded(0, 1, 'Opacity; transparency is derived automatically.')
}, [], 'Supported agent PBR patch keys; baseColor is used instead of Three.js color.');
const assetTypes = ['auto', 'glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'hdr', 'exr', 'texture'];
const importOptions = obj({ type: en(assetTypes, 'Explicit type or auto inference.'), name: str('Imported root name.'),
  position: vector(3, 'Root position.'), scale: scalarVector(3, 'Root scale.'), colorSpace: en(['srgb', 'linear'], 'For image assets.'), onProgress: callback
});
const approve = obj({ confirm: bool('Request trusted user approval; never a confirmation bypass.') });

function definition(id, description, params, args, result, pitfalls, related, extra = {}) {
  const properties = Object.fromEntries(params.map(({ name, required, ...schema }) => [name, schema]));
  return {
    id, toolId: id, method: id, kind: 'api', label: id, description,
    when: `Use this operation to ${description.charAt(0).toLowerCase()}${description.slice(1)}`,
    params, parameters: obj(properties, params.filter(v => v.required).map(v => v.name), 'Signature order; HTTP transport sends positional args.'),
    argsSchema: { type: 'array', prefixItems: params.map(({ name, required, ...schema }) => schema),
      minItems: params.reduce((n, value, index) => value.required ? index + 1 : n, 0), maxItems: params.length, items: false },
    returns: { data: result, success: ERROR_CONTRACT.success, failure: ERROR_CONTRACT.failure }, errors: ERROR_CONTRACT,
    examples: [{ method: id, args }], exampleCall: `await agent.${id}(${args.map(v => JSON.stringify(v)).join(', ')})`,
    steps: ['Discover prerequisite object, asset or control ids using related tools.', 'Call the method with the documented arguments; inspect ok, then data or error.'],
    pitfalls: [pitfalls, 'A ToolDef documents a contract, not proof of a working handler. available is null when no public facade is supplied.'],
    related, agentCallable: true, requiresConfirm: false, ...extra
  };
}

/** Signatures match the public facade and its asset/geometry/animation/tutorial adapters. */
export const API_TOOL_DEFS = [
  definition('exec', 'Execute isolated JavaScript against a mirrored studio scene.', [p('code', { ...str('Worker source, at most 200000 characters; use studio and $(agentId).'), maxLength: 200000 }), opt('options', obj({ label: str('Undo label.'), timeout: bounded(1, 120000, 'Worker timeout milliseconds; default 30000.', true), dryRun: bool('Preview without changing the live scene.'), autoCommit: bool('false leaves an explicit transaction open.'), confirm: bool('Request approval if the script deletes objects.') }))], ["$('obj_1').position.x = 2; return $('obj_1').name;", { dryRun: true }], '{value,logs,changes,txId,dryRun,autoCommit}; exec also exposes top-level value/logs.', 'Requires worker CSP isolation and no pending writes/transactions. Worker code cannot call the public agent facade or access the live DOM. The mirror is not a live handle.', ['tx.commit', 'observe.logs']),
  definition('caps', 'Discover tool contracts, shortcuts, limits and live-DOM audit differences.', [opt('options', obj({ deep: bool('Visit dock and inspector tabs only; default false.') }))], [], 'Capability descriptor with tools, shortcuts, features, limits and audit.', 'Automatic mappings do not prove event-handler coverage; absent historical controls are not unmapped.', ['ui.list', 'docs.all']),
  definition('scene.tree', 'Inspect the scene hierarchy with stable agentIds.', [opt('options', obj({ depth: { type: 'integer', minimum: 0, description: 'Maximum child depth; default 20.' }, compact: bool('Omit children.') }))], [], 'Array of root descriptors with transform, material and children.', 'System/helper nodes are excluded. Names are not stable ids.', ['scene.find', 'scene.info']),
  definition('scene.find', 'Find scene objects by name substring, id, type, tag or material name.', [opt('query', obj({ name: str('Case-insensitive name substring.'), agentId: idSchema, type: str('Exact Three.js type.'), tag: str('One user tag.'), materialName: str('Exact material name.') }))], [{ name: 'Cube', type: 'Mesh' }], 'Compact object descriptor array.', 'No regex, exact-name option or tags array is accepted by this facade.', ['scene.tree', 'scene.info']),
  definition('scene.get', 'Explain the restriction on public live scene handles.', [], [], 'Always an E_PERMISSION error; mirrored handles are exposed only inside exec.', 'Do not call scene.get(id) expecting an Object3D. Use scene.info(id) or $(id) inside isolated exec.', ['scene.info', 'exec'], { agentCallable: false }),
  definition('scene.info', 'Read mesh geometry, bounds, bones, morph targets and PBR material details.', [p('agentId', idSchema)], ['obj_1'], 'Object descriptor including materials with matId and textureIds.', 'Geometry/material sharing and animation bindings require care; a scene id is not a material id.', ['scene.find', 'material.listMaps']),
  definition('scene.select', 'Replace the current selection with an array of scene agentIds.', [p('ids', arr(idSchema, 'Array only; [] clears selection.'))], [['obj_1']], 'The selected id array.', 'A scalar id and additive options are not supported. Selection controls many inspector/UV prerequisites.', ['scene.find', 'ui.list']),
  definition('scene.focus', 'Frame a scene object in the viewport.', [p('agentId', idSchema)], ['obj_1'], '{agentId}.', 'Camera state and empty geometry can affect framing.', ['scene.select', 'observe.screenshot']),
  definition('scene.rename', 'Rename an object while preserving its agentId.', [p('agentId', idSchema), p('name', { ...str('Nonempty name; surrounding whitespace is trimmed.'), minLength: 1, maxLength: 200 })], ['obj_1', 'Hero'], 'Updated compact descriptor.', 'Names are made unique. Name-bound animation tracks can be affected.', ['scene.info', 'undo']),
  definition('scene.delete', 'Delete one scene object and its descendants after user approval.', [p('agentId', idSchema), opt('options', approve)], ['obj_1', { confirm: true }], '{agentId,deleted:true}.', 'Destructive: inspect descendants first. This accepts one id, not an array.', ['scene.tree', 'undo'], { requiresConfirm: true }),
  definition('scene.clear', 'Clear all user scene objects after user approval.', [opt('options', approve)], [{ confirm: true }], '{cleared:true}.', 'Destructive: not a selection or console clear. Helpers are outside agent-visible scope.', ['scene.tree', 'undo'], { requiresConfirm: true }),
  definition('assets.importURL', 'Import a model or image asset from a URL.', [p('url', { ...str('HTTP(S), same-origin relative URL, uploaded blob, or bounded PNG/JPEG/WebP data URL.'), minLength: 1 }), opt('options', importOptions)], ['models/model.glb', { type: 'glb', name: 'ImportedModel', scale: 1 }], 'Model handle {assetId,agentId,clips,textures,bones,size}, or image texture handle.', 'External HTTP resources use the server proxy allowlist. Models and batches have 50MB/5000-object limits; onProgress is browser-only.', ['assets.list', 'scene.tree']),
  definition('assets.importFiles', 'Import a browser File array or FileList supplied by the user.', [p('files', files)], [], 'Array of imported asset handles.', 'JSON paths are not File objects. A batch is limited to 50MB; files also provide dependencies to model loaders.', ['assets.pickFile', 'assets.importURL'], { agentCallable: false, browserOnly: true, examples: [{ method: 'assets.importFiles', browserCall: 'const picked = await agent.assets.pickFile({accept:".glb"}); if (picked.ok && picked.data) await agent.assets.importFiles([picked.data]);' }], exampleCall: 'const picked = await agent.assets.pickFile({accept:".glb"}); if (picked.ok && picked.data) await agent.assets.importFiles([picked.data]);' }),
  definition('assets.pickFile', 'Ask the user to choose one local file through a trusted browser gesture.', [opt('options', obj({ accept: str('File accept filter; default common model/image formats.') }))], [{ accept: '.glb,.gltf' }], 'One browser File or null on cancellation.', 'No multiple option is supported. File objects cannot be faithfully serialized over HTTP; prefer importURL for remote automation.', ['assets.importFiles', 'assets.importURL'], { browserOnly: true }),
  definition('assets.list', 'List imported asset records that still have live scene roots.', [], [], 'Asset catalogue with assetId, source, type and available object/texture ids.', 'Records are an asset catalogue, not the entire scene or every material-created texture.', ['assets.delete', 'assets.loadTexture']),
  definition('assets.loadTexture', 'Load and register an image, HDR or EXR texture.', [p('source', { anyOf: [str('URL or image data URL.'), { 'x-js-type': 'File', description: 'Browser File; not JSON serializable.' }] }), opt('options', obj({ type: en(['texture', 'hdr', 'exr', 'auto'], 'Explicit loader type; URL default texture.'), name: str('Texture name.'), colorSpace: en(['srgb', 'linear'], 'Color textures use srgb; data maps use linear.') }))], ['models/albedo.png', { type: 'texture', colorSpace: 'srgb' }], '{textureId,assetId,size:[width,height],format}.', 'GPU maximum texture size and 50MB resource limits apply. Set HDR/EXR type explicitly for URL loads.', ['material.setMap', 'assets.list']),
  definition('assets.delete', 'Delete an asset catalogue entry and its model or unassigned texture.', [p('assetId', str('assetId from assets.list, not textureId.')), opt('options', approve)], ['asset_1', { confirm: true }], '{assetId,deleted:true}.', 'Destructive. Assigned textures cannot be deleted until their scene material maps are removed.', ['assets.list', 'material.setMap'], { requiresConfirm: true }),
  definition('material.create', 'Create a named physical PBR material and register its matId.', [p('name', str('Material name; empty string falls back to Material.')), opt('pbr', pbr)], ['Copper', { baseColor: '#b87333', roughness: 0.3, metalness: 1 }], 'matId string, e.g. mat_1.', 'Pass supported agent PBR keys; color, map and arbitrary Three.js options are not accepted.', ['material.assign', 'material.set']),
  definition('material.assign', 'Assign a registered material to a mesh, replacing its material array.', [p('agentId', idSchema), p('matId', str('Material id returned by material.create.'))], ['obj_1', 'mat_1'], '{agentId,matId}.', 'A mesh id is required. No material slot option is supported; this replaces every material slot.', ['material.create', 'scene.info']),
  definition('material.set', 'Clone and patch every material on a scene mesh.', [p('agentId', idSchema), p('patch', pbr)], ['obj_1', { roughness: 0.4, baseColor: '#ff8800' }], 'Updated material detail array.', 'The first argument is a mesh agentId, not matId. Cloning avoids mutating other meshes sharing the original materials.', ['material.assign', 'scene.info']),
  definition('material.listMaps', 'Inspect supported texture map slots on a scene mesh.', [p('agentId', idSchema)], ['obj_1'], 'Object mapping baseColor/normal/roughness/metalness/ao/emissive to per-material texture arrays.', 'The first argument is a mesh agentId. Empty slots are null.', ['material.setMap', 'scene.info']),
  definition('material.setMap', 'Clone mesh materials and attach or remove a texture map.', [p('agentId', idSchema), p('slot', en(['baseColor', 'normal', 'roughness', 'metalness', 'ao', 'emissive'], 'Agent map slot, not raw Three.js map property.')), p('textureId', { type: ['string', 'null'], description: 'Registered texture id; null removes the map.' }), opt('options', obj({ uvChannel: channel, wrap: en(['repeat', 'clamp', 'mirror'], 'Wrapping mode.'), repeat: vector(2, 'UV repeat.'), offset: vector(2, 'UV offset.'), rotation: num('Texture rotation radians.'), flipY: bool('Vertical flip; default false.') }))], ['obj_1', 'baseColor', 'tex_1', { repeat: [2, 2], wrap: 'repeat', uvChannel: 0 }], '{agentId,slot,textureId}; attached texture is cloned and receives a new textureId.', 'The mesh must have the requested UV channel. Color space is chosen by slot; use baseColor instead of map.', ['assets.loadTexture', 'material.listMaps', 'uv.list']),
  definition('uv.list', 'Inspect available UV channels and their coordinate bounds on a mesh.', [p('agentId', idSchema)], ['obj_1'], '{meshAgentId,channels:[{channel,attribute,vertices,min,max}]}.', 'No coordinate sampling or limit option is exposed. Only triangle BufferGeometry and channels 0–3 are supported.', ['uv.unwrap', 'scene.info']),
  definition('uv.unwrap', 'Generate and pack smart or cube-projected UV charts.', [p('agentId', idSchema), opt('options', obj({ method: en(['smart', 'cube', 'angle', 'conformal'], 'smart/cube supported; angle/conformal return E_UNSUPPORTED.'), angleLimit: bounded(0, 180, 'Degrees; default 66, smart only.'), margin, channel }))], ['obj_1', { method: 'smart', angleLimit: 66, margin: 0.02, channel: 0 }], 'UV operation summary including charts, packingScale, vertices and faces.', 'Not true angle/conformal unwrapping. Indexed geometry is expanded to independent triangle vertices; cube rejects angleLimit.', ['uv.pack', 'uv.list', 'undo']),
  definition('uv.project', 'Project mesh UVs from a preset, camera direction or explicit direction vector.', [p('agentId', idSchema), opt('options', obj({ from: { anyOf: [en(['front', 'back', 'left', 'right', 'top', 'bottom', 'camera'], 'Projection direction; default front.'), vector(3, 'Nonzero direction.')] }, channel, scale: scalarVector(2, 'UV scale.'), offset: vector(2, 'UV offset.') }))], ['obj_1', { from: 'camera', channel: 0, scale: [1, 1], offset: [0, 0] }], 'Projection summary with meshAgentId, channel, from, scale and offset.', 'Camera mode projects world coordinates orthographically along camera direction, not a perspective screenshot. Other directions use local geometry.', ['scene.focus', 'uv.list', 'undo']),
  definition('uv.pack', 'Shelf-pack existing UV charts into the unit square.', [p('agentId', idSchema), opt('options', obj({ margin, rotate: bool('Allow chart rotation; default true.'), channel }))], ['obj_1', { margin: 0.02, rotate: true, channel: 0 }], 'Packing summary including charts, packingScale, margin and rotate.', 'Existing UVs are required. Excess chart margins can fail E_TOO_LARGE; packing does not repair every overlap.', ['uv.unwrap', 'uv.list']),
  definition('uv.transform', 'Transform mesh UVs around the fixed pivot [0.5,0.5], optionally by face region.', [p('agentId', idSchema), opt('options', obj({ channel, offset: vector(2, 'Translation.'), scale: scalarVector(2, 'UV scale.'), rotation: num('Radians.'), region: { anyOf: [region, { type: 'null' }], description: 'null selects all faces.' } }))], ['obj_1', { scale: [0.5, 0.5], offset: [0.25, 0], rotation: 0 }], 'UV summary with faceIndices/transformedFaces, or modified:false for an empty region.', 'No custom center or vertex indices option is supported; operation clones and expands indexed geometry.', ['uv.selectRegion', 'uv.list', 'undo']),
  definition('uv.selectRegion', 'Resolve a 3D face region without changing scene selection.', [p('agentId', idSchema), opt('region', region)], ['obj_1', { mode: 'box', min: [-1, -1, -1], max: [1, 1, 1], space: 'local' }], '{meshAgentId,mode,faceCount,faceIndices}.', 'Box/sphere tests use face centroids. This is not a UV rectangle or a vertex-selection operation.', ['uv.transform', 'scene.info']),
  definition('decal.project', 'Project or bake an image decal onto a target mesh.', [p('options', obj({ meshAgentId: idSchema, textureId: str('Registered source texture id.'), position: vector(3, 'World-space projector center.'), normal: vector(3, 'Nonzero world-space facing normal.'), size: scalarVector(3, 'Positive world-space projector size.'), rotation: num('Radians about normal.'), opacity: bounded(0, 1, 'Opacity; default 1.'), blendMode: en(['normal'], 'Only normal blending is implemented.'), bake: bool('Bake into base maps instead of creating geometry; default false.') }, ['meshAgentId', 'textureId', 'position', 'normal', 'size']))], [{ meshAgentId: 'obj_1', textureId: 'tex_1', position: [0, 1, 0], normal: [0, 1, 0], size: [0.5, 0.5, 0.5], bake: false }], 'Created decal summary, or baked map/texture summary with decalAgentId:null.', 'Skinned meshes/active morphs require baking. Baking rejects overlapping/wrapped UVs, unsupported textures and unsafe material groups.', ['assets.loadTexture', 'uv.unwrap', 'undo']),
  definition('anim.clips', 'List animation clips on an object root.', [p('agentId', idSchema)], ['obj_1'], '[{clipId,name,duration,tracks}].', 'Use clipId when names are duplicated. Imported mesh children may not own root clips.', ['anim.play', 'anim.retarget']),
  definition('anim.play', 'Play one clip, transitioning away from other actions.', [p('agentId', idSchema), p('clipId', str('Clip id or unique exact clip name.')), opt('options', obj({ loop: bool('true repeats; false plays once and clamps final pose.'), speed: { type: 'number', exclusiveMinimum: 0, description: 'Positive time scale; default 1.' }, weight: bounded(0, 1, 'Blend weight; default 1.'), fadeIn: { type: 'number', minimum: 0, description: 'Transition seconds; default 0.' } }))], ['obj_1', 'Walk', { loop: true, speed: 1 }], '{id,clipId,loop,speed,weight,fadeIn}.', 'loop is boolean, not once/repeat/pingpong. Calling play again resets the action; use pause for zero speed.', ['anim.clips', 'anim.pause', 'anim.blend']),
  definition('anim.stop', 'Stop all animation actions on an object root.', [p('agentId', idSchema)], ['obj_1'], '{id,stopped:true}.', 'No optional clip argument is supported. Stopping may restore original property values.', ['anim.pause', 'anim.play']),
  definition('anim.pause', 'Pause an existing object mixer without resetting playback time.', [p('agentId', idSchema)], ['obj_1'], '{id,paused}.', 'There is no paused=false argument. Play/blend resume the mixer; play also resets its clip.', ['anim.seek', 'anim.play']),
  definition('anim.seek', 'Seek active actions to a nonnegative time in seconds.', [p('agentId', idSchema), p('time', { type: 'number', minimum: 0, description: 'Seconds, not timeline frames.' })], ['obj_1', 1.25], '{id,time}.', 'Play a clip first; no mixer returns E_NOT_FOUND. Repeating actions wrap, one-shot actions clamp.', ['anim.pause', 'anim.clips']),
  definition('anim.blend', 'Blend a nonempty array of clip weights on one object root.', [p('agentId', idSchema), p('entries', { ...arr(obj({ clipId: str('Clip id or unique name.'), weight: bounded(0, 1, 'Blend weight.') }, ['clipId', 'weight']), 'Unique clips; weights are not automatically normalized.'), minItems: 1 }), opt('options', obj({ duration: { type: 'number', minimum: 0, description: 'Transition seconds; default 0.' } }))], ['obj_1', [{ clipId: 'Idle', weight: 0.5 }, { clipId: 'Walk', weight: 0.5 }], { duration: 0.3 }], '{id,clips:[{clipId,weight}],duration}.', 'Entries must resolve to distinct clips. New blend actions loop; actions omitted from entries fade out and stop.', ['anim.clips', 'anim.play']),
  definition('anim.retarget', 'Retarget all source clips onto a compatible target named-bone hierarchy.', [p('sourceId', idSchema), p('targetId', idSchema), opt('mapping', { type: 'object', additionalProperties: { type: 'string' }, description: 'Source bone name to target bone name; default matching names.' })], ['obj_1', 'obj_2', { Hips: 'pelvis' }], '{sourceId,targetId,supported,retargeted,clips,limitations}; unsupported rigs return supported:false with code:E_UNSUPPORTED inside successful data.', 'Only named-bone position/quaternion tracks are supported. Samples are 30 fps; scale, morphs, IK and constraints are not transferred.', ['anim.clips', 'scene.info']),
  definition('anim.mixer', 'Access the live Three.js mixer in the browser.', [p('agentId', idSchema)], ['obj_1'], 'Live AnimationMixer in the success data field.', 'Not a JSON-safe handle; remote serialization may fail. Mutations bypass the high-level playback API.', ['anim.play', 'anim.pause'], { agentCallable: false, browserOnly: true }),
  definition('anim.onEnd', 'Subscribe a browser callback to final animation completion.', [p('agentId', idSchema), p('callback', callback)], [], 'Unsubscribe function in success data.', 'Functions cannot travel over JSON. Repeating clips do not normally finish; unsubscribe to release listeners.', ['anim.play', 'anim.stop'], { agentCallable: false, browserOnly: true, examples: [{ method: 'anim.onEnd', browserCall: 'const result = await agent.anim.onEnd("obj_1", event => console.log(event)); if (result.ok) result.data();' }], exampleCall: 'const result = await agent.anim.onEnd("obj_1", event => console.log(event)); if (result.ok) result.data();' }),
  definition('observe.screenshot', 'Capture the current viewport as an image data URL.', [opt('options', obj({ format: en(['png', 'jpeg', 'webp'], 'Default png.'), width: bounded(1, 4096, 'Output width; defaults to canvas width.', true), height: bounded(1, 4096, 'Output height; defaults to source aspect ratio.', true), viewportOnly: bool('Must remain true; false returns E_UNSUPPORTED.') }))], [{ format: 'png', width: 960, viewportOnly: true }], 'Image data URL string.', 'Full-DOM capture is unsupported. quality is fixed internally, not a supported option; cross-origin textures may taint capture.', ['scene.focus', 'observe.state']),
  definition('observe.logs', 'Read bounded recent log entries with severity/source filters.', [opt('query', obj({ since: num('Unix timestamp milliseconds, not seq.'), level: en(['debug', 'log', 'info', 'warn', 'error'], 'Minimum severity.'), source: str('Exact source filter.'), limit: { type: 'integer', minimum: 1, description: 'Maximum entries; default 200.' } }))], [{ level: 'warn', limit: 50 }], 'Log entry array with seq, ts, level, source, message and optional data.', 'Buffer history is bounded and may omit old entries.', ['exec', 'observe.state']),
  definition('observe.state', 'Read active panels, selection, mode, dirty state, object count and fps.', [], [], '{activePanel,selection,mode,dirty,objectCount,fps}.', 'dirty reflects canUndo, not a persisted-save comparison. State is not a project backup.', ['scene.tree', 'ui.activePanel']),
  definition('observe.performance', 'Read renderer/frame counters without a benchmark run.', [], [], '{fps,drawCalls,tris,textures,gpuMemMB:null}.', 'GPU memory is unavailable; counters are instantaneous, not benchmark evidence.', ['observe.state', 'observe.screenshot']),
  definition('tx.begin', 'Begin an explicit labelled deep-snapshot scene transaction.', [opt('label', str('Undo label; default Agent action.'))], ['UV edit'], 'txId string.', 'Deep mode is always enabled by the facade; no options argument is accepted. One explicit transaction at a time; 120s idle auto-commit and deep-copy budget apply.', ['tx.commit', 'tx.rollback', 'tx.list']),
  definition('tx.commit', 'Commit the current transaction as one shared undo command.', [opt('txId', str('Open transaction id; omitted means current.'))], ['tx_1'], '{txId,label,committed,changes,deepSkipped}.', 'Nested transactions must close first. Empty commits create no undo entry.', ['tx.begin', 'undo']),
  definition('tx.rollback', 'Revert and close the current snapshot-based transaction.', [opt('txId', str('Open transaction id; omitted means current.'))], ['tx_1'], '{txId,label,rolledBack,reverted,deepSkipped}.', 'External I/O and geometry skipped by the deep-copy budget cannot be fully reversed.', ['tx.begin', 'tx.list']),
  definition('tx.list', 'List bounded recent and currently open transaction records.', [], [], 'Array of {txId,label,ts,status,ops,nested,changes?}.', 'Only open transactions can be committed or rolled back.', ['tx.commit', 'tx.rollback']),
  definition('ui.list', 'Discover live controls with values, constraints and documentation ids.', [opt('query', obj({ panel: str('Exact panel or panel-prefix filter.'), visibleOnly: bool('Default false.'), type: str('Exact control type.'), query: str('Case-insensitive id/label/tooltip search.') }))], [{ panel: 'inspector', visibleOnly: true }], 'Live Control[] including id,type,label,panel,disabled,docsToolId,options,range.', 'Presence is not handler verification. Previously rendered controls are retained in the manifest, not ui.list.', ['ui.openPanel', 'docs.get']),
  definition('ui.click', 'Activate a rendered button, menu item, tab or summary toggle.', [p('id', str('Control id from ui.list, not ui.control ToolDef id.')), opt('options', approve)], ['btn-file-new', { confirm: true }], '{id,value,activePanel}.', 'Canvas clicks are unsupported; file inputs cannot be safely automated. Disabled controls throw E_DISABLED. Destructive controls request trusted approval.', ['ui.list', 'ui.waitFor', 'docs.get']),
  definition('ui.setValue', 'Set an input/select value and dispatch its DOM events.', [p('id', str('Control id.')), p('value', { type: ['string', 'number', 'boolean'], description: 'Number for numeric inputs, boolean for checked state, string for text/select/color.' })], ['viewport-shading-mode', 'solid'], '{id,value}.', 'Use exact select values and #rrggbb colors. Numbers are clamped. Text inputs also emit Enter; file inputs return E_PERMISSION.', ['ui.list', 'ui.waitFor']),
  definition('ui.openPanel', 'Activate a dock, inspector tab, menu, workspace or sidebar.', [p('panelId', en(Object.keys(PANELS), 'Known panel id.'))], ['inspector.material'], '{panel,active}.', 'Workspace changes may alter mode/selection; deep audits must not visit them. Inspector content can require a selected mesh.', ['ui.list', 'ui.activePanel']),
  definition('ui.closePanel', 'Close a supported menu, popover, sidebar, toolbar or copilot.', [p('panelId', en(Object.keys(PANELS), 'Known panel id.'))], ['menu-file'], '{panel,active} or {panel,note}.', 'Dock panes generally cannot be closed; open another pane instead.', ['ui.openPanel', 'ui.activePanel']),
  definition('ui.activePanel', 'Read active dock, workspace, menu, popover, inspector and copilot state.', [], [], '{dock,workspace,menu,popover,inspectorTab,copilot}.', 'Active state does not indicate every control visibility.', ['ui.openPanel', 'observe.state']),
  definition('ui.waitFor', 'Wait for a control presence, visibility or enabled state.', [p('id', str('Control id.')), opt('options', obj({ state: en(['visible', 'hidden', 'enabled', 'disabled', 'present', 'absent'], 'Default visible.'), timeout: { type: 'number', minimum: 0, description: 'Milliseconds; default 5000.' } }))], ['btn-edit-delete', { state: 'enabled', timeout: 5000 }], '{id,state,elapsedMs}.', 'Missing satisfies absent, not hidden. Open the owning panel first.', ['ui.openPanel', 'ui.list']),
  definition('ui.shortcut', 'Dispatch a key combination through current engine/app bindings.', [p('keys', str('For example Shift+D, Numpad1, Ctrl+Space.'))], ['Numpad1'], '{keys,key,code,mods}.', 'This blurs focused inputs. Destructive shortcuts bypass confirmation and must not be automated; mode and modifiers affect behavior.', ['ui.click', 'ui.activePanel'], { shortcuts: SHORTCUTS }),
  definition('ui.highlight', 'Outline a control or its nearest visible ancestor temporarily.', [p('id', str('Control id.')), opt('ms', num('Milliseconds; default 1200, minimum effective 100.'))], ['btn-edit-delete', 1200], '{id,highlighted,target?}.', 'Highlighting does not enable or invoke a handler.', ['ui.list', 'tutorial.step']),
  definition('ui.status', 'Show or dismiss a short agent status message.', [p('text', str('Empty string dismisses.')), opt('options', obj({ tone: en(['info', 'warn', 'error'], 'Default info.'), ttl: num('Auto-dismiss milliseconds; 0 stays visible.') }))], ['Reviewing materials', { tone: 'info', ttl: 2000 }], '{shown,text?}.', 'Text is truncated to 200 characters; this is not a confirmation dialog.', ['ui.highlight', 'observe.logs']),
  definition('docs.get', 'Read task-oriented documentation for a ToolDef.', [p('toolId', str('API id or ui.control.<controlId>.'))], ['scene.select'], '{toolId,overview,when,params,steps,pitfalls,exampleCall,related}.', 'Historical control documentation remains after re-render; check available before using its example.', ['docs.search', 'ui.list']),
  definition('docs.search', 'Search descriptions, parameter contracts and pitfalls.', [p('query', str('Case-insensitive search terms.'))], ['texture'], 'Matching documentation record array.', 'Only previously observed controls are searchable; the public facade forwards query only.', ['docs.get', 'docs.all']),
  definition('docs.all', 'Read all API and historical control documentation.', [], [], 'Documentation record array.', 'Catalogue size is not handler coverage.', ['docs.search', 'caps']),
  definition('tutorial.start', 'Start a new tutorial recording with a title and audience.', [p('options', obj({ title: { ...str('Nonempty tutorial title.'), minLength: 1 }, audience: str('Audience; default empty.') }, ['title']))], [{ title: 'Apply a material', audience: 'Beginners' }], '{title,audience,stepCount:0}.', 'Starting replaces the previous session and revokes its export URL; recording grants no destructive permission.', ['tutorial.step', 'tutorial.export']),
  definition('tutorial.step', 'Record instructions, arguments, optional documentation, highlight and screenshot.', [p('options', obj({ text: { ...str('Nonempty instructions.'), minLength: 1 }, toolId: str('Optional documented ToolDef id.'), args: { description: 'JSON-compatible example arguments; not executed.' }, screenshot: bool('Capture JPEG viewport; default true.'), highlight: str('Optional rendered control id.') }, ['text']))], [{ text: 'Select a target mesh before editing its material.', toolId: 'scene.select', args: [['obj_1']], screenshot: false }], 'Recorded step number.', 'Requires tutorial.start first. Arguments are snapshotted, not executed; screenshot/highlight prerequisites can fail.', ['tutorial.start', 'docs.get', 'ui.highlight']),
  definition('tutorial.export', 'Export recorded steps as Markdown, HTML, JSON or PDF with a blob URL.', [opt('options', obj({ format: en(['markdown', 'html', 'json', 'pdf'], 'Default markdown.'), embedScreenshots: bool('Default true.') }))], [{ format: 'json', embedScreenshots: false }], '{url,content,mime,sizeBytes}.', 'Exports above 10MB request user approval. PDF text uses a basic Latin font; export URL is revoked by the next export/start.', ['tutorial.start', 'tutorial.step']),
  definition('util.hash', 'Compute a stable non-cryptographic FNV-1a hash of a value.', [p('value', { description: 'JSON-compatible value; object keys are sorted.' })], [{ name: 'Cube', position: [0, 0, 0] }], 'Eight-character hexadecimal string.', 'Not safe for authentication, secrets or collision-free identity.', ['observe.state', 'scene.info']),
  definition('util.raycast', 'Find object surface hits under normalized viewport coordinates.', [p('point', obj({ x: bounded(-1, 1, 'NDC x: left -1, right +1.'), y: bounded(-1, 1, 'NDC y: bottom -1, top +1.') }, ['x', 'y']))], [{ x: 0, y: 0 }], 'Hit array with agentId,point,normal,distance,faceIndex.', 'Coordinates are not pixels; face normals are local-space normals, not guaranteed world normals for decal projection.', ['scene.select', 'decal.project']),
  definition('undo', 'Undo the latest command on the shared scene stack.', [], [], '{undone,canUndo,canRedo}.', 'Pending writes/open transactions prevent undo; empty stack returns E_NOT_FOUND.', ['redo', 'tx.list']),
  definition('redo', 'Redo the next command on the shared scene stack.', [], [], '{redone,canUndo,canRedo}.', 'Pending writes/open transactions prevent redo; new edits can discard redo history.', ['undo', 'tx.list'])
];

const CURATED_CONFIRM = new Set(['btn-file-new', 'btn-edit-delete', 'btn-edit-delete-geometry', 'btn-reset-scene', 'btn-clear-code', 'btn-clear-console', 'btn-clear-all-modifiers', 'tl-btn-delete-kf']);
const destructive = c => CURATED_CONFIRM.has(c.id) || (!['input', 'select', 'slider', 'color', 'viewport'].includes(c.type) &&
  /\b(delete|clear|remove all|new scene|new file)\b|(?:xoá|xóa|xóa)/iu.test(`${c.id.replace(/[._-]/g, ' ')} ${c.label} ${c.tooltip || ''}`));
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const duplicateValues = values => {
  const counts = new Map(); values.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
  return [...counts].filter(([, count]) => count > 1).map(([id, count]) => ({ id, count }));
};

export class AgentManifest {
  constructor(ctx) {
    this.ctx = ctx;
    this._api = new Map(API_TOOL_DEFS.map(def => [def.id, def]));
    this._controls = new Map(); this._liveIds = new Set(); this._refreshing = false; this._auditing = false;
    this.docs = Object.freeze({ get: this.get.bind(this), search: this.search.bind(this), all: this.all.bind(this) });
    this.shortcuts = SHORTCUTS;
  }

  toolIdForControl(id) { return `ui.control.${id}`; }

  _live() {
    if (this._refreshing) return [];
    this._refreshing = true;
    try {
      const controls = this.ctx.ui?.list() || [];
      this._liveIds = new Set(controls.map(c => c.id));
      for (const control of controls) {
        const el = this.ctx.ui?.idToEl?.get(control.id);
        const existing = this._controls.get(control.id);
        const dom = el ? { tag: el.tagName, inputType: el.type, editable: !!el.isContentEditable } : existing?.dom || null;
        const signature = c => ({ id: c.id, type: c.type, label: c.label, panel: c.panel, options: c.options, range: c.range, accept: c.accept });
        if (!existing) this._controls.set(control.id, { latest: clone(control), history: [clone(control)], dom });
        else {
          if (!same(signature(existing.latest), signature(control)) || !same(existing.dom, dom)) existing.history.push(clone(control));
          existing.latest = clone(control); existing.dom = dom;
        }
      }
      return controls;
    } finally { this._refreshing = false; }
  }

  _controlTool(entry) {
    const c = entry.latest, dom = entry.dom;
    const fileInput = c.accept !== undefined || dom?.inputType === 'file';
    const viewport = c.type === 'viewport' || dom?.tag === 'CANVAS';
    const settable = !fileInput && (dom ? ['INPUT', 'SELECT', 'TEXTAREA'].includes(dom.tag) || dom.editable
      : ['input', 'select', 'slider', 'color'].includes(c.type));
    let value = str('Text value.'), exampleValue = typeof c.value === 'string' ? c.value : '';
    if (c.options) { const values = c.options.map(o => String(o.value)); value = { ...str('Exact option value, not label.'), enum: values }; exampleValue = values[0] ?? ''; }
    else if (c.type === 'slider' || c.range) {
      value = num('Number; AgentUI clamps to HTML min/max.');
      if (c.range?.min != null) value.minimum = c.range.min;
      if (c.range?.max != null) value.maximum = c.range.max;
      if (c.range?.step != null) value['x-html-step'] = c.range.step;
      exampleValue = typeof c.value === 'number' ? c.value : c.range?.min ?? 0;
    } else if (c.type === 'color') { value = color; exampleValue = '#ff8800'; }
    else if (c.type === 'toggle' && settable) { value = bool('Desired checked state.'); exampleValue = true; }
    const requiresConfirm = destructive(c), method = settable ? 'ui.setValue' : 'ui.click';
    const args = settable ? [c.id, exampleValue] : requiresConfirm ? [c.id, { confirm: true }] : [c.id];
    const params = [p('id', { ...str('Fixed control id.'), const: c.id }), ...(settable ? [p('value', value)] : [opt('options', approve)])];
    const description = viewport ? 'Inspect canvas metadata; direct canvas automation is unsupported.'
      : fileInput ? 'Request a local file through the asset picker rather than setting this file input.'
      : settable ? `Set ${c.label} in ${c.panel} and dispatch its DOM value events.` : `Activate ${c.label} in ${c.panel} through its DOM click behavior.`;
    const related = viewport ? ['scene.select', 'util.raycast'] : fileInput ? ['assets.pickFile', 'assets.importFiles', 'assets.importURL'] : [method, 'ui.list', 'ui.waitFor'];
    const def = definition(this.toolIdForControl(c.id), description, params, args,
      settable ? '{id,value}.' : '{id,value,activePanel}.',
      viewport ? 'Canvas clicks return E_UNSUPPORTED; use scene.select/util.raycast.' : fileInput ? 'File inputs cannot be set programmatically; local paths are not browser Files.'
        : 'A rendered control may lack a real handler. Open its panel, inspect disabled/visible state and verify the resulting application state.', related);
    Object.assign(def, {
      kind: 'control', method, label: c.label, panel: c.panel, controlId: c.id, controlType: c.type,
      requiresConfirm, agentCallable: !viewport && !fileInput, available: this._liveIds.has(c.id),
      disabled: !!c.disabled, visible: !!c.visible, control: clone(c), history: clone(entry.history),
      examples: [{ method, args }], exampleCall: `await agent.${method}(${args.map(v => JSON.stringify(v)).join(', ')})`,
      coverage: { source: 'live-dom', handlerVerified: false }
    });
    if (c.disabled) def.pitfalls.push('Currently disabled: satisfy selection, mesh, mode or asset prerequisites.');
    if (!def.available) def.pitfalls.push('Historical definition, currently absent: reopen the panel and rediscover the control. Absence is not unmapped coverage.');
    if (requiresConfirm) def.pitfalls.push('Destructive: ui.click requires {confirm:true}, which asks the user and does not bypass approval.');
    if (c.tooltip) def.pitfalls.push(`UI guidance: ${c.tooltip}`);
    if (c.options) def.pitfalls.push(`Option values: ${c.options.map(o => JSON.stringify(o.value)).join(', ')}.`);
    if (c.range) def.pitfalls.push(`HTML range: ${JSON.stringify(c.range)}; step metadata does not prove handler quantization.`);
    def.steps = [
      PANELS[c.panel] ? `await agent.ui.openPanel(${JSON.stringify(c.panel)});` : `Locate the owning panel (${c.panel}) using ui.list/openPanel.`,
      `Inspect await agent.ui.list({query:${JSON.stringify(c.id)}}) for current prerequisites.`,
      ...(def.agentCallable ? [def.exampleCall, 'Inspect ok/data and application state; dispatch success does not prove the intended handler ran.'] : ['Use the related supported APIs; do not invoke this control programmatically.'])
    ];
    if (!def.agentCallable) { def.examples = []; def.exampleCall = viewport ? 'await agent.util.raycast({x:0,y:0})' : 'await agent.assets.pickFile({accept:"*"})'; }
    return def;
  }

  _availableAPI(def) {
    const facade = this.ctx.agent || this.ctx.api || this.ctx.app?.agent || globalThis.window?.agent;
    for (const candidate of [facade, this.ctx]) {
      let value = candidate; for (const part of def.method.split('.')) value = value?.[part];
      if (typeof value === 'function') return true;
    }
    if (def.method.startsWith('docs.')) return typeof this.docs[def.method.slice(5)] === 'function';
    return facade ? false : null;
  }

  _tools() {
    return [...this._api.values()].map(def => ({ ...clone(def), available: this._availableAPI(def) }))
      .concat([...this._controls.values()].map(entry => this._controlTool(entry))).sort((a, b) => a.id.localeCompare(b.id));
  }
  tools() { this._live(); return this._tools(); }
  getTool(id) {
    this._live(); const api = this._api.get(id);
    if (api) return { ...clone(api), available: this._availableAPI(api) };
    const entry = typeof id === 'string' && id.startsWith('ui.control.') ? this._controls.get(id.slice(11)) : null;
    return entry ? this._controlTool(entry) : null;
  }
  _doc(tool) {
    return { toolId: tool.id, kind: tool.kind, overview: tool.description, when: tool.when,
      params: tool.params, parameters: tool.parameters, argsSchema: tool.argsSchema, steps: tool.steps, pitfalls: tool.pitfalls,
      exampleCall: tool.exampleCall, examples: tool.examples, returns: tool.returns, errors: tool.errors, related: tool.related,
      agentCallable: tool.agentCallable, requiresConfirm: tool.requiresConfirm, available: tool.available };
  }
  get(id) {
    const tool = this.getTool(id);
    if (!tool) throw new AgentError('E_NOT_FOUND', `No documentation for '${id}'`, 'Use docs.search or ui.list to discover a ToolDef id.', 'docs.get');
    return this._doc(tool);
  }
  all() { return this.tools().map(tool => this._doc(tool)); }
  search(query, { limit = 50, kind } = {}) {
    if (typeof query !== 'string' || !Number.isInteger(limit) || limit < 1 || (kind && !['api', 'control'].includes(kind))) throw new AgentError('E_INVALID_ARG', 'Search requires a string query and positive integer limit.', 'Optional kind must be api or control.', 'docs.search');
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return this.tools().filter(tool => (!kind || tool.kind === kind) && words.every(word =>
      JSON.stringify([tool.id, tool.label, tool.description, tool.params, tool.pitfalls, tool.related]).toLowerCase().includes(word)
    )).slice(0, limit).map(tool => this._doc(tool));
  }

  audit({ deep = false } = {}) { return deep ? this._deepAudit() : this._auditLive(); }
  _auditLive() {
    const controls = this._live(), tools = this._tools(), byId = new Map(tools.map(t => [t.id, t]));
    const unmappedControls = controls.filter(c => !byId.has(this.toolIdForControl(c.id))).map(c => c.id);
    const differences = {
      unmappedControls,
      mismatchedDocsToolIds: controls.filter(c => c.docsToolId !== this.toolIdForControl(c.id)).map(c => ({ id: c.id, actual: c.docsToolId ?? null, expected: this.toolIdForControl(c.id) })),
      duplicateControlIds: duplicateValues(controls.map(c => c.id)), duplicateToolIds: duplicateValues(tools.map(t => t.id)),
      duplicateDOMIds: typeof document === 'undefined' ? [] : duplicateValues([...document.querySelectorAll('[id]')].map(el => el.id).filter(Boolean)),
      untaggedControls: typeof document === 'undefined' ? [] : [...document.querySelectorAll(CONTROL_SELECTOR)].filter(el => !el.closest('.agent-ui-root') && !el.dataset.agentId).map(el => ({ id: el.id || null, tag: el.tagName.toLowerCase() })),
      missingDocs: tools.filter(t => !t.description || !t.when || !t.params || !t.steps?.length || !t.pitfalls?.length || !t.exampleCall).map(t => t.id)
    };
    const diff = Object.fromEntries(Object.entries(differences).map(([key, values]) => [key, values.length]));
    return {
      source: 'live-dom', deep: false, totalControls: controls.length, mappedControls: controls.length - unmappedControls.length,
      totalTools: tools.length, historicalControls: this._controls.size,
      absentHistoricalControls: [...this._controls.keys()].filter(id => !this._liveIds.has(id)),
      unsupportedControls: tools.filter(t => t.kind === 'control' && !t.agentCallable).map(t => t.controlId),
      diff, differences, ok: Object.values(diff).every(n => n === 0),
      coverage: { source: 'live-dom', uiReady: !!this.ctx.ui, handlerCoverage: 'unknown', handlerVerified: false, limitations: [
        'Exactly one ToolDef is automatically generated per observed control id. Zero mapping differences do not prove real event-handler coverage.',
        'Absent controls are not unmapped; historical definitions remain discoverable.',
        'Menus, dialogs, workspaces, alternate selections, assets and unvisited states are not exhaustively covered.',
        'Canvas/file inputs are documented but not agent-callable. Disabled controls require prerequisites.',
        'API metadata does not install handlers; availability can be unknown until main exposes the facade.'
      ] }
    };
  }

  async _deepAudit() {
    if (this._auditing) throw new AgentError('E_TX_CONFLICT', 'A deep UI audit is already running', 'Await its completion.', 'caps');
    if (!this.ctx.ui || typeof document === 'undefined') throw new AgentError('E_NOT_FOUND', 'Deep audit requires an initialized browser UI', 'Set ctx.ui before auditing.', 'caps');
    this._auditing = true;
    const ui = this.ctx.ui, visitedPanels = [], skippedPanels = [], restoreErrors = [], samples = [];
    let state, styles, activeFlags, focus, focusId, scroll;
    try {
      state = clone(ui.activePanel()); focus = document.activeElement; focusId = focus?.dataset?.agentId;
      styles = [...document.querySelectorAll('#sidebar-right,#bottom-dock,#dock-mocap,.blender-toolbar')].map(el => ({ el, style: el.getAttribute('style'), mocapFocus: el.classList.contains('mocap-focus') }));
      activeFlags = [...document.querySelectorAll('.dock-tab,.dock-pane,.prop-tab-btn,.menu-item,.menu-dropdown,#viewport-shading-popover')].map(el => ({ el, active: el.classList.contains('active'), open: el.classList.contains('open'), visible: el.classList.contains('visible') }));
      scroll = [...document.querySelectorAll('#properties-content-body,.properties-content,.dock-pane')].map(el => ({ el, id: el.id, top: el.scrollTop, left: el.scrollLeft }));
      samples.push(this._auditLive());
      for (const [panelId, panel] of Object.entries(PANELS)) {
        if (!['dock', 'inspector-tab'].includes(panel.kind)) continue;
        const selector = panel.kind === 'dock' ? `.dock-tab[data-pane="${panel.pane}"]` : `.prop-tab-btn[data-tab="${panel.tab}"]`;
        if (!document.querySelector(selector)) { skippedPanels.push({ panel: panelId, reason: 'Tab is not rendered.' }); continue; }
        try {
          await ui.openPanel(panelId); const active = ui.activePanel();
          if ((panel.kind === 'dock' ? active.dock : active.inspectorTab) !== (panel.kind === 'dock' ? panelId : panel.tab)) skippedPanels.push({ panel: panelId, reason: 'Activation was not observed; handler coverage remains unknown.' });
          else visitedPanels.push(panelId);
          samples.push(this._auditLive());
        } catch (error) { skippedPanels.push({ panel: panelId, reason: error.message || String(error) }); }
      }
    } finally {
      try {
        // Restore internal tab state through tab handlers, then restore presentation.
        for (const panelId of [state?.dock, state?.inspectorTab ? `inspector.${state.inspectorTab}` : null]) {
          if (!panelId || !PANELS[panelId]) continue;
          try { await ui.openPanel(panelId); } catch (error) { restoreErrors.push({ panel: panelId, message: error.message || String(error) }); }
        }
        for (const entry of activeFlags || []) if (entry.el.isConnected) {
          for (const name of ['active', 'open', 'visible']) entry.el.classList.toggle(name, entry[name]);
        }
        for (const entry of styles || []) if (entry.el.isConnected) {
          if (entry.style === null) entry.el.removeAttribute('style'); else entry.el.setAttribute('style', entry.style);
          entry.el.classList.toggle('mocap-focus', entry.mocapFocus);
        }
        this.ctx.engine?.onResize?.(); ui.tagAll?.();
        for (const entry of scroll || []) { const el = entry.el.isConnected ? entry.el : entry.id ? document.getElementById(entry.id) : null; if (el) { el.scrollTop = entry.top; el.scrollLeft = entry.left; } }
        const target = focus?.isConnected ? focus : focusId ? ui.idToEl?.get(focusId) : null; target?.focus?.({ preventScroll: true });
      } catch (error) { restoreErrors.push({ message: error.message || String(error) }); }
      finally { this._auditing = false; }
    }
    const report = this._auditLive(); samples.push(report);
    // Retain failures observed in temporary panels, not just the final restored DOM.
    report.differences = Object.fromEntries(Object.keys(report.differences).map(key => [key,
      [...new Map(samples.flatMap(sample => sample.differences[key]).map(value => [JSON.stringify(value), value])).values()]
    ]));
    report.diff = Object.fromEntries(Object.entries(report.differences).map(([key, values]) => [key, values.length]));
    report.deep = true; report.visitedPanels = visitedPanels; report.skippedPanels = skippedPanels; report.restoreErrors = restoreErrors;
    report.restoredState = ui.activePanel(); report.diff.restoreErrors = restoreErrors.length;
    report.diff.stateRestoreMismatch = same(state, report.restoredState) ? 0 : 1;
    report.ok = Object.values(report.diff).every(n => n === 0);
    report.coverage.visitedPanels = visitedPanels; report.coverage.samples = samples.length;
    report.coverage.observedControlDefinitions = this._controls.size;
    report.coverage.limitations.push('Deep audit visits only dock/inspector tabs and restores UI in finally. Totals describe the restored DOM; differences include every sampled panel. It does not execute controls or visit workspace tabs.');
    return report;
  }
}
export default AgentManifest;

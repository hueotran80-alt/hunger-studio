import * as THREE from 'three';
import { AgentError, assertArg } from './agent-core.js';

const MAX_BYTES = 50 * 1024 * 1024;
const TYPES = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'hdr', 'exr', 'texture'];

export function createAssetTools(ctx) {
  const assets = new Map();
  let counter = 0;
  const local = new URL('../../', import.meta.url);
  const infer = (url, type = 'auto') => {
    if (type !== 'auto') {
      assertArg(TYPES.includes(type), `Unsupported asset type: ${type}`);
      return type;
    }
    const ext = new URL(url, local).pathname.split('.').pop().toLowerCase();
    if (TYPES.includes(ext)) return ext;
    if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(ext)) return 'texture';
    throw new AgentError('E_UNSUPPORTED', `Cannot infer asset type: ${ext}`, 'Pass opts.type explicitly.');
  };
  const route = (url) => {
    const u = new URL(url, local);
    assertArg(['https:', 'http:', 'blob:', 'data:'].includes(u.protocol), 'Only HTTP(S), uploaded blobs and image data URLs are supported.');
    if (u.protocol === 'data:') assertArg(/^data:image\/(png|jpeg|webp);base64,/i.test(u.href) && u.href.length < MAX_BYTES * 1.4, 'Use a bounded PNG/JPEG/WebP data URL.');
    if (u.origin === local.origin || ['blob:', 'data:'].includes(u.protocol)) return u.href;
    return `/api/agent/proxy?url=${encodeURIComponent(u.href)}`;
  };
  const managerFor = (url, fileURLs) => {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(path => {
      if (fileURLs) {
        const key = decodeURIComponent(new URL(path, url).pathname.split('/').pop());
        if (fileURLs.has(key)) return fileURLs.get(key);
      }
      return route(new URL(path, url).href);
    });
    return manager;
  };
  async function boundedFetch(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(route(url), { signal: controller.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new AgentError(body?.error?.code || 'E_CORS', body?.error?.message || `Asset HTTP ${response.status}`, body?.error?.hint || 'Check the asset URL and server allowlist.');
      }
      if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new AgentError('E_TOO_LARGE', 'Asset exceeds 50MB.');
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new AgentError('E_TOO_LARGE', 'Asset exceeds 50MB.'); }
        chunks.push(value);
      }
      return { buffer: await new Blob(chunks).arrayBuffer(), size: bytes };
    } catch (e) {
      if (controller.signal.aborted) throw new AgentError('E_TIMEOUT', 'Asset download exceeded 20 seconds.');
      throw e;
    } finally { clearTimeout(timer); }
  }
  async function loadTexture(url, opts = {}, file = null) {
    const type = infer(file?.name || url, opts.type || 'auto');
    const { buffer, size } = file ? { buffer: await file.arrayBuffer(), size: file.size } : await boundedFetch(url);
    let texture;
    if (type === 'hdr' || type === 'exr') {
      const { RGBELoader } = type === 'hdr' ? await import('three/addons/loaders/RGBELoader.js') : {};
      const { EXRLoader } = type === 'exr' ? await import('three/addons/loaders/EXRLoader.js') : {};
      const loader = type === 'hdr' ? new RGBELoader() : new EXRLoader();
      const data = loader.parse(buffer);
      texture = new THREE.DataTexture(data.data, data.width, data.height, data.format || THREE.RGBAFormat, data.type || THREE.HalfFloatType);
      texture.mapping = THREE.EquirectangularReflectionMapping;
      texture.colorSpace = THREE.LinearSRGBColorSpace;
      texture.needsUpdate = true;
    } else {
      const blob = new Blob([buffer], { type: file?.type || '' });
      const objectURL = URL.createObjectURL(blob);
      try { texture = await new THREE.TextureLoader().loadAsync(objectURL); }
      finally { URL.revokeObjectURL(objectURL); }
      texture.colorSpace = opts.colorSpace === 'linear' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    }
    const image = texture.image;
    const max = ctx.engine.renderer.capabilities.maxTextureSize;
    if (image.width > max || image.height > max) { texture.dispose(); throw new AgentError('E_TOO_LARGE', `Texture exceeds GPU maximum ${max}px.`); }
    const protocol = new URL(url, local).protocol;
    const derived = ['data:', 'blob:'].includes(protocol) ? `${type === 'texture' ? 'image' : type}.bin` : new URL(url, local).pathname.split('/').pop();
    texture.name = opts.name || file?.name || derived;
    const textureId = ctx.textures.assign(texture);
    const assetId = `asset_${++counter}`;
    assets.set(assetId, { assetId, textureId, name: texture.name, type, sizeBytes: size, source: file ? 'file' : 'url', url: file ? null : (protocol === 'data:' ? `data:${type}` : String(url)) });
    return { textureId, assetId, size: [image.width, image.height], format: type };
  }
  async function importImpl(url, opts = {}, file = null, fileURLs = null, isExpired = () => false) {
    assertArg(typeof url === 'string' && url.length > 0, 'Asset URL must be a string.');
    const type = infer(file?.name || url, opts.type || 'auto');
    if (['texture', 'hdr', 'exr'].includes(type)) return loadTexture(url, { ...opts, type }, file);
    const { buffer, size } = file ? { buffer: await file.arrayBuffer(), size: file.size } : await boundedFetch(url);
    const absolute = new URL(url, local).href;
    const base = absolute.startsWith('blob:') ? local.href : new URL('.', absolute).href;
    const manager = managerFor(base, fileURLs);
    let object, clips = [];
    if (type === 'glb' || type === 'gltf') {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
      const draco = new DRACOLoader();
      draco.setDecoderPath(new URL('vendor/three/addons/libs/draco/gltf/', local).href);
      try {
        const gltf = await new GLTFLoader(manager).setDRACOLoader(draco).parseAsync(type === 'gltf' ? new TextDecoder().decode(buffer) : buffer, base);
        object = gltf.scene; clips = gltf.animations;
      } finally { draco.dispose(); }
    } else if (type === 'fbx') {
      const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
      object = new FBXLoader(manager).parse(buffer, base); clips = object.animations || [];
    } else if (type === 'obj') {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      object = new OBJLoader(manager).parse(new TextDecoder().decode(buffer));
    } else {
      const module = type === 'stl' ? await import('three/addons/loaders/STLLoader.js') : await import('three/addons/loaders/PLYLoader.js');
      const Loader = module.STLLoader || module.PLYLoader;
      const geometry = new Loader(manager).parse(buffer);
      geometry.computeVertexNormals();
      object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xb7bec9, roughness: .65, vertexColors: !!geometry.attributes.color }));
    }
    if (opts.position) { assertArg(opts.position.length === 3 && opts.position.every(Number.isFinite), 'position must be [x,y,z].'); object.position.fromArray(opts.position); }
    if (opts.scale !== undefined) {
      assertArg(Number.isFinite(opts.scale) || (Array.isArray(opts.scale) && opts.scale.length === 3 && opts.scale.every(Number.isFinite)), 'scale must be a number or [x,y,z].');
      if (Array.isArray(opts.scale)) object.scale.fromArray(opts.scale); else object.scale.setScalar(opts.scale);
    }
    const name = opts.name || file?.name?.replace(/\.[^.]+$/, '') || new URL(url, local).pathname.split('/').pop().replace(/\.[^.]+$/, '') || 'Imported_Model';
    const result = await ctx.mutate('Import asset', () => {
      let importedCount = 0;
      object.traverse(() => { importedCount++; });
      if (ctx.scan().length + importedCount > 5000) throw new AgentError('E_TOO_LARGE', 'Scene object limit reached.');
      ctx.app.exporter._integrateImportedObject(object, name, clips);
      ctx.assignHierarchy(object);
      object.animations = clips;
      const assetId = `asset_${++counter}`;
      const textures = [], bones = [];
      object.traverse(o => {
        if (o.isBone) bones.push({ agentId: ctx.ids.assign(o), name: o.name });
        ctx.materialsOf(o).forEach(m => Object.values(m).forEach(t => { if (t?.isTexture) textures.push(ctx.textures.assign(t)); }));
      });
      const handle = { assetId, agentId: ctx.ids.assign(object), name: object.name, type, clips: clips.map((c, i) => ({ clipId: `clip_${object.userData.agentId}_${i}`, name: c.name, duration: c.duration })), textures: [...new Set(textures)], bones, size };
      assets.set(assetId, { ...handle, sizeBytes: size, source: file ? 'file' : 'url', url: file ? null : url });
      ctx.events.emit('asset:loaded', handle);
      return handle;
    });
    opts.onProgress?.({ loaded: size, total: size });
    return result;
  }
  return {
    importURL: (url, opts = {}) => importImpl(url, opts),
    async importFiles(files) {
      const list = Array.from(files || []);
      assertArg(list.length > 0 && list.every(f => f instanceof File), 'Pass File[] or FileList.');
      assertArg(list.reduce((n, f) => n + f.size, 0) <= MAX_BYTES, 'Upload batch exceeds 50MB.');
      const urls = new Map(list.map(f => [f.name, URL.createObjectURL(f)]));
      try {
        const results = [];
        for (const file of list) {
          if (!/\.(glb|gltf|fbx|obj|stl|ply|hdr|exr|png|jpe?g|webp)$/i.test(file.name)) continue;
          results.push(await importImpl(urls.get(file.name), {}, file, urls));
        }
        return results;
      } finally { urls.forEach(u => URL.revokeObjectURL(u)); }
    },
    loadTexture: (source, opts = {}) => source instanceof File ? loadTexture(source.name, opts, source) : loadTexture(source, { ...opts, type: opts.type || 'texture' }),
    list: () => [...assets.values()].filter(a => !a.agentId || ctx.scan().some(o => o.userData.agentId === a.agentId)).sort((a, b) => a.assetId.localeCompare(b.assetId, undefined, { numeric: true })),
    async delete(assetId, opts = {}) {
      const a = assets.get(assetId);
      if (!a) throw new AgentError('E_NOT_FOUND', `Asset ${assetId} not found.`);
      await ctx.requireConfirm('Delete asset', a.name, opts);
      if (a.agentId) await ctx.mutate('Delete asset', () => ctx.detach(ctx.node(a.agentId)));
      else if (a.textureId) {
        const tex = ctx.textures.get(a.textureId);
        if (ctx.scan().some(o => ctx.materialsOf(o).some(m => Object.values(m).includes(tex)))) throw new AgentError('E_PERMISSION', 'Texture is still assigned to a scene material.', 'Remove its material maps first.');
        tex?.dispose(); ctx.textures.delete(a.textureId);
      }
      assets.delete(assetId);
      return { assetId, deleted: true };
    },
    pickFile({ accept = '.glb,.gltf,.fbx,.obj,.png,.jpg,.hdr,.exr' } = {}) {
      return new Promise(resolve => {
        const root = document.createElement('div'); root.className = 'agent-ui-root agent-filepick'; root.dataset.agentProtected = '1';
        root.innerHTML = '<span>Agent requests file selection</span><button class="agent-filepick-go">Choose File</button><button class="agent-filepick-cancel">Cancel</button>';
        const input = document.createElement('input'); input.type = 'file'; input.accept = accept; input.hidden = true; root.append(input);
        const finish = file => { root.remove(); resolve(file); };
        root.querySelector('.agent-filepick-go').onclick = e => { if (e.isTrusted) input.click(); };
        root.querySelector('.agent-filepick-cancel').onclick = () => finish(null);
        input.onchange = () => finish(input.files[0] || null); input.oncancel = () => finish(null);
        document.body.append(root);
      });
    }
  };
}

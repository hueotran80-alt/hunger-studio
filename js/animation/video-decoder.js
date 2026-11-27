/**
 * Web Blender Studio - Sequential WebCodecs video decoding for mocap.
 * File: js/animation/video-decoder.js
 *
 * Demuxes MP4 (vendored mp4box, BSD-3-Clause, vendor/mp4box/) or WebM
 * (minimal built-in EBML parser for VP8/VP9/AV1) into EncodedVideoChunk
 * samples and decodes them SEQUENTIALLY with VideoDecoder. This replaces
 * the slow "seek a paused <video> per frame" loop in browser-mocap.js when
 * WebCodecs is available; the seek loop remains the fallback.
 *
 * Pure demux helpers (demuxWebM/demuxMp4) never touch browser globals so
 * they can be exercised from Node tests. `openVideoFrameStream()` is the
 * browser entry point and returns a bounded, back-pressured frame queue:
 *
 *   const stream = await openVideoFrameStream(arrayBuffer, { signal });
 *   let item;
 *   while ((item = await stream.next())) {
 *     // item = { frame: VideoFrame, timestampUs, timeSec }
 *     ctx.drawImage(item.frame, 0, 0, w, h);
 *     item.frame.close();            // caller MUST close every frame
 *   }
 *   stream.cancel();                 // idempotent teardown
 *
 * Frames are delivered in presentation order with their exact container
 * timestamps (microseconds). Any demux/codec failure throws so the caller
 * can fall back to the seek path.
 */

export const DEFAULT_MP4BOX_URL = '/vendor/mp4box/mp4box.all.min.js';

/** True when the WebCodecs video surface exists (does not probe codecs). */
export function isWebCodecsSupported() {
  return typeof VideoDecoder !== 'undefined'
    && typeof EncodedVideoChunk !== 'undefined'
    && typeof VideoDecoder.isConfigSupported === 'function';
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('Decode aborted', 'AbortError');
  const err = new Error('Decode aborted');
  err.name = 'AbortError';
  return err;
}

function toUint8(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  throw new Error('video-decoder requires an ArrayBuffer or TypedArray.');
}

/** 'webm' | 'mp4' | null — sniffed from the first bytes. */
export function sniffContainer(bytes) {
  const u8 = toUint8(bytes);
  if (u8.length >= 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return 'webm';
  // ISO-BMFF: a top-level box whose type is ftyp / moov / mdat / free / styp.
  if (u8.length >= 8) {
    const type = String.fromCharCode(u8[4], u8[5], u8[6], u8[7]);
    if (['ftyp', 'moov', 'mdat', 'free', 'skip', 'styp', 'wide'].includes(type)) return 'mp4';
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Minimal WebM (Matroska) demuxer — video track, VP8/VP9/AV1.
 * Handles EBML header, Segment/Info/Tracks/Cluster, SimpleBlock and
 * BlockGroup. Lacing, encrypted tracks and non-video tracks are skipped
 * (lacing throws -> caller falls back to the seek path).
 * ------------------------------------------------------------------ */

const EBML_IDS = {
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  DEFAULT_DURATION: 0x23e383,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_DURATION: 0x9b,
  REFERENCE_BLOCK: 0xfb,
};

/** EBML variable-length integer. `keepMarker` retains the ID marker bit. */
function readVint(view, pos, keepMarker) {
  if (pos >= view.byteLength) throw new Error('WebM: unexpected end of data.');
  const first = view.getUint8(pos);
  if (first === 0) throw new Error('WebM: invalid VINT.');
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) { length += 1; mask >>= 1; }
  if (length > 8 || pos + length > view.byteLength) throw new Error('WebM: VINT too long.');
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < length; i++) value = value * 256 + view.getUint8(pos + i);
  const allOnes = Math.pow(2, 7 * length) - 1;
  return { value, length, unknown: !keepMarker && value === allOnes };
}

function readUint(view, start, size) {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + view.getUint8(start + i);
  return value;
}

function readString(bytes, start, size) {
  let out = '';
  for (let i = 0; i < size; i++) out += String.fromCharCode(bytes[start + i]);
  return out;
}

/** Iterates direct children of an EBML master element in [start, end). */
function* ebmlChildren(view, bytes, start, end) {
  let pos = start;
  while (pos + 2 <= end) {
    const id = readVint(view, pos, true);
    const size = readVint(view, pos + id.length, false);
    const dataStart = pos + id.length + size.length;
    if (dataStart > end) throw new Error('WebM: truncated element.');
    const dataEnd = size.unknown ? end : Math.min(dataStart + size.value, end);
    yield { id: id.value, start: dataStart, end: dataEnd };
    pos = size.unknown ? end : dataEnd;
  }
}

function webmCodecConfig(codecId, codecPrivate) {
  if (codecId === 'V_VP8') return { codec: 'vp8', description: null };
  if (codecId === 'V_VP9') {
    // Profile/level hint accepted by Chromium for any profile-0..2 stream;
    // unsupported strings are re-probed by openVideoFrameStream.
    return { codec: 'vp09.00.10.08', description: null };
  }
  if (codecId === 'V_AV1') {
    return { codec: 'av01.0.04M.08', description: codecPrivate && codecPrivate.length ? codecPrivate : null };
  }
  throw new Error(`WebM: unsupported codec "${codecId}" (requires VP8/VP9/AV1).`);
}

/**
 * Demux a WebM buffer into ordered video samples.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{container:string, codec:string, description:Uint8Array|null,
 *            codedWidth:number, codedHeight:number,
 *            samples:Array<{data:Uint8Array,timestampUs:number,durationUs:number,keyframe:boolean}>,
 *            frameCount:number, durationSec:number, fps:number}}
 */
export function demuxWebM(buffer) {
  const bytes = toUint8(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length;

  // Pass 1: locate Segment, then its Info/Tracks/Cluster children (order-safe).
  let segment = null;
  for (const child of ebmlChildren(view, bytes, 0, end)) {
    if (child.id === EBML_IDS.SEGMENT) { segment = child; break; }
  }
  if (!segment) throw new Error('WebM: Segment not found.');

  let info = null;
  let tracks = null;
  const clusters = [];
  for (const child of ebmlChildren(view, bytes, segment.start, segment.end)) {
    if (child.id === EBML_IDS.INFO) info = child;
    else if (child.id === EBML_IDS.TRACKS) tracks = child;
    else if (child.id === EBML_IDS.CLUSTER) clusters.push(child);
  }
  if (!tracks) throw new Error('WebM: Tracks not found.');

  let timecodeScaleNs = 1000000; // Matroska default: 1 ms per tick
  let durationTicks = 0;
  if (info) {
    for (const child of ebmlChildren(view, bytes, info.start, info.end)) {
      if (child.id === EBML_IDS.TIMECODE_SCALE) timecodeScaleNs = readUint(view, child.start, child.end - child.start);
      else if (child.id === EBML_IDS.DURATION) {
        const size = child.end - child.start;
        durationTicks = size === 8 ? view.getFloat64(child.start) : view.getFloat32(child.start);
      }
    }
  }

  let videoTrack = null;
  for (const entry of ebmlChildren(view, bytes, tracks.start, tracks.end)) {
    if (entry.id !== EBML_IDS.TRACK_ENTRY) continue;
    const track = { number: 0, type: 0, codecId: '', codecPrivate: null, width: 0, height: 0, defaultDurationNs: 0 };
    for (const field of ebmlChildren(view, bytes, entry.start, entry.end)) {
      const size = field.end - field.start;
      switch (field.id) {
        case EBML_IDS.TRACK_NUMBER: track.number = readUint(view, field.start, size); break;
        case EBML_IDS.TRACK_TYPE: track.type = readUint(view, field.start, size); break;
        case EBML_IDS.CODEC_ID: track.codecId = readString(bytes, field.start, size); break;
        case EBML_IDS.CODEC_PRIVATE: track.codecPrivate = bytes.subarray(field.start, field.end); break;
        case EBML_IDS.VIDEO:
          for (const vf of ebmlChildren(view, bytes, field.start, field.end)) {
            const vs = vf.end - vf.start;
            if (vf.id === EBML_IDS.PIXEL_WIDTH) track.width = readUint(view, vf.start, vs);
            else if (vf.id === EBML_IDS.PIXEL_HEIGHT) track.height = readUint(view, vf.start, vs);
            else if (vf.id === EBML_IDS.DEFAULT_DURATION) track.defaultDurationNs = readUint(view, vf.start, vs);
          }
          break;
        default: break;
      }
    }
    if (track.type === 1 && !videoTrack) videoTrack = track;
  }
  if (!videoTrack) throw new Error('WebM: no video track found.');
  const codecConfig = webmCodecConfig(videoTrack.codecId, videoTrack.codecPrivate);

  const samples = [];
  const parseBlock = (blockStart, blockEnd, clusterTimecode, keyframe) => {
    const trackNo = readVint(view, blockStart, false);
    let pos = blockStart + trackNo.length;
    if (pos + 3 > blockEnd) throw new Error('WebM: truncated Block.');
    const relTimecode = view.getInt16(pos);
    pos += 2;
    const flags = view.getUint8(pos);
    pos += 1;
    if (trackNo.value !== videoTrack.number) return;
    if (flags & 0x06) throw new Error('WebM: lacing is not supported.');
    const timestampUs = Math.round(((clusterTimecode + relTimecode) * timecodeScaleNs) / 1000);
    samples.push({
      data: bytes.subarray(pos, blockEnd),
      timestampUs,
      durationUs: videoTrack.defaultDurationNs ? Math.round(videoTrack.defaultDurationNs / 1000) : 0,
      keyframe: !!keyframe,
    });
  };

  for (const cluster of clusters) {
    let clusterTimecode = 0;
    const blocks = [];
    for (const child of ebmlChildren(view, bytes, cluster.start, cluster.end)) {
      if (child.id === EBML_IDS.TIMECODE) clusterTimecode = readUint(view, child.start, child.end - child.start);
      else if (child.id === EBML_IDS.SIMPLE_BLOCK) blocks.push({ ...child, simple: true });
      else if (child.id === EBML_IDS.BLOCK_GROUP) blocks.push({ ...child, simple: false });
    }
    for (const block of blocks) {
      if (block.simple) {
        const keyframe = (view.getUint8(block.start + readVint(view, block.start, false).length + 2) & 0x80) !== 0;
        parseBlock(block.start, block.end, clusterTimecode, keyframe);
      } else {
        let blockData = null;
        let hasReference = false;
        let blockDurationTicks = 0;
        for (const child of ebmlChildren(view, bytes, block.start, block.end)) {
          if (child.id === EBML_IDS.BLOCK) blockData = child;
          else if (child.id === EBML_IDS.REFERENCE_BLOCK) hasReference = true;
          else if (child.id === EBML_IDS.BLOCK_DURATION) blockDurationTicks = readUint(view, child.start, child.end - child.start);
        }
        if (blockData) {
          const before = samples.length;
          parseBlock(blockData.start, blockData.end, clusterTimecode, !hasReference);
          if (samples.length > before && blockDurationTicks) {
            samples[samples.length - 1].durationUs = Math.round((blockDurationTicks * timecodeScaleNs) / 1000);
          }
        }
      }
    }
  }

  if (!samples.length) throw new Error('WebM: no video samples extracted.');
  samples.sort((a, b) => a.timestampUs - b.timestampUs);
  // Block timecodes are presentation timestamps; decode order for VP8/VP9/AV1
  // without alt-ref show-existing tricks equals presentation order.
  const last = samples[samples.length - 1];
  const lastDurUs = last.durationUs || (samples.length > 1 ? last.timestampUs - samples[samples.length - 2].timestampUs : 33333);
  const durationSec = durationTicks > 0
    ? (durationTicks * timecodeScaleNs) / 1e9
    : (last.timestampUs + lastDurUs) / 1e6;
  const fps = videoTrack.defaultDurationNs
    ? 1e9 / videoTrack.defaultDurationNs
    : samples.length / Math.max(1e-6, durationSec);
  return {
    container: 'webm',
    codec: codecConfig.codec,
    description: codecConfig.description,
    codedWidth: videoTrack.width,
    codedHeight: videoTrack.height,
    samples,
    frameCount: samples.length,
    durationSec,
    fps,
  };
}

/* ------------------------------------------------------------------ *
 * MP4 demuxer via vendored mp4box (classic 0.5.x API, loaded lazily).
 * ------------------------------------------------------------------ */

let mp4boxPromise = null;

/**
 * Loads vendored mp4box through a classic <script> tag (its dist build
 * assigns top-level `MP4Box` / `DataStream` globals). Cached singleton.
 */
export function loadMp4Box(url = DEFAULT_MP4BOX_URL) {
  if (typeof window !== 'undefined' && window.MP4Box && window.MP4Box.createFile && window.DataStream) {
    return Promise.resolve({ createFile: window.MP4Box.createFile, DataStream: window.DataStream });
  }
  if (typeof document === 'undefined') return Promise.reject(new Error('mp4box requires a browser environment (or pass lib manually).'));
  if (!mp4boxPromise) {
    mp4boxPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => {
        if (window.MP4Box && window.MP4Box.createFile && window.DataStream) {
          resolve({ createFile: window.MP4Box.createFile, DataStream: window.DataStream });
        } else {
          mp4boxPromise = null;
          reject(new Error('mp4box loaded but MP4Box/DataStream globals are missing.'));
        }
      };
      script.onerror = () => {
        mp4boxPromise = null;
        script.remove();
        reject(new Error(`Unable to load mp4box from ${url}.`));
      };
      document.head.appendChild(script);
    });
  }
  return mp4boxPromise;
}

/** Serialises an avcC/hvcC/vpcC/av1C box into a WebCodecs `description`. */
function boxDescription(box, DataStream) {
  const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8, stream.position - 8);
}

export function parseTkhdRotationDeg(tkhdMatrix) {
  if (!tkhdMatrix || tkhdMatrix.length < 6) return 0;
  const a = Number(tkhdMatrix[0]) / 65536;
  const b = Number(tkhdMatrix[1]) / 65536;
  if (Math.hypot(a, b) <= 1e-4) return 0;
  const deg = Math.round((Math.atan2(b, a) * 180) / Math.PI);
  return ((deg % 360) + 360) % 360;
}

/**
 * Demux an MP4 buffer with mp4box. `lib` = { createFile, DataStream }
 * (pass manually in Node; browser callers use loadMp4Box()).
 * Samples stay in DECODE order (required by VideoDecoder); `timestampUs`
 * is the presentation time (cts). The decoder re-orders output itself.
 */
export function demuxMp4(buffer, lib) {
  if (!lib || typeof lib.createFile !== 'function') throw new Error('demuxMp4 requires the mp4box library.');
  const bytes = toUint8(buffer);
  const arrayBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  const file = lib.createFile();
  let readyInfo = null;
  let demuxError = null;
  const rawSamples = [];
  file.onError = (err) => { demuxError = new Error(`MP4 demux: ${err}`); };
  file.onReady = (info) => {
    readyInfo = info;
    const track = info.videoTracks && info.videoTracks[0];
    if (!track) { demuxError = new Error('MP4: no video track found.'); return; }
    file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
    file.start();
  };
  file.onSamples = (id, ref, samples) => {
    for (const sample of samples) rawSamples.push(sample);
  };
  const CHUNK_BYTES = 4 * 1024 * 1024;
  if (arrayBuffer.byteLength > CHUNK_BYTES && typeof arrayBuffer.slice === 'function') {
    for (let offset = 0; offset < arrayBuffer.byteLength; offset += CHUNK_BYTES) {
      const end = Math.min(arrayBuffer.byteLength, offset + CHUNK_BYTES);
      const chunk = arrayBuffer.slice(offset, end);
      chunk.fileStart = offset;
      file.appendBuffer(chunk);
      if (demuxError) break;
    }
  } else {
    arrayBuffer.fileStart = 0;
    file.appendBuffer(arrayBuffer);
  }
  file.flush();
  if (demuxError) throw demuxError;
  if (!readyInfo) throw new Error('MP4: unable to read moov atom (corrupted or incomplete file).');
  const track = readyInfo.videoTracks && readyInfo.videoTracks[0];
  if (!track || !rawSamples.length) throw new Error('MP4: no video samples extracted.');

  const trak = file.getTrackById(track.id);
  const rotationDeg = parseTkhdRotationDeg(trak?.tkhd?.matrix);
  const entry = trak && trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl && trak.mdia.minf.stbl.stsd.entries[0];
  if (!entry) throw new Error('MP4: missing sample entry (stsd).');
  const codec = String(track.codec || entry.type || '');
  let description = null;
  const configBox = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  if (configBox) {
    if (!lib.DataStream) throw new Error('MP4: missing DataStream to read codec description.');
    description = boxDescription(configBox, lib.DataStream);
  }
  if ((codec.startsWith('avc1') || codec.startsWith('avc3')) && !description) {
    throw new Error('MP4: H.264 stream missing avcC description.');
  }

  const timescale = track.timescale || readyInfo.timescale || 1000;
  const movieTimescale = readyInfo.timescale || file?.moov?.mvhd?.timescale || 1000;
  const samples = rawSamples.map((sample) => ({
    data: sample.data,
    timestampUs: Math.round((sample.cts * 1e6) / timescale),
    durationUs: Math.round(((sample.duration || 0) * 1e6) / timescale),
    keyframe: !!sample.is_sync,
  }));
  const sorted = [...samples].sort((a, b) => a.timestampUs - b.timestampUs);
  const last = sorted[sorted.length - 1];
  const minSampleUs = sorted[0]?.timestampUs ?? 0;

  // ISO-BMFF edit list (edts/elst): trimmed MP4s embed pre-roll frames before
  // `media_time` so H.264 B/P frames decode cleanly while <video> starts at `media_time`.
  let editStartUs = 0;
  let editEndUs = Infinity;
  let presDelayUs = 0;
  let editDurationSec = 0;
  const elstEntries = trak?.edts?.elst?.entries;
  if (Array.isArray(elstEntries) && elstEntries.length > 0) {
    for (const e of elstEntries) {
      if (e.media_time < 0 || e.media_time === 0xffffffff) {
        presDelayUs += Math.round(((e.segment_duration || 0) * 1e6) / movieTimescale);
        continue;
      }
      if ((e.media_rate_integer ?? 1) !== 0 || (e.media_rate_fraction ?? 0) !== 0) {
        editStartUs = Math.max(0, Math.round((e.media_time * 1e6) / timescale));
        const segUs = e.segment_duration > 0 ? Math.round((e.segment_duration * 1e6) / movieTimescale) : 0;
        editDurationSec = segUs > 0 ? segUs / 1e6 : 0;
        editEndUs = segUs > 0 ? (editStartUs + segUs) : Infinity;
        break;
      }
    }
  }
  const hasEditList = editStartUs > minSampleUs + 1000 || editEndUs < Infinity || presDelayUs > 0;
  const activeCount = hasEditList
    ? sorted.filter((s) => s.timestampUs >= editStartUs - 1000 && s.timestampUs < editEndUs + 1000).length || samples.length
    : samples.length;
  const durationSec = (track.duration || readyInfo.duration || 0) / (track.timescale || readyInfo.timescale || 1000);
  const rawDuration = durationSec > 0 ? durationSec : (last.timestampUs + (last.durationUs || 33333)) / 1e6;
  const effectiveDuration = (hasEditList && editDurationSec > 0) ? editDurationSec : rawDuration;
  return {
    container: 'mp4',
    codec,
    description,
    codedWidth: entry.width || 0,
    codedHeight: entry.height || 0,
    samples,
    frameCount: activeCount,
    durationSec: effectiveDuration,
    fps: activeCount / Math.max(1e-6, effectiveDuration),
    rotationDeg,
    hasEditList,
    editStartUs,
    editEndUs,
    presDelayUs,
  };
}

/** Container-sniffing demux front-end (no decoding). */
export async function demuxVideo(buffer, options = {}) {
  const bytes = toUint8(buffer);
  const container = sniffContainer(bytes);
  if (container === 'webm') return demuxWebM(bytes);
  if (container === 'mp4') {
    const lib = options.mp4box || await loadMp4Box(options.mp4boxUrl || DEFAULT_MP4BOX_URL);
    return demuxMp4(bytes, lib);
  }
  throw new Error('Unrecognized video format (requires MP4 or WebM).');
}

/* ------------------------------------------------------------------ *
 * Sequential VideoDecoder stream with bounded queue + back-pressure.
 * ------------------------------------------------------------------ */

/**
 * Demux + configure + sequentially decode a whole video buffer.
 * Rejects (so callers can fall back to seeking) when WebCodecs is absent,
 * the container is unknown, demuxing fails, or the codec is unsupported.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {{signal?:AbortSignal, mp4boxUrl?:string, maxBuffered?:number}} options
 * @returns {Promise<{codec:string, container:string, codedWidth:number, codedHeight:number,
 *                    frameCount:number, durationSec:number, fps:number,
 *                    next:Function, cancel:Function}>}
 */
export async function openVideoFrameStream(buffer, options = {}) {
  if (!isWebCodecsSupported()) throw new Error('WebCodecs (VideoDecoder) is not available.');
  const signal = options.signal;
  if (signal && signal.aborted) throw abortError();

  const demux = await demuxVideo(buffer, options);
  const baseConfig = {
    codec: demux.codec,
    codedWidth: demux.codedWidth || undefined,
    codedHeight: demux.codedHeight || undefined,
  };
  if (demux.description) baseConfig.description = demux.description;

  let config = null;
  let support = await VideoDecoder.isConfigSupported(baseConfig);
  if (support && support.supported) {
    config = baseConfig;
  } else if (!demux.description) {
    // VP9 profile/level hints vary; probe a few common strings before giving up.
    for (const codec of ['vp09.00.31.08', 'vp09.00.41.08', 'vp09.02.10.08', 'vp8']) {
      if (codec === demux.codec) continue;
      if (!demux.codec.startsWith('vp09') && codec !== 'vp8') continue;
      // eslint-disable-next-line no-await-in-loop
      support = await VideoDecoder.isConfigSupported({ ...baseConfig, codec });
      if (support && support.supported) { config = { ...baseConfig, codec }; break; }
    }
  }
  if (!config) throw new Error(`Codec "${demux.codec}" is not supported by VideoDecoder.`);
  if (signal && signal.aborted) throw abortError();

  const maxBuffered = Math.max(2, Math.floor(options.maxBuffered || 8));
  const queue = [];
  let waiters = [];
  let drainWaiters = [];
  let streamError = null;
  let finished = false;
  let closed = false;
  let reachedEditEnd = false;
  const hasEditList = Boolean(demux.hasEditList);
  const editStartUs = demux.editStartUs || 0;
  const editEndUs = Number.isFinite(demux.editEndUs) ? demux.editEndUs : Infinity;
  const presShiftUs = hasEditList ? ((demux.presDelayUs || 0) - editStartUs) : 0;

  const notify = () => { const w = waiters; waiters = []; for (const resolve of w) resolve(); };
  const notifyDrain = () => { const w = drainWaiters; drainWaiters = []; for (const resolve of w) resolve(); };
  const waitForNotification = () => new Promise((resolve) => { waiters.push(resolve); });
  const waitForDrain = () => new Promise((resolve) => { drainWaiters.push(resolve); });

  let pumpFn = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      if (closed || streamError || reachedEditEnd) { frame.close(); return; }
      const rawTs = frame.timestamp;
      if (hasEditList) {
        if (rawTs < editStartUs - 1000) {
          frame.close();
          notifyDrain();
          if (pumpFn) pumpFn();
          return;
        }
        if (rawTs >= editEndUs + 1000) {
          frame.close();
          reachedEditEnd = true;
          finished = true;
          notify();
          notifyDrain();
          return;
        }
      }
      queue.push({ frame, rawTs });
      notify();
      notifyDrain();
    },
    error: (err) => {
      streamError = err instanceof Error ? err : new Error(String(err && err.message || err));
      notify();
      notifyDrain();
    },
  });

  const onDequeue = () => {
    notifyDrain();
    if (pumpFn) pumpFn();
  };
  if (typeof decoder.addEventListener === 'function') {
    decoder.addEventListener('dequeue', onDequeue);
  }

  const onAbort = () => {
    streamError = abortError();
    closed = true;
    if (typeof decoder.removeEventListener === 'function') {
      try { decoder.removeEventListener('dequeue', onDequeue); } catch (_) { /* best-effort */ }
    }
    for (const item of queue) item.frame.close();
    queue.length = 0;
    try { if (decoder.state !== 'closed') decoder.close(); } catch (_) { /* best-effort */ }
    notify();
    notifyDrain();
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const cleanup = () => {
    closed = true;
    if (signal) signal.removeEventListener('abort', onAbort);
    if (typeof decoder.removeEventListener === 'function') {
      try { decoder.removeEventListener('dequeue', onDequeue); } catch (_) { /* best-effort */ }
    }
    for (const item of queue) item.frame.close();
    queue.length = 0;
    try { if (decoder.state !== 'closed') decoder.close(); } catch (_) { /* best-effort */ }
    notify();
    notifyDrain();
  };

  try {
    decoder.configure(config);
  } catch (err) {
    cleanup();
    throw err;
  }

  // Feed pump: keeps at most `maxBuffered` frames in flight (queued output +
  // decoder input) so long videos do not balloon memory. Chunks go in decode
  // order; VideoDecoder emits frames in presentation order.
  let feedIndex = 0;
  let flushStarted = false;
  let pumpRunning = false;
  const pump = () => {
    if (pumpRunning || closed || streamError || reachedEditEnd) return;
    pumpRunning = true;
    (async () => {
      try {
        while (!closed && !streamError && !reachedEditEnd && feedIndex < demux.samples.length) {
          if (queue.length + decoder.decodeQueueSize >= maxBuffered) {
            await waitForDrain();
            continue;
          }
          const sample = demux.samples[feedIndex++];
          decoder.decode(new EncodedVideoChunk({
            type: sample.keyframe ? 'key' : 'delta',
            timestamp: sample.timestampUs,
            duration: sample.durationUs || undefined,
            data: sample.data,
          }));
        }
        if (!closed && !streamError && !reachedEditEnd && !flushStarted) {
          flushStarted = true;
          await decoder.flush();
          finished = true;
          notify();
        }
      } catch (err) {
        if (!closed && !streamError) streamError = err && err.name === 'AbortError' ? err : (err instanceof Error ? err : new Error(String(err)));
        notify();
        notifyDrain();
      } finally {
        pumpRunning = false;
      }
    })();
  };
  pumpFn = pump;
  pump();

  return {
    codec: config.codec,
    container: demux.container,
    codedWidth: demux.codedWidth,
    codedHeight: demux.codedHeight,
    frameCount: demux.frameCount,
    durationSec: demux.durationSec,
    fps: demux.fps,
    rotationDeg: demux.rotationDeg || 0,
    /**
     * Next decoded frame in presentation order, or null at end-of-stream.
     * Caller owns the VideoFrame and must call frame.close().
     */
    async next() {
      for (;;) {
        if (streamError) { const err = streamError; cleanup(); throw err; }
        if (closed) return null;
        if (queue.length) {
          const item = queue.shift();
          notifyDrain();
          pump();
          const outTs = hasEditList ? Math.max(0, item.rawTs + presShiftUs) : item.rawTs;
          return { frame: item.frame, timestampUs: outTs, timeSec: outTs / 1e6 };
        }
        if (finished) return null;
        await waitForNotification();
      }
    },
    /** Idempotent teardown: closes decoder + all queued frames. */
    cancel() {
      if (closed) return;
      cleanup();
    },
  };
}
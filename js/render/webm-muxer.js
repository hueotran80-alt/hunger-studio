/**
 * Web Blender Studio - Zero-Dependency Deterministic WebM (EBML/Matroska) Muxer
 * Muxes WebCodecs EncodedVideoChunk (VP9 / VP8) and optional EncodedAudioChunk (Opus)
 * into a standards-compliant, seekable WebM container with Cues.
 * File: js/render/webm-muxer.js
 */

function encodeVintSize(value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Invalid EBML size: ${value}`);
  }
  // Reserve all-1s (unknown size) for each width by requiring value < (2^(7*len) - 1)
  if (value < 0x7f) {
    return new Uint8Array([0x80 | value]);
  }
  if (value < 0x3fff) {
    return new Uint8Array([0x40 | (value >>> 8), value & 0xff]);
  }
  if (value < 0x1fffff) {
    return new Uint8Array([
      0x20 | (value >>> 16),
      (value >>> 8) & 0xff,
      value & 0xff,
    ]);
  }
  if (value < 0x0fffffff) {
    return new Uint8Array([
      0x10 | (value >>> 24),
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ]);
  }
  // 8-byte VINT for very large segments (> 256 MiB)
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let rem = Math.floor(value);
  for (let i = 7; i >= 1; i--) {
    out[i] = rem % 256;
    rem = Math.floor(rem / 256);
  }
  return out;
}

function encodeId(id) {
  if (id <= 0xff) return new Uint8Array([id]);
  if (id <= 0xffff) return new Uint8Array([(id >>> 8) & 0xff, id & 0xff]);
  if (id <= 0xffffff) return new Uint8Array([(id >>> 16) & 0xff, (id >>> 8) & 0xff, id & 0xff]);
  return new Uint8Array([
    (id >>> 24) & 0xff,
    (id >>> 16) & 0xff,
    (id >>> 8) & 0xff,
    id & 0xff,
  ]);
}

function encodeUintData(value) {
  const v = Math.max(0, Math.floor(value));
  if (v === 0) return new Uint8Array([0]);
  const bytes = [];
  let rem = v;
  while (rem > 0) {
    bytes.unshift(rem % 256);
    rem = Math.floor(rem / 256);
  }
  return new Uint8Array(bytes);
}

function encodeFloat64Data(value) {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, false);
  return new Uint8Array(buf);
}

function encodeAsciiData(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0x7f;
  }
  return out;
}

function concatBytes(parts) {
  let total = 0;
  for (let i = 0; i < parts.length; i++) total += parts[i].byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], offset);
    offset += parts[i].byteLength;
  }
  return out;
}

function ebmlElement(id, payload) {
  const idBytes = encodeId(id);
  const data = payload instanceof Uint8Array ? payload : concatBytes(payload);
  const sizeBytes = encodeVintSize(data.byteLength);
  return concatBytes([idBytes, sizeBytes, data]);
}

function ebmlUint(id, value) {
  return ebmlElement(id, encodeUintData(value));
}

function ebmlFloat(id, value) {
  return ebmlElement(id, encodeFloat64Data(value));
}

function ebmlString(id, value) {
  return ebmlElement(id, encodeAsciiData(value));
}

/**
 * Builds standard RFC 7845 OpusHead CodecPrivate (19 bytes).
 */
function buildOpusHead(channels, sampleRate) {
  const buf = new ArrayBuffer(19);
  const u8 = new Uint8Array(buf);
  const view = new DataView(buf);
  const magic = 'OpusHead';
  for (let i = 0; i < magic.length; i++) u8[i] = magic.charCodeAt(i);
  u8[8] = 1; // Version 1
  u8[9] = Math.max(1, Math.min(2, channels));
  view.setUint16(10, 312, true); // Pre-skip samples at 48 kHz (~6.5 ms)
  view.setUint32(12, Math.round(sampleRate || 48000), true);
  view.setInt16(16, 0, true); // Output gain
  u8[18] = 0; // Channel mapping family 0 (mono / stereo)
  return u8;
}

function buildSimpleBlock(trackNumber, relativeTimestampMs, isKeyframe, payload) {
  const header = new Uint8Array(4);
  header[0] = 0x80 | (trackNumber & 0x7f);
  const clampedRel = Math.max(-32768, Math.min(32767, Math.round(relativeTimestampMs)));
  new DataView(header.buffer).setInt16(1, clampedRel, false);
  header[3] = isKeyframe ? 0x80 : 0x00;
  return ebmlElement(0xa3, [header, payload]);
}

export class WebMMuxer {
  /**
   * @param {Object} options
   * @param {Object} options.video
   * @param {'V_VP9'|'V_VP8'|'vp9'|'vp8'} [options.video.codec='V_VP9']
   * @param {number} options.video.width
   * @param {number} options.video.height
   * @param {number} [options.video.fps=30]
   * @param {Object|null} [options.audio]
   * @param {number} [options.audio.sampleRate=48000]
   * @param {number} [options.audio.numberOfChannels=2]
   */
  constructor(options = {}) {
    const v = options.video || {};
    const rawCodec = String(v.codec || 'V_VP9').toUpperCase();
    this.video = {
      codecId: rawCodec.includes('VP8') ? 'V_VP8' : 'V_VP9',
      width: Math.max(2, Math.round(v.width || 1280)),
      height: Math.max(2, Math.round(v.height || 720)),
      fps: Math.max(1, Number(v.fps) || 30),
    };

    this.audio = options.audio ? {
      codecId: 'A_OPUS',
      sampleRate: Math.round(options.audio.sampleRate || 48000),
      numberOfChannels: Math.max(1, Math.min(2, Math.round(options.audio.numberOfChannels || 2))),
    } : null;

    this._chunks = [];
    this._maxEndMs = 0;
    this._buffer = null;
  }

  /**
   * Adds a video chunk (WebCodecs EncodedVideoChunk or raw Uint8Array).
   * @param {EncodedVideoChunk|Uint8Array} chunk
   * @param {number} [timestampUs]
   * @param {number} [durationUs]
   * @param {boolean} [isKey]
   */
  addVideoChunk(chunk, timestampUs = null, durationUs = null, isKey = null) {
    let data;
    let tsUs = timestampUs;
    let durUs = durationUs;
    let key = isKey;

    if (chunk instanceof Uint8Array) {
      data = chunk;
    } else if (chunk && typeof chunk.copyTo === 'function') {
      data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      if (tsUs === null && Number.isFinite(chunk.timestamp)) tsUs = chunk.timestamp;
      if (durUs === null && Number.isFinite(chunk.duration)) durUs = chunk.duration;
      if (key === null) key = chunk.type === 'key';
    } else {
      throw new TypeError('Invalid WebM video chunk');
    }

    const tsMs = Math.max(0, Math.round((tsUs || 0) / 1000));
    const durMs = Math.max(1, Math.round((durUs || (1_000_000 / this.video.fps)) / 1000));
    if (tsMs + durMs > this._maxEndMs) this._maxEndMs = tsMs + durMs;

    this._chunks.push({
      track: 1,
      tsMs,
      isKey: Boolean(key),
      data,
    });
  }

  /**
   * Adds an Opus audio chunk (WebCodecs EncodedAudioChunk or raw Uint8Array).
   */
  addAudioChunk(chunk, timestampUs = null, durationUs = null) {
    if (!this.audio) return;
    let data;
    let tsUs = timestampUs;
    let durUs = durationUs;

    if (chunk instanceof Uint8Array) {
      data = chunk;
    } else if (chunk && typeof chunk.copyTo === 'function') {
      data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      if (tsUs === null && Number.isFinite(chunk.timestamp)) tsUs = chunk.timestamp;
      if (durUs === null && Number.isFinite(chunk.duration)) durUs = chunk.duration;
    } else {
      throw new TypeError('Invalid WebM audio chunk');
    }

    const tsMs = Math.max(0, Math.round((tsUs || 0) / 1000));
    const durMs = Math.max(1, Math.round((durUs || 20_000) / 1000));
    if (tsMs + durMs > this._maxEndMs) this._maxEndMs = tsMs + durMs;

    this._chunks.push({
      track: 2,
      tsMs,
      isKey: true,
      data,
    });
  }

  /**
   * Finalizes the WebM container and returns the complete ArrayBuffer.
   * @returns {ArrayBuffer}
   */
  finalize() {
    // 1. EBML Header
    const ebmlHeader = ebmlElement(0x1a45dfa3, [
      ebmlUint(0x4286, 1), // EBMLVersion
      ebmlUint(0x42f7, 1), // EBMLReadVersion
      ebmlUint(0x42f2, 4), // EBMLMaxIDLength
      ebmlUint(0x42f3, 8), // EBMLMaxSizeLength
      ebmlString(0x4282, 'webm'), // DocType
      ebmlUint(0x4287, 4), // DocTypeVersion
      ebmlUint(0x4285, 2), // DocTypeReadVersion
    ]);

    // 2. Segment Info
    const durationMs = Math.max(1, this._maxEndMs);
    const info = ebmlElement(0x1549a966, [
      ebmlUint(0x2ad7b1, 1_000_000), // TimestampScale = 1ms
      ebmlString(0x4d80, 'Web Blender Studio'), // MuxingApp
      ebmlString(0x5741, 'Web Blender Studio'), // WritingApp
      ebmlFloat(0x4489, durationMs), // Duration in TimestampScale units
    ]);

    // 3. Tracks
    const trackEntries = [];
    const videoTrack = ebmlElement(0xae, [
      ebmlUint(0xd7, 1), // TrackNumber
      ebmlUint(0x73c5, 1), // TrackUID
      ebmlUint(0x83, 1), // TrackType = video
      ebmlString(0x86, this.video.codecId), // CodecID
      ebmlUint(0x23e383, Math.round(1_000_000_000 / this.video.fps)), // DefaultDuration (ns)
      ebmlElement(0xe0, [
        ebmlUint(0xb0, this.video.width), // PixelWidth
        ebmlUint(0xba, this.video.height), // PixelHeight
      ]),
    ]);
    trackEntries.push(videoTrack);

    if (this.audio) {
      const audioTrack = ebmlElement(0xae, [
        ebmlUint(0xd7, 2), // TrackNumber
        ebmlUint(0x73c5, 2), // TrackUID
        ebmlUint(0x83, 2), // TrackType = audio
        ebmlString(0x86, this.audio.codecId), // CodecID = A_OPUS
        ebmlElement(0x63a2, buildOpusHead(this.audio.numberOfChannels, this.audio.sampleRate)),
        ebmlUint(0x56aa, 6_500_000), // CodecDelay = 6.5ms
        ebmlUint(0x56bb, 80_000_000), // SeekPreRoll = 80ms
        ebmlElement(0xe1, [
          ebmlFloat(0xb5, this.audio.sampleRate), // SamplingFrequency
          ebmlUint(0x9f, this.audio.numberOfChannels), // Channels
          ebmlUint(0x6264, 16), // BitDepth
        ]),
      ]);
      trackEntries.push(audioTrack);
    }
    const tracks = ebmlElement(0x1654ae6b, trackEntries);

    // 4. Sort chunks chronologically (video before audio on ties) and group into Clusters
    const sorted = this._chunks.slice().sort((a, b) => (a.tsMs - b.tsMs) || (a.track - b.track));
    const clusters = [];
    const cueMeta = [];

    let currentClusterTs = 0;
    let currentBlocks = [];
    let segmentOffset = info.byteLength + tracks.byteLength;

    const flushCluster = () => {
      if (currentBlocks.length === 0) return;
      const clusterEl = ebmlElement(0x1f43b675, [
        ebmlUint(0xe7, currentClusterTs),
        ...currentBlocks,
      ]);
      cueMeta.push({ timeMs: currentClusterTs, clusterPos: segmentOffset });
      segmentOffset += clusterEl.byteLength;
      clusters.push(clusterEl);
      currentBlocks = [];
    };

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      const needNewCluster =
        currentBlocks.length === 0 ||
        (c.track === 1 && c.isKey && c.tsMs > currentClusterTs) ||
        (c.tsMs - currentClusterTs) > 30000;

      if (needNewCluster) {
        flushCluster();
        currentClusterTs = c.tsMs;
      }

      const relMs = c.tsMs - currentClusterTs;
      currentBlocks.push(buildSimpleBlock(c.track, relMs, c.isKey, c.data));
    }
    flushCluster();

    // 5. Cues for fast seeking
    const cuePoints = cueMeta.map((cue) =>
      ebmlElement(0xbb, [
        ebmlUint(0xb3, cue.timeMs),
        ebmlElement(0xb7, [
          ebmlUint(0xf7, 1), // CueTrack = video
          ebmlUint(0xf1, cue.clusterPos), // CueClusterPosition (relative to Segment payload)
        ]),
      ])
    );
    const segmentParts = [info, tracks, ...clusters];
    if (cuePoints.length > 0) {
      segmentParts.push(ebmlElement(0x1c53bb6b, cuePoints));
    }

    const segment = ebmlElement(0x18538067, segmentParts);
    const full = concatBytes([ebmlHeader, segment]);
    this._buffer = full.buffer;
    return this._buffer;
  }

  get buffer() {
    return this._buffer;
  }
}

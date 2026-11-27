/**
 * Client-side Audio Extraction, Resampling & WebCodecs AAC Preparation
 * Zero-server-GPU pipeline for muxing source video music/audio into rendered 3D MP4/WebM clips.
 *
 * File: js/render/audio-extractor.js
 */

const PREFERRED_AAC_SAMPLE_RATES = [48000, 44100, 32000, 24000, 22050, 16000];
const DEFAULT_AUDIO_BITRATE = 128_000;

function getAudioChannelArray(audioBuffer, index) {
  if (!audioBuffer) return null;
  if (typeof audioBuffer.getChannelData === 'function') {
    return audioBuffer.getChannelData(index);
  }
  if (Array.isArray(audioBuffer.channels) && audioBuffer.channels[index]) {
    return audioBuffer.channels[index];
  }
  return null;
}

function getOfflineAudioContextCtor() {
  if (typeof OfflineAudioContext !== 'undefined') return OfflineAudioContext;
  if (typeof webkitOfflineAudioContext !== 'undefined') return webkitOfflineAudioContext;
  return null;
}

function getAudioContextCtor() {
  if (typeof AudioContext !== 'undefined') return AudioContext;
  if (typeof webkitAudioContext !== 'undefined') return webkitAudioContext;
  return null;
}

function mixChannels(srcArrays, targetChannels, length) {
  const srcCount = srcArrays.length;
  const outCount = Math.max(1, targetChannels || srcCount || 1);
  const channels = [];

  for (let c = 0; c < outCount; c++) {
    channels.push(new Float32Array(length));
  }

  if (srcCount === 0 || length <= 0) {
    return channels;
  }

  if (outCount === 1 && srcCount > 1) {
    const inv = 1 / srcCount;
    const dst = channels[0];
    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let s = 0; s < srcCount; s++) {
        sum += srcArrays[s][i] || 0;
      }
      dst[i] = Math.max(-1, Math.min(1, sum * inv));
    }
    return channels;
  }

  for (let c = 0; c < outCount; c++) {
    const src = srcArrays[Math.min(c, srcCount - 1)];
    const dst = channels[c];
    const copyLen = Math.min(length, src.length);
    for (let i = 0; i < copyLen; i++) {
      const v = src[i];
      dst[i] = v > 1 ? 1 : (v < -1 ? -1 : v);
    }
  }
  return channels;
}

/**
 * Probe WebCodecs AudioEncoder for a supported AAC-LC configuration.
 * Prefers requested sampleRate/channels (clamped <=2 ch), falling back to 48kHz/44.1kHz stereo/mono.
 */
export async function probeAacEncoderConfig(
  sampleRate = 48000,
  numberOfChannels = 2,
  bitrate = DEFAULT_AUDIO_BITRATE
) {
  if (typeof AudioEncoder !== 'function' || typeof AudioEncoder.isConfigSupported !== 'function') {
    return null;
  }

  const reqRate = Math.round(Number(sampleRate) || 48000);
  const reqCh = Math.max(1, Math.min(2, Math.round(Number(numberOfChannels) || 2)));

  const rateCandidates = [];
  const addRate = (r) => {
    if (r > 0 && !rateCandidates.includes(r)) rateCandidates.push(r);
  };
  if (PREFERRED_AAC_SAMPLE_RATES.includes(reqRate)) addRate(reqRate);
  addRate(48000);
  addRate(44100);
  addRate(reqRate);

  const chCandidates = reqCh === 1 ? [1, 2] : [2, 1];

  for (const sr of rateCandidates) {
    for (const ch of chCandidates) {
      const cfg = {
        codec: 'mp4a.40.2',
        sampleRate: sr,
        numberOfChannels: ch,
        bitrate: Math.max(64_000, Math.min(320_000, Math.round(bitrate || DEFAULT_AUDIO_BITRATE))),
      };
      try {
        const res = await AudioEncoder.isConfigSupported(cfg);
        if (res && res.supported) {
          return {
            supported: true,
            codec: res.config?.codec || cfg.codec,
            sampleRate: res.config?.sampleRate || cfg.sampleRate,
            numberOfChannels: res.config?.numberOfChannels || cfg.numberOfChannels,
            bitrate: res.config?.bitrate || cfg.bitrate,
          };
        }
      } catch (_) {
        // Try next candidate
      }
    }
  }

  return null;
}

/**
 * Decode an audio track from a File, Blob, ArrayBuffer, HTMLMediaElement, URL string, or AudioBuffer.
 * Gracefully returns null if the media has no audio stream or decoding fails.
 */
export async function decodeSourceAudio(source, options = {}) {
  const { signal = null } = options;
  if (!source) return null;

  if (signal?.aborted) {
    throw new DOMException('Audio decode cancelled by user', 'AbortError');
  }

  // Pass-through if caller already decoded AudioBuffer / mock PCM descriptor
  if (
    typeof source === 'object' &&
    !(source instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(source) &&
    !(typeof Blob !== 'undefined' && source instanceof Blob) &&
    Number.isFinite(source.sampleRate) &&
    Number.isFinite(source.numberOfChannels) &&
    (typeof source.getChannelData === 'function' || Array.isArray(source.channels))
  ) {
    return source;
  }

  let resolvedSource = source;
  if (typeof HTMLMediaElement !== 'undefined' && source instanceof HTMLMediaElement) {
    resolvedSource = source.currentSrc || source.src || null;
    if (!resolvedSource) return null;
  }

  let rawBytes = null;
  try {
    if (resolvedSource instanceof ArrayBuffer) {
      rawBytes = resolvedSource;
    } else if (ArrayBuffer.isView(resolvedSource)) {
      rawBytes = resolvedSource.buffer.slice(
        resolvedSource.byteOffset,
        resolvedSource.byteOffset + resolvedSource.byteLength
      );
    } else if (typeof Blob !== 'undefined' && resolvedSource instanceof Blob) {
      rawBytes = await resolvedSource.arrayBuffer();
    } else if (typeof resolvedSource === 'string') {
      const resp = await fetch(resolvedSource, signal ? { signal } : undefined);
      if (!resp.ok) return null;
      rawBytes = await resp.arrayBuffer();
    }
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return null;
  }

  if (signal?.aborted) {
    throw new DOMException('Audio decode cancelled by user', 'AbortError');
  }
  if (!rawBytes || rawBytes.byteLength === 0) return null;

  const OfflineCtx = getOfflineAudioContextCtor();
  if (OfflineCtx) {
    try {
      const ctx = new OfflineCtx(2, 1, 48000);
      const decoded = await ctx.decodeAudioData(rawBytes.slice(0));
      if (decoded && decoded.length > 0 && decoded.numberOfChannels > 0) {
        return decoded;
      }
      return null;
    } catch (_) {
      // Video has no audio stream or codec unsupported by decodeAudioData
      return null;
    }
  }

  const AudioCtx = getAudioContextCtor();
  if (AudioCtx) {
    let ctx = null;
    try {
      ctx = new AudioCtx();
      const decoded = await ctx.decodeAudioData(rawBytes.slice(0));
      if (decoded && decoded.length > 0 && decoded.numberOfChannels > 0) {
        return decoded;
      }
      return null;
    } catch (_) {
      return null;
    } finally {
      try { await ctx?.close?.(); } catch (_) { /* ignore */ }
    }
  }

  return null;
}

/**
 * Resample and remix an AudioBuffer-like object to targetSampleRate & targetChannels.
 * Uses native OfflineAudioContext when available, with a pure-JS linear resampler fallback.
 */
export async function resampleAudioBuffer(audioBuffer, targetSampleRate, targetChannels = null) {
  if (!audioBuffer || !audioBuffer.numberOfChannels || !audioBuffer.sampleRate) {
    return null;
  }

  const srcRate = audioBuffer.sampleRate;
  const srcChannels = audioBuffer.numberOfChannels;
  const outRate = Math.max(8000, Math.round(targetSampleRate || srcRate));
  const outCh = Math.max(1, Math.min(2, Math.round(targetChannels || srcChannels)));
  const srcLen = audioBuffer.length ?? (getAudioChannelArray(audioBuffer, 0)?.length || 0);

  if (srcRate === outRate && srcChannels === outCh) {
    const rawArrays = [];
    for (let c = 0; c < srcChannels; c++) {
      rawArrays.push(getAudioChannelArray(audioBuffer, c) || new Float32Array(srcLen));
    }
    const channels = mixChannels(rawArrays, outCh, srcLen);
    return {
      sampleRate: outRate,
      numberOfChannels: outCh,
      length: srcLen,
      channels,
      getChannelData: (idx) => channels[idx],
    };
  }

  const OfflineCtx = getOfflineAudioContextCtor();
  const isNativeAudioBuffer = typeof AudioBuffer !== 'undefined' && audioBuffer instanceof AudioBuffer;
  if (OfflineCtx && isNativeAudioBuffer) {
    try {
      const targetLen = Math.max(1, Math.ceil((srcLen / srcRate) * outRate));
      const offline = new OfflineCtx(outCh, targetLen, outRate);
      const srcNode = offline.createBufferSource();
      srcNode.buffer = audioBuffer;
      srcNode.connect(offline.destination);
      srcNode.start(0);
      const rendered = await offline.startRendering();
      if (rendered && rendered.length > 0) return rendered;
    } catch (_) {
      // Fall through to pure-JS linear resampler
    }
  }

  // Pure-JS linear resampling + channel mix fallback (Node unit tests / non-AudioBuffer objects)
  const srcArrays = [];
  for (let c = 0; c < srcChannels; c++) {
    srcArrays.push(getAudioChannelArray(audioBuffer, c) || new Float32Array(srcLen));
  }
  const mixed = mixChannels(srcArrays, outCh, srcLen);
  if (srcRate === outRate) {
    return {
      sampleRate: outRate,
      numberOfChannels: outCh,
      length: srcLen,
      channels: mixed,
      getChannelData: (idx) => mixed[idx],
    };
  }

  const outLen = Math.max(1, Math.round((srcLen / srcRate) * outRate));
  const ratio = srcRate / outRate;
  const resampled = mixed.map((src) => {
    const dst = new Float32Array(outLen);
    if (srcLen === 0) return dst;
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = src[Math.min(idx, srcLen - 1)];
      const b = src[Math.min(idx + 1, srcLen - 1)];
      dst[i] = a + (b - a) * frac;
    }
    return dst;
  });

  return {
    sampleRate: outRate,
    numberOfChannels: outCh,
    length: outLen,
    channels: resampled,
    getChannelData: (idx) => resampled[idx],
  };
}

/**
 * Slice PCM channels starting at startSec for durationSec (pads silence if video is longer than audio).
 */
export function sliceAudioPcm(audioBuffer, startSec = 0, durationSec = 0, targetChannels = null) {
  if (!audioBuffer || !audioBuffer.sampleRate || !audioBuffer.numberOfChannels) {
    return null;
  }

  const sampleRate = Math.round(audioBuffer.sampleRate);
  const srcChannels = audioBuffer.numberOfChannels;
  const outChannels = Math.max(1, Math.min(2, Math.round(targetChannels || srcChannels)));
  const srcLen = audioBuffer.length ?? (getAudioChannelArray(audioBuffer, 0)?.length || 0);

  const startSample = Math.max(0, Math.round(Math.max(0, startSec) * sampleRate));
  const outLen = durationSec > 0
    ? Math.max(1, Math.round(durationSec * sampleRate))
    : Math.max(0, srcLen - startSample);

  const slicedRaw = [];
  for (let c = 0; c < srcChannels; c++) {
    const src = getAudioChannelArray(audioBuffer, c);
    const dst = new Float32Array(outLen);
    if (src && startSample < src.length) {
      const copyCount = Math.min(outLen, src.length - startSample);
      if (copyCount > 0) {
        dst.set(src.subarray(startSample, startSample + copyCount), 0);
      }
    }
    slicedRaw.push(dst);
  }

  const channels = mixChannels(slicedRaw, outChannels, outLen);
  let peak = 0;
  for (let c = 0; c < outChannels; c++) {
    const ch = channels[c];
    for (let i = 0; i < outLen; i++) {
      const a = Math.abs(ch[i]);
      if (a > peak) peak = a;
    }
  }

  return {
    sampleRate,
    numberOfChannels: outChannels,
    length: outLen,
    durationSec: outLen / sampleRate,
    peak,
    channels,
  };
}

/**
 * Probe WebCodecs AudioEncoder for a supported Opus configuration (for WebM).
 */
export async function probeOpusEncoderConfig(
  sampleRate = 48000,
  numberOfChannels = 2,
  bitrate = DEFAULT_AUDIO_BITRATE
) {
  if (typeof AudioEncoder !== 'function' || typeof AudioEncoder.isConfigSupported !== 'function') {
    return null;
  }
  const reqCh = Math.max(1, Math.min(2, Math.round(Number(numberOfChannels) || 2)));
  const chCandidates = reqCh === 1 ? [1, 2] : [2, 1];
  const rateCandidates = [48000, 24000, 16000];
  for (const sr of rateCandidates) {
    for (const ch of chCandidates) {
      const cfg = {
        codec: 'opus',
        sampleRate: sr,
        numberOfChannels: ch,
        bitrate: Math.max(48_000, Math.min(256_000, Math.round(bitrate || DEFAULT_AUDIO_BITRATE))),
      };
      try {
        const res = await AudioEncoder.isConfigSupported(cfg);
        if (res && res.supported) {
          return {
            supported: true,
            codec: res.config?.codec || 'opus',
            sampleRate: res.config?.sampleRate || cfg.sampleRate,
            numberOfChannels: res.config?.numberOfChannels || cfg.numberOfChannels,
            bitrate: res.config?.bitrate || cfg.bitrate,
          };
        }
      } catch (_) {}
    }
  }
  return null;
}

/**
 * End-to-end helper: decode source media audio, match WebCodecs AAC-LC or Opus config,
 * resample if necessary, and slice to exact clip [startSec, startSec + durationSec].
 */
export async function prepareAudioTrackForExport(source, options = {}) {
  const {
    startSec = 0,
    durationSec = 0,
    bitrate = DEFAULT_AUDIO_BITRATE,
    signal = null,
    skipAacProbe = false,
    codec = 'aac',
  } = options;

  const decoded = await decodeSourceAudio(source, { signal });
  if (!decoded) return null;

  const isOpus = String(codec || 'aac').toLowerCase() === 'opus';
  const probedConfig = isOpus
    ? await probeOpusEncoderConfig(decoded.sampleRate, decoded.numberOfChannels, bitrate)
    : await probeAacEncoderConfig(decoded.sampleRate, decoded.numberOfChannels, bitrate);
  if (!probedConfig && !skipAacProbe) {
    return null;
  }

  const targetRate = probedConfig?.sampleRate || (isOpus ? 48000 : (decoded.sampleRate || 48000));
  const targetCh = probedConfig?.numberOfChannels || Math.min(2, Math.max(1, decoded.numberOfChannels || 2));

  const resampled = await resampleAudioBuffer(decoded, targetRate, targetCh);
  if (!resampled) return null;

  const pcm = sliceAudioPcm(resampled, startSec, durationSec, targetCh);
  if (!pcm || pcm.length <= 0) return null;

  return {
    codec: isOpus ? 'opus' : 'aac',
    webcodecsCodec: probedConfig?.codec || (isOpus ? 'opus' : 'mp4a.40.2'),
    sampleRate: pcm.sampleRate,
    numberOfChannels: pcm.numberOfChannels,
    bitrate: probedConfig?.bitrate || bitrate,
    channels: pcm.channels,
    length: pcm.length,
    durationSec: pcm.durationSec,
    peak: pcm.peak,
  };
}

/**
 * Attach prepared PCM audio to a MediaRecorder captureStream using WebAudio
 * (without routing sound to speakers).
 */
export function attachAudioTrackToMediaStream(audioTrackData, stream, options = {}) {
  const AudioCtx = getAudioContextCtor();
  if (!AudioCtx || !audioTrackData?.channels?.length || !stream) {
    return null;
  }

  try {
    const ctx = new AudioCtx({ sampleRate: audioTrackData.sampleRate });
    const length = audioTrackData.length || audioTrackData.channels[0].length;
    const buffer = ctx.createBuffer(audioTrackData.numberOfChannels, length, audioTrackData.sampleRate);
    for (let c = 0; c < audioTrackData.numberOfChannels; c++) {
      buffer.copyToChannel(audioTrackData.channels[c], c);
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);

    const tracks = dest.stream.getAudioTracks();
    for (const t of tracks) {
      stream.addTrack(t);
    }

    let stopped = false;
    const duration = Number(options.durationSec) > 0 ? Number(options.durationSec) : (length / audioTrackData.sampleRate);

    return {
      start() {
        try {
          if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
          }
          src.start(0, 0, duration);
        } catch (_) {
          // ignore
        }
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        try { src.stop(); } catch (_) { /* ignore */ }
        try { tracks.forEach((t) => t.stop()); } catch (_) { /* ignore */ }
        try { await ctx.close(); } catch (_) { /* ignore */ }
      },
    };
  } catch (_) {
    return null;
  }
}

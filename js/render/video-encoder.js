/**
 * Web Blender Studio - Client-Side Deterministic Video Encoder
 * Supports:
 * - MP4 (H.264 AVC + AAC) via WebCodecs + mp4-muxer
 * - WebM (VP9 / VP8 + Opus) via WebCodecs + built-in EBML WebMMuxer
 * File: js/render/video-encoder.js
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { WebMMuxer } from './webm-muxer.js';

const H264_CANDIDATES = [
  'avc1.640028', // High Profile, Level 4.0 (1080p)
  'avc1.64002a', // High Profile, Level 4.2 (1080p60)
  'avc1.4d0028', // Main Profile, Level 4.0
  'avc1.42e01f', // Baseline Profile, Level 3.1
];

const WEBM_CANDIDATES = [
  { codec: 'vp09.00.31.08', muxerCodec: 'V_VP9' },
  { codec: 'vp09.00.20.08', muxerCodec: 'V_VP9' },
  { codec: 'vp09.00.10.08', muxerCodec: 'V_VP9' },
  { codec: 'vp8', muxerCodec: 'V_VP8' },
];

/**
 * Probes WebCodecs encoder candidates preferring hardware GPU acceleration
 * (NVIDIA NVENC / AMD VCN / Apple VideoToolbox / Intel QuickSync) with safe fallback.
 */
export async function probePreferredVideoConfig(candidates, baseConfig, isConfigSupportedFn = null) {
  const probe = isConfigSupportedFn || (typeof VideoEncoder !== 'undefined' ? VideoEncoder.isConfigSupported.bind(VideoEncoder) : null);
  if (typeof probe !== 'function') return null;

  for (const hwMode of ['prefer-hardware', 'no-preference']) {
    for (const item of candidates) {
      const codec = typeof item === 'string' ? item : item.codec;
      try {
        const res = await probe({
          ...baseConfig,
          codec,
          hardwareAcceleration: hwMode,
        });
        if (res?.supported) {
          return {
            item,
            codec,
            hardwareAcceleration: hwMode,
            hardwareAccelerated: hwMode === 'prefer-hardware',
          };
        }
      } catch (_) {}
    }
  }
  return null;
}

export class VideoEncoderClient {
  /**
   * Probes browser WebCodecs support for MP4 (H.264) and WebM (VP9/VP8), including GPU HW acceleration.
   * @param {number} [width=1280]
   * @param {number} [height=720]
   * @param {number} [fps=30]
   */
  static async probeCapabilities(width = 1280, height = 720, fps = 30) {
    const hasWebCodecs = typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
    const hasAudioWebCodecs = typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';
    const result = {
      webCodecs: hasWebCodecs,
      audioWebCodecs: hasAudioWebCodecs,
      mp4: false,
      mp4Codec: null,
      mp4Hardware: false,
      webm: false,
      webmCodec: null,
      webmHardware: false,
    };
    if (!hasWebCodecs || typeof VideoEncoder.isConfigSupported !== 'function') {
      return result;
    }
    const w = Math.max(16, width & ~1);
    const h = Math.max(16, height & ~1);
    const mp4Match = await probePreferredVideoConfig(H264_CANDIDATES, {
      width: w, height: h, bitrate: 4_000_000, framerate: fps, avc: { format: 'avc' },
    });
    if (mp4Match) {
      result.mp4 = true;
      result.mp4Codec = mp4Match.codec;
      result.mp4Hardware = mp4Match.hardwareAccelerated;
    }
    const webmMatch = await probePreferredVideoConfig(WEBM_CANDIDATES, {
      width: w, height: h, bitrate: 4_000_000, framerate: fps,
    });
    if (webmMatch) {
      result.webm = true;
      result.webmCodec = webmMatch.codec;
      result.webmHardware = webmMatch.hardwareAccelerated;
    }
    return result;
  }

  /**
   * @param {Object} options
   * @param {number} options.width
   * @param {number} options.height
   * @param {number} [options.fps=30]
   * @param {number} [options.bitrate=6000000] 6 Mbps default for 1080p/720p
   * @param {string} [options.format='mp4'] 'mp4' | 'webm'
   * @param {number} [options.keyframeInterval=30] Keyframe every N frames
   */
  constructor(options = {}) {
    this.width = options.width || 1280;
    this.height = options.height || 720;
    this.fps = options.fps || 30;
    this.bitrate = options.bitrate || 6_000_000;
    this.format = (options.format || 'mp4').toLowerCase() === 'webm' ? 'webm' : 'mp4';
    this.mimeType = this.format === 'webm' ? 'video/webm' : 'video/mp4';
    this.keyframeInterval = options.keyframeInterval || this.fps;
    this.audio = options.audio ? {
      codec: options.audio.codec || (this.format === 'webm' ? 'opus' : 'aac'),
      webcodecsCodec: options.audio.webcodecsCodec || (this.format === 'webm' ? 'opus' : 'mp4a.40.2'),
      numberOfChannels: Math.max(1, Math.min(2, Math.round(options.audio.numberOfChannels || 2))),
      sampleRate: Math.round(options.audio.sampleRate || 48000),
      bitrate: Math.round(options.audio.bitrate || 128_000),
    } : null;

    this.muxer = null;
    this.encoder = null;
    this.audioEncoder = null;
    this.activeVideoCodec = null;
    this.activeAudioCodec = null;
    this.hardwareAccelerated = false;
    this.encodedChunkCount = 0;
    this.audioEncodedChunkCount = 0;
    this.isFinalized = false;
    this.error = null;
    this.audioError = null;

    this.hasWebCodecs = typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
    this.hasAudioWebCodecs = typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined';
  }

  /**
   * Initializes encoder and container muxer (video + optional AAC/Opus audio).
   */
  async init() {
    if (!this.hasWebCodecs) return;
    if (this.format === 'webm') {
      await this._initWebM();
    } else {
      await this._initMP4();
    }
  }

  async _initMP4() {
    let activeAudio = null;
    if (this.audio && this.hasAudioWebCodecs && typeof AudioEncoder.isConfigSupported === 'function') {
      try {
        const audioSupport = await AudioEncoder.isConfigSupported({
          codec: this.audio.webcodecsCodec || 'mp4a.40.2',
          sampleRate: this.audio.sampleRate,
          numberOfChannels: this.audio.numberOfChannels,
          bitrate: this.audio.bitrate,
        });
        if (audioSupport?.supported) {
          activeAudio = {
            codec: 'aac',
            webcodecsCodec: audioSupport.config?.codec || this.audio.webcodecsCodec || 'mp4a.40.2',
            numberOfChannels: audioSupport.config?.numberOfChannels || this.audio.numberOfChannels,
            sampleRate: audioSupport.config?.sampleRate || this.audio.sampleRate,
            bitrate: audioSupport.config?.bitrate || this.audio.bitrate,
          };
        }
      } catch (_) {
        activeAudio = null;
      }
    }
    this.audio = activeAudio;

    // Probe supported H.264 profile preferring GPU hardware acceleration (NVENC/VCN/VideoToolbox)
    const mp4Match = await probePreferredVideoConfig(H264_CANDIDATES, {
      width: this.width,
      height: this.height,
      bitrate: this.bitrate,
      framerate: this.fps,
      avc: { format: 'avc' },
    });
    const selectedCodec = mp4Match?.codec || null;
    const selectedHwMode = mp4Match?.hardwareAcceleration || 'no-preference';

    // 1. Initialize MP4 Muxer
    const muxerOptions = {
      target: new ArrayBufferTarget(),
      video: {
        codec: 'avc',
        width: this.width,
        height: this.height,
      },
      fastStart: 'in-memory',
    };
    if (activeAudio) {
      muxerOptions.audio = {
        codec: 'aac',
        numberOfChannels: activeAudio.numberOfChannels,
        sampleRate: activeAudio.sampleRate,
      };
      muxerOptions.firstTimestampBehavior = 'offset';
    }
    this.muxer = new Muxer(muxerOptions);

    if (activeAudio) {
      const fallbackAudioDurUs = Math.max(1, Math.round((1024 * 1_000_000) / activeAudio.sampleRate));
      this.audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          this.audioEncodedChunkCount++;
          if (this.muxer) {
            const ts = (typeof chunk.timestamp === 'number' && Number.isFinite(chunk.timestamp) && chunk.timestamp >= 0)
              ? chunk.timestamp
              : 0;
            if (typeof chunk.duration === 'number' && Number.isFinite(chunk.duration) && chunk.duration >= 0) {
              this.muxer.addAudioChunk(chunk, meta, ts);
            } else {
              const data = new Uint8Array(chunk.byteLength);
              chunk.copyTo(data);
              this.muxer.addAudioChunkRaw(data, chunk.type || 'key', ts, fallbackAudioDurUs, meta);
            }
          }
        },
        error: (err) => {
          console.warn('[VideoEncoderClient] Audio encoding warning:', err);
          this.audioError = err;
        },
      });
      this.audioEncoder.configure({
        codec: activeAudio.webcodecsCodec,
        sampleRate: activeAudio.sampleRate,
        numberOfChannels: activeAudio.numberOfChannels,
        bitrate: activeAudio.bitrate,
      });
      this.activeAudioCodec = activeAudio.webcodecsCodec;
    }

    // 2. Initialize WebCodecs VideoEncoder (H.264)
    const fallbackFrameDurationUs = Math.max(1, Math.round(1_000_000 / Math.max(1, this.fps)));
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        this.encodedChunkCount++;
        if (this.muxer) {
          if (typeof chunk.duration === 'number' && Number.isFinite(chunk.duration) && chunk.duration >= 0) {
            this.muxer.addVideoChunk(chunk, meta);
          } else {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            const ts = (typeof chunk.timestamp === 'number' && Number.isFinite(chunk.timestamp) && chunk.timestamp >= 0)
              ? chunk.timestamp
              : 0;
            this.muxer.addVideoChunkRaw(data, chunk.type, ts, fallbackFrameDurationUs, meta);
          }
        }
      },
      error: (err) => {
        console.error('[VideoEncoderClient] Encoding error:', err);
        this.error = err;
      },
    });

    try {
      const codecToUse = selectedCodec || 'avc1.42e01f';
      this.encoder.configure({
        codec: codecToUse,
        width: this.width,
        height: this.height,
        bitrate: this.bitrate,
        framerate: this.fps,
        hardwareAcceleration: selectedHwMode,
        avc: { format: 'avc' },
      });
      this.activeVideoCodec = codecToUse;
      this.hardwareAccelerated = selectedHwMode === 'prefer-hardware';
    } catch (err) {
      console.warn('[VideoEncoderClient] H.264 configure failed:', err);
      this.dispose();
    }
  }

  async _initWebM() {
    let activeAudio = null;
    if (this.audio && this.hasAudioWebCodecs && typeof AudioEncoder.isConfigSupported === 'function') {
      const requestedRate = Number(this.audio.sampleRate) || 48000;
      const candidateRates = [...new Set([requestedRate, 48000, 24000, 16000].filter((r) => [8000, 12000, 16000, 24000, 48000].includes(r)))];
      if (!candidateRates.length) candidateRates.push(48000);
      for (const sr of candidateRates) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const audioSupport = await AudioEncoder.isConfigSupported({
            codec: 'opus',
            sampleRate: sr,
            numberOfChannels: this.audio.numberOfChannels,
            bitrate: this.audio.bitrate,
          });
          if (audioSupport?.supported) {
            activeAudio = {
              codec: 'opus',
              webcodecsCodec: 'opus',
              numberOfChannels: audioSupport.config?.numberOfChannels || this.audio.numberOfChannels,
              sampleRate: audioSupport.config?.sampleRate || sr,
              bitrate: audioSupport.config?.bitrate || this.audio.bitrate,
            };
            break;
          }
        } catch (_) {
          // Try next supported sample rate
        }
      }
    }
    this.audio = activeAudio;

    const webmMatch = await probePreferredVideoConfig(WEBM_CANDIDATES, {
      width: this.width,
      height: this.height,
      bitrate: this.bitrate,
      framerate: this.fps,
    });
    const selected = webmMatch?.item || WEBM_CANDIDATES[WEBM_CANDIDATES.length - 1];
    const selectedHwMode = webmMatch?.hardwareAcceleration || 'no-preference';

    this.muxer = new WebMMuxer({
      video: {
        codec: selected.muxerCodec,
        width: this.width,
        height: this.height,
        fps: this.fps,
      },
      audio: activeAudio ? {
        sampleRate: activeAudio.sampleRate,
        numberOfChannels: activeAudio.numberOfChannels,
      } : null,
    });

    if (activeAudio) {
      this.audioEncoder = new AudioEncoder({
        output: (chunk) => {
          this.audioEncodedChunkCount++;
          if (this.muxer) {
            this.muxer.addAudioChunk(chunk);
          }
        },
        error: (err) => {
          console.warn('[VideoEncoderClient] Opus audio encoding warning:', err);
          this.audioError = err;
        },
      });
      this.audioEncoder.configure({
        codec: 'opus',
        sampleRate: activeAudio.sampleRate,
        numberOfChannels: activeAudio.numberOfChannels,
        bitrate: activeAudio.bitrate,
      });
      this.activeAudioCodec = 'opus';
    }

    const fallbackDurUs = Math.max(1, Math.round(1_000_000 / Math.max(1, this.fps)));
    this.encoder = new VideoEncoder({
      output: (chunk) => {
        this.encodedChunkCount++;
        if (this.muxer) {
          this.muxer.addVideoChunk(
            chunk,
            Number.isFinite(chunk.timestamp) ? chunk.timestamp : 0,
            Number.isFinite(chunk.duration) ? chunk.duration : fallbackDurUs,
            chunk.type === 'key'
          );
        }
      },
      error: (err) => {
        console.error('[VideoEncoderClient] WebM encoding error:', err);
        this.error = err;
      },
    });

    try {
      this.encoder.configure({
        codec: selected.codec,
        width: this.width,
        height: this.height,
        bitrate: this.bitrate,
        framerate: this.fps,
        hardwareAcceleration: selectedHwMode,
      });
      this.activeVideoCodec = selected.codec;
      this.hardwareAccelerated = selectedHwMode === 'prefer-hardware';
    } catch (err) {
      console.warn('[VideoEncoderClient] WebM configure failed:', err);
      this.dispose();
    }
  }

  /**
   * Encodes a single frame. Handles backpressure when encodeQueueSize > 4.
   * @param {VideoFrame|CanvasImageSource} frameSource
   * @param {number} frameIndex
   * @param {number} timestampUs Timestamp in microseconds
   */
  async addFrame(frameSource, frameIndex, timestampUs) {
    if (this.error) throw this.error;

    const isKeyframe = frameIndex % this.keyframeInterval === 0;

    if (this.encoder) {
      // Manage backpressure: don't flood the encoder queue
      while (this.encoder.encodeQueueSize > 4) {
        if (this.error) throw this.error;
        if (this.encoder.state === 'closed') throw new Error('VideoEncoder closed unexpectedly');
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      if (this.error) throw this.error;

      let videoFrame = null;
      if (typeof VideoFrame !== 'undefined' && frameSource instanceof VideoFrame) {
        videoFrame = frameSource;
      } else if (typeof VideoFrame !== 'undefined') {
        videoFrame = new VideoFrame(frameSource, {
          timestamp: timestampUs,
          duration: Math.round(1_000_000 / this.fps),
        });
      }

      if (videoFrame) {
        this.encoder.encode(videoFrame, { keyFrame: isKeyframe });
        videoFrame.close();
      }
    }
  }

  /**
   * Encodes planar PCM float32 channels via WebCodecs AudioEncoder into the active muxer.
   * @param {Float32Array[]} channels
   * @param {number} sampleRate
   * @param {AbortSignal} [signal]
   * @returns {Promise<number>} Number of encoded samples
   */
  async addAudioPcm(channels, sampleRate, signal = null) {
    if (!this.audioEncoder || !this.audio || !Array.isArray(channels) || channels.length === 0) {
      return 0;
    }

    const numCh = this.audio.numberOfChannels;
    const rate = this.audio.sampleRate || sampleRate || 48000;
    const inRate = Number(sampleRate) || rate;
    let srcChannels = channels;
    if (inRate > 0 && inRate !== rate && channels[0]?.length > 1) {
      // Linearly resample planar audio to match AudioEncoder configured sampleRate cleanly (prevents pitch shift)
      const inLen = channels[0].length;
      const outLen = Math.max(1, Math.round((inLen * rate) / inRate));
      const ratio = inRate / rate;
      srcChannels = channels.map((src) => {
        const dst = new Float32Array(outLen);
        for (let k = 0; k < outLen; k++) {
          const pos = k * ratio;
          const i0 = Math.floor(pos);
          const i1 = Math.min(inLen - 1, i0 + 1);
          const frac = pos - i0;
          dst[k] = src[i0] * (1 - frac) + src[i1] * frac;
        }
        return dst;
      });
    }
    const totalFrames = srcChannels[0]?.length || 0;
    if (totalFrames <= 0) return 0;

    // 960 samples (20ms @ 48kHz) is ideal for Opus; 1024 samples for AAC
    const chunkSize = this.audio.codec === 'opus' ? 960 : 1024;
    for (let offset = 0; offset < totalFrames; offset += chunkSize) {
      if (signal?.aborted) {
        throw new DOMException('Audio encode cancelled by user', 'AbortError');
      }
      if (this.audioError) break;

      while (this.audioEncoder.encodeQueueSize > 8) {
        if (signal?.aborted) {
          throw new DOMException('Audio encode cancelled by user', 'AbortError');
        }
        if (this.audioError || this.audioEncoder.state === 'closed') break;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      if (this.audioError || this.audioEncoder.state === 'closed') break;

      const count = Math.min(chunkSize, totalFrames - offset);
      const planar = new Float32Array(count * numCh);
      for (let c = 0; c < numCh; c++) {
        const src = srcChannels[Math.min(c, srcChannels.length - 1)];
        planar.set(src.subarray(offset, offset + count), c * count);
      }

      const timestamp = Math.round((offset * 1_000_000) / rate);
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate: rate,
        numberOfFrames: count,
        numberOfChannels: numCh,
        timestamp,
        data: planar,
      });
      this.audioEncoder.encode(audioData);
      audioData.close();
    }

    return totalFrames;
  }

  /**
   * True when a real encoder + muxer are configured (WebCodecs available).
   * Callers must not report success when this is false.
   * @returns {boolean}
   */
  canEncode() {
    return !!(this.encoder && this.muxer);
  }

  /**
   * True when an audio encoder was configured and encoded at least one chunk.
   * @returns {boolean}
   */
  hasAudio() {
    return !!(this.audio && this.audioEncodedChunkCount > 0);
  }

  /**
   * Flushes encoder and finalizes container muxer.
   * @param {Object} [options]
   * @param {boolean} [options.requireFrames=false] Throw instead of returning the
   *   placeholder blob when no chunk was encoded (product export path).
   * @returns {Promise<Blob>}
   */
  async finalize(options = {}) {
    const { requireFrames = false } = options;
    if (this.isFinalized) return null;
    this.isFinalized = true;

    if (this.encoder) {
      await this.encoder.flush();
      this.encoder.close();
      this.encoder = null;
    }

    if (this.audioEncoder) {
      try {
        await this.audioEncoder.flush();
      } catch (err) {
        console.warn('[VideoEncoderClient] Audio flush warning:', err);
      }
      try {
        this.audioEncoder.close();
      } catch (_) {}
      this.audioEncoder = null;
    }

    if (this.muxer && this.encodedChunkCount > 0) {
      let buffer;
      if (this.format === 'webm') {
        buffer = this.muxer.finalize();
      } else {
        this.muxer.finalize();
        buffer = this.muxer.target.buffer;
      }
      this.muxer = null;
      return new Blob([buffer], { type: this.mimeType });
    }
    this.muxer = null;

    if (requireFrames) {
      throw new Error(
        `No frames were encoded (0 chunks): ${this.format.toUpperCase()} configuration is not supported by WebCodecs. ` +
        'Try switching format to WebM or PNG Sequence (.zip).'
      );
    }

    // Fallback minimal blob when 0 chunks were encoded or in non-browser/test mocks
    if (this.format === 'webm') {
      return new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'video/webm' });
    }
    return new Blob([new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])], { type: 'video/mp4' });
  }

  /**
   * Disposes resources.
   */
  dispose() {
    if (this.encoder) {
      try { this.encoder.close(); } catch (_) {}
      this.encoder = null;
    }
    if (this.audioEncoder) {
      try { this.audioEncoder.close(); } catch (_) {}
      this.audioEncoder = null;
    }
    this.muxer = null;
  }
}

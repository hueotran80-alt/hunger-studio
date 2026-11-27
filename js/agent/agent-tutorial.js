import { AgentError, assertArg, toPlain } from './agent-core.js';
import {
  STEM_LESSONS,
  getStemLesson,
  gradeStemLesson,
  computeAvatarTargetPosition,
  TutorVoiceEngine
} from '../education/stem-curriculum.js';

export {
  STEM_LESSONS,
  getStemLesson,
  gradeStemLesson,
  computeAvatarTargetPosition,
  TutorVoiceEngine
};

const TEN_MB = 10 * 1024 * 1024;
const JPEG_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const json = value => JSON.stringify(value, null, 2);
const snapshot = value => JSON.parse(JSON.stringify(toPlain(value)));

function jpegImage(dataURL) {
  if (!JPEG_URL.test(dataURL)) throw new AgentError('E_UNSUPPORTED', 'PDF screenshots must be base64 JPEG images');
  let bytes;
  try {
    bytes = Uint8Array.from(atob(dataURL.slice(dataURL.indexOf(',') + 1)), character => character.charCodeAt(0));
  } catch (_) {
    throw new AgentError('E_UNSUPPORTED', 'The screenshot contains invalid JPEG data');
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new AgentError('E_UNSUPPORTED', 'The screenshot is not a JPEG image');
  const frames = new Set([0xc0, 0xc1, 0xc2]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (frames.has(marker)) {
      const bits = bytes[offset + 2];
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const channels = bytes[offset + 7];
      if (length < 8 + channels * 3 || bits !== 8 || !width || !height || ![1, 3].includes(channels)) {
        throw new AgentError('E_UNSUPPORTED', 'PDF supports only 8-bit grayscale or RGB JPEG screenshots');
      }
      let ended = false;
      for (let i = offset + length; i + 1 < bytes.length; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) { ended = true; break; }
      }
      if (!ended) throw new AgentError('E_UNSUPPORTED', 'The JPEG screenshot is truncated');
      return { bytes, width, height, colorSpace: channels === 1 ? '/DeviceGray' : '/DeviceRGB' };
    }
    offset += length;
  }
  throw new AgentError('E_UNSUPPORTED', 'The JPEG screenshot has no supported frame header');
}

function createPDF(tutorial) {
  const encoder = new TextEncoder();
  const ascii = value => encoder.encode(value);
  const normalize = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e\n\t]/g, '?');
  const literal = value => normalize(value).replace(/([\\()])/g, '\\$1');
  const pages = [];
  let page = { commands: [], image: null };
  let y = 744;
  pages.push(page);

  function newPage(image = null) {
    page = { commands: [], image };
    pages.push(page);
    y = 744;
  }

  function lines(text, size = 11) {
    const maxChars = Math.floor(516 / (size * 0.6));
    for (const paragraph of normalize(text).replace(/\t/g, '    ').split('\n')) {
      let rest = paragraph;
      do {
        if (y < 48) newPage();
        let cut = Math.min(rest.length, maxChars);
        if (rest.length > maxChars) {
          const space = rest.lastIndexOf(' ', maxChars);
          if (space > maxChars / 2) cut = space;
        }
        const line = rest.slice(0, cut);
        page.commands.push(`BT /F1 ${size} Tf 1 0 0 1 48 ${y} Tm (${literal(line)}) Tj ET`);
        y -= size + 4;
        rest = rest.slice(cut).replace(/^ +/, '');
      } while (rest.length);
    }
  }

  lines(tutorial.title, 18);
  if (tutorial.audience) lines(`Audience: ${tutorial.audience}`);
  lines('PDF text uses a basic Latin font; other characters are transliterated or shown as ?.');
  lines('');
  for (const step of tutorial.steps) {
    if (page.image) newPage();
    lines(`Step ${step.number}`, 14);
    lines(step.text);
    if (step.toolId) {
      lines(`Tool: ${step.toolId}`);
      lines(`Arguments: ${json(step.args)}`, 9);
      lines(`Documentation: ${json(step.docs)}`, 9);
    }
    if (step.highlight) lines(`Highlight: ${step.highlight}`);
    if (step.screenshot) {
      const image = jpegImage(step.screenshot);
      newPage(image);
      lines(`Step ${step.number} screenshot`, 14);
      const scale = Math.min(516 / image.width, 650 / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      page.commands.push(`q ${width.toFixed(3)} 0 0 ${height.toFixed(3)} 48 ${(y - height - 8).toFixed(3)} cm /Im1 Do Q`);
    } else lines('');
  }

  const objects = [null, null, null, null];
  objects[3] = [ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')];
  const add = parts => { objects.push(parts); return objects.length - 1; };
  const stream = (dictionary, bytes) => [ascii(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`), bytes, ascii('\nendstream')];
  const pageIds = [];
  for (const item of pages) {
    let imageId = null;
    if (item.image) {
      const image = item.image;
      imageId = add(stream(`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.colorSpace} /BitsPerComponent 8 /Filter /DCTDecode`, image.bytes));
    }
    const contentId = add(stream('', ascii(item.commands.join('\n'))));
    const resource = imageId ? ` /XObject << /Im1 ${imageId} 0 R >>` : '';
    pageIds.push(add([ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >>${resource} >> /Contents ${contentId} 0 R >>`)]));
  }
  objects[1] = [ascii('<< /Type /Catalog /Pages 2 0 R >>')];
  objects[2] = [ascii(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)];
  const chunks = [ascii('%PDF-1.4\n'), new Uint8Array([37, 226, 227, 207, 211, 10])];
  let size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const offsets = [0];
  const append = bytes => { chunks.push(bytes); size += bytes.length; };
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = size;
    append(ascii(`${id} 0 obj\n`));
    objects[id].forEach(append);
    append(ascii('\nendobj\n'));
  }
  const xref = size;
  append(ascii(`xref\n0 ${objects.length}\n0000000000 65535 f \n`));
  for (let id = 1; id < objects.length; id++) append(ascii(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`));
  append(ascii(`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  const result = new Uint8Array(size);
  let offset = 0;
  chunks.forEach(chunk => { result.set(chunk, offset); offset += chunk.length; });
  return result;
}

function codeBlock(value) {
  const text = json(value);
  const runs = text.match(/`+/g) || [];
  const fence = '`'.repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
  return `${fence}json\n${text}\n${fence}`;
}

function markdown(tutorial) {
  const parts = [`# ${tutorial.title}`];
  if (tutorial.audience) parts.push(`Audience: ${tutorial.audience}`);
  for (const step of tutorial.steps) {
    parts.push(`## Step ${step.number}`, step.text);
    if (step.toolId) parts.push(`Tool: ${step.toolId}`, 'Arguments:', codeBlock(step.args), 'Documentation:', codeBlock(step.docs));
    if (step.highlight) parts.push(`Highlight: ${step.highlight}`);
    if (step.screenshot) parts.push(`![](${step.screenshot})`);
  }
  return `${parts.join('\n\n')}\n`;
}

function html(tutorial) {
  const parts = ['<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">',
    `<title>${escapeHtml(tutorial.title)}</title>`,
    '<style>body{font:16px sans-serif;max-width:960px;margin:32px auto;padding:0 24px}p,pre{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;height:auto}section{margin:32px 0}</style></head><body>',
    `<h1>${escapeHtml(tutorial.title)}</h1>`];
  if (tutorial.audience) parts.push(`<p>Audience: ${escapeHtml(tutorial.audience)}</p>`);
  for (const step of tutorial.steps) {
    parts.push(`<section><h2>Step ${step.number}</h2><p>${escapeHtml(step.text)}</p>`);
    if (step.toolId) parts.push(`<p>Tool: ${escapeHtml(step.toolId)}</p>`,
      `<h3>Arguments</h3><pre>${escapeHtml(json(step.args))}</pre>`,
      `<h3>Documentation</h3><pre>${escapeHtml(json(step.docs))}</pre>`);
    if (step.highlight) parts.push(`<p>Highlight: ${escapeHtml(step.highlight)}</p>`);
    if (step.screenshot) parts.push(`<img src="${escapeHtml(step.screenshot)}" alt="Step ${step.number} screenshot">`);
    parts.push('</section>');
  }
  parts.push('</body></html>');
  return parts.join('\n');
}

export function createTutorialTools(ctx) {
  let current = null;
  let ownedURL = null;

  function active() {
    if (!current) throw new AgentError('E_NOT_FOUND', 'No tutorial has been started', 'Call tutorial.start({title,audience}) first.');
    return current;
  }

  function stillActive(session) {
    if (current !== session) throw new AgentError('E_TX_CONFLICT', 'The tutorial changed while this operation was pending');
  }

  function revoke() {
    if (ownedURL) URL.revokeObjectURL(ownedURL);
    ownedURL = null;
  }

  return {
    start({ title, audience = '' } = {}) {
      assertArg(typeof title === 'string' && title.trim().length > 0, 'Tutorial title must be a non-empty string');
      assertArg(typeof audience === 'string', 'Tutorial audience must be a string');
      revoke();
      current = { title, audience, startedAt: new Date().toISOString(), steps: [], queue: Promise.resolve() };
      const data = { title, audience, stepCount: 0 };
      ctx.log?.push({ level: 'info', source: 'tutorial', message: 'Tutorial started', data });
      ctx.events?.emit('tutorial:start', data);
      return data;
    },

    async step({ text, toolId, args = {}, screenshot = true, highlight } = {}) {
      const session = active();
      assertArg(typeof text === 'string' && text.trim().length > 0, 'Step text must be a non-empty string');
      assertArg(toolId === undefined || (typeof toolId === 'string' && toolId.length > 0), 'toolId must be a non-empty string');
      assertArg(typeof screenshot === 'boolean', 'screenshot must be a boolean');
      assertArg(highlight === undefined || (typeof highlight === 'string' && highlight.length > 0), 'highlight must be a UI control ID');
      const savedArgs = snapshot(args);
      const operation = session.queue.then(async () => {
        stillActive(session);
        let docs = null;
        if (toolId !== undefined) {
          if (typeof ctx.manifest?.getTool !== 'function') throw new AgentError('E_UNSUPPORTED', 'The tool manifest is unavailable');
          const definition = await ctx.manifest.getTool(toolId);
          if (!definition) throw new AgentError('E_NOT_FOUND', `Tool '${toolId}' is not documented`);
          docs = snapshot(definition);
        }
        stillActive(session);
        if (highlight !== undefined) {
          if (typeof ctx.ui?.highlight !== 'function') throw new AgentError('E_UNSUPPORTED', 'UI highlighting is unavailable');
          await ctx.ui.highlight(highlight);
          ctx.app?.stemTutor?.moveToTarget?.(highlight, {
            openBubble: true,
            title: session.title,
            stepBadge: `Step ${session.steps.length + 1}`,
            speechText: text,
            speak: true
          });
        } else if (ctx.app?.stemTutor) {
          ctx.app.stemTutor.setBubbleOpen(true);
          ctx.app.stemTutor.setBubbleContent({
            title: session.title,
            stepBadge: `Step ${session.steps.length + 1}`,
            text
          });
          ctx.app.stemTutor.speak(text);
        }
        let dataURL = null;
        if (screenshot) {
          if (typeof ctx.screenshot !== 'function') throw new AgentError('E_UNSUPPORTED', 'Screenshots are unavailable');
          const image = await ctx.screenshot({ format: 'jpeg', width: 960 });
          dataURL = typeof image === 'string' ? image : image?.dataURL || image?.dataUrl || image?.data?.dataURL;
          if (typeof dataURL !== 'string' || !JPEG_URL.test(dataURL)) {
            throw new AgentError('E_UNSUPPORTED', 'The screenshot service did not return a JPEG data URL');
          }
        }
        stillActive(session);
        const record = {
          number: session.steps.length + 1, text, toolId: toolId ?? null, args: savedArgs,
          docs, screenshot: dataURL, highlight: highlight ?? null
        };
        session.steps.push(record);
        const data = { step: record.number, toolId: record.toolId, screenshot: !!dataURL };
        ctx.log?.push({ level: 'info', source: 'tutorial', message: 'Tutorial step recorded', data });
        ctx.events?.emit('tutorial:step', data);
        return record.number;
      });
      session.queue = operation.then(() => undefined, () => undefined);
      return operation;
    },

    async export({ format = 'markdown', embedScreenshots = true } = {}) {
      assertArg(['markdown', 'html', 'json', 'pdf'].includes(format), 'format must be markdown, html, json or pdf');
      assertArg(typeof embedScreenshots === 'boolean', 'embedScreenshots must be a boolean');
      const session = active();
      await session.queue;
      stillActive(session);
      const tutorial = {
        title: session.title, audience: session.audience, startedAt: session.startedAt,
        steps: session.steps.map(step => ({ ...step, screenshot: embedScreenshots ? step.screenshot : null }))
      };
      const types = { markdown: 'text/markdown;charset=utf-8', html: 'text/html;charset=utf-8', json: 'application/json;charset=utf-8', pdf: 'application/pdf' };
      const content = format === 'markdown' ? markdown(tutorial) : format === 'html' ? html(tutorial) :
        format === 'json' ? json(tutorial) : createPDF(tutorial);
      if (typeof Blob === 'undefined' || typeof URL === 'undefined' ||
          typeof URL.createObjectURL !== 'function' || typeof URL.revokeObjectURL !== 'function') {
        throw new AgentError('E_UNSUPPORTED', 'Blob URL exports are unavailable in this environment');
      }
      const mime = types[format];
      const blob = new Blob([content], { type: mime });
      if (blob.size > TEN_MB) {
        if (typeof ctx.confirm !== 'function') throw new AgentError('E_NEEDS_CONFIRM', 'Exports larger than 10 MB require user confirmation');
        const approved = await ctx.confirm({
          title: 'Export large tutorial', message: `This export is ${(blob.size / 1024 / 1024).toFixed(1)} MB. Continue?`, danger: false
        });
        if (approved !== true) throw new AgentError('E_PERMISSION', 'The user declined the large tutorial export');
      }
      stillActive(session);
      const url = URL.createObjectURL(blob);
      revoke();
      ownedURL = url;
      const data = { url, format, mime, sizeBytes: blob.size };
      ctx.log?.push({ level: 'info', source: 'tutorial', message: 'Tutorial exported', data });
      ctx.events?.emit('tutorial:export', data);
      return { url, content, mime, sizeBytes: blob.size };
    }
  };
}

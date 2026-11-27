/**
 * Unit tests — STEM live voice session (không cần trình duyệt).
 * Kiểm tra: nghe liên tục, auto-submit sau khoảng lặng, barge-in, wake word,
 * khởi động lại phiên, lỗi micro, và các guard (minChars, stop, destroy).
 */
import assert from 'node:assert/strict';
import { StemVoiceSession, VOICE_SESSION_STATES } from '../js/education/stem-voice-session.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    failed += 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    failed += 1;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeRecognition {
  constructor() {
    this.started = 0;
    this.stopped = 0;
    this.aborted = 0;
  }
  start() {
    this.started += 1;
    if (this.onstart) this.onstart();
  }
  stop() {
    this.stopped += 1;
    if (this.onend) this.onend();
  }
  abort() {
    this.aborted += 1;
    if (this.onend) this.onend();
  }
  /** emit('xin chào', true) hoặc emit('đang nói', false) */
  emit(transcript, isFinal = false) {
    this.onresult({
      resultIndex: 0,
      results: [{ 0: { transcript }, isFinal, length: 1 }]
    });
  }
}

function makeSession(overrides = {}) {
  const fake = new FakeRecognition();
  const events = { transcripts: [], submits: [], states: [], errors: [], bargeIns: [] };
  const session = new StemVoiceSession({
    recognitionFactory: () => fake,
    silenceMs: 15,
    restartDelayMs: 5,
    minChars: 2,
    maxChars: 120,
    setTimeout,
    clearTimeout,
    onTranscript: (p) => events.transcripts.push(p),
    onSubmit: (p) => {
      events.submits.push(p);
      if (overrides.onSubmit) return overrides.onSubmit(p);
      return undefined;
    },
    onStateChange: (s) => events.states.push(s),
    onBargeIn: (p) => events.bargeIns.push(p),
    onError: (e) => events.errors.push(e),
    ...overrides.options
  });
  return { session, fake, events };
}

console.log('\nSTEM live voice session suite');

await testAsync('start() mở phiên, gọi recognition.start và vào trạng thái listening', async () => {
  const { session, fake } = makeSession();
  assert.equal(session.start(), true);
  assert.equal(session.isActive, true);
  assert.equal(session.state, 'listening');
  assert.ok(fake.started >= 1);
  assert.ok(VOICE_SESSION_STATES.includes(session.state));
  session.stop();
});

await testAsync('kết quả tạm thời (interim) hiển thị nhưng KHÔNG tự gửi', async () => {
  const { session, fake, events } = makeSession();
  session.start();
  fake.emit('extrude là', false);
  await sleep(35);
  assert.equal(events.submits.length, 0);
  const last = events.transcripts.at(-1);
  assert.equal(last.text, 'extrude là');
  assert.equal(last.isFinal, false);
  session.stop();
});

await testAsync('kết quả cuối (final) tự gửi đúng một lần sau khoảng lặng', async () => {
  const { session, fake, events } = makeSession();
  session.start();
  fake.emit('extrude là gì', true);
  await sleep(40);
  assert.equal(events.submits.length, 1);
  assert.equal(events.submits[0].text, 'extrude là gì');
  assert.equal(session.submitCount, 1);
  assert.equal(session.lastSubmitted, 'extrude là gì');
  assert.equal(session.state, 'listening');
  session.stop();
});

await testAsync('hai final liên tiếp trong cùng khoảng lặng chỉ gửi một câu đã ghép', async () => {
  const { session, fake, events } = makeSession();
  session.start();
  fake.emit('tạo một cái', true);
  fake.emit('bàn gỗ', true);
  await sleep(40);
  assert.equal(events.submits.length, 1);
  assert.equal(events.submits[0].text, 'tạo một cái bàn gỗ');
  session.stop();
});

await testAsync('barge-in: nói khi giáo viên đang giảng thì dừng TTS và quay lại nghe', async () => {
  const { session, fake, events, } = makeSession();
  session.start();
  session.notifyAssistantSpeaking();
  assert.equal(session.state, 'speaking');
  fake.emit('khoan đã', false);
  assert.equal(events.bargeIns.length, 1);
  assert.equal(events.bargeIns[0].text, 'khoan đã');
  assert.equal(session.state, 'listening');
  fake.emit('khoan đã', false);
  assert.equal(events.bargeIns.length, 1, 'không bắn barge-in lặp lại trong cùng lượt');
  session.stop();
});

await testAsync('tiếng TTS “xem lại” không bị nhận thành lệnh “quay lại”', async () => {
  const { session, fake, events } = makeSession({ options: { silenceMs: 15, echoGuardMs: 120 } });
  session.start();
  session.notifyAssistantSpeaking('Bạn đã đi qua trọn bộ 4 bước. Có thể bấm Trước, Tiếp để xem lại từng bước hoặc hỏi thêm câu mới!');
  fake.emit('quay lại', true);
  await sleep(35);
  assert.equal(events.bargeIns.length, 0, 'tiếng vọng điều hướng không được kích hoạt barge-in');
  assert.equal(events.submits.length, 0, 'tiếng vọng không được gửi thành lệnh quay lại');
  assert.equal(session.state, 'speaking', 'giáo viên vẫn phải tiếp tục giảng');

  fake.emit('khoan đã', false);
  assert.equal(events.bargeIns.length, 1, 'người dùng vẫn có thể ngắt lời thật');
  session.stop();
});

await testAsync('lệnh tiếp tục thật không bị chặn khi giáo viên chỉ nói “tiếp”', async () => {
  const { session, fake, events } = makeSession({ options: { silenceMs: 15, echoGuardMs: 120 } });
  session.start();
  session.notifyAssistantSpeaking('Tiếp theo bạn hãy chọn công cụ Extrude.');
  fake.emit('tiếp tục', true);
  await sleep(35);
  assert.equal(events.submits.length, 1, 'lệnh tiếp tục của người dùng phải đi qua');
  assert.equal(events.submits[0].text, 'tiếp tục');
  session.stop();
});

await testAsync('wake word: câu không gọi giáo viên bị bỏ qua, câu có wake word được cắt sạch', async () => {
  const { session, fake, events } = makeSession({ options: { wakeWord: 'thầy ơi' } });
  session.start();
  fake.emit('mở bảng modifier', true);
  await sleep(40);
  assert.equal(events.submits.length, 0, 'thiếu wake word thì không gửi');

  fake.emit('Thầy ơi, extrude là gì', true);
  await sleep(40);
  assert.equal(events.submits.length, 1);
  assert.equal(events.submits[0].text.toLowerCase(), 'extrude là gì');
  session.stop();
});

await testAsync('câu quá ngắn (< minChars) không gửi', async () => {
  const { session, fake, events } = makeSession();
  session.start();
  fake.emit('a', true);
  await sleep(40);
  assert.equal(events.submits.length, 0);
  assert.equal(session.state, 'listening');
  session.stop();
});

await testAsync('stop() trước khoảng lặng thì không gửi gì', async () => {
  const { session, fake, events } = makeSession();
  session.start();
  fake.emit('tạo cái ghế', true);
  session.stop();
  await sleep(40);
  assert.equal(events.submits.length, 0);
  assert.equal(session.isActive, false);
  assert.equal(session.state, 'idle');
});

await testAsync('trình duyệt không hỗ trợ: báo E_UNSUPPORTED và start() trả false', async () => {
  const { session, events } = makeSession({ options: { recognitionFactory: () => null } });
  assert.equal(session.start(), false);
  assert.equal(session.state, 'error');
  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].code, 'E_UNSUPPORTED');
});

await testAsync('micro bị từ chối: báo E_MIC_DENIED và đóng phiên', async () => {
  const { session, fake, events } = makeSession();
  session.start();
  fake.onerror({ error: 'not-allowed' });
  assert.equal(events.errors.at(-1).code, 'E_MIC_DENIED');
  assert.equal(session.isActive, false);
});

await testAsync('lỗi no-speech/aborted không làm phiền người dùng', async () => {
  const { session, fake, events } = makeSession();
  session.start();
  fake.onerror({ error: 'no-speech' });
  fake.onerror({ error: 'aborted' });
  assert.equal(events.errors.length, 0);
  assert.equal(session.isActive, true);
  session.stop();
});

await testAsync('onSubmit lỗi thì báo E_SUBMIT và phiên vẫn tiếp tục nghe', async () => {
  const { session, fake, events } = makeSession({
    onSubmit: () => {
      throw new Error('AI offline');
    }
  });
  session.start();
  fake.emit('vẽ cái bàn', true);
  await sleep(40);
  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].code, 'E_SUBMIT');
  assert.match(events.errors[0].message, /AI offline/);
  assert.equal(session.state, 'listening');
  session.stop();
});

await testAsync('recognition kết thúc (onend) thì tự khởi động lại để giữ live', async () => {
  const { session, fake } = makeSession();
  session.start();
  const before = fake.started;
  fake.onend();
  await sleep(25);
  assert.ok(fake.started > before, 'phải gọi start lại');
  assert.equal(session.state, 'listening');
  session.stop();
});

await testAsync('destroy() đóng phiên và không còn submit', async () => {
  const { session, fake, events } = makeSession();
  session.start();
  fake.emit('câu hỏi cuối', true);
  session.destroy();
  await sleep(40);
  assert.equal(events.submits.length, 0);
  assert.equal(session.recognition, null);
});

await testAsync('extractQuery xử lý wake word và không wake word', async () => {
  assert.equal(StemVoiceSession.extractQuery('  Thầy ơi, bevel là gì  ', 'thầy ơi'), 'bevel là gì');
  assert.equal(StemVoiceSession.extractQuery('không có từ khoá', 'thầy ơi'), '');
  assert.equal(StemVoiceSession.extractQuery('  giữ nguyên  ', ''), 'giữ nguyên');
});

await testAsync('interim liên tục kéo dài thời gian im lặng và giữ cả final + interim', async () => {
  const { session, fake, events } = makeSession({ options: { silenceMs: 45 } });
  session.start();
  fake.emit('hướng dẫn tạo', true);
  await sleep(25);
  fake.emit('cái bàn gỗ', false);
  await sleep(28);
  // Sau ~53ms từ lúc final đầu tiên, nhưng nhờ interim ở t=25 nên chưa bị cắt ngang!
  assert.equal(events.submits.length, 0, 'đang nói dở (interim) không được tự gửi sớm');
  assert.equal(events.transcripts.at(-1).text, 'hướng dẫn tạo cái bàn gỗ');
  fake.emit('cái bàn gỗ bốn chân', true);
  await sleep(65);
  assert.equal(events.submits.length, 1);
  assert.equal(events.submits[0].text, 'hướng dẫn tạo cái bàn gỗ bốn chân');
  session.stop();
});

await testAsync('pause() và resume() ngắt/mở micro sạch không gửi nhầm', async () => {
  const { session, fake, events } = makeSession({ options: { silenceMs: 20, echoGuardMs: 80 } });
  session.start();
  assert.equal(session.pause(), true);
  assert.equal(session.isPaused, true);
  assert.equal(session.isListening, false);
  fake.emit('lời nói lúc tạm ngắt', true);
  fake.onend();
  await sleep(35);
  assert.equal(events.submits.length, 0, 'khi pause không được thu âm hay tự restart');
  assert.equal(session.resume(), true);
  assert.equal(session.isPaused, false);
  assert.equal(session.isListening, true);
  fake.emit('nói sau khi mở lại', true);
  await sleep(35);
  assert.equal(events.submits.length, 1);
  assert.equal(events.submits[0].text, 'nói sau khi mở lại');
  session.stop();
});

await testAsync('echoGuardMs sau khi đọc xong vẫn chặn tiếng vọng loa trừ từ ngắt lời mới', async () => {
  const { session, fake, events } = makeSession({ options: { silenceMs: 18, echoGuardMs: 120 } });
  session.start();
  session.notifyAssistantSpeaking('Bước một chọn khối hộp rồi nhấn Tab vào Edit Mode');
  session.notifyAssistantIdle();
  fake.emit('nhấn tab vào edit mode', true);
  await sleep(30);
  assert.equal(events.submits.length, 0, 'vẫn phải chặn dư âm từ loa vừa dứt');
  fake.emit('đợi chút thầy ơi', true);
  await sleep(30);
  assert.equal(events.submits.length, 1, 'từ ngắt lời thật phải đi qua ngay');
  session.stop();
});

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

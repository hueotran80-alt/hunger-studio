/**
 * Tests for unified Wake-Word Auto-Start (Copilot + STEM) & Multi-Step Guided Walkthrough.
 */
import assert from 'node:assert/strict';
import {
  COPILOT_WAKE_WORDS,
  STEM_WAKE_WORDS,
  parseQuickVoiceCommand,
  routeVoiceUtterance,
  VoiceWakeCoordinator
} from '../js/ai/voice-wake-router.js';
import { StemVoiceSession } from '../js/education/stem-voice-session.js';
import { StemTutorUI } from '../js/ui/stem-tutor-ui.js';
import { studio } from '../js/scripting/rapid-api.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n       `, err);
    failed += 1;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n       `, err);
    failed += 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakeRecognition {
  constructor() {
    this.started = 0;
    this.aborted = 0;
  }
  start() {
    this.started += 1;
    this.onstart?.();
  }
  stop() {
    this.onend?.();
  }
  abort() {
    this.aborted += 1;
    this.onend?.();
  }
  emit(transcript, isFinal = true) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ 0: { transcript }, isFinal, length: 1 }]
    });
  }
}

console.log('\nUnified Wake-Word & Multi-Step Tutor Walkthrough suite');

test('parseQuickVoiceCommand nhận diện lệnh điều khiển nhanh mà không nuốt câu dựng 3D', () => {
  assert.equal(parseQuickVoiceCommand('bước tiếp theo'), 'next_step');
  assert.equal(parseQuickVoiceCommand('quay lại'), 'prev_step');
  assert.equal(parseQuickVoiceCommand('tự chạy'), 'auto_walk');
  assert.equal(parseQuickVoiceCommand('tạm dừng'), 'pause_walk');
  assert.equal(parseQuickVoiceCommand('chấm điểm'), 'grade');
  assert.equal(parseQuickVoiceCommand('mở copilot'), 'open_copilot');
  assert.equal(parseQuickVoiceCommand('tạo cái bàn có bước tiếp theo'), null);
});

test('routeVoiceUtterance phân luồng chính xác lệnh gọi Copilot / STEM / Wake-Only / Ignore', () => {
  assert.ok(COPILOT_WAKE_WORDS.includes('copilot ơi'));
  assert.ok(STEM_WAKE_WORDS.includes('thầy ơi'));

  const r1 = routeVoiceUtterance('Copilot ơi, tạo một ngôi nhà hiện đại', { requireWakeWord: true });
  assert.equal(r1.target, 'copilot');
  assert.equal(r1.wakeOnly, false);
  assert.equal(r1.query, 'tạo một ngôi nhà hiện đại');

  const r2 = routeVoiceUtterance('Copilot ơi', { requireWakeWord: true });
  assert.equal(r2.target, 'copilot');
  assert.equal(r2.wakeOnly, true);

  const r3 = routeVoiceUtterance('Thầy ơi, hướng dẫn làm cái bàn 3D', { requireWakeWord: true });
  assert.equal(r3.target, 'stem');
  assert.equal(r3.wakeOnly, false);
  assert.equal(r3.query, 'hướng dẫn làm cái bàn 3D');

  const r4 = routeVoiceUtterance('Thầy ơi', { requireWakeWord: true });
  assert.equal(r4.target, 'stem');
  assert.equal(r4.wakeOnly, true);

  const rIgnore = routeVoiceUtterance('hôm nay nói chuyện phiếm ngoài lề', { requireWakeWord: true, inActiveWindow: false });
  assert.equal(rIgnore.target, 'ignore');

  const rFollowUp = routeVoiceUtterance('hướng dẫn dùng Extrude', { requireWakeWord: true, inActiveWindow: true, activeTarget: 'stem' });
  assert.equal(rFollowUp.target, 'stem');
  assert.equal(rFollowUp.query, 'hướng dẫn dùng Extrude');
});

await testAsync('VoiceWakeCoordinator đánh thức đúng Copilot/STEM, chạy quick command & auto-arm theo gesture', async () => {
  const events = { copilot: [], copilotWake: 0, stem: [], stemWake: 0, cmds: [] };
  const fakeRec = new FakeRecognition();
  const listeners = new Map();
  const fakeWindow = {
    SpeechRecognition: FakeRecognition,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); }
  };

  const coord = new VoiceWakeCoordinator({
    silenceMs: 12,
    activeWindowMs: 5000,
    recognitionFactory: () => fakeRec,
    onCopilotQuery: (d) => events.copilot.push(d.query),
    onCopilotWakeOnly: () => { events.copilotWake += 1; },
    onStemQuery: (d) => events.stem.push(d.query),
    onStemWakeOnly: () => { events.stemWake += 1; },
    onCommand: (d) => events.cmds.push(d.command)
  });

  // 1. Giả lập chế độ Wake được lưu -> auto-arm trên gesture đầu tiên
  coord.wakeEnabled = true;
  const armed = await coord.armAutoStartOnGesture(fakeWindow);
  assert.equal(armed, true);
  assert.equal(coord.autoWakePendingGesture, true);
  listeners.get('pointerdown')?.();
  assert.equal(coord.mode, 'wake');
  assert.equal(coord.session.isActive, true);

  // 2. Bỏ qua tạp âm không có wake word trước khi đánh thức
  fakeRec.emit('trời hôm nay mát mẻ', true);
  await sleep(30);
  assert.equal(events.copilot.length, 0);
  assert.equal(events.stem.length, 0);

  // 3. Lệnh gọi "Copilot ơi, ..." đánh thức Copilot
  fakeRec.emit('Copilot ơi, dựng siêu xe màu đỏ', true);
  await sleep(35);
  assert.deepEqual(events.copilot, ['dựng siêu xe màu đỏ']);

  // 4. Trong active window: "Thầy ơi" wake-only -> STEM, rồi "bước tiếp theo" -> quick command
  fakeRec.emit('Thầy ơi', true);
  await sleep(30);
  assert.equal(events.stemWake, 1);

  fakeRec.emit('bước tiếp theo', true);
  await sleep(30);
  assert.deepEqual(events.cmds, ['next_step']);

  fakeRec.emit('hướng dẫn vát cạnh bevel', true);
  await sleep(35);
  assert.deepEqual(events.stem, ['hướng dẫn vát cạnh bevel']);

  coord.stopAll();
});

await testAsync('Live Voice chặn lệnh prev_step từ tiếng TTS nhưng vẫn nhận lệnh thật sau khi giảng xong', async () => {
  const fakeRec = new FakeRecognition();
  const commands = [];
  let bargeIns = 0;
  const coord = new VoiceWakeCoordinator({
    recognitionFactory: () => fakeRec,
    silenceMs: 12,
    onCommand: (decision) => commands.push(decision.command),
    onBargeIn: () => { bargeIns += 1; }
  });
  coord.startDirectMode('stem');
  coord.session.echoGuardMs = 30;
  coord.notifyAssistantSpeaking('Bạn đã đi qua trọn bộ 4 bước. Có thể bấm Trước, Tiếp để xem lại từng bước hoặc hỏi thêm câu mới!');

  fakeRec.emit('quay lại', true);
  await sleep(35);
  assert.deepEqual(commands, [], 'tiếng loa không được điều khiển bước học');
  assert.equal(bargeIns, 0, 'tiếng loa không được ngắt walkthrough');
  assert.equal(coord.session.state, 'speaking');

  coord.notifyAssistantIdle();
  await sleep(45);
  fakeRec.emit('quay lại', true);
  await sleep(35);
  assert.deepEqual(commands, ['prev_step'], 'sau echo guard, lệnh quay lại thật phải hoạt động');
  coord.stopAll();
});

await testAsync('StemTutorUI._parseAICoachResponse xử lý đa bước JSON và đa dòng markdown', async () => {
  const tutor = new StemTutorUI({});
  const multiJson = tutor._parseAICoachResponse('```json\n{"title":"Bàn 3D","steps":[{"title":"B1","speech":"Thêm mặt bàn","pointAt":"#menu-add"},{"title":"B2","speech":"Scale mỏng","pointAt":"#tool-scale"},{"title":"B3","speech":"Gắn chân bàn","pointAt":"#tool-move"}]}\n```');
  assert.equal(multiJson.steps.length, 3);
  assert.equal(multiJson.steps[1].pointAt, '#tool-scale');

  const multiText = tutor._parseAICoachResponse('1. Mở menu Add để tạo Cube\n2. Dùng Scale (S) ép mỏng mặt bàn\n3. Nhân bản chân bàn bằng Shift+D');
  assert.equal(multiText.steps.length, 3);
});

await testAsync('StemTutorUI multi-step guideSteps chạy liên tục hết mọi bước không dừng ngang ở Bước 1', async () => {
  const tutor = new StemTutorUI({});
  const spokenHistory = [];
  tutor.voice = {
    enabled: true,
    rate: 2.0,
    prefetch: () => {},
    stop: () => {},
    speak: (text, opts = {}) => {
      spokenHistory.push(text);
      setTimeout(() => opts.onEnd?.(), 15);
      return { spoken: true, text };
    }
  };
  const shownTitles = [];
  tutor.setBubbleContent = ({ title } = {}) => {
    if (title) shownTitles.push(title);
  };

  const res = await tutor.askAICoach('Hướng dẫn tôi dựng cái bàn 3D', { speak: true, autoAdvance: true });
  assert.equal(res.ok, true);
  assert.ok(res.stepsCount >= 3, `expected >= 3 steps, got ${res.stepsCount}`);
  assert.equal(res.walkthroughActive, true);

  // Chờ chuỗi 4 bước chạy hết (offline speed + gap < 4.5s)
  for (let i = 0; i < 60 && tutor.isAutoWalking; i += 1) {
    await sleep(90);
  }
  assert.equal(tutor.isAutoWalking, false, 'walkthrough phải tự hoàn tất toàn bộ chuỗi');
  assert.ok(spokenHistory.length >= 4, `tất cả 4 bước đều phải được giảng liên tục, thấy ${spokenHistory.length}`);
  assert.ok(shownTitles.some((t) => /Hoàn tất 4\/4/i.test(t)));

  // Kiểm tra nextStep / prevStep sau khi hoàn tất AI guide
  const prevRes = await tutor.prevStep({ speak: false });
  assert.equal(prevRes.ok, true);
});

await testAsync('StemTutorUI.startLesson tự động đi hết toàn bộ 4 bước bài học khi autoAdvance bật', async () => {
  const tutor = new StemTutorUI({});
  const spokenSteps = [];
  tutor.voice = {
    enabled: true,
    rate: 2.0,
    prefetch: () => {},
    stop: () => {},
    speak: (text, opts = {}) => {
      spokenSteps.push(text);
      setTimeout(() => opts.onEnd?.(), 10);
      return { spoken: true, text };
    }
  };
  tutor.startLesson('lesson-01-primitives', { loadStarter: false, speak: true, guided: true, autoAdvance: true });
  assert.equal(tutor.isAutoWalking, true);

  for (let i = 0; i < 65 && tutor.isAutoWalking; i += 1) {
    await sleep(90);
  }
  assert.equal(tutor.isAutoWalking, false);
  assert.ok(spokenSteps.length >= 4, `bài học 4 bước phải đọc hết cả 4 bước + câu kết, thấy ${spokenSteps.length}`);
});

await testAsync('StemVoiceSession.extractQuery giữ nguyên hành vi chuẩn & studio.tutor.guideSteps tồn tại', async () => {
  assert.equal(StemVoiceSession.extractQuery('  Thầy ơi, bevel là gì  ', 'thầy ơi'), 'bevel là gì');
  assert.equal(typeof studio.tutor.guideSteps, 'function');
  assert.equal(typeof studio.tutor.stop, 'function');
});

await testAsync('Chống echo loa AI + biến thể nhận diện wake tiếng Việt + studio.tutor.guideSteps không dừng ở bước 1', async () => {
  // 1. Biến thể STT tiếng Việt
  const rCo = routeVoiceUtterance('co pilot ơi, dựng cái ghế', { requireWakeWord: true });
  assert.equal(rCo.target, 'copilot');
  assert.equal(rCo.query, 'dựng cái ghế');

  const rThay = routeVoiceUtterance('Thầy giáo ơi, hướng dẫn Bevel', { requireWakeWord: true });
  assert.equal(rThay.target, 'stem');
  assert.equal(rThay.query, 'hướng dẫn Bevel');

  // 2. Echo loa AI bị chặn, nhưng câu ngắt lời thật ('khoan đã') đi qua ngay
  const fake = new FakeRecognition();
  let submits = 0;
  let bargeIns = 0;
  const sess = new StemVoiceSession({
    recognitionFactory: () => fake,
    silenceMs: 12,
    onSubmit: () => { submits += 1; },
    onBargeIn: () => { bargeIns += 1; }
  });
  sess.start();
  sess.notifyAssistantSpeaking('Bước một bạn hãy bấm nút Extrude trên thanh công cụ');
  fake.emit('bấm nút extrude trên thanh', true);
  await sleep(30);
  assert.equal(bargeIns, 0, 'tiếng vọng từ loa AI không được kích hoạt barge-in');
  assert.equal(submits, 0, 'tiếng vọng từ loa AI không được gửi thành câu hỏi mới');

  fake.emit('khoan đã', false);
  assert.equal(bargeIns, 1, 'người dùng nói chen thật phải ngắt lời ngay');
  sess.stop();

  // 3. studio.tutor.guideSteps tự động bỏ qua autoAdvance: false do LLM sinh nhầm
  const tutor = new StemTutorUI({});
  tutor.voice = {
    enabled: true,
    rate: 2.0,
    prefetch: () => {},
    stop: () => {},
    speak: (_t, opts = {}) => {
      setTimeout(() => opts.onEnd?.(), 12);
      return { spoken: true };
    }
  };
  const g = typeof window !== 'undefined' ? window : globalThis;
  const prevTutor = g.stemTutor;
  if (typeof window !== 'undefined') window.stemTutor = tutor;
  try {
    if (typeof window !== 'undefined') {
      const walk = await studio.tutor.guideSteps([
        { title: 'B1', speech: 'Bước 1', pointAt: '#menu-add' },
        { title: 'B2', speech: 'Bước 2', pointAt: '#tool-scale' }
      ], { speak: true, autoAdvance: false });
      assert.equal(walk.walkthroughActive, true);
      tutor.stopWalkthrough({ stopVoice: true });
    }
  } finally {
    if (typeof window !== 'undefined') window.stemTutor = prevTutor;
  }
});

console.log('\nWake word, Voice routing, and Multi-step Walkthrough suite');

await testAsync('parseQuickVoiceCommand hiểu pause_walk mở rộng, resume_walk và maybeAutoStart opt-in chặt', async () => {
  assert.equal(parseQuickVoiceCommand('tạm dừng'), 'pause_walk');
  assert.equal(parseQuickVoiceCommand('đợi chút'), 'pause_walk');
  assert.equal(parseQuickVoiceCommand('nghỉ chút'), 'pause_walk');
  assert.equal(parseQuickVoiceCommand('tiếp tục'), 'resume_walk');
  assert.equal(parseQuickVoiceCommand('nói tiếp'), 'resume_walk');
  assert.equal(parseQuickVoiceCommand('tiếp tục hướng dẫn'), 'resume_walk');

  const fakeRec = new FakeRecognition();
  const coord = new VoiceWakeCoordinator({ recognitionFactory: () => fakeRec });
  coord.wakeEnabled = false;
  assert.equal(coord.maybeAutoStartOnAssistantOpen({ SpeechRecognition: function () { return fakeRec; } }), false, 'không được tự bật mic khi wakeEnabled=false');
  coord.stopAll();
});

await testAsync('StemTutorUI: pauseWalkthrough giữ nguyên chữ, resume tiếp bước, strip <think>, và huỷ askAICoach cũ khi hỏi/đổi bài mới', async () => {
  const tutor = new StemTutorUI({});
  tutor.voice = {
    enabled: true,
    rate: 1.5,
    isSpeaking: false,
    lastSpokenText: '',
    prefetch: () => {},
    stop: () => { tutor.voice.isSpeaking = false; },
    speak: (text, opts = {}) => {
      tutor.voice.isSpeaking = true;
      tutor.voice.lastSpokenText = text;
      setTimeout(() => { tutor.voice.isSpeaking = false; opts.onEnd?.({ failed: false }); }, 15);
      return { spoken: true, text };
    }
  };

  // 1. Strip <think> khỏi phản hồi Coach
  const stripped = tutor._parseAICoachResponse('<think>suy nghĩ nội bộ</think>\n```json\n{"title":"Vát cạnh","steps":[{"title":"B1","speech":"Chọn cạnh","pointAt":"#btn-mode-edge"}]}\n```');
  assert.equal(stripped?.title, 'Vát cạnh');
  assert.equal(stripped?.steps?.length, 1);

  // 2. pauseWalkthrough & resumeWalkthrough giữ đúng text hiện tại
  tutor.startLesson('lesson-01-primitives', { loadStarter: false, speak: false, guided: true, autoAdvance: true });
  const textBeforePause = tutor.currentBubbleText;
  tutor.pauseWalkthrough();
  assert.equal(tutor.isAutoWalking, false);
  assert.ok(tutor._pausedState, 'phải lưu snapshot để resume');
  assert.equal(tutor.currentBubbleText, textBeforePause, 'pauseWalkthrough không được xoá lời giảng đang đọc');
  assert.equal(tutor.resumeWalkthrough({ speak: false }), true);
  assert.equal(tutor.isAutoWalking, true);
  tutor.stopWalkthrough({ stopVoice: true });

  // 3. Stale askAICoach (mạng chậm) bị huỷ sạch khi học viên chọn bài mới
  const g = typeof window !== 'undefined' ? window : globalThis;
  const hadWin = 'window' in g;
  const prevWinFetch = g.window?.fetch;
  if (!hadWin) g.window = g;
  g.window.fetch = (_url, opts = {}) => new Promise((_, reject) => {
    opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
  });
  try {
    const oldReq = tutor.askAICoach('Hướng dẫn cũ chậm', { speak: true });
    tutor.startLesson('lesson-02-materials-lights', { loadStarter: false, speak: false, guided: false });
    const oldRes = await oldReq;
    assert.equal(oldRes.ok, false);
    assert.equal(oldRes.cancelled, true);
    assert.equal(tutor.activeLesson?.id, 'lesson-02-materials-lights', 'askAICoach cũ không được ghi đè bài học mới');
  } finally {
    if (prevWinFetch !== undefined) g.window.fetch = prevWinFetch;
    else delete g.window.fetch;
    if (!hadWin) delete g.window;
  }
});

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

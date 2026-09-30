// 효과음. 소리 파일 없이 WebAudio 로 그때그때 합성한다(교실 망에서 받을 파일이 없다).
// 브라우저는 사용자가 한 번 누르기 전에는 소리를 막으므로 첫 조작 때 오디오를 깨운다.
let ctx = null;
let master = null;
let on = true;
let volume = 0.5;
const lastPlayed = new Map();

// 소리마다 최소 간격(ms). 연달아 울려 시끄럽지 않게 한다.
const GAP = { type: 38, click: 60, ping: 400, nav: 180, alarm: 4000, think: 900 };

export function configure({ enabled, vol } = {}) {
  if (enabled !== undefined) on = Boolean(enabled);
  if (vol !== undefined) volume = Math.max(0, Math.min(1, Number(vol) || 0));
  if (master) master.gain.setTargetAtTime(volume * 0.9, ctx.currentTime, 0.02);
}

export const isEnabled = () => on;

function ensure() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume * 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 6;
    master.connect(comp).connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

for (const ev of ["pointerdown", "keydown"]) {
  window.addEventListener(ev, () => { if (on) ensure(); }, { capture: true, passive: true });
}

// ---------------------------------------------------------------- 합성 부품
function tone(t0, { type = "sine", freq = 440, to = null, dur = 0.15, gain = 0.2, attack = 0.006, release = 0.09, filter = null, detune = 0 } = {}) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
  if (detune) osc.detune.value = detune;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.setValueAtTime(gain, t0 + Math.max(attack, dur - release));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let node = osc;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = filter.type || "lowpass";
    f.frequency.value = filter.freq || 1200;
    f.Q.value = filter.q || 0.7;
    node.connect(f);
    node = f;
  }
  node.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

let noiseBuf = null;
function noise(t0, { dur = 0.3, gain = 0.08, type = "bandpass", freq = 800, to = null, q = 1.2 } = {}) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, t0);
  if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.35);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

// ---------------------------------------------------------------- 소리 목록
const SOUNDS = {
  // 스테이션 전환: 바람 소리 + 짧게 올라가는 음
  nav(t) {
    noise(t, { dur: 0.32, gain: 0.07, freq: 380, to: 2600, q: 0.9 });
    tone(t + 0.04, { type: "sine", freq: 520, to: 820, dur: 0.16, gain: 0.05 });
  },
  // 창 열기·닫기
  open(t) {
    tone(t, { type: "triangle", freq: 660, dur: 0.07, gain: 0.07 });
    tone(t + 0.06, { type: "triangle", freq: 990, dur: 0.1, gain: 0.07 });
  },
  close(t) {
    tone(t, { type: "triangle", freq: 880, to: 440, dur: 0.12, gain: 0.06 });
  },
  click(t) {
    tone(t, { type: "square", freq: 1900, dur: 0.028, gain: 0.025, attack: 0.002, release: 0.02, filter: { freq: 3200 } });
  },
  // 성공: 밝은 두 음
  ok(t) {
    tone(t, { type: "sine", freq: 880, dur: 0.18, gain: 0.1 });
    tone(t + 0.09, { type: "sine", freq: 1318.5, dur: 0.3, gain: 0.09 });
  },
  // 주의: 내려가는 두 음
  warn(t) {
    tone(t, { type: "triangle", freq: 660, dur: 0.14, gain: 0.09 });
    tone(t + 0.16, { type: "triangle", freq: 520, dur: 0.2, gain: 0.09 });
  },
  // 오류: 낮은 버저
  error(t) {
    tone(t, { type: "sawtooth", freq: 190, to: 140, dur: 0.28, gain: 0.07, filter: { freq: 900 } });
    tone(t, { type: "sawtooth", freq: 196, to: 144, dur: 0.28, gain: 0.05, filter: { freq: 900 }, detune: 12 });
  },
  // 경보(CONDITION RED): 짧은 사이렌 두 번
  alarm(t) {
    for (let i = 0; i < 2; i++) {
      const s = t + i * 0.46;
      tone(s, { type: "sawtooth", freq: 440, to: 330, dur: 0.4, gain: 0.07, filter: { freq: 1600 } });
      tone(s, { type: "square", freq: 220, to: 165, dur: 0.4, gain: 0.03, filter: { freq: 900 } });
    }
  },
  // 엘피 글자 찍힘
  type(t) {
    tone(t, { type: "square", freq: 2300 + Math.random() * 500, dur: 0.018, gain: 0.012, attack: 0.001, release: 0.012, filter: { type: "highpass", freq: 1500 } });
  },
  // 엘피가 말을 시작할 때: 반짝이는 아르페지오
  elfy(t) {
    [1046.5, 1318.5, 1568, 2093].forEach((f, i) => tone(t + i * 0.055, { type: "sine", freq: f, dur: 0.22, gain: 0.045 }));
  },
  // 엘피가 생각 중
  think(t) {
    tone(t, { type: "sine", freq: 330, to: 392, dur: 0.5, gain: 0.03, attack: 0.15, release: 0.3 });
  },
  // 제안 카드가 뜰 때: 주의를 끄는 세 음
  proposal(t) {
    tone(t, { type: "triangle", freq: 740, dur: 0.1, gain: 0.07 });
    tone(t + 0.11, { type: "triangle", freq: 988, dur: 0.1, gain: 0.07 });
    tone(t + 0.22, { type: "triangle", freq: 740, dur: 0.16, gain: 0.06 });
  },
  // 질문 보냄
  send(t) {
    noise(t, { dur: 0.12, gain: 0.04, freq: 1200, to: 4200, q: 1.4 });
    tone(t, { type: "sine", freq: 900, to: 1600, dur: 0.09, gain: 0.04 });
  },
  // 호출이 들어옴: 작은 소나 핑
  ping(t) {
    tone(t, { type: "sine", freq: 1250, to: 1150, dur: 0.22, gain: 0.025 });
    tone(t + 0.16, { type: "sine", freq: 1250, to: 1150, dur: 0.2, gain: 0.01 });
  },
  // 기동
  boot(t) {
    tone(t, { type: "sine", freq: 180, to: 1100, dur: 0.7, gain: 0.05, attack: 0.2 });
    noise(t + 0.1, { dur: 0.6, gain: 0.03, freq: 300, to: 3000 });
  },
};

export const SOUND_NAMES = Object.keys(SOUNDS);

export function play(name, { force = false } = {}) {
  if ((!on && !force) || !SOUNDS[name]) return;
  if (document.visibilityState === "hidden") return;
  const now = performance.now();
  const gap = GAP[name] ?? 70;
  if (now - (lastPlayed.get(name) || 0) < gap) return;
  lastPlayed.set(name, now);
  const c = ensure();
  if (!c || c.state !== "running") return;
  try { SOUNDS[name](c.currentTime + 0.005); } catch (e) { console.warn("효과음 실패", e); }
}

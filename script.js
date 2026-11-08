'use strict';

/* =========================================================
 * 1. 확률 로직 (DOM과 분리, Node에서도 검증 가능)
 * ========================================================= */

const cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto) || require('crypto').webcrypto;

// 0 이상 n 미만의 정수. 거절 샘플링으로 편향을 없앤다.
function randInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  let x;
  do {
    cryptoObj.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % n;
}

function chance(p) {
  return randInt(1000000) < p * 1000000;
}

// 홀/짝이 정해지면 그 안에서 눈금을 균등하게 고른다.
function pickFace(even) {
  const faces = even ? [2, 4, 6] : [1, 3, 5];
  return faces[randInt(3)];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 일반판: 10라운드마다 짝 4 / 홀 6. 짝 최대 2연속, 홀 최대 3연속.
const NORMAL = { deckSize: 10, evenCount: 4, maxEvenRun: 2, maxOddRun: 3 };

function createNormalGenerator() {
  let deck = [];
  let last = null;
  let run = 0;

  // 직전 덱의 마지막 연속 상태에 이어 붙여도 제한을 넘지 않는지 검사
  function fits(candidate) {
    let l = last;
    let r = run;
    for (const even of candidate) {
      r = even === l ? r + 1 : 1;
      l = even;
      if (r > (even ? NORMAL.maxEvenRun : NORMAL.maxOddRun)) return false;
    }
    return true;
  }

  function makeDeck() {
    const base = [];
    for (let i = 0; i < NORMAL.deckSize; i++) base.push(i < NORMAL.evenCount);
    for (;;) {
      const candidate = shuffle(base.slice());
      if (fits(candidate)) return candidate;
    }
  }

  return {
    next() {
      if (deck.length === 0) deck = makeDeck();
      const even = deck.shift();
      run = even === last ? run + 1 : 1;
      last = even;
      return pickFace(even);
    },
  };
}

// UPGRADE판: 50:50에서 시작해 연속될수록 같은 결과가 나올 확률을 낮춘다. 최대 4연속.
// 인덱스 = 현재 연속 횟수
const UPGRADE_REPEAT_P = [0.5, 0.5, 0.35, 0.15, 0];

function createUpgradeGenerator() {
  let last = null;
  let run = 0;

  return {
    next() {
      let even;
      if (last === null) {
        even = chance(0.5);
      } else {
        const p = UPGRADE_REPEAT_P[Math.min(run, UPGRADE_REPEAT_P.length - 1)];
        even = chance(p) ? last : !last;
      }
      run = even === last ? run + 1 : 1;
      last = even;
      return pickFace(even);
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { randInt, createNormalGenerator, createUpgradeGenerator, NORMAL, UPGRADE_REPEAT_P };
}

/* =========================================================
 * 2. 화면 동작
 * ========================================================= */

if (typeof document !== 'undefined') initApp();

function initApp() {
  const $ = (id) => document.getElementById(id);

  const ROLL_MS = 2000;
  const TICK_FROM_MS = 5000;
  const TICK_STEP_MS = 500;
  const DEFAULT_SEC = 30;
  const MIN_SEC = 1;
  const MAX_SEC = 600;
  const STORE_TIMER = 'oddEvenDice.timerSec';
  const STORE_MUTE = 'oddEvenDice.muted';

  const startScreen = $('startScreen');
  const gameScreen = $('gameScreen');
  const timerLabel = $('timerLabel');
  const timerDisplay = $('timerDisplay');
  const timeInput = $('timeInput');
  const minusBtn = $('minusBtn');
  const plusBtn = $('plusBtn');
  const presetBtns = document.querySelectorAll('[data-preset]');
  const startBtn = $('startBtn');
  const resetBtn = $('resetBtn');
  const muteBtn = $('muteBtn');
  const diceArea = $('diceArea');
  const dice = $('dice');
  const rollBtn = $('rollBtn');
  const sloganEl = $('slogan');

  function load(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 저장 불가 환경은 무시 */ }
  }

  /* ---------- 소리 (Web Audio API) ---------- */

  let audioCtx = null;
  let muted = load(STORE_MUTE) === '1';

  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function tone({ freq, endFreq, type = 'sine', at = 0, dur = 0.08, vol = 0.3 }) {
    if (muted) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  function playTick(high) {
    tone({ freq: high ? 1700 : 1150, type: 'square', dur: 0.05, vol: 0.12 });
  }

  function playAlarm() {
    tone({ freq: 880, type: 'square', at: 0, dur: 0.32, vol: 0.18 });
    tone({ freq: 1320, type: 'sine', at: 0, dur: 0.32, vol: 0.12 });
    tone({ freq: 880, type: 'square', at: 0.45, dur: 0.4, vol: 0.18 });
    tone({ freq: 1320, type: 'sine', at: 0.45, dur: 0.4, vol: 0.12 });
  }

  // 주사위가 튀어 바닥에 닿는 소리 (bounce 애니메이션의 착지 시점과 맞춤)
  function playRollSounds() {
    const s = ROLL_MS / 1000;
    [[0.28, 0.45], [0.54, 0.3], [0.74, 0.2]].forEach(([at, vol]) => {
      tone({ freq: 220, endFreq: 70, type: 'triangle', at: at * s, dur: 0.12, vol });
    });
  }

  function playLand() {
    tone({ freq: 1400, endFreq: 900, type: 'sine', dur: 0.1, vol: 0.2 });
  }

  function renderMute() {
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.setAttribute('aria-label', muted ? '소리 켜기' : '음소거');
  }

  function toggleMute() {
    muted = !muted;
    save(STORE_MUTE, muted ? '1' : '0');
    renderMute();
  }

  /* ---------- 카운트다운 타이머 ---------- */

  const timer = {
    duration: DEFAULT_SEC * 1000,
    remaining: DEFAULT_SEC * 1000,
    endAt: 0,
    running: false,
    ended: false,
    nextTick: 0,
    raf: 0,
  };

  let shownText = '';

  function timeText(ms) {
    if (ms > TICK_FROM_MS) return String(Math.ceil(ms / 1000));
    return (Math.ceil(ms / 100) / 10).toFixed(1);
  }

  function makeSlot(ch, animate) {
    const slot = document.createElement('span');
    slot.className = ch === '.' ? 'slot dot' : 'slot';
    const inner = document.createElement('span');
    inner.textContent = ch;
    if (animate) inner.className = 'in';
    slot.appendChild(inner);
    return slot;
  }

  function swapSlot(slot, ch, animate) {
    const inner = document.createElement('span');
    inner.textContent = ch;
    if (animate) {
      const old = slot.lastElementChild;
      old.className = 'out';
      setTimeout(() => old.remove(), 300);
      inner.className = 'in';
    } else {
      slot.textContent = '';
    }
    slot.appendChild(inner);
  }

  // 숫자가 위에서 아래로 한 칸씩 내려오는 표시. 소수점 아래 자리는 애니메이션 없이 바꾼다.
  function renderDigits(text, animate) {
    if (text === shownText) return;
    const prev = shownText;
    shownText = text;
    const dot = text.indexOf('.');

    if (prev.length !== text.length || !animate) {
      timerDisplay.textContent = '';
      for (const ch of text) timerDisplay.appendChild(makeSlot(ch, animate));
      return;
    }
    const slots = timerDisplay.children;
    for (let i = 0; i < text.length; i++) {
      if (prev[i] !== text[i]) swapSlot(slots[i], text[i], animate && (dot === -1 || i < dot));
    }
  }

  function renderTimer(animate) {
    renderDigits(timeText(timer.remaining), animate);
    const danger = timer.running && timer.remaining <= TICK_FROM_MS;
    timerDisplay.classList.toggle('danger', danger);
    timerDisplay.classList.toggle('ended', timer.ended);
  }

  function renderTimerControls() {
    startBtn.textContent = timer.running ? '❚❚ 일시정지' : '▶ 시작';
    startBtn.classList.toggle('active', timer.running);
    const lock = timer.running;
    [timeInput, minusBtn, plusBtn, ...presetBtns].forEach((el) => { el.disabled = lock; });
    timerLabel.textContent = timer.ended ? '베팅 마감!' : '⏱ 베팅할까? 말까? 토의 시간';
    timerLabel.classList.toggle('ended', timer.ended);
  }

  function setDuration(sec) {
    const value = Math.min(MAX_SEC, Math.max(MIN_SEC, Math.round(Number(sec)) || DEFAULT_SEC));
    timer.duration = value * 1000;
    timeInput.value = value;
    save(STORE_TIMER, String(value));
    resetTimer();
  }

  function resetTimer() {
    cancelAnimationFrame(timer.raf);
    timer.running = false;
    timer.ended = false;
    timer.remaining = timer.duration;
    renderTimer(false);
    renderTimerControls();
  }

  function startTimer() {
    if (timer.ended || timer.remaining <= 0) {
      timer.ended = false;
      timer.remaining = timer.duration;
      renderTimer(false);
    }
    timer.running = true;
    timer.endAt = performance.now() + timer.remaining;
    timer.nextTick = Math.min(TICK_FROM_MS, Math.floor(timer.remaining / TICK_STEP_MS) * TICK_STEP_MS);
    timer.raf = requestAnimationFrame(frame);
    renderTimerControls();
  }

  function pauseTimer() {
    cancelAnimationFrame(timer.raf);
    timer.running = false;
    timer.remaining = Math.max(0, timer.endAt - performance.now());
    renderTimer(false);
    renderTimerControls();
  }

  function toggleTimer() {
    if (timer.running) pauseTimer();
    else startTimer();
  }

  function finishTimer() {
    timer.running = false;
    timer.ended = true;
    timer.remaining = 0;
    renderTimer(true);
    renderTimerControls();
    playAlarm();
  }

  function frame(now) {
    if (!timer.running) return;
    const rem = Math.max(0, timer.endAt - now);
    timer.remaining = rem;

    // 5.0초부터 0.5초마다 틱/톡 번갈아 재생. 탭이 멈췄다 돌아와도 밀린 소리는 몰아서 내지 않는다.
    if (timer.nextTick > 0 && rem <= timer.nextTick) {
      playTick((timer.nextTick / TICK_STEP_MS) % 2 === 0);
      do timer.nextTick -= TICK_STEP_MS;
      while (timer.nextTick > 0 && timer.nextTick >= rem);
    }

    if (rem <= 0) {
      finishTimer();
      return;
    }
    renderTimer(true);
    timer.raf = requestAnimationFrame(frame);
  }

  /* ---------- 3D 주사위 ---------- */

  // 3×3 칸 번호(1~9)로 나타낸 눈 위치
  const PIPS = {
    1: [5],
    2: [3, 7],
    3: [3, 5, 7],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9],
  };

  // 각 눈이 정면을 향하게 하는 주사위 회전값 [X, Y]
  const FACE_ROT = {
    1: [0, 0],
    2: [0, -90],
    3: [-90, 0],
    4: [90, 0],
    5: [0, 90],
    6: [0, 180],
  };

  function buildDice() {
    // 둥근 면 모서리 사이로 배경이 비치지 않게 안쪽을 채우는 조금 작은 정육면체
    for (let n = 1; n <= 6; n++) {
      const core = document.createElement('div');
      core.className = `core f${n}`;
      dice.appendChild(core);
    }
    for (let n = 1; n <= 6; n++) {
      const face = document.createElement('div');
      face.className = `face f${n}`;
      for (const cell of PIPS[n]) {
        const pip = document.createElement('span');
        pip.className = 'pip';
        pip.style.gridRow = String(Math.ceil(cell / 3));
        pip.style.gridColumn = String(((cell - 1) % 3) + 1);
        face.appendChild(pip);
      }
      dice.appendChild(face);
    }
  }

  const rot = { x: 0, y: 0, z: 0 };
  let generator = null;
  let rolling = false;

  // cur 이후에서 base와 같은 방향이 되는 각도 + turns 바퀴
  function spinTo(cur, base, turns) {
    const k = Math.ceil((cur - base) / 360);
    return base + 360 * (k + turns);
  }

  function roll() {
    if (rolling || !generator) return;
    rolling = true;
    rollBtn.disabled = true;
    rollBtn.textContent = '🎲 굴러가는 중...';

    const value = generator.next();
    const [bx, by] = FACE_ROT[value];
    rot.x = spinTo(rot.x, bx, 2 + randInt(3));
    rot.y = spinTo(rot.y, by, 2 + randInt(3));
    rot.z += 360 * (1 + randInt(2));
    dice.style.transform = `rotateX(${rot.x}deg) rotateY(${rot.y}deg) rotateZ(${rot.z}deg)`;

    diceArea.classList.remove('rolling');
    void diceArea.offsetWidth; // 애니메이션 재시작
    diceArea.classList.add('rolling');
    playRollSounds();

    setTimeout(() => {
      rolling = false;
      diceArea.classList.remove('rolling');
      rollBtn.disabled = false;
      rollBtn.textContent = '🎲 주사위 굴리기';
      playLand();
    }, ROLL_MS);
  }

  /* ---------- 하단 슬로건 순환 ---------- */

  const SLOGANS = [
    '💀 도박은 반드시 잃는 게임입니다',
    '⚠️ 한 번의 클릭이 중독의 시작',
    '📞 도박 문제 상담: 1336 (한국도박문제예방치유원)',
    '🚫 도박 안돼! 절대금지! 🚫',
  ];
  let sloganIdx = 0;

  function rotateSlogan() {
    sloganIdx = (sloganIdx + 1) % SLOGANS.length;
    sloganEl.classList.remove('show');
    void sloganEl.offsetWidth;
    sloganEl.textContent = SLOGANS[sloganIdx];
    sloganEl.classList.add('show');
  }

  /* ---------- 시작 화면 / 이벤트 ---------- */

  function startGame(mode) {
    ensureAudio();
    generator = mode === 'upgrade' ? createUpgradeGenerator() : createNormalGenerator();
    startScreen.hidden = true;
    gameScreen.hidden = false;
  }

  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => startGame(btn.dataset.mode));
  });

  minusBtn.addEventListener('click', () => setDuration(timer.duration / 1000 - 5));
  plusBtn.addEventListener('click', () => setDuration(timer.duration / 1000 + 5));
  presetBtns.forEach((btn) => btn.addEventListener('click', () => setDuration(btn.dataset.preset)));
  timeInput.addEventListener('change', () => setDuration(timeInput.value));
  startBtn.addEventListener('click', toggleTimer);
  resetBtn.addEventListener('click', resetTimer);
  muteBtn.addEventListener('click', toggleMute);
  rollBtn.addEventListener('click', roll);

  // 버튼에 포커스가 남아 Space가 그 버튼을 다시 누르는 일을 막는다
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) btn.blur();
  });

  // 브라우저는 첫 사용자 입력 전에는 소리를 막으므로 첫 입력에서 오디오를 켠다
  document.addEventListener('pointerdown', ensureAudio, { once: true });

  document.addEventListener('keydown', (e) => {
    if (gameScreen.hidden) return;
    if (e.target === timeInput) {
      if (e.key === 'Enter') timeInput.blur();
      return;
    }
    if (e.repeat) return;
    // e.code를 써서 한글 입력 상태에서도 단축키가 동작하게 한다
    switch (e.code) {
      case 'Space': e.preventDefault(); roll(); break;
      case 'KeyT': toggleTimer(); break;
      case 'KeyR': resetTimer(); break;
      case 'KeyM': toggleMute(); break;
      default: return;
    }
    ensureAudio();
  });

  buildDice();
  renderMute();
  setDuration(load(STORE_TIMER) || DEFAULT_SEC);
  setInterval(rotateSlogan, 3500);
}

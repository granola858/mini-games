/**
 * 貓咪跳箱（Cat Agility）— Flappy Bird 變體
 *
 * 內部一律使用 360×640 虛擬座標，畫布緩衝區再依 devicePixelRatio 放大。
 * 物理以固定 60 步／秒推進（數值單位是 px/frame），高更新率螢幕靠插值補畫面。
 * 結構：Store（持久化）→ Sound（Web Audio 合成）→ Controller（狀態機與物理）→ Renderer（純向量繪製）。
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // 常數
  // ---------------------------------------------------------------------------
  const VIEW_W = 360;
  const VIEW_H = 640;
  const GROUND_H = 60;
  const GROUND_Y = VIEW_H - GROUND_H;
  const BASEBOARD_H = 16;
  const STEP_MS = 1000 / 60;
  const MAX_STEPS_PER_FRAME = 5;
  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;

  const PHYSICS = Object.freeze({
    gravity: 0.38,
    jump: -6.8,
    maxFall: 9,
    tiltUp: -20,
    tiltDown: 70
  });

  const PIPE = Object.freeze({
    speed: 2.2,
    spawnEvery: 100,
    firstDelay: 60,
    gap: 145,
    minCenter: 150,
    maxCenter: 480,
    width: 64,
    postWidth: 50,
    capHeight: 18,
    ropeSpacing: 8
  });

  const CAT = Object.freeze({ x: 100, readyY: 280, radius: 14, ceiling: 16 });

  // 9 幀 ≈ 150ms
  const SHAKE = Object.freeze({ frames: 9, amplitude: 4 });
  const RESTART_LOCK_MS = 400;
  const PANEL_DELAY = 12;
  // 暫停面板高 130：貓在上半部（y < 300）就放到下方，否則放到分數下方；
  // 兩個位置都與貓的繪製範圍（約 ±30）保持距離
  const PAUSE_PANEL = Object.freeze({ height: 130, flipAt: 300, above: 130, below: 360 });
  const SCARED_SPEED = 7.2;
  const DECOR_GAP = 240;

  const INK = '#5A3A22';
  const WOOD = '#8B5A2B';
  const SISAL = '#D2B48C';
  const EAR_PINK = '#FFB6C1';
  const EYE_GREEN = '#98FB98';
  const EYE_GOLD = '#FFD700';
  const FONT = '"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif';

  const STORAGE_KEYS = Object.freeze({
    stats: 'cat-agility_stats_v1',
    state: 'cat-agility_state_v1',
    pref: 'cat-agility_pref_v1'
  });

  const ACTION_KEYS = new Set(['Space', 'ArrowUp', 'KeyW']);

  const State = Object.freeze({
    READY: 'READY',
    PLAYING: 'PLAYING',
    PAUSED: 'PAUSED',
    GAMEOVER: 'GAMEOVER'
  });

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (min, max) => min + Math.random() * (max - min);
  const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
  const now = () => performance.now();

  // ---------------------------------------------------------------------------
  // Store：localStorage 一律包 try...catch（隱私模式、壞 JSON 都不能讓遊戲掛掉）
  // ---------------------------------------------------------------------------
  const Store = {
    read(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    },
    write(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (_) {}
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch (_) {}
    }
  };

  // ---------------------------------------------------------------------------
  // Sound：AudioContext 的建立、手勢解鎖與節點回收交給共用的 BoboAudio
  // ---------------------------------------------------------------------------
  const Sound = (() => {
    const kit = (typeof BoboAudio !== 'undefined' && BoboAudio)
      ? BoboAudio.create({ storageKey: STORAGE_KEYS.pref, storageField: 'sound' })
      : null;

    const jump = () => {
      if (!kit) return;
      kit.sweep({ type: 'sine', from: 400, to: 800, duration: 0.1, gain: 0.16 });
    };

    const score = () => {
      if (!kit) return;
      kit.chord([987, 1318], { type: 'sine', duration: 0.15, gain: 0.08, attack: 0.004 });
    };

    const hit = () => {
      if (!kit || !kit.enabled) return;
      kit.noise({ duration: 0.28, gain: 0.2, filter: { type: 'lowpass', frequency: 2600, to: 160 } });

      // 鋸齒波要經過低通濾波，現成原語表達不出來，改走 BoboAudio 的 context 逃生口
      const audio = kit.context();
      const out = kit.destination();
      if (!audio || !out) return;
      try {
        const t0 = audio.currentTime;
        const osc = audio.createOscillator();
        const lowpass = audio.createBiquadFilter();
        const amp = audio.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(250, t0);
        osc.frequency.exponentialRampToValueAtTime(60, t0 + 0.3);
        lowpass.type = 'lowpass';
        lowpass.frequency.setValueAtTime(1600, t0);
        lowpass.frequency.exponentialRampToValueAtTime(200, t0 + 0.32);
        amp.gain.setValueAtTime(0.16, t0);
        amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
        osc.connect(lowpass);
        lowpass.connect(amp);
        amp.connect(out);
        osc.onended = () => {
          try {
            osc.disconnect();
            lowpass.disconnect();
            amp.disconnect();
          } catch (_) {}
        };
        osc.start(t0);
        osc.stop(t0 + 0.35);
      } catch (_) {}
    };

    return {
      available: !!kit,
      jump,
      score,
      hit,
      enabled: () => (kit ? kit.enabled : false),
      toggle: () => (kit ? kit.toggle() : false)
    };
  })();

  // ---------------------------------------------------------------------------
  // 遊戲模型
  // ---------------------------------------------------------------------------
  const cat = {
    y: CAT.readyY,
    prevY: CAT.readyY,
    vy: 0,
    rot: 0,
    prevRot: 0,
    tail: 0,
    tailVel: 0
  };

  const game = {
    state: State.READY,
    tick: 0,
    idle: 0,
    score: 0,
    best: 0,
    plays: 0,
    isNewBest: false,
    scroll: 0,
    prevScroll: 0,
    spawnTimer: 0,
    shake: 0,
    overTicks: 0,
    gameOverAt: 0,
    grounded: false,
    pipes: [],
    effects: [],
    motes: []
  };

  // ---------------------------------------------------------------------------
  // 持久化：戰績、進行中局況
  // ---------------------------------------------------------------------------
  function loadStats() {
    const data = Store.read(STORAGE_KEYS.stats);
    const valid = (value) => isNum(value) && value >= 0;
    game.best = data && valid(data.best) ? Math.floor(data.best) : 0;
    game.plays = data && valid(data.plays) ? Math.floor(data.plays) : 0;
  }

  function saveStats() {
    Store.write(STORAGE_KEYS.stats, { best: game.best, plays: game.plays });
  }

  function saveGameState() {
    if (game.state !== State.PLAYING && game.state !== State.PAUSED) return;
    Store.write(STORAGE_KEYS.state, {
      v: 1,
      score: game.score,
      scroll: game.scroll,
      spawnTimer: game.spawnTimer,
      cat: { y: cat.y, vy: cat.vy, rot: cat.rot },
      pipes: game.pipes.map((pipe) => ({ x: pipe.x, gapY: pipe.gapY, passed: pipe.passed }))
    });
  }

  function loadGameState() {
    const saved = Store.read(STORAGE_KEYS.state);
    if (!saved) return false;

    const validPipe = (pipe) => pipe && isNum(pipe.x) && isNum(pipe.gapY)
      && pipe.gapY >= PIPE.minCenter && pipe.gapY <= PIPE.maxCenter;
    const valid = saved.v === 1
      && isNum(saved.score) && saved.score >= 0
      && isNum(saved.scroll) && isNum(saved.spawnTimer)
      && saved.cat && isNum(saved.cat.y) && isNum(saved.cat.vy) && isNum(saved.cat.rot)
      && Array.isArray(saved.pipes) && saved.pipes.length <= 8 && saved.pipes.every(validPipe);
    if (!valid) {
      clearGameState();
      return false;
    }

    game.state = State.PAUSED;
    game.score = Math.floor(saved.score);
    game.scroll = game.prevScroll = Math.max(0, saved.scroll);
    game.spawnTimer = clamp(saved.spawnTimer, 0, PIPE.spawnEvery);
    game.pipes = saved.pipes.map((pipe) => {
      const x = clamp(pipe.x, -PIPE.width, VIEW_W + PIPE.width);
      return { x, prevX: x, gapY: pipe.gapY, passed: pipe.passed === true };
    });
    cat.y = cat.prevY = clamp(saved.cat.y, CAT.ceiling, GROUND_Y - CAT.radius - 1);
    cat.vy = clamp(saved.cat.vy, PHYSICS.jump, PHYSICS.maxFall);
    cat.rot = cat.prevRot = clamp(saved.cat.rot, PHYSICS.tiltUp, PHYSICS.tiltDown);
    return true;
  }

  function clearGameState() {
    Store.remove(STORAGE_KEYS.state);
  }

  // ---------------------------------------------------------------------------
  // Controller：所有輸入都只走 triggerAction()
  // ---------------------------------------------------------------------------
  function triggerAction() {
    switch (game.state) {
      case State.READY:
        startRun();
        flap();
        break;
      case State.PLAYING:
        flap();
        break;
      case State.PAUSED:
        game.state = State.PLAYING;
        announce('');
        flap();
        break;
      case State.GAMEOVER:
        if (now() - game.gameOverAt >= RESTART_LOCK_MS) resetToReady();
        break;
      default:
        break;
    }
  }

  function startRun() {
    clearGameState();
    game.state = State.PLAYING;
    game.score = 0;
    game.isNewBest = false;
    game.grounded = false;
    game.pipes.length = 0;
    game.spawnTimer = PIPE.spawnEvery - PIPE.firstDelay;
  }

  function flap() {
    cat.vy = PHYSICS.jump;
    spawnJumpDust();
    Sound.jump();
  }

  function resetToReady() {
    game.state = State.READY;
    game.score = 0;
    game.idle = 0;
    game.shake = 0;
    game.pipes.length = 0;
    game.effects.length = 0;
    cat.y = cat.prevY = CAT.readyY;
    cat.vy = 0;
    cat.rot = cat.prevRot = 0;
    cat.tail = 0;
    cat.tailVel = 0;
    announce('');
  }

  function pause() {
    if (game.state !== State.PLAYING) return;
    game.state = State.PAUSED;
    saveGameState();
    announce('遊戲已暫停，點擊畫面或按空白鍵繼續');
  }

  function gameOver() {
    game.state = State.GAMEOVER;
    game.gameOverAt = now();
    game.overTicks = 0;
    game.shake = reduceMotion ? 0 : SHAKE.frames;
    cat.vy = Math.max(cat.vy, 0);
    game.grounded = cat.y + CAT.radius >= GROUND_Y - 0.5;
    spawnBurst(CAT.x, cat.y);
    Sound.hit();

    game.plays += 1;
    game.isNewBest = game.score > game.best;
    if (game.isNewBest) game.best = game.score;
    saveStats();
    clearGameState();
    announce(`遊戲結束，本次 ${game.score} 分，最佳紀錄 ${game.best} 分`);
  }

  // ---------------------------------------------------------------------------
  // 每一步（1/60 秒）的模擬
  // ---------------------------------------------------------------------------
  function update() {
    game.tick += 1;
    cat.prevY = cat.y;
    cat.prevRot = cat.rot;
    game.prevScroll = game.scroll;
    for (const pipe of game.pipes) pipe.prevX = pipe.x;

    updateMotes();
    updateEffects();

    if (game.state === State.READY) updateReady();
    else if (game.state === State.PLAYING) updatePlaying();
    else if (game.state === State.GAMEOVER) updateGameOver();
  }

  function updateReady() {
    game.idle += 1;
    cat.y = CAT.readyY + Math.sin(game.idle * 0.06) * 8;
    cat.vy = 0;
    cat.rot += (0 - cat.rot) * 0.1;
    game.scroll += PIPE.speed;
    updateTail(Math.sin(game.idle * 0.045) * 10);
  }

  function updatePlaying() {
    cat.vy = Math.min(cat.vy + PHYSICS.gravity, PHYSICS.maxFall);
    cat.y += cat.vy;
    if (cat.y < CAT.ceiling) {
      cat.y = CAT.ceiling;
      cat.vy = Math.max(cat.vy, 0);
    }
    updateTilt();
    updateTail(-cat.vy * 3);
    game.scroll += PIPE.speed;
    updatePipes();

    if (cat.y + CAT.radius >= GROUND_Y) {
      cat.y = GROUND_Y - CAT.radius;
      gameOver();
    } else if (game.pipes.some(hitsPipe)) {
      gameOver();
    }
  }

  function updateGameOver() {
    game.overTicks += 1;
    if (game.shake > 0) game.shake -= 1;
    if (!game.grounded) {
      cat.vy = Math.min(cat.vy + PHYSICS.gravity, PHYSICS.maxFall);
      cat.y += cat.vy;
      if (cat.y + CAT.radius >= GROUND_Y) {
        cat.y = GROUND_Y - CAT.radius;
        cat.vy = 0;
        game.grounded = true;
      }
      updateTilt();
    }
    updateTail(0);
  }

  // 上升時快速抬頭；下墜時依速度平方插值，先維持水平再加速俯衝
  function updateTilt() {
    if (cat.vy < 0) {
      cat.rot += (PHYSICS.tiltUp - cat.rot) * 0.35;
      return;
    }
    const t = clamp(cat.vy / PHYSICS.maxFall, 0, 1);
    const target = lerp(PHYSICS.tiltUp, PHYSICS.tiltDown, t * t);
    cat.rot += (target - cat.rot) * 0.12;
  }

  // 彈簧追目標值，讓尾巴比身體慢半拍
  function updateTail(target) {
    cat.tailVel += (clamp(target, -18, 18) - cat.tail) * 0.08;
    cat.tailVel *= 0.8;
    cat.tail += cat.tailVel;
  }

  function spawnPipe() {
    const x = VIEW_W + 4;
    game.pipes.push({ x, prevX: x, gapY: rand(PIPE.minCenter, PIPE.maxCenter), passed: false });
  }

  function updatePipes() {
    game.spawnTimer += 1;
    if (game.spawnTimer >= PIPE.spawnEvery) {
      game.spawnTimer = 0;
      spawnPipe();
    }
    for (let i = game.pipes.length - 1; i >= 0; i--) {
      const pipe = game.pipes[i];
      pipe.x -= PIPE.speed;
      if (!pipe.passed && pipe.x + PIPE.width / 2 < CAT.x) {
        pipe.passed = true;
        game.score += 1;
        Sound.score();
      }
      if (pipe.x + PIPE.width < -SHAKE.amplitude) game.pipes.splice(i, 1);
    }
  }

  function circleHitsRect(x, y, w, h) {
    const dx = CAT.x - clamp(CAT.x, x, x + w);
    const dy = cat.y - clamp(cat.y, y, y + h);
    return dx * dx + dy * dy < CAT.radius * CAT.radius;
  }

  // 柱身與頂蓋分開判定：頂蓋比柱身寬，合成一個大矩形會讓擦邊變得不公平
  function hitsPipe(pipe) {
    const top = pipe.gapY - PIPE.gap / 2;
    const bottom = pipe.gapY + PIPE.gap / 2;
    const postX = pipe.x + (PIPE.width - PIPE.postWidth) / 2;
    return circleHitsRect(postX, -VIEW_H, PIPE.postWidth, top + VIEW_H)
      || circleHitsRect(pipe.x, top - PIPE.capHeight, PIPE.width, PIPE.capHeight)
      || circleHitsRect(postX, bottom, PIPE.postWidth, GROUND_Y - bottom)
      || circleHitsRect(pipe.x, bottom, PIPE.width, PIPE.capHeight);
  }

  // ---------------------------------------------------------------------------
  // 粒子
  // ---------------------------------------------------------------------------
  function spawnJumpDust() {
    const count = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) {
      const life = Math.round(rand(24, 36));
      game.effects.push({
        kind: 'paw',
        layer: 'back',
        x: CAT.x - 12 + rand(-3, 3),
        y: cat.y + 8 + rand(-3, 3),
        vx: -rand(1.2, 3),
        vy: rand(0.2, 1.8),
        gravity: 0.03,
        drag: 0.96,
        size: rand(2.6, 4.2),
        rot: rand(-0.6, 0.6),
        spin: rand(-0.05, 0.05),
        life,
        maxLife: life,
        alpha: 0.7,
        color: '#FFFFFF'
      });
    }
  }

  function spawnBurst(x, y) {
    const palette = ['#FFFFFF', EYE_GOLD, EAR_PINK];
    for (let i = 0; i < 10; i++) {
      const angle = (i / 10) * TAU + rand(-0.2, 0.2);
      const speed = rand(2.4, 4.6);
      const life = Math.round(rand(40, 60));
      game.effects.push({
        kind: i % 2 ? 'star' : 'paw',
        layer: 'front',
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1,
        gravity: 0.08,
        drag: 0.97,
        size: rand(4.5, 7),
        rot: rand(0, TAU),
        spin: rand(-0.15, 0.15),
        life,
        maxLife: life,
        alpha: 1,
        color: palette[i % palette.length]
      });
    }
  }

  function updateEffects() {
    for (let i = game.effects.length - 1; i >= 0; i--) {
      const fx = game.effects[i];
      fx.vx *= fx.drag;
      fx.vy = fx.vy * fx.drag + fx.gravity;
      fx.x += fx.vx;
      fx.y += fx.vy;
      fx.rot += fx.spin;
      fx.life -= 1;
      if (fx.life <= 0) game.effects.splice(i, 1);
    }
  }

  function makeMote(anywhere) {
    return {
      x: rand(0, VIEW_W),
      y: anywhere ? rand(0, GROUND_Y) : GROUND_Y + rand(4, 30),
      r: rand(1.2, 3),
      vy: -rand(0.15, 0.4),
      phase: rand(0, TAU),
      sway: rand(0.06, 0.16),
      alpha: rand(0.3, 0.6)
    };
  }

  // 環境微塵數量固定，飄出頂端就從地板重生，不會累積
  function createMotes() {
    const count = 6 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i++) game.motes.push(makeMote(true));
  }

  function updateMotes() {
    for (const mote of game.motes) {
      mote.phase += 0.02;
      mote.x += Math.sin(mote.phase) * mote.sway;
      mote.y += mote.vy;
      if (mote.y < -6) Object.assign(mote, makeMote(false));
    }
  }

  // ---------------------------------------------------------------------------
  // Renderer
  // ---------------------------------------------------------------------------
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const soundBtn = document.getElementById('sound-btn');
  const statusEl = document.getElementById('game-status');
  const view = { sx: 0, sy: 0 };

  const reduceMotion = (() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) {
      return false;
    }
  })();

  // 漸層只建一次；各自以「繪製當下的區域座標」定義，使用前先 translate 到對應位置
  const paint = (() => {
    const addStops = (gradient, stops) => {
      stops.forEach(([at, color]) => gradient.addColorStop(at, color));
      return gradient;
    };
    const linear = (x0, y0, x1, y1, stops) => addStops(ctx.createLinearGradient(x0, y0, x1, y1), stops);
    const radial = (x0, y0, r0, x1, y1, r1, stops) => addStops(ctx.createRadialGradient(x0, y0, r0, x1, y1, r1), stops);
    return {
      wall: linear(0, 0, 0, GROUND_Y, [[0, '#FFDCCB'], [0.5, '#FFE9D8'], [1, '#FFF4E4']]),
      floor: linear(0, GROUND_Y, 0, VIEW_H, [[0, '#C68A55'], [1, '#9E6538']]),
      post: linear(0, 0, PIPE.postWidth, 0, [[0, '#E6CFA8'], [0.4, SISAL], [1, '#B48F62']]),
      cap: linear(0, 0, 0, PIPE.capHeight, [[0, '#A5733F'], [1, '#76481F']]),
      sky: linear(0, 0, 0, 120, [[0, '#BFE3FF'], [1, '#EAF6FF']]),
      body: radial(-9, -3, 1, -5, 3, 18, [[0, '#474747'], [0.55, '#1A1A1A'], [1, '#050505']]),
      head: radial(5, -10, 1, 9.5, -4.5, 13, [[0, '#4C4C4C'], [0.5, '#1C1C1C'], [1, '#060606']]),
      eye: radial(-0.8, -1.2, 0.3, 0, 0, 4.4, [[0, EYE_GOLD], [1, EYE_GREEN]])
    };
  })();

  function roundRectPath(x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function drawText(str, x, y, opts) {
    const { size, weight = 900, fill, stroke = null, strokeWidth = 0, align = 'center' } = opts;
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    if (stroke && strokeWidth) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = stroke;
      ctx.strokeText(str, x, y);
    }
    ctx.fillStyle = fill;
    ctx.fillText(str, x, y);
  }

  function render(alpha) {
    if (!view.sx || !view.sy) return;
    ctx.setTransform(view.sx, 0, 0, view.sy, 0, 0);
    ctx.save();
    if (game.shake > 0) {
      ctx.translate(rand(-SHAKE.amplitude, SHAKE.amplitude), rand(-SHAKE.amplitude, SHAKE.amplitude));
    }

    const scroll = lerp(game.prevScroll, game.scroll, alpha);
    drawWall(scroll);
    drawMotes();
    drawPipes(alpha);
    drawFloor(scroll);
    drawEffects('back');
    drawCat(CAT.x, lerp(cat.prevY, cat.y, alpha), lerp(cat.prevRot, cat.rot, alpha), cat.tail, catMood());
    drawEffects('front');
    drawOverlay();
    ctx.restore();
  }

  function catMood() {
    if (game.state === State.GAMEOVER) return 'dizzy';
    if (game.state === State.PLAYING && cat.vy > SCARED_SPEED) return 'scared';
    return 'normal';
  }

  // --- 背景：客廳牆面、壁紙、窗戶與踢腳板 ------------------------------------
  function drawWall(scroll) {
    const bleed = SHAKE.amplitude * 2;
    ctx.fillStyle = paint.wall;
    ctx.fillRect(-bleed, -bleed, VIEW_W + bleed * 2, GROUND_Y + bleed);

    // 壁紙與擺設以 1/4 速度移動，做出遠景視差
    const drift = scroll * 0.25;
    const stripe = 36;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    for (let x = -(drift % stripe) - stripe; x < VIEW_W + stripe; x += stripe) {
      ctx.fillRect(x, -bleed, 14, GROUND_Y + bleed);
    }
    drawDecor(drift);

    const top = GROUND_Y - BASEBOARD_H;
    ctx.fillStyle = '#FFF8EF';
    ctx.fillRect(-bleed, top, VIEW_W + bleed * 2, BASEBOARD_H);
    ctx.fillStyle = '#E9CFB8';
    ctx.fillRect(-bleed, top, VIEW_W + bleed * 2, 3);
    ctx.fillStyle = 'rgba(120, 72, 36, 0.12)';
    ctx.fillRect(-bleed, GROUND_Y - 3, VIEW_W + bleed * 2, 3);
  }

  function drawDecor(drift) {
    const first = Math.floor(drift / DECOR_GAP) - 1;
    for (let i = first; i <= first + 3; i++) {
      const x = i * DECOR_GAP - drift + 200;
      if (x > VIEW_W + 20 || x < -130) continue;
      if (((i % 2) + 2) % 2 === 0) drawWindow(x, 226);
      else drawPicture(x + 16, 118);
    }
  }

  function drawWindow(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = '#C99A70';
    ctx.fillRect(-16, -16, 128, 4);
    ctx.fillStyle = '#FFFFFF';
    roundRectPath(-6, -6, 108, 132, 10);
    ctx.fill();
    ctx.fillStyle = paint.sky;
    roundRectPath(0, 0, 96, 120, 6);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.beginPath();
    ctx.moveTo(35, 34);
    ctx.arc(26, 34, 9, 0, TAU);
    ctx.moveTo(50, 30);
    ctx.arc(38, 30, 12, 0, TAU);
    ctx.moveTo(60, 35);
    ctx.arc(52, 35, 8, 0, TAU);
    ctx.fill();

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(46, 0, 4, 120);
    ctx.fillRect(0, 58, 96, 4);

    ctx.fillStyle = '#FFC4B0';
    ctx.beginPath();
    ctx.moveTo(-12, -12);
    ctx.lineTo(22, -12);
    ctx.quadraticCurveTo(8, 60, 18, 126);
    ctx.lineTo(-12, 126);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(108, -12);
    ctx.lineTo(74, -12);
    ctx.quadraticCurveTo(88, 60, 78, 126);
    ctx.lineTo(108, 126);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#F1D6BF';
    roundRectPath(-14, 122, 124, 9, 4);
    ctx.fill();
    ctx.restore();
  }

  function drawPicture(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = '#C8956B';
    roundRectPath(0, 0, 64, 52, 4);
    ctx.fill();
    ctx.fillStyle = '#FFF3E1';
    ctx.fillRect(5, 5, 54, 42);
    ctx.fillStyle = '#FFD27A';
    ctx.beginPath();
    ctx.arc(20, 18, 6, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#A9D3A0';
    ctx.beginPath();
    ctx.moveTo(5, 47);
    ctx.quadraticCurveTo(24, 26, 40, 40);
    ctx.quadraticCurveTo(50, 30, 59, 38);
    ctx.lineTo(59, 47);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawMotes() {
    ctx.fillStyle = '#FFFFFF';
    for (const mote of game.motes) {
      ctx.globalAlpha = mote.alpha;
      ctx.beginPath();
      ctx.arc(mote.x, mote.y, mote.r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // --- 木地板：條紋與接縫跟著障礙物等速捲動 ---------------------------------------
  function drawFloor(scroll) {
    const bleed = SHAKE.amplitude * 2;
    ctx.fillStyle = paint.floor;
    ctx.fillRect(-bleed, GROUND_Y, VIEW_W + bleed * 2, GROUND_H + bleed);
    ctx.fillStyle = 'rgba(255, 226, 190, 0.35)';
    ctx.fillRect(-bleed, GROUND_Y, VIEW_W + bleed * 2, 2);

    const rowH = GROUND_H / 3;
    const plank = 96;

    ctx.beginPath();
    for (let row = 1; row < 3; row++) {
      const y = GROUND_Y + row * rowH;
      ctx.moveTo(-bleed, y);
      ctx.lineTo(VIEW_W + bleed, y);
    }
    for (let row = 0; row < 3; row++) {
      const y0 = GROUND_Y + row * rowH + 2;
      const offset = (scroll + row * 37) % plank;
      for (let x = -offset; x < VIEW_W + bleed; x += plank) {
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y0 + rowH - 4);
      }
    }
    ctx.strokeStyle = 'rgba(84, 48, 20, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    for (let row = 0; row < 3; row++) {
      const y = GROUND_Y + row * rowH + rowH / 2;
      const offset = (scroll + row * 37) % plank;
      for (let x = -offset; x < VIEW_W + bleed; x += plank) {
        ctx.moveTo(x + 16, y - 2);
        ctx.lineTo(x + 50, y - 2);
        ctx.moveTo(x + 58, y + 3);
        ctx.lineTo(x + 82, y + 3);
      }
    }
    ctx.strokeStyle = 'rgba(255, 230, 200, 0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // --- 貓抓柱 --------------------------------------------------------------------
  function drawPipes(alpha) {
    for (const pipe of game.pipes) {
      const x = lerp(pipe.prevX, pipe.x, alpha);
      const top = pipe.gapY - PIPE.gap / 2;
      const bottom = pipe.gapY + PIPE.gap / 2;
      drawPost(x, -SHAKE.amplitude * 3, top - PIPE.capHeight);
      drawCap(x, top - PIPE.capHeight);
      drawPost(x, bottom + PIPE.capHeight, GROUND_Y);
      drawCap(x, bottom);
    }
  }

  function drawPost(x, y0, y1) {
    if (y1 <= y0) return;
    const w = PIPE.postWidth;
    const h = y1 - y0;
    ctx.save();
    ctx.translate(x + (PIPE.width - w) / 2, 0);
    ctx.fillStyle = paint.post;
    roundRectPath(0, y0, w, h, 6);
    ctx.fill();

    // 每 8px 一圈深褐細線，模擬劍麻繩纏繞
    ctx.beginPath();
    for (let y = y0 + 4; y < y1; y += PIPE.ropeSpacing) {
      ctx.moveTo(1, y + 0.5);
      ctx.lineTo(w - 1, y + 0.5);
    }
    ctx.strokeStyle = 'rgba(101, 67, 33, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.fillRect(5, y0, 4, h);
    ctx.fillStyle = 'rgba(90, 55, 25, 0.18)';
    ctx.fillRect(w - 7, y0, 7, h);
    ctx.restore();
  }

  function drawCap(x, y) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = paint.cap;
    roundRectPath(0, 0, PIPE.width, PIPE.capHeight, 6);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 220, 170, 0.3)';
    roundRectPath(4, 3, PIPE.width - 8, 4, 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60, 32, 12, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(8, 11.5);
    ctx.bezierCurveTo(22, 9.5, 34, 13.5, PIPE.width - 10, 11);
    ctx.stroke();
    ctx.strokeStyle = WOOD;
    ctx.lineWidth = 1.5;
    roundRectPath(0.75, 0.75, PIPE.width - 1.5, PIPE.capHeight - 1.5, 5.5);
    ctx.stroke();
    ctx.restore();
  }

  // --- 黑貓（區域座標以身體中心為原點、面向右） ----------------------------------
  function drawCat(x, y, rotation, tail, mood) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation * DEG);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = '#141414';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(-16, 6);
    ctx.quadraticCurveTo(-31, 8 + tail * 0.45, -28, -8 + tail);
    ctx.stroke();

    drawPaw(-12, 12.5, 5, 4.2);

    ctx.fillStyle = paint.body;
    ctx.beginPath();
    ctx.ellipse(-5, 3.5, 15.5, 12, 0, 0, TAU);
    ctx.fill();

    drawPaw(4.5, 13.5, 3.8, 3.2);
    drawPaw(11, 12.5, 3.8, 3.2);

    drawEar([[-0.5, -10.5], [1, -23], [8, -15]]);
    drawEar([[11, -16], [18.5, -22.5], [20.5, -9]]);

    ctx.fillStyle = paint.head;
    ctx.beginPath();
    ctx.arc(9.5, -4.5, 12, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(8.5, -5, 8.5, 1.08 * Math.PI, 1.42 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-6, 3, 10, 1.05 * Math.PI, 1.38 * Math.PI);
    ctx.stroke();

    ctx.strokeStyle = '#E4574B';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(9.5, -4.5, 11.2, 0.3 * Math.PI, 0.92 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = EYE_GOLD;
    ctx.beginPath();
    ctx.arc(4.8, 7.6, 2.3, 0, TAU);
    ctx.fill();

    drawFace(mood);
    ctx.restore();
  }

  function drawPaw(x, y, rx, ry) {
    ctx.fillStyle = '#111111';
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.ellipse(x, y + ry * 0.45, rx * 0.72, ry * 0.5, 0, 0, Math.PI);
    ctx.fill();
  }

  function trianglePath(points) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    ctx.lineTo(points[1][0], points[1][1]);
    ctx.lineTo(points[2][0], points[2][1]);
    ctx.closePath();
  }

  function drawEar(points) {
    ctx.fillStyle = '#121212';
    trianglePath(points);
    ctx.fill();
    const cx = (points[0][0] + points[1][0] + points[2][0]) / 3;
    const cy = (points[0][1] + points[1][1] + points[2][1]) / 3;
    ctx.fillStyle = EAR_PINK;
    trianglePath(points.map(([px, py]) => [cx + (px - cx) * 0.58, cy + (py - cy) * 0.58]));
    ctx.fill();
  }

  function drawFace(mood) {
    const eyes = [[5, -5.5], [14.5, -5.5]];
    if (mood === 'normal') {
      for (const [ex, ey] of eyes) {
        ctx.save();
        ctx.translate(ex, ey);
        ctx.fillStyle = paint.eye;
        ctx.beginPath();
        ctx.arc(0, 0, 4.3, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#050505';
        ctx.beginPath();
        ctx.ellipse(0.7, 0.2, 1.3, 3.2, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(-1.4, -1.7, 1.1, 0, TAU);
        ctx.fill();
        ctx.restore();
      }
    } else {
      ctx.strokeStyle = EYE_GREEN;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      if (mood === 'scared') {
        // 緊閉的 > < 眼
        ctx.moveTo(2.8, -8.2);
        ctx.lineTo(6.6, -5.5);
        ctx.lineTo(2.8, -2.8);
        ctx.moveTo(16.7, -8.2);
        ctx.lineTo(12.9, -5.5);
        ctx.lineTo(16.7, -2.8);
      } else {
        for (const [ex, ey] of eyes) {
          ctx.moveTo(ex - 2.5, ey - 2.5);
          ctx.lineTo(ex + 2.5, ey + 2.5);
          ctx.moveTo(ex + 2.5, ey - 2.5);
          ctx.lineTo(ex - 2.5, ey + 2.5);
        }
      }
      ctx.stroke();
    }

    ctx.fillStyle = EAR_PINK;
    ctx.beginPath();
    ctx.moveTo(10.4, -1.6);
    ctx.lineTo(13, -1.6);
    ctx.lineTo(11.7, -0.1);
    ctx.closePath();
    ctx.fill();

    if (mood === 'normal') {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(10, 0.9);
      ctx.quadraticCurveTo(10.9, 2.2, 11.7, 0.5);
      ctx.quadraticCurveTo(12.5, 2.2, 13.4, 0.9);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.ellipse(11.7, 2.8, 1.7, 2.2, 0, 0, TAU);
      ctx.fill();
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(17.5, -0.5);
    ctx.lineTo(26, -2.5);
    ctx.moveTo(17.5, 1.5);
    ctx.lineTo(26, 2.5);
    ctx.moveTo(4, -0.2);
    ctx.lineTo(-3, -1.8);
    ctx.moveTo(4, 1.6);
    ctx.lineTo(-3, 2.4);
    ctx.stroke();
  }

  // --- 粒子 ----------------------------------------------------------------------
  function pawPath(size) {
    ctx.beginPath();
    ctx.ellipse(0, size * 0.45, size, size * 0.82, 0, 0, TAU);
    const toes = [[-0.92, -0.5], [-0.34, -1.02], [0.34, -1.02], [0.92, -0.5]];
    const r = size * 0.36;
    for (const [tx, ty] of toes) {
      ctx.moveTo(tx * size + r, ty * size);
      ctx.arc(tx * size, ty * size, r, 0, TAU);
    }
  }

  function starPath(size) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? size * 0.45 : size;
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const px = Math.cos(angle) * r;
      const py = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function drawEffects(layer) {
    for (const fx of game.effects) {
      if (fx.layer !== layer) continue;
      const fade = fx.life / fx.maxLife;
      ctx.save();
      ctx.translate(fx.x, fx.y);
      ctx.rotate(fx.rot);
      ctx.globalAlpha = fx.alpha * fade;
      const size = fx.layer === 'back' ? fx.size * (1 + (1 - fade) * 0.4) : fx.size;
      if (fx.kind === 'star') starPath(size);
      else pawPath(size);
      ctx.fillStyle = fx.color;
      ctx.fill();
      if (fx.layer === 'front') {
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(90, 58, 34, 0.45)';
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // --- 介面層 --------------------------------------------------------------------
  function drawOverlay() {
    switch (game.state) {
      case State.READY:
        drawReadyScreen();
        break;
      case State.PLAYING:
        drawScore();
        break;
      case State.PAUSED:
        drawScore();
        drawPausedScreen();
        break;
      case State.GAMEOVER:
        drawGameOverPanel();
        break;
      default:
        break;
    }
  }

  function drawScore() {
    drawText(String(game.score), VIEW_W / 2, 84, { size: 58, fill: '#FFFFFF', stroke: INK, strokeWidth: 9 });
  }

  function drawReadyScreen() {
    const bob = Math.sin(game.tick * 0.05) * 3;
    drawText('貓咪跳箱', VIEW_W / 2, 150 + bob, { size: 48, fill: INK, stroke: '#FFFFFF', strokeWidth: 10 });
    drawText('CAT AGILITY', VIEW_W / 2, 196, { size: 15, weight: 800, fill: '#B9794A' });

    ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
    roundRectPath(VIEW_W / 2 - 124, 379, 248, 42, 21);
    ctx.fill();
    const pulse = 0.65 + Math.sin(game.tick * 0.08) * 0.35;
    drawText('點擊螢幕或按空白鍵開始', VIEW_W / 2, 400, { size: 17, weight: 800, fill: `rgba(90, 58, 34, ${pulse.toFixed(3)})` });

    if (game.best > 0) {
      drawText(`最佳紀錄　${game.best}`, VIEW_W / 2, 446, { size: 15, weight: 800, fill: WOOD, stroke: '#FFF8EE', strokeWidth: 5 });
    }
  }

  // 續玩的第一下就會蹬跳，面板必須避開貓，讓玩家先看清楚貓與柱子的相對位置
  function pausePanelTop(catY) {
    return catY < PAUSE_PANEL.flipAt ? PAUSE_PANEL.below : PAUSE_PANEL.above;
  }

  function drawPausedScreen() {
    ctx.fillStyle = 'rgba(58, 36, 20, 0.35)';
    ctx.fillRect(-SHAKE.amplitude * 2, -SHAKE.amplitude * 2, VIEW_W + SHAKE.amplitude * 4, VIEW_H + SHAKE.amplitude * 4);
    const top = pausePanelTop(cat.y);
    drawPanel(VIEW_W / 2 - 120, top, 240, PAUSE_PANEL.height);
    drawText('暫停中', VIEW_W / 2, top + 42, { size: 30, fill: INK });
    drawText('點擊螢幕或按空白鍵繼續', VIEW_W / 2, top + 90, { size: 15, weight: 800, fill: WOOD });
  }

  function drawPanel(x, y, w, h) {
    ctx.fillStyle = '#FFF8EE';
    roundRectPath(x, y, w, h, 22);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = WOOD;
    ctx.stroke();
  }

  function easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function drawGameOverPanel() {
    if (game.overTicks < PANEL_DELAY) return;
    const t = clamp((game.overTicks - PANEL_DELAY) / 18, 0, 1);
    const scale = Math.max(0.01, easeOutBack(t));

    ctx.fillStyle = `rgba(58, 36, 20, ${(0.28 * t).toFixed(3)})`;
    ctx.fillRect(-SHAKE.amplitude * 2, -SHAKE.amplitude * 2, VIEW_W + SHAKE.amplitude * 4, VIEW_H + SHAKE.amplitude * 4);

    ctx.save();
    ctx.translate(VIEW_W / 2, 300);
    ctx.scale(scale, scale);
    ctx.globalAlpha = t;
    drawPanel(-130, -120, 260, 240);
    drawText('遊戲結束', 0, -82, { size: 30, fill: INK });
    drawText('本次分數', 0, -40, { size: 15, weight: 800, fill: '#A57A55' });
    drawText(String(game.score), 0, 0, { size: 46, fill: INK });
    ctx.fillStyle = 'rgba(139, 90, 43, 0.25)';
    ctx.fillRect(-90, 32, 180, 2);
    drawText('最佳紀錄', 0, 60, { size: 15, weight: 800, fill: '#A57A55' });
    drawText(String(game.best), 0, 92, { size: 28, fill: INK });

    if (game.isNewBest) {
      ctx.save();
      ctx.translate(92, -112);
      ctx.rotate(12 * DEG);
      ctx.fillStyle = '#FF7FA0';
      roundRectPath(-40, -15, 80, 30, 15);
      ctx.fill();
      drawText('新紀錄！', 0, 0, { size: 14, fill: '#FFFFFF' });
      ctx.restore();
    }
    ctx.restore();

    if (now() - game.gameOverAt >= RESTART_LOCK_MS) {
      const blink = 0.55 + Math.sin(game.tick * 0.1) * 0.45;
      drawText('點擊螢幕回到開始畫面', VIEW_W / 2, 462, {
        size: 16,
        weight: 800,
        fill: `rgba(90, 58, 34, ${blink.toFixed(3)})`,
        stroke: 'rgba(255, 248, 238, 0.9)',
        strokeWidth: 6
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 畫布尺寸：CSS 負責 9:16 置中，這裡只把緩衝區放大到實體像素
  // ---------------------------------------------------------------------------
  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    view.sx = width / VIEW_W;
    view.sy = height / VIEW_H;
  }

  // 視窗拖到不同 DPR 的螢幕時不一定會觸發 resize，另外監聽解析度變化
  function watchPixelRatio() {
    if (typeof window.matchMedia !== 'function') return;
    try {
      const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      if (typeof query.addEventListener !== 'function') return;
      query.addEventListener('change', () => {
        resize();
        watchPixelRatio();
      }, { once: true });
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // 主迴圈：固定步長模擬 + 插值繪製
  // ---------------------------------------------------------------------------
  let lastTime = 0;
  let accumulator = 0;

  function loop(time) {
    requestAnimationFrame(loop);
    if (!lastTime) lastTime = time;
    let delta = time - lastTime;
    lastTime = time;
    // 分頁切回來時不補跑落後的模擬
    if (delta < 0 || delta > 250) delta = STEP_MS;
    accumulator += delta;

    let steps = 0;
    while (accumulator >= STEP_MS && steps < MAX_STEPS_PER_FRAME) {
      update();
      accumulator -= STEP_MS;
      steps += 1;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
    render(accumulator / STEP_MS);
  }

  // ---------------------------------------------------------------------------
  // 輸入與生命週期
  // ---------------------------------------------------------------------------
  function announce(message) {
    if (statusEl) statusEl.textContent = message;
  }

  function syncSoundButton() {
    if (!soundBtn) return;
    if (!Sound.available) {
      soundBtn.hidden = true;
      return;
    }
    const on = Sound.enabled();
    soundBtn.setAttribute('aria-pressed', String(on));
    soundBtn.title = on ? '關閉音效' : '開啟音效';
    const icon = soundBtn.querySelector('span');
    if (icon) icon.textContent = on ? '🔊' : '🔇';
  }

  function bindInput() {
    canvas.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      triggerAction();
    });
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    window.addEventListener('keydown', (event) => {
      if (!ACTION_KEYS.has(event.code) || event.ctrlKey || event.metaKey || event.altKey) return;
      // 鍵盤使用者聚焦在按鈕／連結上時，空白鍵保留給該控制項
      if (event.code === 'Space' && event.target instanceof Element && event.target.closest('a, button')) return;
      event.preventDefault();
      if (event.repeat) return;
      triggerAction();
    });

    // iOS Safari 的雙指縮放不受 touch-action 管
    document.addEventListener('gesturestart', (event) => event.preventDefault());

    if (soundBtn) {
      soundBtn.addEventListener('click', (event) => {
        Sound.toggle();
        syncSoundButton();
        // 滑鼠／觸控點完就交還焦點，之後的空白鍵才會回到遊戲
        if (event.detail > 0) soundBtn.blur();
      });
    }
  }

  function bindLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') pause();
      else lastTime = 0;
    });
    window.addEventListener('pagehide', pause);
    window.addEventListener('resize', resize);
  }

  function init() {
    if (typeof BoboTheme !== 'undefined') BoboTheme.init();
    loadStats();
    createMotes();
    if (loadGameState()) {
      announce('偵測到未完成的一局，點擊畫面或按空白鍵繼續');
    } else {
      resetToReady();
    }
    bindInput();
    bindLifecycle();
    syncSoundButton();
    resize();
    watchPixelRatio();
    requestAnimationFrame(loop);
  }

  // 唯讀快照，供冒煙測試與除錯確認狀態機
  window.CatAgility = Object.freeze({
    snapshot: () => ({
      state: game.state,
      score: game.score,
      best: game.best,
      plays: game.plays,
      catY: cat.y,
      pipes: game.pipes.length,
      effects: game.effects.length,
      motes: game.motes.length
    })
  });

  init();
})();

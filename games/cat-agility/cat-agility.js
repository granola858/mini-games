/**
 * 貓咪跳箱（Cat Agility）— Flappy Bird 變體
 *
 * 內部一律使用 360×640 虛擬座標，畫布緩衝區再依 devicePixelRatio 放大。
 * 物理以固定 60 步／秒推進（數值單位是 px/frame），高更新率螢幕靠插值補畫面。
 * 結構：Store（持久化）→ Sound（Web Audio 合成）→ Controller（狀態機與物理）→ Renderer。
 * Renderer 採策略模式：Themes.pixel16（預設，16-bit 像素日系客廳）與 Themes.classic（原本的純向量畫風）
 * 實作同一組繪製方法，render() 依 GameConfig.currentTheme 分派。主題只管外觀，判定與玩法完全相同。
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
    // 縫隙 140：黑貓從沙發坐墊夾縫、拉門縫之間鑽過的緊湊感
    gap: 140,
    minCenter: 150,
    maxCenter: 480,
    width: 64,
    // 48 = 24 個美術像素，柱身左右各內縮 8（4 個美術像素）；兩種主題共用同一套判定
    postWidth: 48,
    capHeight: 18,
    ropeSpacing: 8
  });

  const CAT = Object.freeze({ x: 100, readyY: 280, radius: 14, ceiling: 16 });

  // 9 幀 ≈ 150ms；無敵撞散家具時只輕輕晃 5 幀
  const SHAKE = Object.freeze({ frames: 9, amplitude: 4, smashFrames: 5, smashAmplitude: 2 });
  const RESTART_LOCK_MS = 400;
  const PANEL_DELAY = 12;
  // 暫停面板高 130：貓在上半部（y < 300）就放到下方，否則放到分數下方；
  // 兩個位置都與貓的繪製範圍（約 ±30）保持距離
  const PAUSE_PANEL = Object.freeze({ height: 130, flipAt: 300, above: 130, below: 360 });
  const SCARED_SPEED = 7.2;
  const DECOR_GAP = 240;
  // 存檔捲動量上限：正常玩要連續飛上好幾個月才會到，只擋手改或壞掉的存檔
  const MAX_SCROLL = 1e9;

  // 無敵衝刺：180 步 = 3000ms；速度倍率 10 步升到 1.6、30 步降回 1；
  // 殘影取往回 3／6／9 步的位置，撞散家具噴 8～12 顆碎屑
  const FRENZY = Object.freeze({
    steps: 180,
    speed: 1.6,
    rampIn: 0.06,
    rampOut: 0.02,
    ghostLags: Object.freeze([3, 6, 9]),
    ghostAlphas: Object.freeze([0.5, 0.34, 0.18]),
    trailLen: 10,
    debrisMin: 8,
    debrisMax: 12
  });

  // 每穿過 10 組障礙物，就在下一組的縫隙正中央放一顆道具（罐頭或貓草），畫面上下浮動 ±3px
  const ITEM = Object.freeze({ every: 10, radius: 12, bob: 3, kinds: Object.freeze(['can', 'grass']) });

  // 家具組合：A 立體貓抓柱／B 半開抽屜櫃 + 地面跳箱／C 高垂盆栽 + 矮几
  const VARIANTS = Object.freeze(['post', 'drawer', 'plant']);

  // Squash & Stretch：上升拉長（0.8 × 1.25）、下墜壓扁（1.25 × 0.8），|vy| 到 full 時變形到底；
  // 下墜速度超過 ball 就縮成一團肉球；ease 是每步追目標值的比例
  const SQUASH = Object.freeze({
    stretchX: 0.8,
    stretchY: 1.25,
    squashX: 1.25,
    squashY: 0.8,
    full: 3,
    ball: 4,
    ease: 0.35
  });

  // 畫面風格：pixel16 是預設的 16-bit 像素風，classic 是原本的向量畫風
  // GameConfig 是整支遊戲共用的設定（放在 IIFE 內，不外露到 window）：執行中只有 currentTheme 會被讀取與切換
  // （HUD 風格鍵、偏好 cat-agility_pref_v1.style），其餘欄位是各常數表的唯讀檢視，改它們不會影響遊戲
  const THEMES = Object.freeze(['pixel16', 'classic']);
  const GameConfig = {
    currentTheme: 'pixel16', // 可選值：'pixel16'（預設）、'classic'
    physics: PHYSICS,
    pipe: PIPE,
    cat: CAT,
    frenzy: FRENZY,
    item: ITEM,
    squash: SQUASH
  };

  // 像素網格：1 個美術像素 = PX 個虛擬像素，低解析緩衝區 180×320（美術片段依賴這些名稱與數值）
  const PX = 2;
  const LOW_W = VIEW_W / PX;
  const LOW_H = VIEW_H / PX;
  const GROUND_AY = GROUND_Y / PX;
  const BASEBOARD_AH = BASEBOARD_H / PX;
  const PIPE_AW = PIPE.width / PX;
  const POST_AW = PIPE.postWidth / PX;
  const POST_AINSET = (PIPE_AW - POST_AW) / 2;
  const CAP_AH = PIPE.capHeight / PX;
  const GAP_AH = PIPE.gap / PX;
  const CAT_AX = CAT.x / PX;

  const INK = '#5A3A22';
  const WOOD = '#8B5A2B';
  const SISAL = '#D2B48C';
  const EAR_PINK = '#FFB6C1';
  const EYE_GREEN = '#98FB98';
  const EYE_GOLD = '#FFD700';
  const SPARK_COLORS = Object.freeze(['#FFF6C8', '#FFD54F', '#F48FB1', '#D4E157', '#9AD0EC', '#FFFFFF']);
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
  const isBool = (value) => typeof value === 'boolean';
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

    // 吃到道具：方波由低到高的 4 音階快速琶音；stagger 交給音訊時鐘排程，不用 setTimeout
    const frenzy = () => {
      if (!kit) return;
      kit.chord([392, 523.25, 659.25, 1046.5], { type: 'square', stagger: 0.07, duration: 0.12, gain: 0.07 });
    };

    // 撞散家具：短促的帶通噪音「喀啦」一聲，再墊一記往下掉的低頻悶響
    const smash = () => {
      if (!kit) return;
      kit.noise({ duration: 0.16, gain: 0.16, filter: { type: 'bandpass', frequency: 2400, to: 500, Q: 0.8 } });
      kit.sweep({ type: 'triangle', from: 220, to: 70, duration: 0.12, gain: 0.12 });
    };

    return {
      available: !!kit,
      jump,
      score,
      hit,
      frenzy,
      smash,
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
    tailVel: 0,
    // Squash & Stretch 的水平／垂直縮放：每步平滑追目標值，繪製時再插值
    sx: 1,
    sy: 1,
    prevSx: 1,
    prevSy: 1
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
    shakeAmp: SHAKE.amplitude,
    overTicks: 0,
    gameOverAt: 0,
    grounded: false,
    pipes: [],
    effects: [],
    motes: [],
    // 累計穿過的障礙物數；每 ITEM.every 組送一顆道具
    passCount: 0,
    // 達標當下畫面上還沒有下一組障礙物時，道具留給下一次生成的那組
    itemPending: false,
    // 無敵衝刺剩餘步數：模擬步計時，暫停時自然凍結，不必清任何計時器
    frenzy: 0,
    speedMul: 1,
    // 彩虹殘影取樣（最多 FRENZY.trailLen 筆）與淡出係數 0..1
    trail: [],
    trailFade: 0
  };

  // ---------------------------------------------------------------------------
  // 持久化：戰績、偏好、進行中局況
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

  // 偏好 key 與 BoboAudio 共用（它存 sound 欄位），一律讀回整包再只改 style，整包覆寫會清掉音效設定
  function readPrefs() {
    const pref = Store.read(STORAGE_KEYS.pref);
    return pref && typeof pref === 'object' && !Array.isArray(pref) ? pref : {};
  }

  function loadPrefs() {
    const style = readPrefs().style;
    GameConfig.currentTheme = THEMES.includes(style) ? style : THEMES[0];
  }

  function savePrefs() {
    const pref = readPrefs();
    pref.style = GameConfig.currentTheme;
    Store.write(STORAGE_KEYS.pref, pref);
  }

  function saveGameState() {
    if (game.state !== State.PLAYING && game.state !== State.PAUSED) return;
    Store.write(STORAGE_KEYS.state, {
      v: 1,
      score: game.score,
      scroll: game.scroll,
      spawnTimer: game.spawnTimer,
      passCount: game.passCount,
      frenzy: game.frenzy,
      speed: game.speedMul,
      itemPending: game.itemPending,
      cat: { y: cat.y, vy: cat.vy, rot: cat.rot },
      pipes: game.pipes.map((pipe) => ({
        x: pipe.x,
        gapY: pipe.gapY,
        passed: pipe.passed,
        variant: pipe.variant,
        item: pipe.item,
        brokenTop: pipe.brokenTop,
        brokenBottom: pipe.brokenBottom
      }))
    });
  }

  function loadGameState() {
    const saved = Store.read(STORAGE_KEYS.state);
    if (!saved) return false;

    // 新欄位都是選填（相容舊存檔）；有給但型別或列舉值不對，就跟其他壞存檔一樣整包丟掉
    const optional = (value, check) => value === undefined || check(value);
    const validPipe = (pipe) => pipe && isNum(pipe.x) && isNum(pipe.gapY)
      && pipe.gapY >= PIPE.minCenter && pipe.gapY <= PIPE.maxCenter
      && optional(pipe.variant, (value) => VARIANTS.includes(value))
      && optional(pipe.item, (value) => value === null || ITEM.kinds.includes(value))
      && optional(pipe.brokenTop, isBool)
      && optional(pipe.brokenBottom, isBool);
    const valid = saved.v === 1
      && isNum(saved.score) && saved.score >= 0
      && isNum(saved.scroll) && isNum(saved.spawnTimer)
      && optional(saved.passCount, isNum) && optional(saved.frenzy, isNum)
      && optional(saved.speed, isNum) && optional(saved.itemPending, isBool)
      && saved.cat && isNum(saved.cat.y) && isNum(saved.cat.vy) && isNum(saved.cat.rot)
      && Array.isArray(saved.pipes) && saved.pipes.length <= 8 && saved.pipes.every(validPipe);
    if (!valid) {
      clearGameState();
      return false;
    }

    game.state = State.PAUSED;
    game.score = Math.floor(saved.score);
    // 捲動量只推動視差與地板花紋；夾上限，手改或壞掉的超大值（超過 2^53 附近）才不會讓繪製迴圈停不下來
    game.scroll = game.prevScroll = clamp(saved.scroll, 0, MAX_SCROLL);
    game.spawnTimer = clamp(saved.spawnTimer, 0, PIPE.spawnEvery);
    game.passCount = isNum(saved.passCount) ? Math.floor(Math.max(0, saved.passCount)) : game.score;
    game.itemPending = saved.itemPending === true;
    game.frenzy = isNum(saved.frenzy) ? Math.floor(clamp(saved.frenzy, 0, FRENZY.steps)) : 0;
    game.speedMul = isNum(saved.speed) ? clamp(saved.speed, 1, FRENZY.speed) : 1;
    // 殘影不存檔：續玩後重新取樣；衝刺剛結束、速度還在降的存檔，彩虹淡出係數跟著速度倍率接回去
    game.trail.length = 0;
    game.trailFade = game.frenzy > 0 ? 1 : clamp((game.speedMul - 1) / (FRENZY.speed - 1), 0, 1);
    game.pipes = saved.pipes.map((pipe) => {
      const x = clamp(pipe.x, -PIPE.width, VIEW_W + PIPE.width);
      return {
        x,
        prevX: x,
        gapY: pipe.gapY,
        passed: pipe.passed === true,
        variant: pipe.variant || VARIANTS[0],
        item: pipe.item || null,
        brokenTop: pipe.brokenTop === true,
        brokenBottom: pipe.brokenBottom === true
      };
    });
    cat.y = cat.prevY = clamp(saved.cat.y, CAT.ceiling, GROUND_Y - CAT.radius - 1);
    cat.vy = clamp(saved.cat.vy, PHYSICS.jump, PHYSICS.maxFall);
    cat.rot = cat.prevRot = clamp(saved.cat.rot, PHYSICS.tiltUp, PHYSICS.tiltDown);
    snapSquash();
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
    game.passCount = 0;
    game.itemPending = false;
    clearFrenzy();
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
    game.passCount = 0;
    game.itemPending = false;
    clearFrenzy();
    cat.y = cat.prevY = CAT.readyY;
    cat.vy = 0;
    cat.rot = cat.prevRot = 0;
    cat.tail = 0;
    cat.tailVel = 0;
    snapSquash();
    announce('');
  }

  // 無敵衝刺相關狀態一律從這裡歸零（開局、回 READY、結算共用），殘影陣列就地清空不留參照
  function clearFrenzy() {
    game.frenzy = 0;
    game.speedMul = 1;
    game.trail.length = 0;
    game.trailFade = 0;
  }

  function pause() {
    if (game.state !== State.PLAYING) return;
    game.state = State.PAUSED;
    // 震動只在 PLAYING／GAMEOVER 倒數；撞散家具後剛好暫停，不清掉的話暫停畫面會一直抖到續玩
    game.shake = 0;
    saveGameState();
    announce('遊戲已暫停，點擊畫面或按空白鍵繼續');
  }

  function gameOver() {
    game.state = State.GAMEOVER;
    game.gameOverAt = now();
    game.overTicks = 0;
    game.shake = reduceMotion ? 0 : SHAKE.frames;
    game.shakeAmp = SHAKE.amplitude;
    cat.vy = Math.max(cat.vy, 0);
    game.grounded = cat.y + CAT.radius >= GROUND_Y - 0.5;
    clearFrenzy();
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
    cat.prevSx = cat.sx;
    cat.prevSy = cat.sy;
    game.prevScroll = game.scroll;
    for (const pipe of game.pipes) pipe.prevX = pipe.x;

    updateMotes();
    updateEffects();

    if (game.state === State.READY) updateReady();
    else if (game.state === State.PLAYING) updatePlaying();
    else if (game.state === State.GAMEOVER) updateGameOver();
    updateSquash();
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
    if (game.shake > 0) game.shake -= 1;
    updateFrenzy();
    cat.vy = Math.min(cat.vy + PHYSICS.gravity, PHYSICS.maxFall);
    cat.y += cat.vy;
    if (cat.y < CAT.ceiling) {
      cat.y = CAT.ceiling;
      cat.vy = Math.max(cat.vy, 0);
    }
    updateTilt();
    updateTail(-cat.vy * 3);
    // 障礙物、地板與遠景都以同一個世界速度前進；衝刺時整體加速
    const speed = PIPE.speed * game.speedMul;
    game.scroll += speed;
    updatePipes(speed);

    // 地板永遠判死，無敵衝刺也一樣
    if (cat.y + CAT.radius >= GROUND_Y) {
      cat.y = GROUND_Y - CAT.radius;
      gameOver();
      return;
    }
    collectItems();
    if (hitObstacles()) return;
    recordTrail();
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

  // --- Squash & Stretch ----------------------------------------------------------
  const squashGoal = { x: 1, y: 1 };

  // 目標縮放只看垂直速度：上升拉長、下墜壓扁，速度越快變形越多
  function squashTarget(vy) {
    if (vy < 0) {
      const t = clamp(-vy / SQUASH.full, 0, 1);
      squashGoal.x = lerp(1, SQUASH.stretchX, t);
      squashGoal.y = lerp(1, SQUASH.stretchY, t);
    } else if (vy > 0) {
      const t = clamp(vy / SQUASH.full, 0, 1);
      squashGoal.x = lerp(1, SQUASH.squashX, t);
      squashGoal.y = lerp(1, SQUASH.squashY, t);
    } else {
      squashGoal.x = 1;
      squashGoal.y = 1;
    }
    return squashGoal;
  }

  function updateSquash() {
    const goal = squashTarget(game.state === State.READY ? 0 : cat.vy);
    cat.sx += (goal.x - cat.sx) * SQUASH.ease;
    cat.sy += (goal.y - cat.sy) * SQUASH.ease;
  }

  // 載入存檔、回 READY 時直接跳到目標值，不從上一局的形變慢慢彈回來
  function snapSquash() {
    const goal = squashTarget(game.state === State.READY ? 0 : cat.vy);
    cat.sx = cat.prevSx = goal.x;
    cat.sy = cat.prevSy = goal.y;
  }

  // --- 無敵衝刺 ------------------------------------------------------------------
  // 計時與速度倍率都是模擬步計數：暫停時自然凍結，也沒有任何 setTimeout 需要回收
  function updateFrenzy() {
    if (game.frenzy > 0) game.frenzy -= 1;
    const target = game.frenzy > 0 ? FRENZY.speed : 1;
    // 線性逼近並用 min／max 停在目標值上，不會累積浮點誤差
    if (game.speedMul < target) game.speedMul = Math.min(target, game.speedMul + FRENZY.rampIn);
    else if (game.speedMul > target) game.speedMul = Math.max(target, game.speedMul - FRENZY.rampOut);

    if (game.frenzy > 0) {
      game.trailFade = 1;
    } else if (game.trailFade > 0) {
      // 殘影與彩虹色跟著速度一起在 30 步內淡出，速度回到 1 的那一步剛好歸零並釋放取樣
      game.trailFade = Math.min(game.trailFade, (game.speedMul - 1) / (FRENZY.speed - 1));
      if (game.trailFade <= 0) {
        game.trailFade = 0;
        game.trail.length = 0;
      }
    }
  }

  // 衝刺中（含淡出期）每步記一筆貓的姿態，只留最近 trailLen 筆；最舊的物件回收重用，不會越積越多
  function recordTrail() {
    if (game.frenzy <= 0 && game.trailFade <= 0) return;
    const trail = game.trail;
    const entry = trail.length >= FRENZY.trailLen ? trail.shift() : {};
    entry.y = cat.y;
    entry.rot = cat.rot;
    entry.sx = cat.sx;
    entry.sy = cat.sy;
    entry.pose = catPose();
    trail.push(entry);
  }

  // 道具與貓都當成圓形判定，圓心是縫隙正中央（上下浮動只是畫面效果）
  function collectItems() {
    const reach = CAT.radius + ITEM.radius;
    for (const pipe of game.pipes) {
      if (!pipe.item) continue;
      const x = pipe.x + PIPE.width / 2;
      const dx = CAT.x - x;
      const dy = cat.y - pipe.gapY;
      if (dx * dx + dy * dy >= reach * reach) continue;
      pipe.item = null;
      startFrenzy(x, pipe.gapY);
    }
  }

  // 衝刺中再吃到道具就把時間補滿；吃到道具時殘影取樣不足 trailLen 筆（剛開始衝刺，或讀檔續玩後還在重新取樣）
  // 就用現在的姿態補滿，吃到的那一幀起就有 3 道殘影，之後隨真正的取樣自然錯開。
  // 讀檔本身不補：殘影不存檔、讀檔後從空的開始，續玩後隨取樣在 10 步內依序出現
  function startFrenzy(x, y) {
    game.frenzy = FRENZY.steps;
    game.trailFade = 1;
    while (game.trail.length < FRENZY.trailLen) {
      game.trail.push({ y: cat.y, rot: cat.rot, sx: cat.sx, sy: cat.sy, pose: catPose() });
    }
    spawnSparks(x, y);
    Sound.frenzy();
  }

  // --- 障礙物 --------------------------------------------------------------------
  function spawnPipe() {
    const x = VIEW_W + 4;
    const gapY = rand(PIPE.minCenter, PIPE.maxCenter);
    const variant = VARIANTS[Math.min(VARIANTS.length - 1, Math.floor(Math.random() * VARIANTS.length))];
    let item = null;
    if (game.itemPending) {
      game.itemPending = false;
      item = pickItemKind();
    }
    game.pipes.push({ x, prevX: x, gapY, passed: false, variant, item, brokenTop: false, brokenBottom: false });
  }

  function pickItemKind() {
    return Math.random() < 0.5 ? ITEM.kinds[0] : ITEM.kinds[1];
  }

  // 生成改用「累積距離」：衝刺加速時間距仍是 220px；倍率 1 時與逐步計數完全相同
  function updatePipes(speed) {
    game.spawnTimer += game.speedMul;
    if (game.spawnTimer >= PIPE.spawnEvery) {
      game.spawnTimer -= PIPE.spawnEvery;
      spawnPipe();
    }
    for (let i = game.pipes.length - 1; i >= 0; i--) {
      const pipe = game.pipes[i];
      pipe.x -= speed;
      if (!pipe.passed && pipe.x + PIPE.width / 2 < CAT.x) {
        pipe.passed = true;
        game.score += 1;
        game.passCount += 1;
        Sound.score();
        if (game.passCount % ITEM.every === 0) queueItem();
      }
      if (pipe.x + PIPE.width < -SHAKE.amplitude) game.pipes.splice(i, 1);
    }
  }

  // 每個里程碑只送一顆：交給下一組還沒通過的障礙物；還沒生成就等下一組
  function queueItem() {
    const next = game.pipes.find((pipe) => !pipe.passed && !pipe.item);
    if (next) next.item = pickItemKind();
    else game.itemPending = true;
  }

  function circleHitsRect(x, y, w, h) {
    const dx = CAT.x - clamp(CAT.x, x, x + w);
    const dy = cat.y - clamp(cat.y, y, y + h);
    return dx * dx + dy * dy < CAT.radius * CAT.radius;
  }

  const HALVES = Object.freeze(['top', 'bottom']);

  // 上下半截分開判定：無敵時只撞散碰到的那一半，另一半照樣擋路；平常碰到任一半就結束
  function hitObstacles() {
    for (const pipe of game.pipes) {
      for (const half of HALVES) {
        if (isBroken(pipe, half) || !hitsHalf(pipe, half)) continue;
        if (game.frenzy <= 0) {
          gameOver();
          return true;
        }
        smash(pipe, half);
      }
    }
    return false;
  }

  function isBroken(pipe, half) {
    return half === 'top' ? pipe.brokenTop : pipe.brokenBottom;
  }

  // 柱身與頂蓋分開判定：頂蓋比柱身寬，合成一個大矩形會讓擦邊變得不公平
  function hitsHalf(pipe, half) {
    const postX = pipe.x + (PIPE.width - PIPE.postWidth) / 2;
    if (half === 'top') {
      const top = pipe.gapY - PIPE.gap / 2;
      return circleHitsRect(postX, -VIEW_H, PIPE.postWidth, top + VIEW_H)
        || circleHitsRect(pipe.x, top - PIPE.capHeight, PIPE.width, PIPE.capHeight);
    }
    const bottom = pipe.gapY + PIPE.gap / 2;
    return circleHitsRect(postX, bottom, PIPE.postWidth, GROUND_Y - bottom)
      || circleHitsRect(pipe.x, bottom, PIPE.width, PIPE.capHeight);
  }

  function smash(pipe, half) {
    if (half === 'top') pipe.brokenTop = true;
    else pipe.brokenBottom = true;
    spawnDebris(pipe, half);
    Sound.smash();
    if (!reduceMotion) {
      game.shake = Math.max(game.shake, SHAKE.smashFrames);
      game.shakeAmp = SHAKE.smashAmplitude;
    }
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

  // 吃到道具：一圈彩色星光從縫隙中央往外噴
  function spawnSparks(x, y) {
    const count = 12;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * TAU + rand(-0.15, 0.15);
      const speed = rand(1.8, 3.8);
      const life = Math.round(rand(26, 40));
      game.effects.push({
        kind: 'spark',
        layer: 'front',
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: 0.02,
        drag: 0.93,
        size: rand(3.5, 6),
        rot: rand(0, TAU),
        spin: rand(-0.2, 0.2),
        life,
        maxLife: life,
        alpha: 1,
        color: SPARK_COLORS[i % SPARK_COLORS.length]
      });
    }
  }

  // 碎屑水平散布的最小寬度（虛擬像素，柱身寬的 1/3）
  const DEBRIS_SPREAD = 16;

  // 無敵撞散半截家具：8～12 顆木屑／麻繩／葉片從撞擊點炸開；顏色由目前主題依家具組合與上下半截決定，
  // 亂數呼叫次數與主題無關，切換主題不影響後續的隨機序列。
  // 撞擊點：高度取貓的位置、夾在被撞那半截的範圍內（柱身很長時才不會從遠處的縫隙邊緣冒出來）；
  // 水平撒在家具柱身上（貓頭前方），碎屑看起來是從家具噴出來，而不是從貓身上冒出來
  function spawnDebris(pipe, half) {
    const span = FRENZY.debrisMax - FRENZY.debrisMin + 1;
    const count = FRENZY.debrisMin + Math.min(span - 1, Math.floor(Math.random() * span));
    const colors = currentTheme().debrisColors(pipe.variant, half);
    const edge = half === 'top' ? pipe.gapY - PIPE.gap / 2 : pipe.gapY + PIPE.gap / 2;
    const postX = pipe.x + (PIPE.width - PIPE.postWidth) / 2;
    // 家具已經滑到貓身後（從後緣擦到頂蓋）時，貓頭前方沒有柱身了：改撒在柱身靠貓的那一段，
    // 範圍至少留 DEBRIS_SPREAD 寬，碎屑才不會全擠在貓的中心線上
    const x1 = postX + PIPE.postWidth;
    const x0 = Math.min(Math.max(postX, CAT.x), x1 - DEBRIS_SPREAD);
    const y = half === 'top' ? clamp(cat.y, CAT.ceiling, edge - 6) : clamp(cat.y, edge + 6, GROUND_Y - 6);
    const lift = half === 'top' ? -1 : -3;
    for (let i = 0; i < count; i++) {
      const life = Math.round(rand(32, 50));
      game.effects.push({
        kind: 'chip',
        layer: 'front',
        x: rand(x0, x1),
        y: y + rand(-14, 14),
        vx: rand(-1.2, 3.6),
        vy: lift + rand(-2.2, 1.2),
        gravity: 0.2,
        drag: 0.97,
        size: rand(3, 6.5),
        rot: rand(0, TAU),
        spin: rand(-0.3, 0.3),
        life,
        maxLife: life,
        alpha: 1,
        color: colors[i % colors.length]
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
  // Renderer（共用）：分派主題、震動、殘影取樣與介面文字
  // ---------------------------------------------------------------------------
  const canvas = document.getElementById('game-canvas');
  // 經典主題要把貓畫進離屏圖層上彩虹色，繪製期間會暫時把 ctx 換成圖層的 context，所以用 let
  let ctx = canvas.getContext('2d', { alpha: false });
  const soundBtn = document.getElementById('sound-btn');
  const styleBtn = document.getElementById('style-btn');
  const stageEl = document.getElementById('stage');
  const statusEl = document.getElementById('game-status');
  const view = { sx: 0, sy: 0 };

  const reduceMotion = (() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) {
      return false;
    }
  })();

  // 離屏畫布：像素緩衝區與殘影圖層都靠它；環境不支援就回傳 null，由呼叫端退回
  function createLayer(width, height) {
    try {
      if (typeof document.createElement !== 'function') return null;
      const layer = document.createElement('canvas');
      layer.width = width;
      layer.height = height;
      const layerCtx = layer.getContext('2d');
      return layerCtx ? { canvas: layer, ctx: layerCtx } : null;
    } catch (_) {
      return null;
    }
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

  // 像素主題需要兩張離屏畫布（緩衝區與殘影圖層）；任一張建不起來（例如沒有 document.createElement）就退回經典
  function pixelAvailable() {
    return !!(pixelBuffer && pixelGhost);
  }

  function activeTheme() {
    return GameConfig.currentTheme === 'pixel16' && pixelAvailable() ? 'pixel16' : 'classic';
  }

  function currentTheme() {
    return Themes[activeTheme()];
  }

  function render(alpha) {
    if (!view.sx || !view.sy) return;
    const theme = currentTheme();
    ctx.setTransform(view.sx, 0, 0, view.sy, 0, 0);
    // 像素主題強制關閉平滑（改畫布尺寸會重設，所以每幀都設）；經典主題維持瀏覽器預設
    ctx.imageSmoothingEnabled = !theme.grid;
    ctx.save();
    if (game.shake > 0) {
      const amp = game.shakeAmp;
      let dx = rand(-amp, amp);
      let dy = rand(-amp, amp);
      // 像素主題的震動對齊美術像素，整張圖才不會被重新取樣而糊掉
      if (theme.grid) {
        dx = Math.round(dx / theme.grid) * theme.grid;
        dy = Math.round(dy / theme.grid) * theme.grid;
      }
      ctx.translate(dx, dy);
    }
    theme.renderScene(alpha);
    drawOverlay(theme);
    ctx.restore();
  }

  // 兩種主題共用同一個繪製順序：遠景 → 障礙物 → 道具 → 地板 → 後景粒子 → 殘影與貓 → 前景粒子 → 分數
  function drawScene(theme, alpha) {
    const scroll = lerp(game.prevScroll, game.scroll, alpha);
    theme.drawBackground(scroll);
    theme.drawObstacles(alpha);
    theme.drawItems(alpha);
    theme.drawGround(scroll);
    theme.drawEffects('back');
    theme.drawPlayer(alpha);
    theme.drawEffects('front');
    if (game.state === State.PLAYING || game.state === State.PAUSED) theme.drawScore();
  }

  function catMood() {
    if (game.state === State.GAMEOVER) return 'dizzy';
    if (game.state === State.PLAYING && cat.vy > SCARED_SPEED) return 'scared';
    return 'normal';
  }

  // 姿勢：上升伸展、下墜蜷縮，掉得夠快就縮成一團肉球；落地結算時維持蜷縮
  function catPose() {
    if (game.state === State.READY) return 'idle';
    if (game.state === State.GAMEOVER && game.grounded) return 'squash';
    if (cat.vy < 0) return 'stretch';
    if (cat.vy > SQUASH.ball) return 'ball';
    if (cat.vy > 0) return 'squash';
    return 'idle';
  }

  // 彩虹色相約每秒轉一圈，跟著 game.tick 走。tick 在每個狀態都會前進，所以暫停時色相（以及道具的浮動與閃光）
  // 照樣轉；凍結的只有衝刺計時與速度倍率
  function rainbowHue(alpha) {
    return ((game.tick + alpha) * 6) % 360;
  }

  function rainbowActive() {
    return game.frenzy > 0 || game.trailFade > 0;
  }

  function itemBob() {
    return Math.sin(game.tick * 0.1) * ITEM.bob;
  }

  // 衝刺計量條最後 1/4 的提醒（兩種主題共用）：step = 剩餘步數，每 16 步切換一次（約 1.9Hz，
  // 低於每秒 3 次的閃爍門檻），一開始就是亮的；使用者要求減少動態時不閃，整段固定成提醒色
  function frenzyMeterWarn(remain, step) {
    if (remain >= 0.25) return false;
    return reduceMotion || ((step >> 4) & 1) === 0;
  }

  // 第 i 道殘影：往回 lag 步的姿態，x 依目前場景速度往後排；取樣還不夠（剛吃到道具）就先不畫
  const ghostView = { x: 0, alpha: 0, hue: 0, entry: null };
  function ghostAt(i, baseHue) {
    const lag = FRENZY.ghostLags[i];
    const trail = game.trail;
    if (game.trailFade <= 0 || trail.length <= lag) return null;
    ghostView.entry = trail[trail.length - 1 - lag];
    ghostView.x = CAT.x - lag * PIPE.speed * game.speedMul;
    ghostView.alpha = FRENZY.ghostAlphas[i] * game.trailFade;
    ghostView.hue = (baseHue + i * 120) % 360;
    return ghostView;
  }

  // #region theme:classic
  // ===========================================================================
  // 經典主題：原本的純向量繪製（漸層、圓角、曲線），外觀完全保留
  // ===========================================================================

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

  // 經典主題的碎屑：劍麻纖維與木頭頂蓋的顏色
  const CLASSIC_DEBRIS = Object.freeze(['#E6CFA8', SISAL, '#B48F62', WOOD]);

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

  // --- 貓抓柱（經典主題不分家具組合，一律畫劍麻柱；被撞散的半截不畫） -------------
  function drawPipes(alpha) {
    for (const pipe of game.pipes) {
      const x = lerp(pipe.prevX, pipe.x, alpha);
      const top = pipe.gapY - PIPE.gap / 2;
      const bottom = pipe.gapY + PIPE.gap / 2;
      if (!pipe.brokenTop) {
        drawPost(x, -SHAKE.amplitude * 3, top - PIPE.capHeight);
        drawCap(x, top - PIPE.capHeight);
      }
      if (!pipe.brokenBottom) {
        drawPost(x, bottom + PIPE.capHeight, GROUND_Y);
        drawCap(x, bottom);
      }
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

  // --- 道具：縫隙正中央，畫面上下浮動 -------------------------------------------
  function classicDrawItems(alpha) {
    const bob = itemBob();
    for (const pipe of game.pipes) {
      if (!pipe.item) continue;
      const x = lerp(pipe.prevX, pipe.x, alpha) + PIPE.width / 2;
      ctx.save();
      classicDrawItem(ctx, x, pipe.gapY + bob, pipe.item, game.tick);
      ctx.restore();
    }
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

  // --- 彩虹上色與殘影 ------------------------------------------------------------
  // 黑貓幾乎沒有色相可言，單靠 hue-rotate 濾鏡看不出變化：先把向量貓畫進離屏圖層，
  // 用 source-atop 只對貓身上的像素上色，色相直接跟著 rainbowHue 轉。
  // 不另外疊 ctx.filter：軟體繪圖（GPU 被停用）時，一次 hue-rotate 貼圖要付整張畫布的濾鏡成本，
  // 衝刺那 3 秒會從 60fps 掉到 40fps；上色本身就已經是完整的彩虹
  const CLASSIC_LAYER = 96;
  const classicLayer = createLayer(CLASSIC_LAYER, CLASSIC_LAYER);

  // 圖層依目前的縮放比例建立實體像素，貼回主畫布時一比一，不會比直接畫糊
  function classicPaintLayer(rot, mood, tint, strength) {
    const w = Math.max(1, Math.round(CLASSIC_LAYER * view.sx));
    const h = Math.max(1, Math.round(CLASSIC_LAYER * view.sy));
    if (classicLayer.canvas.width !== w || classicLayer.canvas.height !== h) {
      classicLayer.canvas.width = w;
      classicLayer.canvas.height = h;
    }
    const layerCtx = classicLayer.ctx;
    layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    layerCtx.globalCompositeOperation = 'source-over';
    layerCtx.globalAlpha = 1;
    layerCtx.clearRect(0, 0, w, h);
    layerCtx.setTransform(w / CLASSIC_LAYER, 0, 0, h / CLASSIC_LAYER, 0, 0);
    const main = ctx;
    ctx = layerCtx;
    try {
      drawCat(CLASSIC_LAYER / 2, CLASSIC_LAYER / 2, rot, cat.tail, mood);
    } finally {
      ctx = main;
    }
    layerCtx.globalCompositeOperation = 'source-atop';
    layerCtx.globalAlpha = strength;
    layerCtx.fillStyle = tint;
    layerCtx.fillRect(0, 0, CLASSIC_LAYER, CLASSIC_LAYER);
    layerCtx.globalCompositeOperation = 'source-over';
    layerCtx.globalAlpha = 1;
  }

  function classicBlitLayer(x, y, alpha) {
    const half = CLASSIC_LAYER / 2;
    ctx.globalAlpha = alpha;
    ctx.drawImage(classicLayer.canvas, x - half, y - half, CLASSIC_LAYER, CLASSIC_LAYER);
    ctx.globalAlpha = 1;
  }

  function classicDrawPlayer(alpha) {
    const y = lerp(cat.prevY, cat.y, alpha);
    const rot = lerp(cat.prevRot, cat.rot, alpha);
    const mood = catMood();
    if (!rainbowActive() || !classicLayer) {
      drawCat(CAT.x, y, rot, cat.tail, mood);
      return;
    }
    const hue = rainbowHue(alpha);
    // 殘影由遠到近畫，最淡的在最底下，全部都在本尊後面
    for (let i = FRENZY.ghostLags.length - 1; i >= 0; i--) {
      const ghost = ghostAt(i, hue);
      if (!ghost) continue;
      classicPaintLayer(ghost.entry.rot, 'normal', `hsl(${Math.round(ghost.hue)}, 90%, 62%)`, 0.85);
      classicBlitLayer(ghost.x, ghost.entry.y, ghost.alpha);
    }
    // 本尊：用循環色相上色，強度跟著 trailFade 淡出
    classicPaintLayer(rot, mood, `hsl(${Math.round(hue)}, 95%, 58%)`, 0.62 * game.trailFade);
    classicBlitLayer(CAT.x, y, 1);
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
      // 撞散的碎屑與道具星光交給 classic:fx，座標、旋轉與透明度由它自己處理
      if (fx.kind === 'chip' || fx.kind === 'spark') {
        ctx.save();
        if (fx.kind === 'chip') classicDrawChip(ctx, fx);
        else classicDrawSpark(ctx, fx);
        ctx.restore();
        continue;
      }
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

  // --- 分數與面板 ----------------------------------------------------------------
  function drawScore() {
    drawText(String(game.score), VIEW_W / 2, 84, { size: 58, fill: '#FFFFFF', stroke: INK, strokeWidth: 9 });
    if (game.frenzy > 0) {
      ctx.save();
      classicDrawFrenzyMeter(ctx, game.frenzy / FRENZY.steps);
      ctx.restore();
    }
  }

  function drawPanel(x, y, w, h) {
    ctx.fillStyle = '#FFF8EE';
    roundRectPath(x, y, w, h, 22);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = WOOD;
    ctx.stroke();
  }

  // 'panel' 暫停／結算卡片、'pill' 開始畫面提示條、'badge' 新紀錄標籤
  function classicDrawPanel(x, y, w, h, style) {
    if (style === 'pill') {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
      roundRectPath(x, y, w, h, h / 2);
      ctx.fill();
    } else if (style === 'badge') {
      ctx.fillStyle = '#FF7FA0';
      roundRectPath(x, y, w, h, h / 2);
      ctx.fill();
    } else {
      drawPanel(x, y, w, h);
    }
  }

  // #region classic:fx
  // ---------------------------------------------------------------------------
  // classic:fx — 經典向量版的道具、家具碎屑、拾取閃光與無敵計量條
  // 沿用經典畫面的語彙：柔和漸層、圓角、深褐描邊；不取亂數，閃爍全由 tick／life 推導
  // ---------------------------------------------------------------------------
  // 描邊色直接用共用的 INK（經典區在像素區之前，INK 在最上面的常數區就宣告了，不會碰到 TDZ）
  const FXC_INK = INK;
  const FXC_EDGE = 'rgba(90, 58, 34, 0.5)';
  const FXC_GOLD = '#FFD36B';
  const FXC_RAINBOW = Object.freeze(['#FF9A8B', '#FFC27A', '#FFE683', '#A8DDA0', '#8FD0F2', '#B9A6EC']);
  const FXC_METER = Object.freeze({ w: 104, h: 10, y: 114, steps: FRENZY.steps });
  // 最後 1/4 的提醒色：空軌道是近白色，液面若也閃成白色就跟軌道糊成一片，看起來像已經見底；
  // 改用番茄紅，對白色軌道約 3.9:1，軌道透出較暗的牆色時也還有 3:1 以上（非文字元件建議至少 3:1）
  const FXC_METER_WARN = '#E04F4A';
  // 閃光點（相對道具中心，虛擬像素）與各自的相位差
  const FXC_TWINKLES = Object.freeze([
    { dx: -19, dy: -12, shift: 0 },
    { dx: 18, dy: -6, shift: 0.37 },
    { dx: -12, dy: 17, shift: 0.68 }
  ]);

  // 瓶底貓草葉：[x, y, 旋轉]
  const FXC_LEAVES = Object.freeze([[-5, 7, -0.6], [0, 5, 0.2], [5, 7, 0.8], [-2, 9.5, -0.2], [3.5, 10, 0.4], [-6.5, 11, 0.1]]);

  // 漸層只建一次（第一次繪製時才建立，屆時才拿得到 ctx）；都以「道具中心為原點」定義，使用前先 translate
  let fxcPaintCache = null;
  function fxcPaint(ctx) {
    if (fxcPaintCache) return fxcPaintCache;
    const linear = (x0, y0, x1, y1, stops) => {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      stops.forEach(([at, color]) => g.addColorStop(at, color));
      return g;
    };
    const radial = (r0, r1, stops) => {
      const g = ctx.createRadialGradient(0, 0, r0, 0, 0, r1);
      stops.forEach(([at, color]) => g.addColorStop(at, color));
      return g;
    };
    const rainbow = ctx.createLinearGradient(0, 0, FXC_METER.w, 0);
    FXC_RAINBOW.forEach((color, i) => rainbow.addColorStop(i / (FXC_RAINBOW.length - 1), color));
    fxcPaintCache = {
      halo: radial(2, 22, [[0, 'rgba(255, 246, 214, 0.95)'], [0.55, 'rgba(255, 240, 200, 0.45)'], [1, 'rgba(255, 240, 200, 0)']]),
      tin: linear(-13, 0, 13, 0, [[0, '#9AA1AB'], [0.2, '#F5F7F9'], [0.45, '#D4D9DF'], [1, '#858C96']]),
      lid: linear(0, -11, 0, -2, [[0, '#FFFFFF'], [1, '#C3C9D1']]),
      label: linear(-13, 0, 13, 0, [[0, '#8DB6D6'], [0.28, '#BCD8EE'], [1, '#7BA2C2']]),
      glass: linear(-10, 0, 10, 0, [[0, '#B9D8AE'], [0.28, '#EEF8E8'], [0.6, '#D3EBC9'], [1, '#98BF8B']]),
      leaf: linear(0, -4, 0, 12, [[0, '#8DB27A'], [1, '#56794A']]),
      cork: linear(-4, 0, 4, 0, [[0, '#D9B48B'], [0.4, '#E8CBA6'], [1, '#A77B52']]),
      rainbow
    };
    return fxcPaintCache;
  }

  function fxcRoundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  // 四角星（內凹的菱形），拾取閃光與道具周圍的眨眼都用它
  function fxcTwinklePath(ctx, size) {
    const k = size * 0.18;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.quadraticCurveTo(k, -k, size, 0);
    ctx.quadraticCurveTo(k, k, 0, size);
    ctx.quadraticCurveTo(-k, k, -size, 0);
    ctx.quadraticCurveTo(-k, -k, 0, -size);
    ctx.closePath();
  }

  // --- 道具 ------------------------------------------------------------------------
  function fxcCanBody(ctx) {
    ctx.beginPath();
    ctx.moveTo(-13, -6);
    ctx.lineTo(-13, 7);
    ctx.ellipse(0, 7, 13, 4.5, 0, Math.PI, 0, true);
    ctx.lineTo(13, -6);
    ctx.closePath();
  }

  function fxcDrawCan(ctx, tone, sweep) {
    fxcCanBody(ctx);
    ctx.fillStyle = tone.tin;
    ctx.fill();

    // 標籤與小魚：先裁成罐身，標籤下緣跟著罐身弧度
    ctx.save();
    fxcCanBody(ctx);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(-13, -2);
    ctx.ellipse(0, -2, 13, 4.5, 0, Math.PI, 0, true);
    ctx.lineTo(13, 4);
    ctx.ellipse(0, 4, 13, 4.5, 0, 0, Math.PI, false);
    ctx.closePath();
    ctx.fillStyle = tone.label;
    ctx.fill();
    ctx.fillStyle = '#FFF8EE';
    ctx.beginPath();
    ctx.ellipse(1.5, 3.2, 4.2, 2.4, 0, 0, Math.PI * 2);
    ctx.moveTo(-2.2, 3.2);
    ctx.lineTo(-6, 0.6);
    ctx.lineTo(-6, 5.8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#6F93B1';
    ctx.beginPath();
    ctx.arc(3.6, 2.6, 0.8, 0, Math.PI * 2);
    ctx.fill();
    // 左側高光與一道隨 tick 掃過的反光
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(-10, -7, 2.5, 17);
    if (sweep !== null) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.beginPath();
      ctx.moveTo(sweep - 3, -12);
      ctx.lineTo(sweep + 1, -12);
      ctx.lineTo(sweep - 5, 14);
      ctx.lineTo(sweep - 9, 14);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    fxcCanBody(ctx);
    ctx.lineWidth = 2;
    ctx.strokeStyle = FXC_INK;
    ctx.stroke();

    // 上蓋與拉環
    ctx.beginPath();
    ctx.ellipse(0, -6, 13, 4.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = tone.lid;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = FXC_INK;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, -6, 10, 3, 0, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120, 128, 140, 0.8)';
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(1.5, -6.6, 3.6, 1.7, 0, 0, Math.PI * 2);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#7D8590';
    ctx.stroke();
  }

  function fxcBottleBody(ctx) {
    fxcRoundRect(ctx, -10, -7, 20, 19, 7);
  }

  function fxcDrawGrass(ctx, tone, sweep) {
    // 軟木塞與瓶頸
    fxcRoundRect(ctx, -4.5, -15, 9, 6, 2);
    ctx.fillStyle = tone.cork;
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = FXC_INK;
    ctx.stroke();
    ctx.fillStyle = '#DDEFD5';
    ctx.fillRect(-5, -9.5, 10, 4);
    ctx.strokeRect(-5, -9.5, 10, 4);

    fxcBottleBody(ctx);
    ctx.fillStyle = tone.glass;
    ctx.fill();

    ctx.save();
    fxcBottleBody(ctx);
    ctx.clip();
    // 瓶底一堆貓草葉
    ctx.fillStyle = tone.leaf;
    for (const [lx, ly, rot] of FXC_LEAVES) {
      ctx.beginPath();
      ctx.ellipse(lx, ly, 2.6, 4.6, rot, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(60, 85, 50, 0.55)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const [lx, ly, rot] of FXC_LEAVES) {
      ctx.moveTo(lx - Math.sin(rot) * 3.6, ly + Math.cos(rot) * 3.6);
      ctx.lineTo(lx + Math.sin(rot) * 3.6, ly - Math.cos(rot) * 3.6);
    }
    ctx.stroke();
    // 淡抹茶色標籤＋葉子記號
    fxcRoundRect(ctx, -7, -3.5, 14, 7, 2);
    ctx.fillStyle = '#F4F7EC';
    ctx.fill();
    ctx.fillStyle = '#7FA56E';
    ctx.beginPath();
    ctx.ellipse(0, 0, 1.7, 2.8, 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fillRect(-7.5, -5, 2.2, 14);
    if (sweep !== null) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.beginPath();
      ctx.moveTo(sweep - 3, -12);
      ctx.lineTo(sweep + 1, -12);
      ctx.lineTo(sweep - 5, 14);
      ctx.lineTo(sweep - 9, 14);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    fxcBottleBody(ctx);
    ctx.lineWidth = 2;
    ctx.strokeStyle = FXC_INK;
    ctx.stroke();
    // 瓶頸麻繩
    ctx.fillStyle = FXC_INK;
    ctx.fillRect(-5.5, -7.8, 11, 1.6);
  }

  function classicDrawItem(ctx, x, y, kind, tick) {
    const t = tick || 0;
    const tone = fxcPaint(ctx);
    // 反光 48 步掃一次：前 24 步從左掃到右，後 24 步休息
    const cycle = t % 48;
    const sweep = cycle < 24 ? -16 + (cycle / 24) * 36 : null;

    ctx.save();
    ctx.translate(x, y);
    const base = ctx.globalAlpha;
    ctx.globalAlpha = base * (0.75 + Math.sin(t * 0.08) * 0.2);
    ctx.fillStyle = tone.halo;
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = base;

    if (kind === 'grass') fxcDrawGrass(ctx, tone, sweep);
    else fxcDrawCan(ctx, tone, sweep);

    // 周圍的四角星輪流眨眼
    for (const site of FXC_TWINKLES) {
      const phase = (t / 48 + site.shift) % 1;
      const glow = Math.sin(phase * Math.PI * 2);
      if (glow <= 0.05) continue;
      ctx.save();
      ctx.translate(site.dx, site.dy);
      ctx.rotate(phase * 0.8);
      fxcTwinklePath(ctx, 2 + glow * 4);
      ctx.fillStyle = FXC_GOLD;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = FXC_EDGE;
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(0, 0, 0.6 + glow, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  // --- 粒子 --------------------------------------------------------------------------
  function fxcFade(fx) {
    const fade = fx.maxLife > 0 ? clamp(fx.life / fx.maxLife, 0, 1) : 0;
    return (fx.alpha === undefined ? 1 : fx.alpha) * fade;
  }

  // 家具碎屑：歪斜的小木片／麻繩屑／葉片，形狀由 size 決定，不取亂數
  function classicDrawChip(ctx, fx) {
    const a = fxcFade(fx);
    if (a <= 0) return;
    const s = Math.max(2, fx.size || 4);
    ctx.save();
    ctx.translate(fx.x, fx.y);
    ctx.rotate(fx.rot || 0);
    ctx.globalAlpha *= a;
    ctx.beginPath();
    ctx.moveTo(-s * 0.55, -s * 0.3);
    ctx.lineTo(s * 0.35, -s * 0.42);
    ctx.lineTo(s * 0.6, s * 0.22);
    ctx.lineTo(-s * 0.3, s * 0.4);
    ctx.closePath();
    ctx.fillStyle = typeof fx.color === 'string' ? fx.color : '#C8A27A';
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1;
    ctx.strokeStyle = FXC_EDGE;
    ctx.stroke();
    // 亮面
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath();
    ctx.moveTo(-s * 0.4, -s * 0.22);
    ctx.lineTo(s * 0.25, -s * 0.3);
    ctx.lineTo(s * 0.1, -s * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 拾取閃光：四角星隨壽命縮小，中心一顆白點
  function classicDrawSpark(ctx, fx) {
    const a = fxcFade(fx);
    if (a <= 0) return;
    const fade = fx.maxLife > 0 ? clamp(fx.life / fx.maxLife, 0, 1) : 0;
    const size = Math.max(2, fx.size || 6) * (0.45 + 0.55 * fade);
    ctx.save();
    ctx.translate(fx.x, fx.y);
    ctx.rotate((fx.rot || 0) * 0.5);
    ctx.globalAlpha *= a;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.55, 0, Math.PI * 2);
    ctx.fill();
    fxcTwinklePath(ctx, size);
    ctx.fillStyle = typeof fx.color === 'string' ? fx.color : FXC_GOLD;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = FXC_EDGE;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // --- 無敵衝刺計量條：分數下方的圓角彩虹條，剩最後 1/4 時閃成番茄紅提醒 ------------------------
  function classicDrawFrenzyMeter(ctx, t) {
    const remain = clamp(Number(t) || 0, 0, 1);
    if (remain <= 0) return;
    const tone = fxcPaint(ctx);
    const { w, h, y } = FXC_METER;
    const x = VIEW_W / 2 - w / 2;
    const r = h / 2;
    const step = Math.round(remain * FXC_METER.steps);
    const warn = frenzyMeterWarn(remain, step);

    ctx.save();
    ctx.fillStyle = 'rgba(90, 58, 34, 0.18)';
    fxcRoundRect(ctx, x, y + 2, w, h, r);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    fxcRoundRect(ctx, x, y, w, h, r);
    ctx.fill();

    ctx.save();
    fxcRoundRect(ctx, x, y, w, h, r);
    ctx.clip();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.rect(0, 0, w * remain, h);
    ctx.fillStyle = warn ? FXC_METER_WARN : tone.rainbow;
    ctx.fill();
    // 斜紋隨剩餘時間流動
    ctx.clip();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.beginPath();
    const shift = (step * 0.5) % 12;
    for (let sx = -12 + shift; sx < w + 12; sx += 12) {
      ctx.moveTo(sx, h);
      ctx.lineTo(sx + 5, 0);
      ctx.lineTo(sx + 10, 0);
      ctx.lineTo(sx + 5, h);
      ctx.closePath();
    }
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fillRect(0, 1.5, w * remain, 2);
    ctx.restore();

    fxcRoundRect(ctx, x, y, w, h, r);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = FXC_INK;
    ctx.stroke();
    ctx.restore();
  }
  // #endregion classic:fx
  // #endregion theme:classic

  // #region theme:pixel16
  // ===========================================================================
  // 16-bit 像素主題：整個場景先畫進 180×320 的低解析緩衝區（1 美術像素 = 2 虛擬像素），
  // 再關掉平滑、以最近鄰放大貼回主畫布。這一區只用對齊網格的整數矩形，不畫任何曲線
  // ===========================================================================

  // 低彩度日系客廳調色盤（規格指定的主色；美術片段可以衍生同色系深淺）
  const PAL = Object.freeze({
    wallLight: '#E8E3D9', // 牆面米白
    wallShade: '#D5CFC4', // 亞麻灰
    walnut: '#785338',    // 胡桃木
    oak: '#B38B6D',       // 淺木
    sage: '#6A7F60',      // 灰綠
    moss: '#4D5D44',      // 抹茶綠（深）
    catBody: '#1E1E24',   // 墨黑
    catEye: '#D4E157',    // 亮黃綠眼
    catPad: '#F48FB1'     // 粉嫩肉球
  });

  // 決定性雜湊：同樣的 n 永遠得到同樣的 [0, 1)。繪製程式碼一律用它取代亂數（亂數會閃爍，也會干擾測試）
  function hash01(n) {
    let h = Math.imul((n | 0) ^ 0x9E3779B9, 0x85EBCA6B);
    h ^= h >>> 13;
    h = Math.imul(h, 0xC2B2AE35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // 像素繪圖 API：所有座標都是「美術像素」，一律取整後才畫，保證落在網格上
  function createPix(pctx) {
    const fill = (x, y, w, h, color) => {
      pctx.fillStyle = color;
      pctx.fillRect(x, y, w, h);
    };
    return {
      ctx: pctx,
      rect(x, y, w, h, color) {
        const x0 = Math.round(x);
        const y0 = Math.round(y);
        const x1 = Math.round(x + w);
        const y1 = Math.round(y + h);
        if (x1 > x0 && y1 > y0) fill(x0, y0, x1 - x0, y1 - y0, color);
      },
      dot(x, y, color) {
        fill(Math.round(x), Math.round(y), 1, 1, color);
      },
      alpha(a) {
        pctx.globalAlpha = a;
      },
      // rows：等寬字串陣列，'.' 與空白是透明；palette：{ 字元: 顏色 }
      // (cx, cy)：錨點落在畫面上的位置；opts.ax / opts.ay：錨點在 sprite 內的座標（預設正中央）
      // opts.sx / opts.sy：水平／垂直縮放，以錨點為中心做最近鄰取樣（Squash & Stretch 用）
      sprite(rows, palette, cx, cy, opts) {
        const o = opts || {};
        const h = rows.length;
        const w = rows[0].length;
        const sx = o.sx || 1;
        const sy = o.sy || 1;
        const ax = o.ax === undefined ? w / 2 : o.ax;
        const ay = o.ay === undefined ? h / 2 : o.ay;
        const left = Math.floor(cx - ax * sx);
        const right = Math.ceil(cx + (w - ax) * sx);
        const top = Math.floor(cy - ay * sy);
        const bottom = Math.ceil(cy + (h - ay) * sy);
        for (let dy = top; dy < bottom; dy++) {
          const v = Math.floor((dy + 0.5 - cy) / sy + ay);
          if (v < 0 || v >= h) continue;
          const row = rows[v];
          let runStart = left;
          let runColor = null;
          for (let dx = left; dx <= right; dx++) {
            let color = null;
            if (dx < right) {
              const u = Math.floor((dx + 0.5 - cx) / sx + ax);
              if (u >= 0 && u < w) {
                const ch = row[u];
                if (ch !== '.' && ch !== ' ') color = palette[ch] || null;
              }
            }
            if (color !== runColor) {
              if (runColor) fill(runStart, dy, dx - runStart, 1, runColor);
              runStart = dx;
              runColor = color;
            }
          }
        }
      }
    };
  }

  // 低解析緩衝區只建一次；建不起來就整個主題停用，render() 會退回經典
  const pixelBuffer = (() => {
    const layer = createLayer(LOW_W, LOW_H);
    if (!layer) return null;
    layer.ctx.imageSmoothingEnabled = false;
    layer.pix = createPix(layer.ctx);
    return layer;
  })();

  // 殘影先畫進獨立的小圖層再整張半透明貼上，貓身各部位重疊處才不會疊出深淺不一的色塊
  const PIXEL_GHOST = 64;
  const pixelGhost = (() => {
    if (!pixelBuffer) return null;
    const layer = createLayer(PIXEL_GHOST, PIXEL_GHOST);
    if (!layer) return null;
    layer.ctx.imageSmoothingEnabled = false;
    layer.pix = createPix(layer.ctx);
    return layer;
  })();

  // --- 彩虹調色盤 ----------------------------------------------------------------
  // 每個部位往「同色相、各自亮度」的 HSL 色混合：身體混最多，眼睛與白手套只帶一點色。
  // 身體亮度壓在 40：亮度 50 時黃、青色相的貓幾乎融進米白牆；眼睛只混一點，臉才讀得出來。
  // 色相量化成 24 階、強度 8 階後快取，每幀不必重組字串
  const RAINBOW_SAT = 72;
  const RAINBOW_TONES = Object.freeze({
    body: [1, 40],
    shade: [1, 28],
    rim: [1, 58],
    earIn: [0.7, 66],
    pupil: [0.5, 16],
    eye: [0.15, 70],
    glove: [0.3, 88],
    pad: [0.3, 76],
    nose: [0.4, 70],
    white: [0.2, 94]
  });
  const rainbowCache = new Map();
  const ghostCache = new Map();

  function pixelHueStep(hue) {
    return ((Math.round(hue / 15) % 24) + 24) % 24;
  }

  function pixelHexRgb(color) {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(typeof color === 'string' ? color.trim() : '');
    if (!match) return null;
    const hex = match[1].length === 3 ? match[1].replace(/./g, (c) => c + c) : match[1];
    const n = parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function pixelHslRgb(h, s, l) {
    const sat = s / 100;
    const light = l / 100;
    const a = sat * Math.min(light, 1 - light);
    const channel = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round((light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
    };
    return [channel(0), channel(8), channel(4)];
  }

  function pixelRgbString(rgb) {
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  function pixelMix(base, target, t) {
    const from = pixelHexRgb(base);
    if (!from) return t >= 0.5 ? pixelRgbString(target) : base;
    return pixelRgbString([
      Math.round(lerp(from[0], target[0], t)),
      Math.round(lerp(from[1], target[1], t)),
      Math.round(lerp(from[2], target[2], t))
    ]);
  }

  function rainbowPalette(hue, strength) {
    const level = Math.round(clamp(strength, 0, 1) * 8);
    if (level === 0) return PIXEL_CAT_PALETTE;
    const step = pixelHueStep(hue);
    const key = step * 16 + level;
    let palette = rainbowCache.get(key);
    if (!palette) {
      palette = {};
      for (const name of Object.keys(PIXEL_CAT_PALETTE)) {
        const tone = RAINBOW_TONES[name] || [0.5, 55];
        palette[name] = pixelMix(PIXEL_CAT_PALETTE[name], pixelHslRgb(step * 15, RAINBOW_SAT, tone[1]), (level / 8) * tone[0]);
      }
      rainbowCache.set(key, palette);
    }
    return palette;
  }

  // 殘影：每個部位都是同一個顏色，只剩剪影；亮度 54，黃、青色相的半透明殘影在米白牆上才看得到
  function ghostPalette(hue) {
    const step = pixelHueStep(hue);
    let palette = ghostCache.get(step);
    if (!palette) {
      const color = pixelRgbString(pixelHslRgb(step * 15, 80, 54));
      palette = {};
      for (const name of Object.keys(PIXEL_CAT_PALETTE)) palette[name] = color;
      ghostCache.set(step, palette);
    }
    return palette;
  }

  // --- 場景 ----------------------------------------------------------------------
  function pixelRenderScene(alpha) {
    const bufferCtx = pixelBuffer.ctx;
    bufferCtx.setTransform(1, 0, 0, 1, 0, 0);
    bufferCtx.globalAlpha = 1;
    bufferCtx.globalCompositeOperation = 'source-over';
    bufferCtx.imageSmoothingEnabled = false;
    bufferCtx.fillStyle = PAL.wallShade;
    bufferCtx.fillRect(0, 0, LOW_W, LOW_H);
    drawScene(Themes.pixel16, alpha);
    bufferCtx.globalAlpha = 1;

    // 貼回主畫布：先鋪底色（震動時露出的邊緣不會殘留上一幀），每幀都重新關掉平滑（改尺寸會被重設）。
    // 往下震時上緣露出的是天花板迴緣的木色，家具柱子看起來是伸進迴緣後面，而不是跟天花板脫開
    const bleed = SHAKE.amplitude * 2;
    ctx.fillStyle = PAL.wallShade;
    ctx.fillRect(-bleed, 0, VIEW_W + bleed * 2, GROUND_Y);
    ctx.fillStyle = BG_C.wood;
    ctx.fillRect(-bleed, -bleed, VIEW_W + bleed * 2, bleed);
    ctx.fillStyle = PAL.walnut;
    ctx.fillRect(-bleed, GROUND_Y, VIEW_W + bleed * 2, GROUND_H + bleed);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pixelBuffer.canvas, 0, 0, VIEW_W, VIEW_H);
  }

  function pixelDrawLayers(scroll) {
    const pix = pixelBuffer.pix;
    pixelDrawBackground(pix, scroll);
    pixelDrawMotes(pix, game.motes);
    pix.alpha(1);
  }

  function pixelDrawFloor(scroll) {
    const pix = pixelBuffer.pix;
    pixelDrawGround(pix, scroll);
    pix.alpha(1);
  }

  // 障礙物的美術像素 x：跟地板用同一個取整後的捲動量換算。障礙物與捲動量每步移動同樣的距離，
  // (x + scroll) 對每組障礙物是常數；先把這個「世界座標」取整、再減掉地板的 floor(scroll / PX)，
  // 家具腳才會一直踩在同一條地板接縫上。各自取整的話兩者換格的時機不同，地板會在家具底下左右抖 1 格。
  // 兩邊都用 floor：誤差 = frac(scroll / PX) − frac(世界座標)，左右平均、不超過 1 格；
  // 世界座標用 round 的話會多出 frac(scroll / PX) 的偏移，家具整體往右偏約半格、最多 1.5 格。
  // 1e-6 讓剛好落在整數上的世界座標（生成點 364、每步 2.2，約每 10 局就有 1 局如此）不會因浮點誤差在兩格間來回跳
  function pixelObstacleAx(pipe, alpha, scroll) {
    return Math.floor((lerp(pipe.prevX, pipe.x, alpha) + scroll) / PX + 1e-6) - Math.floor(scroll / PX);
  }

  // 家具的縫隙上下緣先取整，再由上緣推下緣，確保縫隙永遠剛好 GAP_AH 高
  function pixelDrawObstacles(alpha) {
    const pix = pixelBuffer.pix;
    const scroll = lerp(game.prevScroll, game.scroll, alpha);
    for (const pipe of game.pipes) {
      const ax = pixelObstacleAx(pipe, alpha, scroll);
      const gapTop = Math.round((pipe.gapY - PIPE.gap / 2) / PX);
      pixelDrawObstacle(pix, ax, gapTop, gapTop + GAP_AH, pipe.variant, pipe.brokenTop, pipe.brokenBottom);
    }
    pix.alpha(1);
  }

  // 道具的 x 跟著家具的格線走（PIPE.width / 2 剛好是整數個美術像素），不會跟縫隙錯開 1 格
  function pixelDrawItems(alpha) {
    const pix = pixelBuffer.pix;
    const bob = itemBob();
    const scroll = lerp(game.prevScroll, game.scroll, alpha);
    for (const pipe of game.pipes) {
      if (!pipe.item) continue;
      const cx = pixelObstacleAx(pipe, alpha, scroll) + PIPE_AW / 2;
      const cy = Math.round((pipe.gapY + bob) / PX);
      pixelDrawItem(pix, cx, cy, pipe.item, game.tick);
    }
    pix.alpha(1);
  }

  function pixelDrawEffects(layer) {
    const pix = pixelBuffer.pix;
    for (const fx of game.effects) {
      if (fx.layer === layer) pixelDrawEffect(pix, fx);
    }
    pix.alpha(1);
  }

  // 同一個 look 物件每幀重複使用，不在熱路徑上配置記憶體
  const pixelLook = { pose: 'idle', mood: 'normal', sx: 1, sy: 1, tail: 0, palette: null };

  function pixelDrawPlayer(alpha) {
    const pix = pixelBuffer.pix;
    const rainbow = rainbowActive();
    const hue = rainbowHue(alpha);
    if (rainbow) {
      // 殘影由遠到近畫，最淡的在最底下，全部都在本尊後面
      for (let i = FRENZY.ghostLags.length - 1; i >= 0; i--) {
        const ghost = ghostAt(i, hue);
        if (ghost) pixelDrawGhost(ghost);
      }
    }
    pixelLook.pose = catPose();
    pixelLook.mood = catMood();
    pixelLook.sx = lerp(cat.prevSx, cat.sx, alpha);
    pixelLook.sy = lerp(cat.prevSy, cat.sy, alpha);
    pixelLook.tail = cat.tail;
    pixelLook.palette = rainbow ? rainbowPalette(hue, game.trailFade) : PIXEL_CAT_PALETTE;
    pixelDrawCat(pix, CAT_AX, lerp(cat.prevY, cat.y, alpha) / PX, pixelLook);
    pix.alpha(1);
  }

  function pixelDrawGhost(ghost) {
    const entry = ghost.entry;
    pixelLook.pose = entry.pose;
    pixelLook.mood = 'normal';
    pixelLook.sx = entry.sx;
    pixelLook.sy = entry.sy;
    pixelLook.tail = cat.tail;
    pixelLook.palette = ghostPalette(ghost.hue);
    const gx = Math.round(ghost.x / PX);
    const gy = Math.round(entry.y / PX);
    // 殘影圖層一定存在：建不起來時 pixelAvailable() 為 false，整個主題已退回經典
    const half = PIXEL_GHOST / 2;
    pixelGhost.ctx.globalAlpha = 1;
    pixelGhost.ctx.clearRect(0, 0, PIXEL_GHOST, PIXEL_GHOST);
    pixelDrawCat(pixelGhost.pix, half, half, pixelLook);
    const bufferCtx = pixelBuffer.ctx;
    bufferCtx.globalAlpha = ghost.alpha;
    bufferCtx.drawImage(pixelGhost.canvas, gx - half, gy - half);
    bufferCtx.globalAlpha = 1;
  }

  // 分數與衝刺計時條直接畫進緩衝區，跟場景一起放大，維持像素顆粒
  function pixelDrawHud() {
    const pix = pixelBuffer.pix;
    pixelDrawScore(pix, game.score);
    if (game.frenzy > 0) pixelDrawFrenzyMeter(pix, game.frenzy / FRENZY.steps);
    pix.alpha(1);
  }

  function pixelDebrisColors(variant, half) {
    const set = PIXEL_DEBRIS[variant];
    const list = set && set[half];
    return Array.isArray(list) && list.length ? list : CLASSIC_DEBRIS;
  }

  // #region pixel:bg
  // ---------------------------------------------------------------------------
  // 像素背景：遠景客廳牆面（0.3× 視差）、踢腳板、近景木地板（1.0×）與飄浮微塵
  // 牆上擺設在載入時就排成「矩形清單」，每幀只做平移＋裁切，不配置新物件
  // ---------------------------------------------------------------------------

  // 遠景一律偏亮、低對比：墨黑的貓與胡桃木家具都得從牆面「跳出來」
  const BG_C = Object.freeze({
    wall: PAL.wallLight,   // 米白牆
    wallDot: '#DED8CD',    // 砂壁斑點（暗）
    wallFleck: '#EFEBE4',  // 砂壁斑點（亮）
    wallShadow: '#DAD4C9', // 擺設投在牆上的影子
    ceilShadow: '#DFDAD0', // 天花板迴緣下的淡影
    wallTop: '#E2DDD3',    // 牆面上緣三階色帶（天花板下稍暗，往下漸亮）
    wallMid: '#E4DFD5',
    wallLow: '#E6E1D7',
    lampHi: '#FBF8F1',     // 和紙吊燈：亮
    lamp: '#F5F0E5',
    lampRib: '#E4DCCD',
    cord: '#B3A898',
    wain: PAL.wallShade,   // 亞麻灰腰壁
    wainSeam: '#CAC3B7',
    wainHi: '#D9D4CA',
    wainShadow: '#C8C1B5',
    woodHi: '#DDCEBA',     // 遠景淺木（障子框、書架、畫框）
    wood: '#C9B49B',
    woodMid: '#BAA389',
    woodLo: '#A89077',
    baseHi: '#C8B29A',     // 踢腳板
    base: '#AD9479',
    baseLo: '#8E765E',
    shojiHi: '#E4D8C7',
    shoji: '#D5C3AB',
    shojiLo: '#BDA88E',
    kumiko: '#D9CBB8',
    paperHi: '#F8F5EE',    // 障子紙：上半透著日光
    paper: '#F4F1EA',
    paperLo: '#EFEBE3',
    paperLeaf: '#DCD6CA',  // 竹影
    kick: '#CDB9A0',       // 障子下方的腰板
    kickLo: '#B7A287',
    sky: '#E1E6E3',        // 半開障子外的庭院
    garden: '#C3CCB6',
    gardenLo: '#B0BAA2',
    bamboo: '#B8C3A7',
    back: '#CFC4B4',       // 書架內壁
    backShade: '#C0B4A2',
    potHi: '#CDB8A0',
    pot: '#B89F85',
    leaf: '#A7B39A',       // 遠景植物：灰綠／抹茶綠提亮
    leafLo: '#8F9D85',
    mat: '#F2EEE6',        // 畫框襯紙
    ink: '#A6A095',        // 掛軸墨色
    inkLight: '#C8C3B8',
    silk: '#D6CCB9',       // 掛軸裱布
    silkLo: '#C2B6A0',
    scrollPaper: '#F3EFE6',
    face: '#F4F1EA',       // 時鐘面
    tick: '#B6AA9A',
    hand: '#857666',
    brass: '#CDBB90',
    brassLo: '#B3A276',
    glass: '#DDD6C9',
    photoSky: '#DCE1DE',
    photoMount: '#B8BFC0',
    photoSnow: '#F3F1EB',
    photoHill: '#BAC3AB',
    photoHillLo: '#A7B39B',
    photoWarm: '#ECE3D1',
    photoSun: '#E4D0A8',
    mote: '#FFFBF0'        // 微塵：暖白
  });

  // 書背：低彩度的亞麻、灰綠、灰粉、灰藍、麥稈色
  const BG_BOOKS = Object.freeze(['#CABFAE', '#B7BFAB', '#CDB7A9', '#B5B9BC', '#D2C6A7', '#AE9F8E', '#C3B39B', '#BEC5BC']);

  const BG_FAR_RATE = 0.3;                       // 遠景捲動倍率（障礙物的 0.3×）
  const BG_RAIL_AY = 224;                        // 腰壁見切（橫木）224..226
  const BG_WAIN_AY = BG_RAIL_AY + 3;             // 腰壁 227..281
  const BG_BASE_AY = GROUND_AY - BASEBOARD_AH;   // 踢腳板 282..289
  const BG_WAIN_STEP = 24;                       // 腰壁木板寬
  const BG_TEX_CELL = 24;                        // 砂壁斑點取樣格

  // 圓形掃描線（直徑 d），寬度相同的連續列合併成一個矩形：[dx, dy, w, h, ...]
  function bgDiscRuns(d) {
    const out = [];
    const rr = (d / 2) * (d / 2);
    let runX = -1;
    let runY = 0;
    for (let y = 0; y <= d; y++) {
      let x0 = -2;
      if (y < d) {
        const cy = y + 0.5 - d / 2;
        x0 = Math.round(d / 2 - Math.sqrt(Math.max(0, rr - cy * cy)));
      }
      if (x0 !== runX) {
        if (runX >= 0) out.push(runX, runY, d - runX * 2, y - runY);
        runX = x0;
        runY = y;
      }
    }
    return out;
  }

  function bgDisc(r, x, y, d, color) {
    const runs = bgDiscRuns(d);
    for (let i = 0; i < runs.length; i += 4) r.push(x + runs[i], y + runs[i + 1], runs[i + 2], runs[i + 3], color);
  }

  // 由上往下變寬的階梯三角（山形），同寬的列合併
  function bgStepHill(r, cx, top, rows, slope, color, maxW) {
    let prevW = -1;
    let runY = top;
    for (let k = 0; k <= rows; k++) {
      const w = k < rows ? Math.min(maxW - ((maxW + 1) % 2), 1 + 2 * Math.floor(k * slope)) : -1;
      if (w !== prevW) {
        if (prevW > 0) r.push(cx - (prevW - 1) / 2, runY, prevW, top + k - runY, color);
        prevW = w;
        runY = top + k;
      }
    }
  }

  // 竹影（相對於障子單扇左上角）：竹竿、兩個竹節、三簇往下垂的細長竹葉
  const BG_LEAF_RECTS = Object.freeze([
    14, 2, 2, 62, 13, 18, 4, 1, 13, 40, 4, 1,
    7, 15, 6, 1, 4, 16, 4, 1, 2, 17, 3, 1,
    8, 19, 5, 1, 5, 20, 4, 1, 4, 21, 2, 1,
    16, 14, 5, 1, 20, 15, 4, 1, 23, 16, 2, 1,
    16, 37, 6, 1, 21, 38, 3, 1, 23, 39, 2, 1,
    16, 41, 5, 1, 20, 42, 3, 1,
    9, 44, 4, 1, 6, 45, 4, 1
  ]);

  // --- 障子窗：兩扇拉門，上亮下暗的和紙、組子格、腰板；可能半開或映著竹影 --------------
  function bgShojiPanel(r, px, py, leaves) {
    r.push(px, py, 28, 78, BG_C.shoji);
    r.push(px + 2, py + 2, 24, 20, BG_C.paperHi);
    r.push(px + 2, py + 22, 24, 21, BG_C.paper);
    r.push(px + 2, py + 43, 24, 21, BG_C.paperLo);
    if (leaves) {
      // 窗外竹子的影子：一根竹竿＋幾片往下垂的葉子（階梯狀）
      const L = BG_LEAF_RECTS;
      for (let i = 0; i < L.length; i += 4) r.push(px + L[i], py + L[i + 1], L[i + 2], L[i + 3], BG_C.paperLeaf);
    }
    for (let k = 8; k < 62; k += 9) r.push(px + 2, py + 2 + k, 24, 1, BG_C.kumiko);
    r.push(px + 9, py + 2, 1, 62, BG_C.kumiko);
    r.push(px + 18, py + 2, 1, 62, BG_C.kumiko);
    r.push(px + 2, py + 66, 24, 10, BG_C.kick);
    r.push(px + 2, py + 66, 24, 1, BG_C.kickLo);
    r.push(px, py, 1, 78, BG_C.shojiHi);
    r.push(px, py, 28, 1, BG_C.shojiHi);
    r.push(px + 27, py, 1, 78, BG_C.shojiLo);
  }

  function bgBuildShoji(r, x, seed) {
    const y = BG_RAIL_AY - 86;          // 窗台正好坐在腰壁橫木上
    const open = hash01(seed + 1) < 0.4;
    const leaves = !open && hash01(seed + 2) < 0.75;
    r.push(x + 1, y + 1, 62, 86, BG_C.wallShadow);
    r.push(x, y, 62, 86, BG_C.wood);
    r.push(x, y, 62, 1, BG_C.woodHi);
    r.push(x, y, 1, 86, BG_C.woodHi);
    r.push(x + 61, y, 1, 86, BG_C.woodLo);
    r.push(x + 3, y + 3, 56, 1, BG_C.woodLo);
    r.push(x + 3, y + 82, 56, 1, BG_C.woodHi);
    if (open) {
      // 右扇拉到左扇前面，右側露出庭院：天空、竹子、樹籬
      r.push(x + 47, y + 4, 12, 78, BG_C.sky);
      r.push(x + 47, y + 36, 12, 46, BG_C.garden);
      r.push(x + 47, y + 58, 12, 24, BG_C.gardenLo);
      r.push(x + 53, y + 4, 2, 54, BG_C.bamboo);
      r.push(x + 52, y + 20, 4, 1, BG_C.gardenLo);
      bgShojiPanel(r, x + 3, y + 4, leaves);
      bgShojiPanel(r, x + 19, y + 4, false);
    } else {
      bgShojiPanel(r, x + 3, y + 4, false);
      bgShojiPanel(r, x + 31, y + 4, leaves);
    }
    return 62;
  }

  // --- 書架：落地三層，書背低彩度，頂上擺小盆栽或花瓶 ------------------------------
  function bgBuildShelf(r, x, seed) {
    const W = 44;
    const y0 = GROUND_AY - 84;          // 206
    r.push(x + W, y0 + 1, 1, BG_RAIL_AY - y0 - 1, BG_C.wallShadow);
    r.push(x + W, BG_WAIN_AY, 1, BG_BASE_AY - BG_WAIN_AY, BG_C.wainShadow);
    r.push(x, y0, W, 84, BG_C.wood);
    const tiers = [[y0 + 3, 24], [y0 + 29, 23], [y0 + 54, 24]];
    for (let t = 0; t < 3; t++) {
      const ty = tiers[t][0];
      const th = tiers[t][1];
      r.push(x + 3, ty, 38, th, BG_C.back);
      r.push(x + 3, ty, 38, 2, BG_C.backShade);
      r.push(x + 3, ty, 2, th, BG_C.backShade);
      bgShelfTier(r, x + 3, ty, th, seed * 7 + t * 31);
      r.push(x + 3, ty + th, 38, 1, BG_C.woodHi);
    }
    r.push(x, y0, W, 1, BG_C.woodHi);
    r.push(x, y0, 1, 84, BG_C.woodHi);
    r.push(x + W - 1, y0, 1, 84, BG_C.woodLo);
    r.push(x, GROUND_AY - 1, W, 1, BG_C.woodLo);
    // 頂上：小盆栽／花瓶＋枝條／平放的書
    const top = Math.floor(hash01(seed + 5) * 3);
    if (top === 0) {
      r.push(x + 30, y0 - 6, 8, 6, BG_C.pot);
      r.push(x + 30, y0 - 6, 8, 1, BG_C.potHi);
      r.push(x + 29, y0 - 11, 6, 5, BG_C.leaf);
      r.push(x + 33, y0 - 14, 6, 8, BG_C.leaf);
      r.push(x + 27, y0 - 9, 3, 2, BG_C.leafLo);
      r.push(x + 37, y0 - 11, 4, 3, BG_C.leafLo);
      r.push(x + 35, y0 - 14, 2, 3, BG_C.leafLo);
    } else if (top === 1) {
      r.push(x + 8, y0 - 9, 5, 9, BG_C.photoSky);
      r.push(x + 9, y0 - 11, 3, 2, BG_C.photoSky);
      r.push(x + 8, y0 - 9, 1, 9, BG_C.mat);
      r.push(x + 10, y0 - 20, 1, 9, BG_C.woodMid);
      r.push(x + 11, y0 - 24, 1, 5, BG_C.woodMid);
      r.push(x + 7, y0 - 17, 3, 1, BG_C.woodMid);
      r.push(x + 12, y0 - 22, 2, 2, BG_C.photoSun);
      r.push(x + 8, y0 - 19, 2, 2, BG_C.photoSun);
    } else {
      r.push(x + 6, y0 - 2, 14, 2, BG_BOOKS[1]);
      r.push(x + 7, y0 - 4, 12, 2, BG_BOOKS[4]);
      r.push(x + 6, y0 - 6, 13, 2, BG_BOOKS[2]);
    }
    return W + 1;
  }

  function bgShelfTier(r, x, ty, th, seed) {
    const floorY = ty + th;
    let bx = x + 2;
    const stop = x + 38 - Math.floor(hash01(seed) * 3) * 5 - 4;
    let i = 0;
    // 隨機（決定性）留一個空位，擺橫放的書堆或收納盒
    const gapAt = 2 + Math.floor(hash01(seed + 1) * 5);
    while (bx < stop) {
      if (i === gapAt) {
        const kind = hash01(seed + 2) < 0.5;
        if (kind) {
          r.push(bx + 1, floorY - 2, 9, 2, BG_BOOKS[(seed + 3) % 8]);
          r.push(bx + 2, floorY - 4, 8, 2, BG_BOOKS[(seed + 5) % 8]);
        } else {
          r.push(bx + 1, floorY - 8, 9, 8, BG_C.pot);
          r.push(bx + 1, floorY - 8, 9, 1, BG_C.potHi);
          r.push(bx + 1, floorY - 5, 9, 1, BG_C.woodLo);
        }
        bx += 11;
        i++;
        continue;
      }
      const h = Math.max(9, th - 3 - Math.floor(hash01(seed + i * 13 + 7) * 8));
      const w = 2 + Math.floor(hash01(seed + i * 13 + 8) * 3);
      if (bx + w > x + 38) break;
      const c = BG_BOOKS[Math.floor(hash01(seed + i * 13 + 9) * BG_BOOKS.length)];
      r.push(bx, floorY - h, w, h, c);
      if (w >= 3) r.push(bx, floorY - h + 3, w, 1, BG_C.mat);
      bx += w;
      i++;
    }
  }

  // --- 畫框：淺木框＋襯紙＋小風景（富士山／丘陵與夕陽／圓相） --------------------------
  function bgPhoto(r, x, y, w, h, kind) {
    r.push(x + 1, y + 1, w, h, BG_C.wallShadow);
    r.push(x, y, w, h, BG_C.wood);
    r.push(x, y, w, 1, BG_C.woodHi);
    r.push(x, y, 1, h, BG_C.woodHi);
    r.push(x + 2, y + 2, w - 4, h - 4, BG_C.mat);
    const px = x + 3;
    const py = y + 3;
    const pw = w - 6;
    const ph = h - 6;
    if (kind === 0) {
      r.push(px, py, pw, ph, BG_C.photoSky);
      const cx = px + Math.floor(pw / 2);
      const rows = Math.min(ph - 2, Math.floor(pw / 2));
      bgStepHill(r, cx, py + ph - 2 - rows, rows, 1, BG_C.photoMount, pw);
      bgStepHill(r, cx, py + ph - 2 - rows, 2, 1, BG_C.photoSnow, pw);
      r.push(px, py + ph - 2, pw, 2, BG_C.photoHill);
    } else if (kind === 1) {
      r.push(px, py, pw, ph, BG_C.photoWarm);
      r.push(px + pw - 5, py + 2, 2, 2, BG_C.photoSun);
      r.push(px, py + ph - 4, Math.ceil(pw * 0.6), 4, BG_C.photoHill);
      r.push(px + 2, py + ph - 5, Math.ceil(pw * 0.35), 1, BG_C.photoHill);
      r.push(px + Math.floor(pw * 0.4), py + ph - 3, pw - Math.floor(pw * 0.4), 3, BG_C.photoHillLo);
    } else {
      const d = Math.min(pw, ph) - 2;
      const ex = px + Math.floor((pw - d) / 2);
      const ey = py + Math.floor((ph - d) / 2);
      bgDisc(r, ex, ey, d, BG_C.ink);
      bgDisc(r, ex + 2, ey + 2, d - 4, BG_C.mat);
      r.push(ex + d - 3, ey, 3, 3, BG_C.mat);
    }
  }

  function bgBuildFrames(r, x, seed) {
    const v = Math.floor(hash01(seed + 1) * 3);
    const line = 120 + Math.floor(hash01(seed + 2) * 16);   // 掛畫的中心線
    const k = Math.floor(hash01(seed + 3) * 3);
    if (v === 0) {
      bgPhoto(r, x, line - 13, 36, 26, k);
      return 37;
    }
    if (v === 1) {
      bgPhoto(r, x, line - 14, 20, 28, (k + 1) % 3);
      bgPhoto(r, x + 26, line - 9, 18, 18, (k + 2) % 3);
      return 45;
    }
    bgPhoto(r, x, line - 10, 16, 20, k);
    bgPhoto(r, x + 21, line - 8, 24, 16, (k + 1) % 3);
    bgPhoto(r, x + 50, line - 10, 16, 20, (k + 2) % 3);
    return 67;
  }

  // --- 掛軸：天地軸、風帶、裱布與水墨畫 -------------------------------------------
  function bgBuildScroll(r, x, seed) {
    const y = 66 + Math.floor(hash01(seed + 1) * 10);
    const kind = Math.floor(hash01(seed + 2) * 3);
    // 掛繩：從釘子往兩端軸頭斜下（階梯）
    r.push(x + 8, y - 9, 2, 1, BG_C.woodLo);
    for (let k = 1; k <= 8; k++) {
      r.push(x + 8 - k, y - 9 + k, 1, 1, BG_C.cord);
      r.push(x + 9 + k, y - 9 + k, 1, 1, BG_C.cord);
    }
    r.push(x + 2, y + 1, 15, 74, BG_C.wallShadow);
    r.push(x + 1, y, 16, 74, BG_C.silk);
    r.push(x + 1, y, 1, 74, BG_C.silkLo);
    r.push(x + 16, y, 1, 74, BG_C.silkLo);
    r.push(x + 1, y + 7, 16, 1, BG_C.silkLo);
    r.push(x + 1, y + 63, 16, 1, BG_C.silkLo);
    r.push(x + 5, y + 2, 1, 14, BG_C.silkLo);   // 風帶
    r.push(x + 12, y + 2, 1, 14, BG_C.silkLo);
    const px = x + 3;
    const py = y + 10;
    r.push(px, py, 12, 51, BG_C.scrollPaper);
    if (kind === 0) {
      // 墨竹
      r.push(px + 5, py + 4, 1, 45, BG_C.ink);
      r.push(px + 4, py + 17, 3, 1, BG_C.ink);
      r.push(px + 4, py + 32, 3, 1, BG_C.ink);
      r.push(px + 6, py + 10, 3, 1, BG_C.ink);
      r.push(px + 8, py + 11, 3, 1, BG_C.ink);
      r.push(px + 1, py + 22, 4, 1, BG_C.ink);
      r.push(px, py + 23, 2, 1, BG_C.ink);
      r.push(px + 6, py + 26, 4, 1, BG_C.inkLight);
      r.push(px + 9, py + 27, 2, 1, BG_C.inkLight);
    } else if (kind === 1) {
      // 遠山：兩層淡墨
      bgStepHill(r, px + 4, py + 26, 12, 0.5, BG_C.inkLight, 12);
      bgStepHill(r, px + 8, py + 32, 10, 0.6, BG_C.ink, 12);
      r.push(px + 8, py + 6, 2, 2, BG_C.inkLight);
    } else {
      // 圓相
      bgDisc(r, px + 1, py + 14, 10, BG_C.ink);
      bgDisc(r, px + 3, py + 16, 6, BG_C.scrollPaper);
      r.push(px + 8, py + 14, 3, 3, BG_C.scrollPaper);
      r.push(px + 5, py + 30, 2, 1, BG_C.inkLight);
      r.push(px + 5, py + 33, 2, 1, BG_C.inkLight);
      r.push(px + 5, py + 36, 2, 1, BG_C.inkLight);
    }
    // 天軸與地軸（地軸兩端的軸頭略深）
    r.push(x, y - 1, 18, 2, BG_C.woodMid);
    r.push(x, y - 1, 18, 1, BG_C.woodHi);
    r.push(x - 1, y + 73, 20, 3, BG_C.woodMid);
    r.push(x - 1, y + 73, 20, 1, BG_C.woodHi);
    r.push(x - 2, y + 73, 2, 3, BG_C.woodLo);
    r.push(x + 18, y + 73, 2, 3, BG_C.woodLo);
    return 20;
  }

  // --- 時鐘：圓形壁鐘（可能指著不同時間）或木製柱時計 ------------------------------
  function bgRoundClock(r, x, y, seed) {
    bgDisc(r, x + 1, y + 1, 15, BG_C.wallShadow);
    bgDisc(r, x, y, 15, BG_C.woodMid);
    bgDisc(r, x + 2, y + 2, 11, BG_C.face);
    r.push(x + 4, y + 1, 3, 1, BG_C.woodHi);
    r.push(x + 2, y + 2, 1, 2, BG_C.woodHi);
    r.push(x + 1, y + 4, 1, 2, BG_C.woodHi);
    r.push(x + 7, y + 3, 1, 1, BG_C.tick);
    r.push(x + 11, y + 7, 1, 1, BG_C.tick);
    r.push(x + 7, y + 11, 1, 1, BG_C.tick);
    r.push(x + 3, y + 7, 1, 1, BG_C.tick);
    const t = Math.floor(hash01(seed + 9) * 3);
    if (t === 0) {
      r.push(x + 7, y + 4, 1, 4, BG_C.hand);      // 3 點
      r.push(x + 7, y + 7, 3, 1, BG_C.hand);
    } else if (t === 1) {
      r.push(x + 7, y + 4, 1, 4, BG_C.hand);      // 9 點
      r.push(x + 5, y + 7, 3, 1, BG_C.hand);
    } else {
      r.push(x + 5, y + 5, 1, 1, BG_C.hand);      // 10 點 10 分
      r.push(x + 6, y + 6, 1, 1, BG_C.hand);
      r.push(x + 7, y + 7, 1, 1, BG_C.hand);
      r.push(x + 8, y + 6, 1, 1, BG_C.hand);
      r.push(x + 9, y + 5, 1, 1, BG_C.hand);
      r.push(x + 10, y + 4, 1, 1, BG_C.hand);
    }
  }

  function bgPendulumClock(r, x, y, seed) {
    r.push(x + 1, y + 1, 18, 44, BG_C.wallShadow);
    r.push(x + 1, y - 2, 16, 2, BG_C.woodMid);       // 屋頂狀的頂飾
    r.push(x + 4, y - 4, 10, 2, BG_C.woodMid);
    r.push(x + 4, y - 4, 10, 1, BG_C.woodHi);
    r.push(x + 1, y - 2, 16, 1, BG_C.woodHi);
    r.push(x, y, 18, 44, BG_C.woodMid);
    r.push(x, y, 1, 44, BG_C.woodHi);
    r.push(x + 17, y, 1, 44, BG_C.woodLo);
    bgDisc(r, x + 3, y + 2, 12, BG_C.face);
    r.push(x + 8, y + 3, 2, 1, BG_C.tick);
    r.push(x + 8, y + 12, 2, 1, BG_C.tick);
    r.push(x + 4, y + 7, 1, 2, BG_C.tick);
    r.push(x + 13, y + 7, 1, 2, BG_C.tick);
    const t = Math.floor(hash01(seed + 9) * 2);
    r.push(x + 8, y + 4, 1, 5, BG_C.hand);
    r.push(t ? x + 9 : x + 6, y + 8, 3, 1, BG_C.hand);
    r.push(x + 4, y + 17, 10, 21, BG_C.glass);         // 玻璃門＋鐘擺
    r.push(x + 4, y + 17, 10, 1, BG_C.woodLo);
    r.push(x + 4, y + 17, 1, 21, BG_C.woodLo);
    r.push(x + 9, y + 18, 1, 13, BG_C.brassLo);
    r.push(x + 7, y + 31, 5, 4, BG_C.brass);
    r.push(x + 7, y + 34, 5, 1, BG_C.brassLo);
    r.push(x + 12, y + 19, 1, 6, BG_C.mat);            // 玻璃反光
    r.push(x + 2, y + 44, 14, 2, BG_C.woodLo);         // 底座
  }

  function bgBuildClock(r, x, seed) {
    if (hash01(seed + 1) < 0.5) {
      bgRoundClock(r, x, 92 + Math.floor(hash01(seed + 2) * 20), seed);
      return 16;
    }
    bgPendulumClock(r, x + 1, 96 + Math.floor(hash01(seed + 2) * 10), seed);
    return 20;
  }

  // 書架上方的牆面也偶爾掛個小鐘或小畫，但不要每個都掛
  function bgBuildShelfSet(r, x, seed) {
    const w = bgBuildShelf(r, x, seed);
    const above = Math.floor(hash01(seed + 11) * 3);
    if (above === 0) bgRoundClock(r, x + 14, 150, seed);
    else if (above === 1) bgPhoto(r, x + 12, 146, 20, 16, Math.floor(hash01(seed + 12) * 3));
    return w;
  }

  // --- 和紙吊燈：從天花板垂下的細繩＋圓燈籠（有橫向竹骨）或筒形燈罩 ---------------------
  const BG_LAMP_ROUND = Object.freeze([6, 10, 12, 14, 14, 14, 14, 14, 14, 12, 10, 6]);
  function bgBuildLamp(r, cx, seed) {
    const top = 22 + Math.floor(hash01(seed + 1) * 12);
    r.push(cx, 5, 1, top - 5, BG_C.cord);
    if (hash01(seed + 2) < 0.5) {
      const rows = BG_LAMP_ROUND;
      r.push(cx - 2, top, 5, 2, BG_C.woodMid);
      for (let i = 0; i < rows.length; i++) {
        const w = rows[i];
        r.push(cx - w / 2 + 1, top + 2 + i, w - 1, 1, i % 3 === 2 ? BG_C.lampRib : (i < 5 ? BG_C.lampHi : BG_C.lamp));
      }
      r.push(cx - 5, top + 3, 2, 1, BG_C.lampHi);
    } else {
      r.push(cx - 5, top, 11, 2, BG_C.woodMid);
      r.push(cx - 5, top + 2, 11, 12, BG_C.lamp);
      r.push(cx - 5, top + 2, 3, 12, BG_C.lampHi);
      r.push(cx - 5, top + 6, 11, 1, BG_C.lampRib);
      r.push(cx - 5, top + 10, 11, 1, BG_C.lampRib);
      r.push(cx - 5, top + 14, 11, 1, BG_C.woodMid);
    }
  }

  const BG_BUILDERS = Object.freeze({
    shoji: bgBuildShoji,
    shelf: bgBuildShelfSet,
    frames: bgBuildFrames,
    scroll: bgBuildScroll,
    clock: bgBuildClock
  });

  // 擺設順序：固定的組合用雜湊洗牌，再把相鄰（含頭尾相接）重複的拆開
  function bgSlotKinds() {
    const kinds = ['shoji', 'shoji', 'shoji', 'shelf', 'shelf', 'shelf', 'frames', 'frames', 'scroll', 'scroll', 'clock', 'clock'];
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(hash01(4099 + i * 17) * (i + 1));
      const t = kinds[i];
      kinds[i] = kinds[j];
      kinds[j] = t;
    }
    const n = kinds.length;
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < n; i++) {
        const a = (i + 1) % n;
        if (kinds[i] !== kinds[a]) continue;
        for (let j = 0; j < n; j++) {
          const t = kinds[j];
          if (t === kinds[i] || kinds[(j + n - 1) % n] === kinds[a] || kinds[(j + 1) % n] === kinds[a]) continue;
          kinds[j] = kinds[a];
          kinds[a] = t;
          break;
        }
      }
    }
    return kinds;
  }

  // 遠景：{ period, items: [{ x0, x1, r }], tex }，全部在載入時算好
  const BG_FAR = (() => {
    const kinds = bgSlotKinds();
    const widths = kinds.map((k, i) => 104 + 8 * Math.floor(hash01(i * 7 + 3) * 4) + (k === 'shoji' ? 16 : 0));
    let total = widths.reduce((a, b) => a + b, 0);
    // 週期取 48 的倍數：腰壁木板與斑點格（都是 24）都能整除，且 0.3× 換算回捲動距離是整數
    widths[widths.length - 1] += (48 - (total % 48)) % 48;
    total = widths.reduce((a, b) => a + b, 0);
    const items = [];
    let sx = 0;
    for (let i = 0; i < kinds.length; i++) {
      const r = [];
      const seed = 101 + i * 37;
      // 先量寬度再置中（抖動一點，避免間距太規律）
      const w = BG_BUILDERS[kinds[i]]([], 0, seed);
      const mx = sx + 6 + Math.floor((widths[i] - w - 12) * (0.3 + 0.4 * hash01(seed + 77)));
      BG_BUILDERS[kinds[i]](r, mx, seed);
      let x0 = Infinity;
      let x1 = -Infinity;
      for (let k = 0; k < r.length; k += 5) {
        x0 = Math.min(x0, r[k]);
        x1 = Math.max(x1, r[k] + r[k + 2]);
      }
      items.push({ kind: kinds[i], x0, x1, r });
      sx += widths[i];
    }
    // 吊燈：另外一組比擺設更疏的節奏（每個循環 4 盞），打破格子的規律感
    for (let k = 0; k < 4; k++) {
      const r = [];
      const cx = Math.floor((k + 0.25 + 0.5 * hash01(907 + k * 13)) * total / 4);
      bgBuildLamp(r, cx, 911 + k * 29);
      items.push({ kind: 'lamp', x0: cx - 7, x1: cx + 8, r });
    }
    // 砂壁斑點：每格最多一點，亮暗成對，像珪藻土牆上的細砂
    const tex = [];
    for (let gx = 0; gx < total; gx += BG_TEX_CELL) {
      for (let gy = 8; gy + BG_TEX_CELL <= BG_RAIL_AY - 4; gy += BG_TEX_CELL) {
        const h = hash01(gx * 131 + gy * 7919 + 17);
        if (h > 0.55) continue;
        const x = gx + Math.floor(hash01(gx * 31 + gy * 17 + 5) * (BG_TEX_CELL - 3));
        const y = gy + Math.floor(hash01(gx * 13 + gy * 29 + 9) * (BG_TEX_CELL - 2));
        if (h < 0.12) {
          tex.push(x, y, 2, 1, BG_C.wallDot);
          tex.push(x, y - 1, 1, 1, BG_C.wallFleck);
        } else {
          tex.push(x, y, 1, 1, BG_C.wallDot);
        }
      }
    }
    return { period: total, items, tex };
  })();

  function bgWrap(v, m) {
    return ((v % m) + m) % m;
  }

  function bgDrawRects(pix, r, dx) {
    for (let i = 0; i < r.length; i += 5) {
      const x = r[i] + dx;
      const w = r[i + 2];
      if (x >= LOW_W || x + w <= 0) continue;
      pix.rect(x, r[i + 1], w, r[i + 3], r[i + 4]);
    }
  }

  // 畫滿 [0, GROUND_AY) 每一列：牆、腰壁、踢腳板＋ 0.3× 捲動的擺設
  function pixelDrawBackground(pix, scroll) {
    const period = BG_FAR.period;
    const off = bgWrap(Math.floor(scroll * BG_FAR_RATE / PX), period);

    pix.rect(0, 0, LOW_W, BG_RAIL_AY, BG_C.wall);
    pix.rect(0, 5, LOW_W, 8, BG_C.wallTop);
    pix.rect(0, 13, LOW_W, 12, BG_C.wallMid);
    pix.rect(0, 25, LOW_W, 16, BG_C.wallLow);
    for (let k = 0; k < 2; k++) bgDrawRects(pix, BG_FAR.tex, k * period - off);
    // 天花板迴緣（不捲動也看不出來，因為是整條橫木）
    pix.rect(0, 0, LOW_W, 3, BG_C.wood);
    pix.rect(0, 2, LOW_W, 1, BG_C.woodLo);
    pix.rect(0, 3, LOW_W, 2, BG_C.ceilShadow);

    // 腰壁：亞麻灰直板＋接縫（跟著遠景捲動）
    pix.rect(0, BG_WAIN_AY, LOW_W, BG_BASE_AY - BG_WAIN_AY, BG_C.wain);
    pix.rect(0, BG_WAIN_AY, LOW_W, 1, BG_C.wainShadow);
    for (let x = bgWrap(-off, BG_WAIN_STEP); x < LOW_W; x += BG_WAIN_STEP) {
      pix.rect(x, BG_WAIN_AY + 1, 1, BG_BASE_AY - BG_WAIN_AY - 1, BG_C.wainSeam);
      pix.rect(x + 1, BG_WAIN_AY + 1, 1, BG_BASE_AY - BG_WAIN_AY - 1, BG_C.wainHi);
    }
    pix.rect(0, BG_RAIL_AY, LOW_W, 3, BG_C.wood);
    pix.rect(0, BG_RAIL_AY, LOW_W, 1, BG_C.woodHi);
    pix.rect(0, BG_RAIL_AY + 2, LOW_W, 1, BG_C.woodLo);

    // 踢腳板：上緣受光、下緣貼地變暗
    pix.rect(0, BG_BASE_AY, LOW_W, BASEBOARD_AH, BG_C.base);
    pix.rect(0, BG_BASE_AY, LOW_W, 1, BG_C.baseHi);
    pix.rect(0, GROUND_AY - 1, LOW_W, 1, BG_C.baseLo);

    const items = BG_FAR.items;
    for (let k = 0; k < 2; k++) {
      const dx = k * period - off;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.x0 + dx >= LOW_W || it.x1 + dx <= 0) continue;
        bgDrawRects(pix, it.r, dx);
      }
    }
  }

  // --- 近景木地板：四排由遠而近漸寬的地板條，深淺交錯、接縫錯開 ---------------------
  const BG_FLOOR_PERIOD = 240;
  // [第一列, 列數（含最下面一列縫隙）, 最短板長, 最長板長]
  const BG_FLOOR_BANDS = Object.freeze([[291, 5, 36, 60], [296, 6, 40, 68], [302, 8, 48, 80], [310, 10, 56, 96]]);
  const BG_FLOOR_SHADES = Object.freeze([
    // [板面, 受光上緣, 木紋]
    ['#B38B6D', '#C19B7E', '#A58064'],
    ['#9F7A5C', '#AE896B', '#926F52'],
    ['#8B6748', '#9A7556', '#7F5D40'],
    ['#785338', '#876144', '#6C4A31']
  ]);
  const BG_FLOOR_GAP = '#553A26';

  const BG_FLOOR = (() => {
    const P = BG_FLOOR_PERIOD;
    const r = [];
    for (let b = 0; b < BG_FLOOR_BANDS.length; b++) {
      const [y, h, minL, maxL] = BG_FLOOR_BANDS[b];
      const bodyH = b === BG_FLOOR_BANDS.length - 1 ? h : h - 1;
      // 先切出板長（總和剛好一個週期），再整排錯開一個起點
      const lens = [];
      let remain = P;
      let i = 0;
      while (remain > 0) {
        let len = minL + Math.floor(hash01(b * 997 + i * 61 + 3) * (maxL - minL + 1));
        if (remain - len < minL) len = remain;
        lens.push(len);
        remain -= len;
        i++;
      }
      const start = Math.floor(hash01(b * 389 + 11) * P);
      const shades = [];
      for (let j = 0; j < lens.length; j++) {
        let s = Math.floor(hash01(b * 577 + j * 43 + 7) * 4);
        if (j > 0 && s === shades[j - 1]) s = (s + 1 + b) % 4;
        if (j === lens.length - 1 && s === shades[0]) s = (s + 2) % 4;
        if (j === lens.length - 1 && s === shades[j - 1]) s = (s + 1) % 4;
        shades.push(s);
      }
      let x = start;
      for (let j = 0; j < lens.length; j++) {
        const sh = BG_FLOOR_SHADES[shades[j]];
        const len = lens[j];
        // 一塊板子可能跨過週期邊界：拆成兩段，顏色相同所以看不出接痕
        for (let part = 0; part < 2; part++) {
          const px = part === 0 ? x : x - P;
          const a = Math.max(px, 0);
          const e = Math.min(px + len, P);
          if (e <= a) continue;
          r.push(a, y, e - a, bodyH, sh[0]);
          r.push(a, y, e - a, 1, sh[1]);
        }
        // 木紋：每塊板 1～2 條細橫線
        const grains = 1 + Math.floor(hash01(b * 211 + j * 19 + 1) * 2);
        for (let g = 0; g < grains; g++) {
          const gl = 6 + Math.floor(hash01(b * 83 + j * 29 + g * 7) * Math.min(18, len - 14));
          const gx = x + 4 + Math.floor(hash01(b * 47 + j * 23 + g * 11) * (len - gl - 8));
          const gy = y + 2 + Math.floor(hash01(b * 59 + j * 31 + g * 13) * Math.max(1, bodyH - 3));
          const gxw = bgWrap(gx, P);
          r.push(gxw, gy, Math.min(gl, P - gxw), 1, sh[2]);
          if (gxw + gl > P) r.push(0, gy, gxw + gl - P, 1, sh[2]);
        }
        // 接縫：板子左端一條深色直線
        r.push(bgWrap(x, P), y, 1, bodyH, BG_FLOOR_GAP);
        x += len;
      }
    }
    return r;
  })();

  // 畫滿 [GROUND_AY, LOW_H) 每一列，與障礙物等速（1.0×）
  function pixelDrawGround(pix, scroll) {
    const P = BG_FLOOR_PERIOD;
    const off = bgWrap(Math.floor(scroll / PX), P);
    pix.rect(0, GROUND_AY, LOW_W, 1, BG_FLOOR_GAP);
    bgDrawRects(pix, BG_FLOOR, -off);
    bgDrawRects(pix, BG_FLOOR, P - off);
    for (let b = 0; b < BG_FLOOR_BANDS.length - 1; b++) {
      const band = BG_FLOOR_BANDS[b];
      pix.rect(0, band[0] + band[1] - 1, LOW_W, 1, BG_FLOOR_GAP);
    }
  }

  // 微塵：虛擬座標轉美術像素，1～2 px 的暖白方點，透明度量化成 0.25 階
  function pixelDrawMotes(pix, motes) {
    for (let i = 0; i < motes.length; i++) {
      const m = motes[i];
      const a = Math.round(clamp(m.alpha, 0, 1) * 4) / 4;
      if (a <= 0) continue;
      const s = m.r >= 2.2 ? 2 : 1;
      pix.alpha(a);
      pix.rect(Math.floor(m.x / PX - s / 2), Math.floor(m.y / PX - s / 2), s, s, BG_C.mote);
    }
    pix.alpha(1);
  }
  // #endregion pixel:bg

  // #region pixel:furn
  // ---------------------------------------------------------------------------
  // 像素主題：客廳家具障礙物（組合 A 貓抓柱／B 抽屜櫃＋跳箱／C 吊盆＋矮几）
  //
  // 座標一律是美術像素（180×320 緩衝區）。每組障礙物 = 上半（柱身＋頂蓋）＋下半（頂蓋＋柱身），
  // 畫面要塞滿 hitbox 包絡、最多只外溢 1 格，否則玩家會「撞到空氣」或「穿過看得見的木頭」。
  // 柱身高度隨縫隙位置變化（上 31～196、下 6～171），花紋一律從縫隙那端（頂蓋）起算往外鋪，
  // 截斷只會落在畫面外（天花板）或地板那端，靠近縫隙的部分永遠是完整的一格花紋。
  // 細節變化用 hash01(gapTop…) 決定：同一組障礙物整趟長得都一樣，不會閃爍。
  // 光源在左上：左側亮邊、右側 1～2 格暗邊，下半的柱身頂端吃到頂蓋的陰影。
  // ---------------------------------------------------------------------------
  // 上半柱身從緩衝區上緣外 4 格開始畫，保證一路頂到第 0 列。緩衝區沒有留邊，畫面震動是整張貼圖一起位移，
  // 上緣露出的那一條由 pixelRenderScene 的底色補成天花板迴緣的木色，看起來像柱子伸進迴緣後面
  const FURN_TOP = -4;
  const FURN_COIL = 4;         // 劍麻繩一圈的高度
  const FURN_DRAWER_H = 12;    // 抽屜櫃一層的高度
  const FURN_TIER = 14;        // 跳箱一段的目標高度（實際會平均分配，最下面幾段多 1 格）
  const FURN_SHELF = 26;       // 矮几層板間距
  const FURN_LEAF_H = 24;      // 藤蔓葉片一格花紋的高度
  const FURN_LEAF_SPILL = 4;   // 葉片往下蓋到下一格的最大距離

  // 低彩度衍生色：胡桃木／淺木／劍麻／米白坐墊／葉綠／素燒盆／雜誌
  const FURN_C = Object.freeze({
    wdOut: '#3B2A1E',
    wdDeep: '#4E3625',
    wdUnder: '#553B29',
    wdShade: '#5E412C',
    wdGrain: '#6A4A32',
    walnut: PAL.walnut,
    wdLight: '#8C6446',
    wdHi: '#A07858',
    okOut: '#6B4F38',
    okGrain: '#A58064',
    okShade: '#98755A',
    oak: PAL.oak,
    okLight: '#C3A084',
    okHi: '#D4B89E',
    okPale: '#E0C9B0',
    gap: '#2A1E16',
    hole: '#3A2A1F',
    siOut: '#6A5A43',
    siOutDark: '#54462F',
    siDeep: '#7B6950',
    siDark: '#978366',
    siMid: '#AA977A',
    siLight: '#C0AD8D',
    siHi: '#D2C3A4',
    crLine: '#6E5A48',
    crStitch: '#A89A80',
    crShade: '#CBBFA8',
    cream: '#E3D9C6',
    crHi: '#F2ECE0',
    gDeep: '#2E3829',
    gDark: '#3C4935',
    moss: PAL.moss,
    sage: PAL.sage,
    gLight: '#85987A',
    gHi: '#A3B294',
    vine: '#56643F',
    cord: '#D6CBB4',
    cordShade: '#9E937C',
    tcOut: '#5A3B2E',
    tcDeep: '#7A5140',
    tcShade: '#8F604A',
    tc: '#A7775D',
    tcLight: '#BC8E72',
    tcHi: '#CDA488',
    sock: '#8E9BAA',
    sockShade: '#6F7C8C',
    sockStripe: '#E4DCCB',
    paper: '#ECE6D9',
    paperShade: '#D8D0C0',
    shelfBack: '#3A2C22',
    hiWash: 'rgba(255, 250, 238, 0.22)',
    shWash: 'rgba(60, 42, 25, 0.16)',
    capShadow: 'rgba(40, 26, 16, 0.28)',
    wallShadow: 'rgba(90, 70, 50, 0.16)'
  });

  // 碎片顏色（無敵衝刺撞碎時的粒子）：[組合][上半／下半]
  const PIXEL_DEBRIS = Object.freeze({
    post: Object.freeze({
      top: Object.freeze([FURN_C.siHi, FURN_C.siMid, FURN_C.siDeep, FURN_C.walnut]),
      bottom: Object.freeze([FURN_C.siLight, FURN_C.siDark, FURN_C.walnut, FURN_C.wdShade])
    }),
    drawer: Object.freeze({
      top: Object.freeze([FURN_C.wdLight, FURN_C.wdHi, FURN_C.walnut, FURN_C.sock]),
      bottom: Object.freeze([FURN_C.okLight, FURN_C.okHi, FURN_C.oak, FURN_C.cream])
    }),
    plant: Object.freeze({
      top: Object.freeze([FURN_C.gLight, FURN_C.sage, FURN_C.moss, FURN_C.tc]),
      bottom: Object.freeze([FURN_C.walnut, FURN_C.wdShade, FURN_C.paper, '#7E8E9E'])
    })
  });

  // 雜誌／書背配色：[封面或書背, 書口或標籤]
  const FURN_MAGS = Object.freeze([
    Object.freeze(['#7E8E9E', FURN_C.paper]),       // 霧藍
    Object.freeze(['#B38983', FURN_C.paper]),       // 乾燥玫瑰
    Object.freeze(['#BEA673', FURN_C.paperShade]),  // 芥末
    Object.freeze(['#8D9B82', FURN_C.paper]),       // 灰綠
    Object.freeze(['#8B8780', FURN_C.paperShade]),  // 暖灰
    Object.freeze(['#5E5E64', FURN_C.paperShade])   // 炭灰
  ]);

  // 把字串 sprite 編譯成矩形清單 { w, h, rects: [x, y, w, h, color, ...] }，只在載入時跑一次。
  // base：底色字元——先用底色鋪滿每列的不透明範圍，再疊上其他顏色，fillRect 次數通常少一半。
  // 相鄰兩列「同位置、同寬、同色」的色段會往下合併；底色層整批排在細節層前面，疊放順序才不會亂。
  function furnCompile(rows, palette, base) {
    const w = rows[0].length;
    const layers = [[], []];
    let open = [new Map(), new Map()];
    const push = (layer, next, x, y, len, ch) => {
      const color = palette[ch];
      if (!color) throw new Error('furnCompile：調色盤缺少字元 ' + ch);
      const key = x + ',' + len + ',' + ch;
      const prev = open[layer].get(key);
      if (prev) {
        prev[3] += 1;
        next.set(key, prev);
      } else {
        const rect = [x, y, len, 1, color];
        layers[layer].push(rect);
        next.set(key, rect);
      }
    };
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      if (row.length !== w) throw new Error('furnCompile：第 ' + y + ' 列寬度 ' + row.length + '，應為 ' + w);
      const next = [new Map(), new Map()];
      let x = 0;
      while (x < w) {
        const ch = row[x];
        let end = x + 1;
        if (base) {
          // 底色層：不透明的連續範圍
          if (ch === '.') {
            x += 1;
            continue;
          }
          while (end < w && row[end] !== '.') end++;
          push(0, next[0], x, y, end - x, base);
        } else {
          while (end < w && row[end] === ch) end++;
          if (ch !== '.') push(1, next[1], x, y, end - x, ch);
        }
        x = end;
      }
      if (base) {
        // 細節層：非底色、非透明的色段
        x = 0;
        while (x < w) {
          const ch = row[x];
          let end = x + 1;
          while (end < w && row[end] === ch) end++;
          if (ch !== '.' && ch !== base) push(1, next[1], x, y, end - x, ch);
          x = end;
        }
      }
      open = next;
    }
    const rects = [];
    for (const layer of layers) {
      for (const r of layer) rects.push(r[0], r[1], r[2], r[3], r[4]);
    }
    return Object.freeze({ w, h: rows.length, rects: Object.freeze(rects) });
  }

  // 把多個已編譯的小 sprite（葉片）依序拼成一格花紋：[[sprite, x, y], ...]
  function furnCompose(w, h, parts) {
    const rects = [];
    for (const [spr, ox, oy] of parts) {
      const r = spr.rects;
      for (let i = 0; i < r.length; i += 5) rects.push(r[i] + ox, r[i + 1] + oy, r[i + 2], r[i + 3], r[i + 4]);
    }
    return Object.freeze({ w, h, rects: Object.freeze(rects) });
  }

  // 貼上編譯好的 sprite；只在 [clipTop, clipBottom) 之間畫（柱身兩端截斷用），flip = 左右鏡射
  function furnBlit(pix, spr, ox, oy, clipTop, clipBottom, flip) {
    const r = spr.rects;
    for (let i = 0; i < r.length; i += 5) {
      let y0 = oy + r[i + 1];
      let y1 = y0 + r[i + 3];
      if (y0 < clipTop) y0 = clipTop;
      if (y1 > clipBottom) y1 = clipBottom;
      if (y1 <= y0) continue;
      const x = flip ? ox + spr.w - r[i] - r[i + 2] : ox + r[i];
      pix.rect(x, y0, r[i + 2], y1 - y0, r[i + 4]);
    }
  }

  // 只畫落在 [y0, y1) 之間的部分
  function furnClip(pix, x, y, w, h, color, y0, y1) {
    const a = y < y0 ? y0 : y;
    const b = y + h > y1 ? y1 : y + h;
    if (b > a) pix.rect(x, a, w, b - a, color);
  }

  // --- 頂蓋與花紋 sprite（32×9 的頂蓋對齊包絡；柱身花紋另外鋪） -------------------------
  const FURN_SPR = (() => {
    const C = FURN_C;
    const wood = {
      o: C.wdOut, t: C.wdLight, T: C.wdHi, c: C.wdShade, L: C.wdLight,
      b: C.walnut, g: C.wdGrain, d: C.wdDeep, u: C.wdUnder
    };
    return Object.freeze({
      // 組合 A：下方貓抓柱的胡桃木圓盤（看得到上表面）
      discBottom: furnCompile([
        '....oooooooooooooooooooooooo....',
        '..ootttttttttttttttttttttttcoo..',
        '.otTTTTTTtttttttttttttttttttcco.',
        'otttttttttttttttttttttttttttccco',
        'oTTTTTTTTTTTTTTTTTTTTTTTTTTTttco',
        'oLLbbbbbbbbbgggggbbbbbbbbbbbccco',
        'oLbbbbbbbbbbbbbbbbbbbbbgggbbccco',
        '.oddddddddddddddddddddddddddddo.',
        '..oooooooooooooooooooooooooooo..'
      ], wood, 'b'),
      // 組合 A：上方貓抓柱的圓盤（從下往上看得到底面）
      discTop: furnCompile([
        '.oooooooooooooooooooooooooooooo.',
        'oLLbbbbbbbbbbbbbbbbbbbbbbbbcccco',
        'oLbbbbbbgggggbbbbbbbbbbbbbbcccco',
        'oLbbbbbbbbbbbbbbbbbbgggbbbbbccco',
        'oddddddddddddddddddddddddddddddo',
        'ouuuuuuuuuuuuuuuuuuuuuuuuuuuuuuo',
        '.ouuuuuuuuuuuuuuuuuuuuuuuuuuuuo.',
        '..oouuuuuuuuuuuuuuuuuuuuuuuuoo..',
        '....oooooooooooooooooooooooo....'
      ], wood, 'b'),
      // 組合 B 上：往前拉開一半的抽屜——側板斜斜往外張（透視），裡面暗，一隻襪子掛出來
      drawerCap: furnCompile([
        '..oSkkkyyyykkkkkkkkkkkkkkkkkSo..',
        '.oSkkkkyyyykkkkkkkkkkkkkkkkkkSo.',
        'oSkkkkkxxxxkkkkkkkkkkkkkkkkkkkSo',
        'oFFFFFFxxxxFFFFFFFFFFFFFFFFFFFeo',
        'olfffffyyyyffffffffffffffffffeeo',
        'olfffffxxxxffHHHHHHffffffffffeeo',
        'olfffffxxxzffhhhhhhffffffffffeeo',
        'oeeeeezxxxeeeeeeeeeeeeeeeeeeeeeo',
        '.oooooooooooooooooooooooooooooo.'
      ], {
        o: C.wdOut, S: C.oak, k: C.gap, F: C.wdHi, f: C.wdLight, l: C.wdHi, e: C.walnut,
        h: C.wdOut, H: C.okHi, x: C.sock, z: C.sockShade, y: C.sockStripe
      }, 'f'),
      // 組合 B 上：抽屜櫃的一層（寬 20，放在左右側板之間；置中一支橫把手）
      drawerTile: furnCompile([
        'wwwwwwwwwwwwwwwwwwww',
        'FFFFFFFFFFFFFFFFFFFe',
        'lffffffffffffffffffe',
        'lffffffffffffffffffe',
        'lffffffffffffffffffe',
        'lfffffKKKKKKKKfffffe',
        'lfffffkkkkkkkkfffffe',
        'lffffffffffffffffffe',
        'lffffffffffffffffffe',
        'lffffffffffffffffffe',
        'eeeeeeeeeeeeeeeeeeee',
        'kkkkkkkkkkkkkkkkkkkk'
      ], {
        w: C.wdShade, F: C.wdHi, f: C.wdLight, l: C.wdHi, e: C.walnut, K: C.okHi, k: C.gap
      }, 'f'),
      // 組合 B 上：箪笥式的一層「左右兩個小抽屜」，偶爾穿插，打破整排一模一樣的單調
      drawerTile2: furnCompile([
        'wwwwwwwwwwwwwwwwwwww',
        'FFFFFFFFewwFFFFFFFFe',
        'lfffffffewwlfffffffe',
        'lfffffffewwlfffffffe',
        'lfffffffewwlfffffffe',
        'lffKKKKfewwlffKKKKfe',
        'lffkkkkfewwlffkkkkfe',
        'lfffffffewwlfffffffe',
        'lfffffffewwlfffffffe',
        'lfffffffewwlfffffffe',
        'eeeeeeeeewweeeeeeeee',
        'kkkkkkkkkkkkkkkkkkkk'
      ], {
        w: C.wdShade, F: C.wdHi, f: C.wdLight, l: C.wdHi, e: C.walnut, K: C.okHi, k: C.gap
      }, 'f'),
      // 組合 B 下：跳箱最上層的米白坐墊（壓線＋木框）
      cushion: furnCompile([
        '...oooooooooooooooooooooooooo...',
        '.ooCCCCCCCCCCCCCCCCCCCCCCCCccoo.',
        'oCCccccccccccccccccccccccccccsso',
        'oCcccxxccxxccxxccxxccxxccxxccsso',
        'oCcccccccccccccccccccccccccccsso',
        'osssssssssssssssssssssssssssssso',
        'oooooooooooooooooooooooooooooooo',
        'oWWWWWWWWWWWWWWWWWWWWWWWWWWWWvvo',
        'ovvvvvvvvvvvvvvvvvvvvvvvvvvvvvvo'
      ], {
        o: C.crLine, C: C.crHi, c: C.cream, s: C.crShade, x: C.crStitch, W: C.okPale, v: C.oak
      }, 'c'),
      // 組合 C 上：素燒吊盆（麻繩網袋在盆底收成一個結）。黃金葛的藤從盆緣翻出來，貼著盆身與盆外側往下垂
      // （v 莖、G/g 葉），一路垂到頂蓋最下面一列為止——讀得出「吊著的盆栽、藤蔓垂下」，但不會垂進縫隙
      pot: furnCompile([
        'oHHHHHkGGHHHHHHHHHHHHHHGGkHHHrdo',
        'vrrrrrkggrrrrrrrrrrrrrrggkrrdddv',
        'vddddddkkddddddddddddddkkdddDDDv',
        'voHrppvmppppppppppppppppmvppddov',
        'voHrpvppmppppppppppppppmppvpddoG',
        'GGHrpGGppmppppppppppppmppGgpddgG',
        'gvorpgppppmppppppppppmppppvddov.',
        '.vorpvpppppmmppppppmmpppppGddkG.',
        'GGk.oooooooooomnnmoooooooooo....'
      ], {
        o: C.tcOut, H: C.tcHi, r: C.tcLight, p: C.tc, d: C.tcShade, D: C.tcDeep,
        m: C.cord, n: C.cordShade, G: C.gLight, g: C.sage, k: C.moss, v: C.vine
      }, 'p'),
      // 組合 C 下：胡桃木矮几桌面（看得到桌面、前緣與小抽屜的望板）
      table: furnCompile([
        '.oooooooooooooooooooooooooooooo.',
        'oTTTTTTTTTTTTTTTTTTTTTTTTTTTTtto',
        'otttttttttttttttttttttttttttccco',
        'oLbbbbbbggggggbbbbbbbbbbbbbbccco',
        'oLbbbbbbbbbbbbbbbbbbggggbbbbbcco',
        'oddddddddddddddddddddddddddddddo',
        '.oAaaaaaaaaaaaaaaaaaaaaaaaaakko.',
        '.oAaaaaaaaaaaannaaaaaaaaaaaakko.',
        '.oooooooooooooooooooooooooooooo.'
      ], {
        o: C.wdOut, T: C.wdHi, t: C.wdLight, L: C.wdLight, b: C.walnut, g: C.wdGrain, c: C.wdShade,
        d: C.wdDeep, A: C.wdLight, a: C.walnut, k: C.wdShade, n: C.okHi
      }, 'b')
    });
  })();

  // --- 藤蔓葉片：心形大葉／小葉 × 左右 × 兩種受光，加上深色葉影，拼成兩格可上下接續的花紋 ----------
  const FURN_LEAF_TILES = (() => {
    const C = FURN_C;
    const big = ['.hhaaa..', 'ahhaaaaa', 'aaaaaaaa', '.aaaaaa.', '..aaaa..', '...aa...'];
    const small = ['.hha.', 'ahhaa', '.aaa.', '..a..'];
    const shade = ['.aaaaa.', 'aaaaaaa', 'aaaaaaa'];
    const mirror = (rows) => rows.map((r) => r.split('').reverse().join(''));
    const tones = [
      { a: C.sage, h: C.gLight },    // 中排
      { a: C.gLight, h: C.gHi }      // 前排：受光
    ];
    const L = tones.map((pal) => ({
      big: furnCompile(big, pal, 'a'),
      bigR: furnCompile(mirror(big), pal, 'a'),
      small: furnCompile(small, pal, 'a'),
      smallR: furnCompile(mirror(small), pal, 'a')
    }));
    // 葉影：後排葉子藏在陰影裡，只剩一團深色輪廓，把苔綠底色切碎
    const D = furnCompile(shade, { a: C.gDark });
    // 花紋寬 26（柱身左右各多 1 格讓葉尖探出去），高 FURN_LEAF_H；y 可以超出一點蓋到下一格
    const A = furnCompose(26, FURN_LEAF_H, [
      [D, 10, 0], [D, 1, 8], [D, 9, 17],
      [L[0].big, 0, 0], [L[1].bigR, 17, 2], [L[1].big, 8, 7],
      [L[0].bigR, 18, 14], [L[1].big, 1, 15]
    ]);
    const B = furnCompose(26, FURN_LEAF_H, [
      [D, 0, 1], [D, 17, 5], [D, 7, 15],
      [L[1].big, 3, 2], [L[0].bigR, 16, 0], [L[1].bigR, 12, 9],
      [L[0].big, 0, 13], [L[1].bigR, 18, 16]
    ]);
    return Object.freeze([A, B]);
  })();

  // --- 柱身：組合 A 劍麻繩 --------------------------------------------------------------
  // up = true：從下端（頂蓋）往上數圈（上半）；false：從上端往下數（下半）
  function furnSisal(pix, x, y0, y1, up, seed) {
    if (y1 <= y0) return;
    const C = FURN_C;
    const h = y1 - y0;
    pix.rect(x, y0, POST_AW, h, C.siMid);
    for (let k = 0; ; k++) {
      const cy = up ? y1 - (k + 1) * FURN_COIL : y0 + k * FURN_COIL;
      if (up ? cy + FURN_COIL <= y0 : cy >= y1) break;
      // 一圈 = 受光列 + 兩列繩身 + 一列深色繩溝，深淺兩色的繩圈交錯
      const light = (k & 1) === 0;
      if (light) {
        furnClip(pix, x, cy, POST_AW, 3, C.siLight, y0, y1);
        furnClip(pix, x, cy, POST_AW, 1, C.siHi, y0, y1);
      } else {
        // 深色繩圈上挑出一小段淺色纖維，位置固定
        const f = hash01(seed * 7919 + k * 31);
        furnClip(pix, x, cy, POST_AW, 1, C.siLight, y0, y1);
        furnClip(pix, x + 3 + Math.floor(f * 15), cy + 1 + (f < 0.5 ? 0 : 1), 3, 1, C.siLight, y0, y1);
      }
      furnClip(pix, x, cy + FURN_COIL - 1, POST_AW, 1, C.siDeep, y0, y1);
    }
    // 圓柱明暗：左側亮帶、右側漸暗，最外一格描邊
    pix.rect(x + 1, y0, 1, h, C.shWash);
    pix.rect(x + 3, y0, 5, h, C.hiWash);
    pix.rect(x + 4, y0, 2, h, C.hiWash);
    pix.rect(x + 14, y0, 9, h, C.shWash);
    pix.rect(x + 18, y0, 5, h, C.shWash);
    pix.rect(x + 21, y0, 2, h, C.shWash);
    pix.rect(x, y0, 1, h, C.siOut);
    pix.rect(x + POST_AW - 1, y0, 1, h, C.siOutDark);
  }

  // --- 柱身：組合 B 上方的抽屜櫃（深胡桃木櫃體，一層層抽屜各有一支橫把手） -------------------
  function furnCabinet(pix, x, y0, y1, seed) {
    if (y1 <= y0) return;
    const C = FURN_C;
    const h = y1 - y0;
    pix.rect(x, y0, 1, h, C.wdOut);
    pix.rect(x + 1, y0, 1, h, C.walnut);
    pix.rect(x + 22, y0, 1, h, C.wdDeep);
    pix.rect(x + 23, y0, 1, h, C.wdOut);
    for (let k = 0; ; k++) {
      const ty = y1 - (k + 1) * FURN_DRAWER_H;
      if (ty + FURN_DRAWER_H <= y0) break;
      const f = hash01(seed * 131 + k * 7);
      if (k > 0 && f > 0.72) {
        furnBlit(pix, FURN_SPR.drawerTile2, x + 2, ty, y0, y1, false);
        continue;
      }
      furnBlit(pix, FURN_SPR.drawerTile, x + 2, ty, y0, y1, false);
      // 每個抽屜面板一道短木紋，放在左右兩側、避開把手（放正中間會像一張臉）
      const gx = f < 0.5 ? 3 + Math.floor(f * 6) : 13 + Math.floor((f - 0.5) * 8);
      furnClip(pix, x + gx, ty + (k & 1 ? 3 : 8), 5, 1, C.walnut, y0, y1);
    }
  }

  // --- 柱身：組合 B 下方的跳箱（淺色木段一段段疊起，每段一個橢圓提把孔） ----------------------
  function furnVaultBox(pix, x, y0, y1, seed) {
    const total = y1 - y0;
    if (total <= 0) return;
    const n = Math.max(1, Math.round(total / FURN_TIER));
    const base = Math.floor(total / n);
    const extra = total - base * n;
    let y = y0;
    for (let i = 0; i < n; i++) {
      const h = base + (i >= n - extra ? 1 : 0);
      furnTier(pix, x, y, h, seed * 17 + i);
      y += h;
    }
  }

  function furnTier(pix, x, y, h, salt) {
    const C = FURN_C;
    const w = POST_AW;
    // 外框：上下緣各內縮 1 格，段與段之間出現小缺角，看得出是一段一段疊起來的
    pix.rect(x, y + 1, w, h - 2, C.okOut);
    pix.rect(x + 1, y, w - 2, h, C.okOut);
    if (h < 4) return;
    pix.rect(x + 1, y + 1, w - 2, h - 2, C.okLight);
    pix.rect(x + 1, y + 1, w - 2, 1, C.okPale);
    pix.rect(x + 1, y + 2, 1, h - 4, C.okHi);
    pix.rect(x + w - 3, y + 2, 2, h - 3, C.oak);
    pix.rect(x + 1, y + h - 2, w - 2, 1, C.oak);
    if (h >= 7) {
      // 橢圓提把孔：上緣背光最深、下緣內壁受光
      const big = h >= 10;
      const hy = y + Math.floor((h - (big ? 4 : 3)) / 2);
      pix.rect(x + 8, hy, 8, 1, C.gap);
      pix.rect(x + 6, hy + 1, 12, 1, C.gap);
      if (big) pix.rect(x + 6, hy + 2, 12, 1, C.hole);
      pix.rect(x + 8, hy + (big ? 3 : 2), 8, 1, C.okShade);
      // 木紋
      const f = hash01(salt);
      if (big) pix.rect(x + 3 + Math.floor(f * 13), f < 0.5 ? y + 2 : y + h - 3, 5, 1, C.okGrain);
    }
  }

  // --- 柱身：組合 C 上方的吊盆藤蔓（麻繩吊繩被黃金葛層層蓋住） ----------------------------
  function furnFoliage(pix, x, y0, y1, seed) {
    if (y1 <= y0) return;
    const C = FURN_C;
    const h = y1 - y0;
    pix.rect(x, y0, POST_AW, h, C.moss);
    // 吊繩在葉縫間若隱若現
    pix.rect(x + 11, y0, 1, h, C.cordShade);
    for (let k = 0; ; k++) {
      const ty = y1 - (k + 1) * FURN_LEAF_H;
      if (ty + FURN_LEAF_H + FURN_LEAF_SPILL <= y0) break;
      const f = hash01(seed * 613 + k * 97);
      // 垂下的藤蔓莖
      furnClip(pix, x + 4 + Math.floor(f * 16), ty + 2, 1, 12, C.vine, y0, y1);
      furnBlit(pix, FURN_LEAF_TILES[f < 0.5 ? 0 : 1], x - 1, ty, y0, y1, f >= 0.25 && f < 0.75);
    }
    // 麻繩吊繩：兩條從盆緣（網袋上端）直直吊到天花板，一段段被葉子蓋住——看得出盆栽是「吊著的」，
    // 整根不會讀成從盆裡往上長的植物
    for (let c = 0; c < 2; c++) {
      const cx = x + (c === 0 ? 3 : POST_AW - 4);
      for (let cy = y1 - c * 5; cy > y0; cy -= 14) {
        const top = Math.max(y0, cy - 10);
        pix.rect(cx, top, 1, cy - top, C.cord);
      }
    }
    pix.rect(x, y0, 1, h, C.shWash);
    pix.rect(x + POST_AW - 3, y0, 3, h, C.shWash);
    pix.rect(x + POST_AW - 1, y0, 1, h, C.shWash);
  }

  // --- 柱身：組合 C 下方的矮几（桌腳＋一層層板，桌下疊雜誌與書） ----------------------------
  // 矮几只有一層高（FURN_SHELF）。縫隙偏高、柱身比這長的時候，矮几是擱在地上一落籐籃、座布團與
  // 雜誌堆上——不再一格格往下長出層板與桌腳（那樣整根看起來像一座窄書櫃）
  const FURN_STACK_MIN = 8; // 桌下剩不到這麼高，就直接把桌腳伸到地板

  function furnMagazines(pix, x, y0, y1, seed) {
    if (y1 <= y0) return;
    const C = FURN_C;
    const stacked = y1 - y0 > FURN_SHELF + FURN_STACK_MIN;
    const end = stacked ? y0 + FURN_SHELF : y1; // 桌腳底
    const h = end - y0;
    const inX = x + 3;
    const inW = POST_AW - 6;
    pix.rect(inX, y0, inW, h, C.shelfBack);
    let floor = end;
    if (stacked) {
      // 桌腳之間的底板：上緣受光
      floor -= 2;
      pix.rect(inX, floor, inW, 1, C.wdLight);
      pix.rect(inX, floor + 1, inW, 1, C.wdShade);
    }
    const top = y0 + 1;
    const tint = Math.floor(hash01(seed * 5) * FURN_MAGS.length);
    let sy = floor;
    for (let slot = 0; slot < 12; slot++) {
      const f = hash01(seed * 389 + slot * 11);
      let t = f < 0.55 ? 2 : (f < 0.8 ? 3 : 4);
      if (sy - t < top) t = sy - top;
      if (t < 2) break;
      sy -= t;
      const g = hash01(seed * 71 + slot * 5 + 3);
      const w = inW - Math.floor(g * 4);
      const ix = inX + Math.floor(hash01(seed + slot * 7) * (inW - w + 1));
      const mag = FURN_MAGS[(tint + Math.floor(g * 3)) % FURN_MAGS.length];
      if (t === 2) {
        // 雜誌：封面一列＋書口一列
        pix.rect(ix, sy, w, 1, mag[0]);
        pix.rect(ix, sy + 1, w, 1, mag[1]);
      } else {
        // 書：書背（厚書才貼書標）
        pix.rect(ix, sy, w, t, mag[0]);
        if (t === 4) pix.rect(ix + 3, sy + 1, 5, 2, mag[1]);
      }
    }
    // 桌腳：左腳受光、右腳背光
    pix.rect(x, y0, 3, h, C.walnut);
    pix.rect(x, y0, 1, h, C.wdOut);
    pix.rect(x + 1, y0, 1, h, C.wdLight);
    pix.rect(x + POST_AW - 3, y0, 3, h, C.wdShade);
    pix.rect(x + POST_AW - 1, y0, 1, h, C.wdOut);
    if (stacked) furnFloorStack(pix, x, end, y1, seed);
  }

  // 矮几底下由地板往上疊的雜物：籐籃、一疊座布團、雜誌堆輪流出現。每一件都撐滿柱身寬度（坐墊只缺四個角）、
  // 外圍一格深色輪廓，貼著米白牆也看得出剪影，不留會讓人「撞到空氣」的洞
  function furnFloorStack(pix, x, y0, y1, seed) {
    let y = y1;
    for (let k = 0; y > y0; k++) {
      const room = y - y0;
      const f = hash01(seed * 173 + k * 37 + 5);
      const kind = (k + Math.floor(f * 3)) % 3;
      const want = kind === 2 ? 6 + Math.floor(f * 4) : 11 + Math.floor(f * 5);
      // 最上面那件不要只剩 1～4 格的細條：剩太少就併進這一件
      const h = room - want <= 4 ? room : want;
      if (kind === 0) furnBasket(pix, x, y - h, h);
      else if (kind === 1) furnCushions(pix, x, y - h, h, seed * 29 + k);
      else furnPile(pix, x, y - h, h, seed * 31 + k);
      y -= h;
    }
  }

  // 籐籃：胡桃色籐條一列深一列淺交錯、三根直立籐骨，籃口露出一圈米白的布內襯
  function furnBasket(pix, x, y, h) {
    const C = FURN_C;
    const w = POST_AW;
    pix.rect(x, y, w, h, C.wdOut);
    if (h < 5) return;
    pix.rect(x + 1, y + 1, w - 2, h - 2, C.wdLight);
    for (let row = y + 5; row < y + h - 1; row += 2) pix.rect(x + 1, row, w - 2, 1, C.wdShade);
    for (let sx = x + 5; sx < x + w - 2; sx += 7) pix.rect(sx, y + 4, 1, h - 5, C.walnut);
    // 布內襯：從籃口翻出來，中間垂下一小角
    pix.rect(x + 1, y, w - 2, 2, C.cream);
    pix.rect(x + 1, y, w - 2, 1, C.crHi);
    pix.rect(x + 9, y + 2, 5, 1, C.crShade);
    pix.rect(x + 1, y + 2, w - 2, 1, C.wdOut);
    pix.rect(x + 1, y + 3, w - 2, 1, C.wdHi);
    pix.rect(x + w - 3, y + 3, 2, h - 4, C.shWash);
  }

  // 一疊座布團：每張 4～6 格厚、四角缺一格（軟軟的方墊），正中央一個綴線，受光面在上
  function furnCushions(pix, x, y, h, salt) {
    const C = FURN_C;
    const w = POST_AW;
    const n = Math.max(1, Math.round(h / 5));
    let top = y;
    for (let i = 0; i < n; i++) {
      const ch = Math.floor((h - (top - y)) / (n - i));
      const tone = FURN_MAGS[Math.floor(hash01(salt * 7 + i * 3 + 1) * 4)][0];
      pix.rect(x + 1, top, w - 2, ch, C.crLine);
      pix.rect(x, top + 1, w, ch - 2, C.crLine);
      if (ch >= 4) {
        pix.rect(x + 1, top + 1, w - 2, ch - 2, tone);
        pix.rect(x + 2, top + 1, w - 4, 1, C.hiWash);
        pix.rect(x + 1, top + ch - 2, w - 2, 1, C.shWash);
        pix.rect(x + (w >> 1) - 1, top + (ch >> 1), 2, 1, C.crLine);
      }
      top += ch;
    }
  }

  // 一疊雜誌：每本封面一列＋書口一列，左右錯開 1 格；兩端各一格深色輪廓，貼著牆也讀得出來
  function furnPile(pix, x, y, h, salt) {
    const C = FURN_C;
    pix.rect(x, y, POST_AW, h, C.wdOut);
    let sy = y + h;
    for (let i = 0; sy > y + 1; i++) {
      const t = Math.min(sy - y - 1, 2);
      sy -= t;
      const g = hash01(salt * 97 + i * 17 + 1);
      const ix = x + 1 + (g < 0.5 ? 0 : 1);
      const mag = FURN_MAGS[Math.floor(hash01(salt * 11 + i * 5 + 2) * FURN_MAGS.length)];
      pix.rect(ix, sy, POST_AW - 3, 1, mag[0]);
      if (t > 1) pix.rect(ix, sy + 1, POST_AW - 3, 1, mag[1]);
    }
  }

  // 各組合的上下半：柱身繪製函式 + 頂蓋 sprite
  const FURN_KINDS = Object.freeze({
    post: Object.freeze({
      top: (pix, x, y0, y1, seed) => furnSisal(pix, x, y0, y1, true, seed),
      bottom: (pix, x, y0, y1, seed) => furnSisal(pix, x, y0, y1, false, seed),
      topCap: FURN_SPR.discTop,
      bottomCap: FURN_SPR.discBottom
    }),
    drawer: Object.freeze({
      top: furnCabinet,
      bottom: furnVaultBox,
      topCap: FURN_SPR.drawerCap,
      bottomCap: FURN_SPR.cushion
    }),
    plant: Object.freeze({
      top: furnFoliage,
      bottom: furnMagazines,
      topCap: FURN_SPR.pot,
      bottomCap: FURN_SPR.table
    })
  });

  // 一組障礙物：ax = 32 格寬足跡的左緣；gapTop / gapBottom = 縫隙上下緣（相差 GAP_AH）
  // brokenTop / brokenBottom：無敵衝刺撞碎的那一半不畫（也不參與碰撞）
  function pixelDrawObstacle(pix, ax, gapTop, gapBottom, variant, brokenTop, brokenBottom) {
    const x = Math.round(ax);
    // 整組都在緩衝區外（含右側 1 格牆影）就不畫
    if (x >= LOW_W || x + PIPE_AW < 0) return;
    const top = Math.round(gapTop);
    const bottom = Math.round(gapBottom);
    const kind = FURN_KINDS[variant] || FURN_KINDS.post;
    const postX = x + POST_AINSET;
    const seed = top;
    const C = FURN_C;
    if (!brokenTop) {
      const capY = top - CAP_AH;
      kind.top(pix, postX, FURN_TOP, capY, seed);
      furnBlit(pix, kind.topCap, x, capY, capY, top, false);
      // 牆上的影子：光從左上來，右側貼一格淡影
      if (capY > FURN_TOP) pix.rect(postX + POST_AW, FURN_TOP, 1, capY - FURN_TOP, C.wallShadow);
      pix.rect(x + PIPE_AW, capY + 1, 1, CAP_AH - 1, C.wallShadow);
    }
    if (!brokenBottom) {
      const colY = bottom + CAP_AH;
      if (colY < GROUND_AY) {
        kind.bottom(pix, postX, colY, GROUND_AY, seed);
        // 頂蓋壓在柱身上的陰影、柱腳貼地的接觸陰影
        pix.rect(postX, colY, POST_AW, Math.min(2, GROUND_AY - colY), C.capShadow);
        pix.rect(postX, GROUND_AY - 1, POST_AW, 1, C.capShadow);
        pix.rect(postX + POST_AW, colY + 1, 1, GROUND_AY - colY - 1, C.wallShadow);
      }
      furnBlit(pix, kind.bottomCap, x, bottom, bottom, colY, false);
      pix.rect(x + PIPE_AW, bottom + 1, 1, CAP_AH - 1, C.wallShadow);
    }
  }
  // #endregion pixel:furn

  // #region pixel:cat
  // --- 像素黑貓（pixel:cat）：姿勢 × 心情 × 尾巴在載入時烘焙成 sprite，逐幀只做查表 ---------
  // 字元：k 身體、s 暗部、r 輪廓光、e 眼、p 瞳孔、g 白手套、d 肉球、i 耳內、n 鼻子、w 亮點
  // 零件裡的 '#' 是「自動上光」：依該圖層輪廓，上緣／左緣 → r（光從左上來）、下緣 → s、其餘 → k
  const PIXEL_CAT_PALETTE = Object.freeze({
    body: PAL.catBody,  // 墨黑
    shade: '#131317',   // 腹側暗部
    rim: '#4A4A59',     // 左上輪廓光：讓剪影在亮牆與木頭上都讀得出形狀
    eye: PAL.catEye,    // 亮黃綠
    pupil: '#0C0C10',
    glove: '#F3EFE7',   // 白手套（略帶米色，跟牆面同一個色溫）
    pad: PAL.catPad,    // 粉嫩肉球
    earIn: '#C97990',   // 耳內：比肉球暗一階，免得在黑臉上太跳
    nose: PAL.catPad,
    white: '#FFFFFF'    // 眼睛亮點
  });

  const CATPIX_W = 32;
  const CATPIX_H = 32;
  const CATPIX_AX = 16; // 碰撞中心在 sprite 內的位置（像素交界），縮放以此為錨點
  const CATPIX_AY = 16;
  const CATPIX_TAIL_STEP = 5; // 尾巴彈簧值超過 ±5 就換「上揚／下垂」幀

  // 零件（相對座標，由姿勢表決定擺放位置）---------------------------------------------
  // 豎耳的頭：14×15，眼睛在第 7～9 列、鼻子第 10 列、嘴第 11 列（第 10～11 列右緣是臉頰）
  const CATPIX_HEAD_UP = [
    '..#........#..',
    '..##......##..',
    '..#i#....#i#..',
    '.##ii#..#ii##.',
    '.############.',
    '.############.',
    '#############.',
    '#############.',
    '#############.',
    '#############.',
    '##############',
    '##############',
    '.############.',
    '..##########..',
    '...########...'
  ];

  // 飛機耳的頭：兩隻耳朵從後腦勺往後平貼，近側那隻只有 2 列高——拉長姿勢會再縱向放大 1.25 倍，
  // 耳朵畫得太斜的話放大後會變成豎起來的耳朵（或像蝴蝶結）
  const CATPIX_HEAD_FLAT = [
    '......##',
    '####..####',
    '.##ii########',
    '....############',
    '.....############',
    '.....#############',
    '.....#############',
    '.....#############',
    '.....#############',
    '.....##############',
    '.....##############',
    '......############',
    '.......##########',
    '........########'
  ];

  const CATPIX_BODY_IDLE = [
    '.....####.......',
    '...#########....',
    '..############..',
    '.##############.',
    '################',
    '################',
    '################',
    '################',
    '.###############',
    '..##############',
    '....##########..'
  ];

  // 蜷縮：比待機短一截，橫向放大 1.25 倍後才不會變成臘腸
  const CATPIX_BODY_SQUASH = [
    '....######.....',
    '..##########...',
    '.#############.',
    '###############',
    '###############',
    '###############',
    '###############',
    '###############',
    '.#############.',
    '..###########..'
  ];

  // 跳躍拉長：身體約 33° 斜向右上（縱向拉長後接近 45°）；肚子刻意飽滿，碰撞圓右下角才不會是空的
  const CATPIX_BODY_STRETCH = [
    '.............####',
    '...........########',
    '.........##########',
    '.......#############',
    '......##############',
    '....################',
    '..##################',
    '.###################',
    '###################',
    '###################',
    '#################',
    '###############',
    '#############',
    '############',
    '.#########',
    '..######'
  ];

  // 縮成球：耳朵是右上兩個小三角，臉朝右下埋進去
  const CATPIX_BALL = [
    '.................#....#',
    '................##...##',
    '..............#####.#ii#',
    '............############',
    '..........##############',
    '..........#############',
    '.........##############',
    '.........##############',
    '........################',
    '........################',
    '........################',
    '........################',
    '.........##############',
    '.........##############',
    '..........############',
    '..........############',
    '............########',
    '..............####'
  ];

  // 尾巴三幀：上揚／中間／下垂（2px 粗，細長）
  const CATPIX_TAIL_UP = [
    '....##',
    '...##.',
    '..##..',
    '..##..',
    '..##..',
    '..##..',
    '..##..',
    '..##..',
    '..##..',
    '..##..',
    '...##.',
    '...##.'
  ];
  const CATPIX_TAIL_MID = [
    '..##.',
    '.##..',
    '##...',
    '##...',
    '##...',
    '##...',
    '##...',
    '.##..',
    '.##..',
    '..##.',
    '..###',
    '...##'
  ];
  const CATPIX_TAIL_DOWN = [
    '..##',
    '.##.',
    '##..',
    '##..',
    '##..',
    '##..',
    '##..',
    '##..',
    '.##.'
  ];
  // 拉長姿勢：尾巴垂直往下繃直
  const CATPIX_TAIL_TAUT = [
    '##', '##', '##', '##', '##', '##', '##', '##', '##', '##', '##', '##'
  ];
  // 縮成球：尾巴從後下方貼著身體繞到前面，尾尖停在臉頰下
  const CATPIX_TAIL_CURL = [
    '.........................##',
    '........................##',
    '.......................##',
    '.......................##',
    '.......................##',
    '.......................##',
    '......................##',
    '......................##',
    '........##...........##',
    '.........##.........###',
    '...........##.....####',
    '............########',
    '.............######'
  ];

  // 腳：遠側（畫在身體後面，用暗部色）與近側（自動上光）
  // 白手套露在剪影外緣的部分，烘焙時會自動補暗部色描邊（catPixOutline）
  const CATPIX_LEG_FAR = ['ss', 'gg'];
  const CATPIX_LEG_NEAR = ['###', '###', '###', 'ggg', 'ggg'];
  const CATPIX_LEG_BRACE = ['###', '###', '###', '###', '###', 'ggg', 'gggg']; // 蜷縮：前腳撐直、腳掌張開
  const CATPIX_FOOT_FLAT = ['.###', '.###', '####', 'gggg'];                   // 蜷縮：後腳平貼
  const CATPIX_LEG_REACH = [ // 拉長：前腳往右上伸到下巴前面
    '.........gg',
    '.......##gg',
    '....#####',
    '.######',
    '####'
  ];
  const CATPIX_LEG_TUCK_FAR = ['ssss', 'ssss', 'ssss', 'ssss', '.sss', '.ggg']; // 拉長：遠側前腳收在胸口下
  const CATPIX_LEG_TRAIL = [ // 拉長：大腿飽滿、小腿往左下拖，腳底露出肉球
    '......#####',
    '....#######',
    '...########',
    '..#######',
    '.#####',
    '.###',
    '###',
    'ggg',
    'gdg'
  ];
  const CATPIX_LEG_TRAIL_FAR = ['..ss', '.ss', '.ss', 'ss', 'gg'];
  const CATPIX_BALL_PAWS = [ // 球：後腳肉球從左下探出來，前掌抱著尾巴從右側露出
    '.gg............gg',
    '.dg............gg'
  ];

  // 眼睛補丁（'.' 代表不動底圖）。睜眼款寬 2；寬 3 的補丁左眼往左多佔 1 格
  // 睜眼 we/ep/ee：縮放時不論掉哪一欄或哪一列，剩下的都還至少有兩格黃綠，不會整顆眼睛消失
  const CATPIX_EYES_OPEN = {
    normal: [['we', 'ep', 'ee'], ['we', 'ep', 'ee']],
    scared: [['e..', '.ee', 'e..'], ['..e', 'ee.', '..e']],
    dizzy: [['e.e', '.e.', 'e.e'], ['e.e', '.e.', 'e.e']]
  };
  const CATPIX_EYES_SHUT = { // 球：眼睛一律閉緊
    normal: [['.e.', 'e.e'], ['.e.', 'e.e']],
    scared: [['e..', '.ee', 'e..'], ['..e', 'ee.', '..e']],
    dizzy: [['e.e', '.e.', 'e.e'], ['e.e', '.e.', 'e.e']]
  };
  // 嘴巴補丁：平常是鼻子加一撇嘴，受驚／暈眩張嘴
  const CATPIX_MOUTH = {
    normal: ['nn', 'rr'],
    scared: ['nn', 'kk', 'dd'],
    dizzy: ['nn', 'kk', 'dd']
  };
  const CATPIX_MOUTH_SMALL = {
    normal: ['n'],
    scared: ['n', 'd'],
    dizzy: ['n', 'd']
  };
  const CATPIX_WHISKERS = ['.rr', '...', 'rr.'];

  // 姿勢表：依序疊圖層 [零件, x, y]；null 是尾巴的位置，烘焙時換成對應尾巴幀
  // face：eyes [左 x, y, 右 x, y]（以寬 2 的睜眼為準）、nose [x, y]、shut 閉眼、whisk 鬍鬚位置
  // snap：縱向取樣錨點列（見 pixelDrawCat），會被壓扁的姿勢設在眼睛與鼻子中間
  // keep：核心給的 Squash & Stretch 形變保留多少（預設 1＝全部）；球本身就畫成圓的，全壓扁會變成扁麵包
  const CATPIX_POSES = Object.freeze({
    idle: {
      tails: [[CATPIX_TAIL_UP, 0, 3], [CATPIX_TAIL_MID, 0, 5], [CATPIX_TAIL_DOWN, 0, 15]],
      layers: [
        null,
        [CATPIX_LEG_FAR, 15, 21],
        [CATPIX_BODY_IDLE, 3, 11],
        [CATPIX_LEG_NEAR, 4, 19], [CATPIX_LEG_NEAR, 18, 19],
        [CATPIX_HEAD_UP, 13, 3]
      ],
      face: { eyes: [17, 10, 22, 10], nose: [20, 13], shut: false, mouth: CATPIX_MOUTH, whisk: [26, 13] },
      snap: CATPIX_AY
    },
    squash: {
      tails: [[CATPIX_TAIL_UP, 0, 5], [CATPIX_TAIL_MID, 0, 5], [CATPIX_TAIL_DOWN, 0, 16]],
      layers: [
        null,
        [CATPIX_LEG_FAR, 13, 22],
        [CATPIX_BODY_SQUASH, 3, 13],
        [CATPIX_FOOT_FLAT, 3, 20], [CATPIX_LEG_BRACE, 17, 18],
        [CATPIX_HEAD_UP, 12, 5]
      ],
      face: { eyes: [16, 12, 21, 12], nose: [19, 15], shut: false, mouth: CATPIX_MOUTH, whisk: [25, 15] },
      snap: 14
    },
    stretch: {
      tails: [[CATPIX_TAIL_TAUT, 3, 20]],
      layers: [
        null,
        [CATPIX_LEG_TRAIL_FAR, 11, 22], [CATPIX_LEG_TUCK_FAR, 18, 16],
        [CATPIX_BODY_STRETCH, 3, 8],
        [CATPIX_LEG_TRAIL, 7, 19],
        [CATPIX_HEAD_FLAT, 10, 0],
        [CATPIX_LEG_REACH, 19, 11]
      ],
      face: { eyes: [19, 7, 24, 7], nose: [22, 10], shut: false, mouth: CATPIX_MOUTH, whisk: null },
      snap: CATPIX_AY
    },
    ball: {
      tails: [[CATPIX_TAIL_CURL, 0, 12]],
      layers: [
        [CATPIX_BALL, 0, 6],
        null,
        [CATPIX_BALL_PAWS, 7, 18]
      ],
      face: { eyes: [16, 12, 19, 12], nose: [18, 14], shut: true, mouth: CATPIX_MOUTH_SMALL, whisk: null },
      snap: 14,
      keep: 0.35
    }
  });

  // 烘焙 ------------------------------------------------------------------------------
  function catPixFilled(rows, x, y) {
    return y >= 0 && y < rows.length && x >= 0 && x < rows[y].length && rows[y][x] !== '.';
  }

  // '#' 依圖層自己的輪廓上光：左上受光、下緣背光
  function catPixAutoShade(rows, x, y) {
    if (!catPixFilled(rows, x, y - 1) || !catPixFilled(rows, x - 1, y)) return 'r';
    if (!catPixFilled(rows, x, y + 1)) return 's';
    return 'k';
  }

  function catPixStamp(grid, rows, ox, oy) {
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        let ch = rows[y][x];
        if (ch === '.') continue;
        if (ch === '#') ch = catPixAutoShade(rows, x, y);
        const gx = ox + x;
        const gy = oy + y;
        if (gx >= 0 && gx < CATPIX_W && gy >= 0 && gy < CATPIX_H) grid[gy][gx] = ch;
      }
    }
  }

  // 白手套／肉球跟米白牆幾乎同亮度：露在外面（上下左右鄰格透明）的那一側補一格暗部色描邊，
  // 腳掌才會是「黑框裡的白襪」，而不是融進牆裡、只剩黑腳截斷
  function catPixOutline(grid) {
    const edge = (x, y) => x >= 0 && x < CATPIX_W && y >= 0 && y < CATPIX_H && (grid[y][x] === 'g' || grid[y][x] === 'd');
    const marks = [];
    for (let y = 0; y < CATPIX_H; y++) {
      for (let x = 0; x < CATPIX_W; x++) {
        if (grid[y][x] === '.' && (edge(x - 1, y) || edge(x + 1, y) || edge(x, y - 1) || edge(x, y + 1))) marks.push(x, y);
      }
    }
    for (let i = 0; i < marks.length; i += 2) grid[marks[i + 1]][marks[i]] = 's';
  }

  function catPixBake(pose, tail, mood) {
    const grid = [];
    for (let y = 0; y < CATPIX_H; y++) grid.push(new Array(CATPIX_W).fill('.'));
    for (const layer of pose.layers) {
      const part = layer || tail;
      catPixStamp(grid, part[0], part[1], part[2]);
    }
    const face = pose.face;
    const [lx, ly, rx, ry] = face.eyes;
    const eyes = (face.shut ? CATPIX_EYES_SHUT : CATPIX_EYES_OPEN)[mood];
    catPixStamp(grid, eyes[0], eyes[0][0].length > 2 ? lx - 1 : lx, ly);
    catPixStamp(grid, eyes[1], rx, ry);
    catPixStamp(grid, face.mouth[mood], face.nose[0], face.nose[1]);
    if (face.whisk) catPixStamp(grid, CATPIX_WHISKERS, face.whisk[0], face.whisk[1]);
    catPixOutline(grid);
    return grid.map((row) => row.join(''));
  }

  // CATPIX_SPRITES[pose].moods[mood][tailFrame]：3 幀尾巴（上揚／中間／下垂）；只有一條尾巴的姿勢三格共用
  // 用無原型物件，傳進奇怪的 pose / mood 字串只會退回預設，不會撈到 Object.prototype 的東西
  const CATPIX_SPRITES = (() => {
    const out = Object.create(null);
    for (const name of Object.keys(CATPIX_POSES)) {
      const pose = CATPIX_POSES[name];
      const moods = Object.create(null);
      for (const mood of ['normal', 'scared', 'dizzy']) {
        const frames = pose.tails.map((tail) => catPixBake(pose, tail, mood));
        moods[mood] = [frames[0], frames[1] || frames[0], frames[2] || frames[0]];
      }
      out[name] = { snap: pose.snap, keep: pose.keep === undefined ? 1 : pose.keep, moods };
    }
    return out;
  })();

  // 字元 → 調色盤鍵；對照表物件重複使用，每次呼叫只覆寫 10 個值，不配置新物件
  const CATPIX_KEYS = [
    ['k', 'body'], ['s', 'shade'], ['r', 'rim'], ['e', 'eye'], ['p', 'pupil'],
    ['g', 'glove'], ['d', 'pad'], ['i', 'earIn'], ['n', 'nose'], ['w', 'white']
  ];
  const CATPIX_MAP = {};
  const CATPIX_OPTS = { sx: 1, sy: 1, ax: CATPIX_AX, ay: CATPIX_AY };
  const CATPIX_DEFAULT_LOOK = Object.freeze({ pose: 'idle', mood: 'normal', sx: 1, sy: 1, tail: 0, palette: null });

  function catPixScale(value) {
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  // (cx, cy)：碰撞中心（美術像素，可為小數）；look = { pose, mood, sx, sy, tail, palette }
  function pixelDrawCat(pix, cx, cy, look) {
    const lk = look || CATPIX_DEFAULT_LOOK;
    const set = CATPIX_SPRITES[lk.pose] || CATPIX_SPRITES.idle;
    const frames = set.moods[lk.mood] || set.moods.normal;
    const tail = Number.isFinite(lk.tail) ? lk.tail : 0;
    const rows = frames[tail < -CATPIX_TAIL_STEP ? 0 : tail > CATPIX_TAIL_STEP ? 2 : 1];
    const palette = lk.palette || PIXEL_CAT_PALETTE;
    for (let i = 0; i < CATPIX_KEYS.length; i++) {
      const key = CATPIX_KEYS[i][1];
      CATPIX_MAP[CATPIX_KEYS[i][0]] = palette[key] || PIXEL_CAT_PALETTE[key];
    }
    // 形變只保留姿勢表指定的比例（球：大部分抵銷，維持圓滾滾的球形）
    const keep = set.keep;
    const sy = 1 + (catPixScale(lk.sy) - 1) * keep;
    CATPIX_OPTS.sx = 1 + (catPixScale(lk.sx) - 1) * keep;
    CATPIX_OPTS.sy = sy;
    CATPIX_OPTS.ay = set.snap;
    // 縮放錨點＝碰撞中心；但縱向縮小時最近鄰每 5 列會丟 1 列，所以改拿「臉部那條像素交界（snap 列）」
    // 當取樣錨點並對齊整數列：交界上 2 列、下 2 列（眼睛＋鼻子）在 0.8～1 倍之間保證完整。
    // 兩種錨點對應同一個縮放變換，碰撞中心（第 CATPIX_AY 列）仍落在 cy 的 ±0.5px 內；取整也讓貓上下移動時不閃爍
    pix.sprite(rows, CATPIX_MAP, Math.round(cx), Math.round(cy + (set.snap - CATPIX_AY) * sy), CATPIX_OPTS);
  }
  // #endregion pixel:cat

  // #region pixel:fx
  // ---------------------------------------------------------------------------
  // pixel:fx — 道具、粒子、點陣分數、無敵計量條與像素面板
  // 精靈圖在載入時就編譯成「矩形清單」，每幀只剩 fillRect；全部走整數網格，不畫曲線、不取亂數
  // ---------------------------------------------------------------------------
  const FX_INK = '#4A3324';        // 深胡桃：描邊、投影
  const FX_CREAM = '#F4F1EA';      // 米白：數字與面板底色
  const FX_GLINT = '#FFFDF6';      // 反光白（比純白暖一點，貼著米白牆面才不刺眼）
  const FX_GOLD = '#E3BE62';       // 閃光十字的金色光芒
  const FX_GOLD_DEEP = '#B98E3C';

  // 字元圖 → 矩形清單：同列同色的連續像素先併成一段，上下完全對齊的段再併成長方形
  function fxCompile(rows, palette) {
    const rects = [];
    let open = new Map();
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      const next = new Map();
      let x = 0;
      while (x < row.length) {
        const ch = row[x];
        let end = x + 1;
        while (end < row.length && row[end] === ch) end++;
        const color = palette[ch];
        if (color) {
          const key = x + ':' + end + ':' + ch;
          const prev = open.get(key);
          if (prev) {
            prev.h += 1;
            next.set(key, prev);
          } else {
            const rect = { x, y, w: end - x, h: 1, color };
            rects.push(rect);
            next.set(key, rect);
          }
        }
        x = end;
      }
      open = next;
    }
    return rects;
  }

  function fxSprite(rows, palette) {
    return { w: rows[0].length, h: rows.length, rects: fxCompile(rows, palette) };
  }

  // 在字元圖外圍加一圈描邊字元 ch（四鄰接，轉角會留出階梯缺口，看起來比較圓），四周各多 1 格
  function fxOutline(rows, ch) {
    const h = rows.length;
    const w = rows[0].length;
    const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && rows[y][x] !== '.';
    const out = [];
    for (let y = -1; y <= h; y++) {
      let line = '';
      for (let x = -1; x <= w; x++) {
        if (on(x, y)) line += rows[y][x];
        else if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) line += ch;
        else line += '.';
      }
      out.push(line);
    }
    return out;
  }

  // 順時針轉 90°（腳印粒子依旋轉角挑四個方向之一）
  function fxRotate(rows) {
    const out = [];
    for (let x = 0; x < rows[0].length; x++) {
      let line = '';
      for (let y = rows.length - 1; y >= 0; y--) line += rows[y][x];
      out.push(line);
    }
    return out;
  }

  // 每個非透明字元換成同一個字元：做成遮罩，給描邊與投影用
  function fxMask(rows, ch) {
    return rows.map((row) => row.replace(/[^.]/g, ch));
  }

  // 封閉的內洞（0、4、6、8、9 的字腔）整塊填成 ch：從外圍往內淹，淹不到的透明格就是洞
  function fxFillHoles(rows, ch) {
    const h = rows.length;
    const w = rows[0].length;
    const outside = rows.map(() => new Array(w).fill(false));
    const stack = [];
    for (let x = 0; x < w; x++) stack.push([x, 0], [x, h - 1]);
    for (let y = 0; y < h; y++) stack.push([0, y], [w - 1, y]);
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h || outside[y][x] || rows[y][x] !== '.') continue;
      outside[y][x] = true;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    return rows.map((row, y) => row.replace(/./g, (c, x) => (c === '.' && !outside[y][x] ? ch : c)));
  }

  // 在 (x, y) 左上角把矩形清單畫出來；color 若是色槽代號（'1'～'3'）就換成呼叫端給的顏色
  function fxBlit(pix, rects, x, y, c1, c2, c3) {
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      let color = r.color;
      if (color === '1') color = c1;
      else if (color === '2') color = c2;
      else if (color === '3') color = c3;
      pix.rect(x + r.x, y + r.y, r.w, r.h, color);
    }
  }

  // 透明度量化成 1/4 階，淡出時一格一格跳，才有像素遊戲的手感
  function fxQuantFade(life, maxLife) {
    const fade = maxLife > 0 ? clamp(life / maxLife, 0, 1) : 0;
    return Math.ceil(fade * 4) / 4;
  }

  // 顏色加深（碎屑的暗邊）：只解析 #rgb / #rrggbb，其餘格式退回半透明深胡桃；結果快取，不會每幀配置
  const FX_SHADE_CACHE = new Map();
  function fxShade(color) {
    const hit = FX_SHADE_CACHE.get(color);
    if (hit) return hit;
    let shade = 'rgba(74, 51, 36, 0.7)';
    // 十六進位解析共用像素主題基礎區的 pixelHexRgb（彩虹調色盤也是用它）
    const rgb = pixelHexRgb(color);
    if (rgb) {
      // 往暖褐色壓暗：亮部色相保留，陰影偏胡桃而不是發灰
      const r = Math.round(rgb[0] * 0.66 + 10);
      const g = Math.round(rgb[1] * 0.62 + 4);
      const b = Math.round(rgb[2] * 0.58);
      shade = 'rgb(' + r + ', ' + g + ', ' + b + ')';
    }
    if (FX_SHADE_CACHE.size < 64) FX_SHADE_CACHE.set(color, shade);
    return shade;
  }

  // --- 道具：金屬貓罐頭／綠色貓草瓶（光源在左上） ------------------------------------
  // 閃光共 8 個相位，每相位 6 步（0.1 秒）：前半段一道斜向反光掃過瓶罐，四周十字星輪流眨眼
  const FX_ITEM_PHASE_TICKS = 6;
  const FX_ITEM_SWEEP = [-99, 2, 5, 8, 11, 14, -99, -99]; // 反光斜線 x + y 的位置；-99 = 本相位不掃

  const FX_CAN_ROWS = [
    '..kkkkkkkk..',
    '.kLLLLLLLLk.',
    'kLMMrrrrMMLk',
    'kLMrMMMMrMDk',
    'kWLLrrrrLLDk',
    'kLPPPPPPPpDk',
    'kLPfPffPPpDk',
    'kLPfffffPpDk',
    'kLPfPffPPpDk',
    'kMPPPPPPPpDk',
    '.kDDDDDDDDk.',
    '..kkkkkkkk..'
  ];
  const FX_CAN_PAL = Object.freeze({
    k: '#3D3A42', // 罐身描邊（冷灰，和暖色牆面拉開）
    W: '#FFFFFF',
    L: '#E4E6E9',
    M: '#BFC3C9',
    D: '#8D929A',
    r: '#8D929A', // 拉環
    P: '#9FBDD1', // 粉藍標籤
    p: '#7F9EB5',
    f: '#FFF6EA', // 標籤上的小魚
    G: FX_GLINT
  });

  const FX_GRASS_ROWS = [
    '...kkkk...',
    '..kCCcck..',
    '..kttttk..',
    '.kgWgggGk.',
    'kgWeggegGk',
    'kWLLeLLLlk',
    'kWaaaaaAGk',
    'kGaaaLLAGk',
    'kGaaLlaAGk',
    'kGaaaaaAGk',
    '.kLllllLk.',
    '..kkkkkk..'
  ];
  const FX_GRASS_PAL = Object.freeze({
    k: '#2F3A2B',
    C: '#C9A27E', // 軟木塞
    c: '#9C7657',
    t: PAL.walnut, // 瓶頸麻繩
    g: '#CFE0C6', // 帶綠的玻璃
    G: '#A9C09F', // 玻璃暗側
    W: '#F4F8F0',
    e: '#8FA67F', // 葉尖
    L: PAL.sage,
    l: PAL.moss,
    a: '#E6ECDA', // 淡抹茶色標籤（整瓶維持綠色調）
    A: '#CAD6BC',
    X: FX_GLINT
  });

  // 可以被反光斜線蓋過的「本體」字元（描邊、標籤圖案不蓋）
  const FX_SWEEP_BODY = /[LMDPpWgGlaAe]/;

  function fxItemFrames(rows, palette, glintChar) {
    const frames = [];
    for (let p = 0; p < FX_ITEM_SWEEP.length; p++) {
      const s = FX_ITEM_SWEEP[p];
      const lined = rows.map((row, y) => row.replace(/./g, (ch, x) => {
        const d = x + y - s;
        return (d === 0 || d === 1) && FX_SWEEP_BODY.test(ch) ? glintChar : ch;
      }));
      frames.push(fxSprite(lined, palette));
    }
    return frames;
  }

  const FX_ITEMS = Object.freeze({
    can: fxItemFrames(FX_CAN_ROWS, FX_CAN_PAL, 'G'),
    grass: fxItemFrames(FX_GRASS_ROWS, FX_GRASS_PAL, 'X')
  });

  // 十字星：0 = 不亮、1 = 單點、2 = 小十字、3 = 大十字（中心白、光芒金）
  const FX_TWINKLE = [
    null,
    fxSprite(['1'], { 1: FX_GLINT }),
    fxSprite(['.2.', '212', '.2.'], { 1: FX_GLINT, 2: FX_GOLD }),
    fxSprite(['..3..', '..2..', '32123', '..2..', '..3..'], { 1: FX_GLINT, 2: FX_GOLD, 3: FX_GOLD_DEEP })
  ];
  // 每個閃光點 8 相位的亮度序列，三個點錯開相位
  const FX_TWINKLE_SEQ = [0, 1, 2, 3, 2, 1, 0, 0];
  const FX_TWINKLE_SITES = [
    { dx: -9, dy: -6, shift: 0 },
    { dx: 9, dy: -3, shift: 3 },
    { dx: -6, dy: 8, shift: 5 }
  ];

  // 背後一圈暖光（階梯狀圓盤，內圈較亮），隨相位一大一小地呼吸，讓道具在米白牆上也一眼看得出是「可以吃的東西」
  function fxDiscRows(r, inner) {
    const rows = [];
    for (let y = 0; y < r * 2; y++) {
      const dy = y + 0.5 - r;
      let line = '';
      for (let x = 0; x < r * 2; x++) {
        const dx = x + 0.5 - r;
        const d2 = dx * dx + dy * dy;
        line += d2 <= inner * inner ? 'i' : d2 <= r * r ? 'o' : '.';
      }
      rows.push(line);
    }
    return rows;
  }
  const FX_HALO_PAL = { i: '#FFFBEC', o: '#FFF3D6' };
  const FX_HALO = [fxSprite(fxDiscRows(10, 7), FX_HALO_PAL), fxSprite(fxDiscRows(9, 6), FX_HALO_PAL)];

  function pixelDrawItem(pix, cx, cy, kind, tick) {
    const frames = FX_ITEMS[kind] || FX_ITEMS.can;
    const phase = Math.floor((tick || 0) / FX_ITEM_PHASE_TICKS) & 7;
    const x = Math.round(cx);
    const y = Math.round(cy);

    const halo = FX_HALO[phase >> 2];
    pix.alpha(0.55);
    fxBlit(pix, halo.rects, x - (halo.w >> 1), y - (halo.h >> 1));
    pix.alpha(1);

    const sprite = frames[phase];
    fxBlit(pix, sprite.rects, x - (sprite.w >> 1), y - (sprite.h >> 1));

    for (let i = 0; i < FX_TWINKLE_SITES.length; i++) {
      const site = FX_TWINKLE_SITES[i];
      const star = FX_TWINKLE[FX_TWINKLE_SEQ[(phase + site.shift) & 7]];
      if (!star) continue;
      fxBlit(pix, star.rects, x + site.dx - (star.w >> 1), y + site.dy - (star.h >> 1));
    }
  }

  // --- 粒子：腳印塵、撞擊星星、家具碎屑、拾取閃光 -------------------------------------
  // 色槽：'1' = fx.color、'2' = 描邊、'3' = 高光白
  const FX_PAW_SMALL_ROWS = ['1.1', '111', '111'];
  const FX_PAW_BIG_ROWS = ['.1.1.', '1...1', '.111.', '11111', '.111.'];
  const FX_STAR_SMALL_ROWS = ['..1..', '..1..', '11111', '.111.', '.1.1.'];
  const FX_STAR_BIG_ROWS = ['...1...', '..111..', '1111111', '.11111.', '..111..', '.11.11.', '.1...1.'];
  const FX_SLOT_PAL = { 1: '1', 2: '2', 3: '3' };

  function fxDirections(rows) {
    const out = [rows];
    for (let i = 1; i < 4; i++) out.push(fxRotate(out[i - 1]));
    return out;
  }

  const FX_PAW = Object.freeze({
    small: fxDirections(FX_PAW_SMALL_ROWS).map((rows) => fxSprite(rows, FX_SLOT_PAL)),
    big: fxDirections(FX_PAW_BIG_ROWS).map((rows) => fxSprite(rows, FX_SLOT_PAL)),
    bigLined: fxDirections(FX_PAW_BIG_ROWS).map((rows) => fxSprite(fxOutline(rows, '2'), FX_SLOT_PAL))
  });
  // 五角星有 72° 對稱：轉角落在前半 36° 用正立、後半用倒立，連續播放就像在翻轉
  const FX_STAR = Object.freeze({
    small: [FX_STAR_SMALL_ROWS, FX_STAR_SMALL_ROWS.slice().reverse()].map((rows) => fxSprite(fxOutline(rows, '2'), FX_SLOT_PAL)),
    big: [FX_STAR_BIG_ROWS, FX_STAR_BIG_ROWS.slice().reverse()].map((rows) => fxSprite(fxOutline(rows, '2'), FX_SLOT_PAL))
  });

  // 拾取閃光：arm = 光芒長度 0～3，diag = 斜角眨眼格
  function fxSparkRows(arm, diag) {
    const size = arm * 2 + 1;
    const rows = [];
    for (let y = 0; y < size; y++) {
      let line = '';
      for (let x = 0; x < size; x++) {
        const dx = Math.abs(x - arm);
        const dy = Math.abs(y - arm);
        if (dx === 0 && dy === 0) line += '3';
        else if (diag && arm === 1) line += dx === 1 && dy === 1 ? '1' : '.'; // 3×3 眨眼改成 ×，不然會糊成方塊
        else if (dx === 0 || dy === 0) line += (dx + dy === 1 && arm > 1) ? '3' : '1';
        else if (diag && dx === 1 && dy === 1) line += '1';
        else line += '.';
      }
      rows.push(line);
    }
    return rows;
  }
  const FX_SPARK = [0, 1, 2, 3].map((arm) => [false, true].map((diag) => fxSprite(fxSparkRows(arm, diag), FX_SLOT_PAL)));

  const FX_EDGE = '#8C6A50';       // 前景粒子描邊（暖褐，米白牆上也看得清）
  const FX_PAW_BIG_AT = 4.4;       // 虛擬尺寸 ≥ 這個值就用 5×5 大腳印
  const FX_STAR_BIG_AT = 6.2;
  const FX_QUARTER = TAU / 4;
  const FX_TENTH = TAU / 10;

  function fxDirIndex(rot) {
    return ((Math.round((rot || 0) / FX_QUARTER) % 4) + 4) % 4;
  }

  function fxDrawCentered(pix, sprite, x, y, c1, c2, c3) {
    fxBlit(pix, sprite.rects, x - (sprite.w >> 1), y - (sprite.h >> 1), c1, c2, c3);
  }

  function fxDrawChip(pix, x, y, size, rot, color) {
    const n = clamp(Math.round(size / PX), 1, 3);
    if (n === 1) {
      pix.dot(x, y, color);
      return;
    }
    const shade = fxShade(color);
    if (n === 2) {
      pix.rect(x, y, 2, 2, color);
      pix.dot(x + 1, y + 1, shade);
      return;
    }
    // 3 格：轉角落在 45° 附近畫成菱形（翻滾感），否則畫方塊；暗邊一律在右下（光從左上來）
    const turn = (((rot || 0) % FX_QUARTER) + FX_QUARTER) % FX_QUARTER;
    if (turn > FX_QUARTER * 0.25 && turn < FX_QUARTER * 0.75) {
      pix.rect(x - 1, y, 3, 1, color);
      pix.dot(x, y - 1, color);
      pix.dot(x, y + 1, shade);
      pix.dot(x + 1, y, shade);
    } else {
      pix.rect(x - 1, y - 1, 3, 3, color);
      pix.rect(x, y + 1, 2, 1, shade);
      pix.dot(x + 1, y, shade);
    }
  }

  function pixelDrawEffect(pix, fx) {
    const q = fxQuantFade(fx.life, fx.maxLife);
    const a = (fx.alpha === undefined ? 1 : fx.alpha) * q;
    if (a <= 0) return;
    const color = typeof fx.color === 'string' ? fx.color : '#FFFFFF';
    const x = Math.round(fx.x / PX);
    const y = Math.round(fx.y / PX);
    const size = fx.size || 4;
    pix.alpha(a);
    switch (fx.kind) {
      case 'star': {
        const set = size >= FX_STAR_BIG_AT ? FX_STAR.big : FX_STAR.small;
        const turn = (((fx.rot || 0) % (FX_TENTH * 2)) + FX_TENTH * 2) % (FX_TENTH * 2);
        fxDrawCentered(pix, set[turn < FX_TENTH ? 0 : 1], x, y, color, FX_EDGE, FX_GLINT);
        break;
      }
      case 'chip':
        fxDrawChip(pix, x, y, size, fx.rot, color);
        break;
      case 'spark': {
        const base = clamp(Math.round(size / (PX * 1.6)), 1, 3);
        const arm = clamp(base - (q >= 0.75 ? 0 : q >= 0.5 ? 1 : 2), 0, 3);
        // 每 4 步換一次閃光造型；使用者要求減少動態時固定在同一個造型，只保留自然淡出
        const blink = reduceMotion ? 0 : ((fx.life | 0) >> 2) & 1;
        fxDrawCentered(pix, FX_SPARK[arm][blink], x, y, color, FX_EDGE, FX_GLINT);
        break;
      }
      default: {
        // 'paw'：背景層的跳躍塵會隨時間稍微變大（對應經典版的放大淡出）
        const fade = fx.maxLife > 0 ? clamp(fx.life / fx.maxLife, 0, 1) : 0;
        const grown = fx.layer === 'back' ? size * (1 + (1 - fade) * 0.4) : size;
        const dir = fxDirIndex(fx.rot);
        let sprite = FX_PAW.small[dir];
        if (grown >= FX_PAW_BIG_AT) sprite = fx.layer === 'front' ? FX_PAW.bigLined[dir] : FX_PAW.big[dir];
        fxDrawCentered(pix, sprite, x, y, color, FX_EDGE, FX_GLINT);
        break;
      }
    }
    pix.alpha(1);
  }

  // --- 點陣分數：9×13 粗體數字（直筆 3 格、橫筆 2 格），1 格胡桃描邊 + 右下 1 格投影 ---------
  const FX_DIGIT_ROWS = [
    ['..#####..', '.#######.', '###...###', '###...###', '###...###', '###...###', '###...###', '###...###', '###...###', '###...###', '###...###', '.#######.', '..#####..'],
    ['..###..', '.####..', '#####..', '..###..', '..###..', '..###..', '..###..', '..###..', '..###..', '..###..', '..###..', '#######', '#######'],
    ['..#####..', '.#######.', '###...###', '......###', '......###', '.....###.', '...####..', '..###....', '.###.....', '###......', '###......', '#########', '#########'],
    ['..#####..', '.#######.', '###...###', '......###', '......###', '...#####.', '...#####.', '......###', '......###', '......###', '###...###', '.#######.', '..#####..'],
    ['.....###.', '....####.', '...#####.', '..###.###', '.###..###', '###...###', '#########', '#########', '......###', '......###', '......###', '......###', '......###'],
    ['#########', '#########', '###......', '###......', '###......', '#######..', '########.', '......###', '......###', '......###', '###...###', '.#######.', '..#####..'],
    ['..#####..', '.#######.', '###...###', '###......', '###......', '#######..', '########.', '###...###', '###...###', '###...###', '###...###', '.#######.', '..#####..'],
    ['#########', '#########', '......###', '......###', '.....###.', '....###..', '...###...', '...###...', '..###....', '..###....', '..###....', '..###....', '..###....'],
    ['..#####..', '.#######.', '###...###', '###...###', '###...###', '.#######.', '.#######.', '###...###', '###...###', '###...###', '###...###', '.#######.', '..#####..'],
    ['..#####..', '.#######.', '###...###', '###...###', '###...###', '###...###', '.########', '..#######', '......###', '......###', '###...###', '.#######.', '..#####..']
  ];
  const FX_DIGIT_H = 13;
  const FX_DIGIT_GAP = 2;
  const FX_SCORE_CY = 42;
  const FX_SCORE_FILL = FX_CREAM;
  const FX_SCORE_BAND = '#E2D5C1';   // 下半段的暖灰帶：像老遊戲機的雙色字
  const FX_SCORE_LINE = PAL.walnut;
  const FX_SCORE_SHADOW = FX_INK;

  // 字身：上面第 1 列亮白、第 8 列以下換成暖灰帶
  function fxDigitFill(rows) {
    return rows.map((row, y) => row.replace(/#/g, y === 0 ? 'h' : y >= 8 ? 'b' : 'f'));
  }

  const FX_DIGITS = FX_DIGIT_ROWS.map((rows) => {
    const edge = fxFillHoles(fxOutline(fxMask(rows, 'o'), 'o'), 'o');
    return {
      w: rows[0].length,
      fill: fxCompile(fxDigitFill(rows), { h: '#FFFFFF', f: FX_SCORE_FILL, b: FX_SCORE_BAND }),
      edge: fxCompile(edge, { o: FX_SCORE_LINE }),
      shadow: fxCompile(edge, { o: FX_SCORE_SHADOW })
    };
  });

  // 分數拆成個位數字：預先配置好陣列，每幀不產生新字串
  const FX_SCORE_BUF = new Array(12);

  function pixelDrawScore(pix, score) {
    let n = Math.max(0, Math.floor(Number(score) || 0));
    let count = 0;
    do {
      FX_SCORE_BUF[count++] = n % 10;
      n = Math.floor(n / 10);
    } while (n > 0 && count < FX_SCORE_BUF.length);

    let width = -FX_DIGIT_GAP;
    for (let i = 0; i < count; i++) width += FX_DIGITS[FX_SCORE_BUF[i]].w + FX_DIGIT_GAP;
    const left = Math.round(LOW_W / 2 - width / 2);
    const top = FX_SCORE_CY - (FX_DIGIT_H >> 1);

    // 三趟：先全部投影、再全部描邊、最後字身，相鄰數字的描邊才不會互相蓋掉
    for (let pass = 0; pass < 3; pass++) {
      let x = left;
      for (let i = count - 1; i >= 0; i--) {
        const glyph = FX_DIGITS[FX_SCORE_BUF[i]];
        if (pass === 0) fxBlit(pix, glyph.shadow, x, top);
        else if (pass === 1) fxBlit(pix, glyph.edge, x - 1, top - 1);
        else fxBlit(pix, glyph.fill, x, top);
        x += glyph.w + FX_DIGIT_GAP;
      }
    }
  }

  // --- 無敵衝刺計量條：分數下方 40×4 的彩虹斜紋，剩最後 1/4 時閃爍提醒 ---------------------
  const FX_METER = Object.freeze({ w: 40, h: 4, y: 58, steps: FRENZY.steps });
  const FX_METER_STRIPES = Object.freeze(['#E59A94', '#E8B78A', '#E3D48D', '#A9C79A', '#8EBBD2', '#AFA3D6']);
  const FX_METER_BAND = 3; // 每色斜紋寬度

  function pixelDrawFrenzyMeter(pix, t) {
    const remain = clamp(Number(t) || 0, 0, 1);
    if (remain <= 0) return;
    const left = Math.round(LOW_W / 2 - FX_METER.w / 2);
    const top = FX_METER.y;
    const step = Math.round(remain * FX_METER.steps);
    // 最後 1/4：框變淺木色、液面變米白，節奏與減少動態的處理見 frenzyMeterWarn
    const warn = frenzyMeterWarn(remain, step);

    // 外框：胡桃 1 格 + 右下 1 格深色投影
    pix.rect(left, top, FX_METER.w + 2, FX_METER.h + 2, FX_INK);
    pix.rect(left - 1, top - 1, FX_METER.w + 2, FX_METER.h + 2, warn ? PAL.oak : PAL.walnut);
    pix.rect(left, top, FX_METER.w, FX_METER.h, '#5B4636');

    const fill = Math.max(1, Math.ceil(FX_METER.w * remain));
    const shift = Math.floor(step / 2);
    for (let row = 0; row < FX_METER.h; row++) {
      // 斜紋：每往下一列往左錯一格，隨剩餘時間往右流動
      let x = 0;
      while (x < fill) {
        const k = x + row + shift;
        const band = Math.floor(k / FX_METER_BAND);
        const end = Math.min(fill, x + FX_METER_BAND - (k % FX_METER_BAND));
        const color = warn ? FX_CREAM : FX_METER_STRIPES[band % FX_METER_STRIPES.length];
        pix.rect(left + x, top + row, end - x, 1, color);
        x = end;
      }
    }
    // 上緣一列亮光、填滿處右端一格亮白，像液面
    pix.alpha(0.45);
    pix.rect(left, top, fill, 1, '#FFFFFF');
    pix.alpha(1);
    pix.rect(left + fill - 1, top, 1, FX_METER.h, FX_GLINT);
  }

  // --- 像素面板（主畫布、虛擬座標）：階梯缺角、胡桃邊框、米白底、內側亮暗邊 -------------------
  // corner = 外輪廓由外往內每一階（高 PX）的內縮格數；inner = 填色區的階梯；rule = 卡片內側細框的內縮
  const FX_PANEL_STYLES = Object.freeze({
    panel: {
      border: 4, corner: [4, 2, 1], inner: [2, 1], drop: 4, rule: 6,
      edge: PAL.walnut, fill: '#FBF7EF', light: '#FFFFFF', dark: '#ECE2D1', ruleColor: '#E7DAC6',
      shadow: 'rgba(58, 36, 20, 0.28)'
    },
    pill: {
      border: 2, corner: [5, 3, 2, 1, 1], inner: [4, 2, 1], drop: 2, rule: 0,
      edge: '#9C7A5E', fill: 'rgba(251, 247, 239, 0.94)', light: 'rgba(255, 255, 255, 0.9)',
      dark: 'rgba(222, 208, 188, 0.7)', ruleColor: null, shadow: 'rgba(58, 36, 20, 0.18)'
    },
    badge: {
      border: 2, corner: [2, 1], inner: [1], drop: 2, rule: 0,
      edge: '#B45876', fill: '#EE86A8', light: '#F7B3C9', dark: '#DC6E93', ruleColor: null,
      shadow: 'rgba(90, 30, 50, 0.3)'
    }
  });

  // 面板畫在主畫布上、用虛擬座標：縮放比例不是整數（例如桌機的 1.2 倍）時，2px 一階的邊緣會落在實體像素中間，
  // 被抗鋸齒糊成圓角。每個矩形的四邊都先用目前的變換換算成裝置座標、取整後再換回來——同一條邊永遠落在
  // 同一條實體像素線上，階梯寬度跟放大後的像素緩衝區一樣是 2 或 3 個實體像素，但邊緣一定銳利；
  // 結算卡片彈出縮放、畫面震動時也一樣。變換含旋轉或取不到（測試用的假 context）就照原座標畫。
  // fxPanelGridState 是每次畫面板前由 fxPanelGrid 改寫的暫存狀態，不是常數表（不能凍結）
  const fxPanelGridState = { on: false, a: 1, d: 1, e: 0, f: 0 };

  function fxPanelGrid(ctx) {
    const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    const on = !!m && m.b === 0 && m.c === 0 && m.a > 0 && m.d > 0;
    fxPanelGridState.on = on;
    if (!on) return;
    fxPanelGridState.a = m.a;
    fxPanelGridState.d = m.d;
    fxPanelGridState.e = m.e;
    fxPanelGridState.f = m.f;
  }

  function fxRect(ctx, x, y, w, h) {
    const g = fxPanelGridState;
    if (!g.on) {
      ctx.rect(x, y, w, h);
      return;
    }
    const x0 = (Math.round(g.a * x + g.e) - g.e) / g.a;
    const x1 = (Math.round(g.a * (x + w) + g.e) - g.e) / g.a;
    const y0 = (Math.round(g.d * y + g.f) - g.f) / g.d;
    const y1 = (Math.round(g.d * (y + h) + g.f) - g.f) / g.d;
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
  }

  // 把階梯形輪廓加進目前的 path（整個形狀一次 fill，相鄰色塊之間才不會因抗鋸齒疊出細縫）
  function fxStepPath(ctx, x, y, w, h, steps) {
    const n = Math.min(steps.length, Math.floor(h / (PX * 2)));
    for (let i = 0; i < n; i++) {
      const inset = steps[i] * PX;
      fxRect(ctx, x + inset, y + i * PX, w - inset * 2, PX);
      fxRect(ctx, x + inset, y + h - (i + 1) * PX, w - inset * 2, PX);
    }
    fxRect(ctx, x, y + n * PX, w, h - n * PX * 2);
  }

  function fxFillSteps(ctx, x, y, w, h, steps, color) {
    ctx.beginPath();
    fxStepPath(ctx, x, y, w, h, steps);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // 各層互不重疊：邊框只畫「外輪廓減內輪廓」的環、投影只畫卡片以外露出的部分。
  // 結算卡片彈出時整張半透明（globalAlpha = t），重疊的色塊會透出來，底色就會發褐
  function fxPanelFrame(ctx, x, y, w, h, s) {
    const b = s.border;
    ctx.save();
    ctx.beginPath();
    fxRect(ctx, x, y, w + s.drop, h + s.drop);
    fxStepPath(ctx, x, y, w, h, s.corner);
    ctx.clip('evenodd');
    fxFillSteps(ctx, x + s.drop, y + s.drop, w, h, s.corner, s.shadow);
    ctx.restore();

    ctx.beginPath();
    fxStepPath(ctx, x, y, w, h, s.corner);
    fxStepPath(ctx, x + b, y + b, w - b * 2, h - b * 2, s.inner);
    ctx.fillStyle = s.edge;
    ctx.fill('evenodd');
  }

  function pixelDrawPanel(ctx, x, y, w, h, style) {
    const s = FX_PANEL_STYLES[style] || FX_PANEL_STYLES.panel;
    const b = s.border;
    const ix = x + b;
    const iy = y + b;
    const iw = w - b * 2;
    const ih = h - b * 2;
    const cut = s.inner.length * PX;       // 填色區轉角階梯佔掉的高度
    const lip = (s.inner[0] || 0) * PX;    // 填色區第一階的內縮
    ctx.save();
    fxPanelGrid(ctx);
    fxPanelFrame(ctx, x, y, w, h, s);
    fxFillSteps(ctx, ix, iy, iw, ih, s.inner, s.fill);

    // 斜面：左、上兩邊一格亮，右、下兩邊一格暗（光從左上來）
    ctx.beginPath();
    fxRect(ctx, ix + lip, iy, iw - lip * 2, PX);
    fxRect(ctx, ix, iy + cut, PX, ih - cut * 2);
    ctx.fillStyle = s.light;
    ctx.fill();
    ctx.beginPath();
    fxRect(ctx, ix + lip, iy + ih - PX, iw - lip * 2, PX);
    fxRect(ctx, ix + iw - PX, iy + cut, PX, ih - cut * 2);
    ctx.fillStyle = s.dark;
    ctx.fill();

    // 卡片內側再描一圈缺角細框，像和紙便條的壓線
    if (s.rule && s.ruleColor && iw > s.rule * 4 && ih > s.rule * 4) {
      const rx = ix + s.rule;
      const ry = iy + s.rule;
      const rw = iw - s.rule * 2;
      const rh = ih - s.rule * 2;
      ctx.beginPath();
      fxRect(ctx, rx + PX, ry, rw - PX * 2, PX);
      fxRect(ctx, rx + PX, ry + rh - PX, rw - PX * 2, PX);
      fxRect(ctx, rx, ry + PX, PX, rh - PX * 2);
      fxRect(ctx, rx + rw - PX, ry + PX, PX, rh - PX * 2);
      ctx.fillStyle = s.ruleColor;
      ctx.fill();
    }
    ctx.restore();
  }
  // #endregion pixel:fx
  // #endregion theme:pixel16

  // ---------------------------------------------------------------------------
  // 主題策略表：兩種主題實作同一組方法，render() 只認這張表
  // ---------------------------------------------------------------------------
  const Themes = Object.freeze({
    classic: Object.freeze({
      grid: 0,
      badgeTilt: 12 * DEG,
      renderScene: (alpha) => drawScene(Themes.classic, alpha),
      drawBackground: (scroll) => {
        drawWall(scroll);
        drawMotes();
      },
      drawObstacles: drawPipes,
      drawItems: classicDrawItems,
      drawGround: drawFloor,
      drawPlayer: classicDrawPlayer,
      drawEffects,
      drawScore,
      drawPanel: classicDrawPanel,
      debrisColors: () => CLASSIC_DEBRIS
    }),
    // 像素圖的新紀錄標籤不旋轉，保持格線對齊
    pixel16: Object.freeze({
      grid: PX,
      badgeTilt: 0,
      renderScene: pixelRenderScene,
      drawBackground: pixelDrawLayers,
      drawObstacles: pixelDrawObstacles,
      drawItems: pixelDrawItems,
      drawGround: pixelDrawFloor,
      drawPlayer: pixelDrawPlayer,
      drawEffects: pixelDrawEffects,
      drawScore: pixelDrawHud,
      drawPanel: (x, y, w, h, style) => pixelDrawPanel(ctx, x, y, w, h, style),
      debrisColors: pixelDebrisColors
    })
  });

  // --- 介面層（兩種主題共用版面，只有面板與分數的樣式不同） -----------------------
  function drawOverlay(theme) {
    switch (game.state) {
      case State.READY:
        drawReadyScreen(theme);
        break;
      case State.PAUSED:
        drawPausedScreen(theme);
        break;
      case State.GAMEOVER:
        drawGameOverPanel(theme);
        break;
      default:
        break;
    }
  }

  function drawReadyScreen(theme) {
    const bob = Math.sin(game.tick * 0.05) * 3;
    drawText('貓咪跳箱', VIEW_W / 2, 150 + bob, { size: 48, fill: INK, stroke: '#FFFFFF', strokeWidth: 10 });
    drawText('CAT AGILITY', VIEW_W / 2, 196, { size: 15, weight: 800, fill: '#B9794A' });

    theme.drawPanel(VIEW_W / 2 - 124, 379, 248, 42, 'pill');
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

  function drawPausedScreen(theme) {
    ctx.fillStyle = 'rgba(58, 36, 20, 0.35)';
    ctx.fillRect(-SHAKE.amplitude * 2, -SHAKE.amplitude * 2, VIEW_W + SHAKE.amplitude * 4, VIEW_H + SHAKE.amplitude * 4);
    const top = pausePanelTop(cat.y);
    theme.drawPanel(VIEW_W / 2 - 120, top, 240, PAUSE_PANEL.height, 'panel');
    drawText('暫停中', VIEW_W / 2, top + 42, { size: 30, fill: INK });
    drawText('點擊螢幕或按空白鍵繼續', VIEW_W / 2, top + 90, { size: 15, weight: 800, fill: WOOD });
  }

  function easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function drawGameOverPanel(theme) {
    if (game.overTicks < PANEL_DELAY) return;
    const t = clamp((game.overTicks - PANEL_DELAY) / 18, 0, 1);
    const scale = Math.max(0.01, easeOutBack(t));

    ctx.fillStyle = `rgba(58, 36, 20, ${(0.28 * t).toFixed(3)})`;
    ctx.fillRect(-SHAKE.amplitude * 2, -SHAKE.amplitude * 2, VIEW_W + SHAKE.amplitude * 4, VIEW_H + SHAKE.amplitude * 4);

    ctx.save();
    ctx.translate(VIEW_W / 2, 300);
    ctx.scale(scale, scale);
    ctx.globalAlpha = t;
    theme.drawPanel(-130, -120, 260, 240, 'panel');
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
      ctx.rotate(theme.badgeTilt);
      theme.drawPanel(-40, -15, 80, 30, 'badge');
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
  const STYLE_NAMES = Object.freeze({ pixel16: '像素', classic: '經典' });

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

  // 風格鍵顯示「目前」的風格；像素緩衝區建不起來時只剩經典可用，按鈕直接藏起來
  function syncStyleButton() {
    if (stageEl) stageEl.setAttribute('data-style', activeTheme());
    if (!styleBtn) return;
    if (!pixelAvailable()) {
      styleBtn.hidden = true;
      return;
    }
    const current = GameConfig.currentTheme;
    const next = current === 'pixel16' ? 'classic' : 'pixel16';
    const label = `畫面風格：${STYLE_NAMES[current]}，點擊切換為${STYLE_NAMES[next]}`;
    styleBtn.setAttribute('aria-label', label);
    styleBtn.title = label;
    const text = styleBtn.querySelector('span');
    if (text) text.textContent = STYLE_NAMES[current];
  }

  // 切換只影響外觀，進行中（含衝刺中）的局況完全不受影響
  function setTheme(name) {
    if (!THEMES.includes(name)) return;
    GameConfig.currentTheme = name;
    savePrefs();
    syncStyleButton();
    // 聚焦中的按鈕改了 aria-label，很多報讀器不會重唸；另外用狀態列說一聲
    announce(`畫面風格已切換為${STYLE_NAMES[name]}`);
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

    if (styleBtn) {
      styleBtn.addEventListener('click', (event) => {
        setTheme(GameConfig.currentTheme === 'pixel16' ? 'classic' : 'pixel16');
        if (event.detail > 0) styleBtn.blur();
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
    loadPrefs();
    createMotes();
    if (loadGameState()) {
      announce('偵測到未完成的一局，點擊畫面或按空白鍵繼續');
    } else {
      resetToReady();
    }
    bindInput();
    bindLifecycle();
    syncSoundButton();
    syncStyleButton();
    resize();
    watchPixelRatio();
    requestAnimationFrame(loop);
  }

  // 唯讀快照，供冒煙測試與除錯確認狀態機；每次都回傳新的純物件，外部改了也不影響遊戲
  window.CatAgility = Object.freeze({
    snapshot: () => ({
      state: game.state,
      score: game.score,
      best: game.best,
      plays: game.plays,
      catY: cat.y,
      pipes: game.pipes.length,
      effects: game.effects.length,
      motes: game.motes.length,
      theme: activeTheme(),
      passCount: game.passCount,
      itemPending: game.itemPending,
      speed: game.speedMul,
      frenzyMs: Math.round(game.frenzy * STEP_MS),
      invincible: game.frenzy > 0,
      ghosts: game.trail.length,
      catVy: cat.vy,
      catPose: catPose(),
      catSx: cat.sx,
      catSy: cat.sy,
      items: game.pipes
        .filter((pipe) => pipe.item)
        .map((pipe) => ({ kind: pipe.item, x: pipe.x + PIPE.width / 2, y: pipe.gapY })),
      obstacles: game.pipes.map((pipe) => ({
        x: pipe.x,
        gapY: pipe.gapY,
        variant: pipe.variant,
        item: pipe.item,
        brokenTop: pipe.brokenTop,
        brokenBottom: pipe.brokenBottom,
        passed: pipe.passed
      }))
    })
  });

  init();
})();

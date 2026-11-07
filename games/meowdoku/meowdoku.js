/* ==========================================================================
   Meowdoku 貓咪數獨
   ========================================================================== */

const catAssetPaths = {
    1: 'images/1.svg',
    2: 'images/2.svg',
    3: 'images/3.svg',
    4: 'images/4.svg',
    5: 'images/5.svg',
    6: 'images/6.svg',
    7: 'images/7.svg',
    8: 'images/8.svg'
};
const LEGACY_CAT_STYLE_ID_MAP = {
    3: 1,
    4: 2,
    5: 3,
    6: 4,
    7: 5,
    8: 6,
    9: 7,
    10: 8
};

const boardEl = document.getElementById('board');
const livesEl = document.getElementById('livesDisplay');
const toastEl = document.getElementById('toast');
const modeBtns = document.querySelectorAll('.mode-btn');
const darkModeToggle = document.getElementById('darkModeToggle');
const soundBtn = document.getElementById('soundBtn');
const resetBtn = document.getElementById('resetBtn');
const clearBtn = document.getElementById('clearBtn');
const helpBtn = document.getElementById('helpBtn');
const helpOverlay = document.getElementById('helpOverlay');
const helpCloseBtn = document.getElementById('helpCloseBtn');
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmTitleEl = document.getElementById('confirmTitle');
const confirmMessageEl = document.getElementById('confirmMessage');
const confirmCancelBtn = document.getElementById('confirmCancelBtn');
const confirmOkBtn = document.getElementById('confirmOkBtn');
const toolBtns = document.querySelectorAll('.tool-btn');
const toolHintEl = document.getElementById('toolHint');
const resultDialog = document.getElementById('resultDialog');
const resultBadgeEl = document.getElementById('resultBadge');
const resultTitleEl = document.getElementById('resultTitle');
const resultDescEl = document.getElementById('resultDesc');
const resultTimeEl = document.getElementById('resultTime');
const resultLivesEl = document.getElementById('resultLives');
const resultBestEl = document.getElementById('resultBest');
const resultWinsEl = document.getElementById('resultWins');
const resultPrimaryBtn = document.getElementById('resultPrimaryBtn');
const resultSecondaryBtn = document.getElementById('resultSecondaryBtn');
const confettiCanvas = document.getElementById('confetti-canvas');
let pendingConfirmAction = null;

const SAVE_KEY = 'meowdoku-game-states-v1';
const SAVE_VERSION = 2;
const SOUND_KEY = 'meowdoku-sound-v1';
const HOME_PREF_KEY = 'bobo-home-preferences-v2';
const TOOL_KEY = 'meowdoku-tool-v1';
const STATS_KEY = 'meowdoku-stats-v1';
// 色塊的中文名稱，給螢幕閱讀器的格子標籤用（對應 CSS 的 --region-1 ~ 8）
const REGION_TONE_NAMES = ['玫瑰', '陶土', '赭黃', '鼠尾草', '松綠', '霧藍', '靛紫', '藕紫'];
const VALID_SIZES = [6, 7, 8];
const CAT_STYLE_KEYS = Object.keys(catAssetPaths).map(Number).sort((a, b) => a - b);
const REGION_TONE_COUNT = 8;
const REGION_TONE_IDS = Array.from({ length: REGION_TONE_COUNT }, (_, i) => i + 1);

let currentSize = 6;
let darkMode = false;
let toastTimer = null;
let gameStates = {};

/* ==========================================================================
   1. 音效
   --------------------------------------------------------------------------
   - 放置貓咪：16 個真實錄音（cat-1 ~ cat-16），每次隨機挑一個播放
   - 放錯：error-buzz.mp3（低頻蜂鳴，非貓叫）
   - 通關：win-chime.mp3（上行和弦，非貓叫）
   - 遊戲結束：fail-descend.mp3（下行音階，非貓叫）
   - 合成音（synthMeow / synthHiss / synthPurr / synthGameOver）保留作備援
   ========================================================================== */

const CAT_SOUND_COUNT = 16;
const SOUND_FILES = (() => {
    const files = {};
    for (let i = 1; i <= CAT_SOUND_COUNT; i++) files['cat' + i] = 'sounds/cat-' + i + '.mp3';
    files.errorBuzz = 'sounds/error-buzz.mp3';
    files.winChime = 'sounds/win-chime.mp3';
    files.failDescend = 'sounds/fail-descend.mp3';
    return files;
})();

const CAT_VOICES = [
    { f0: [520, 660, 400], dur: 0.52, peakAt: 0.22, f1: [780, 950, 620], f1q: [7, 9.1], f2: [2000, 2100, 1050], f2q: 9, vib: 5.5, cents: 22, breath: 0.05, tilt: 5200, peak: 0.50 },
    { f0: [330, 420, 260], dur: 0.72, peakAt: 0.26, f1: [620, 760, 500], f1q: [5.5, 7], f2: [1500, 1620, 820], f2q: 8, vib: 4.2, cents: 30, breath: 0.07, tilt: 4200, peak: 0.55, detune2: -9 },
    { f0: [700, 880, 600], dur: 0.62, peakAt: 0.20, f1: [900, 1050, 760], f1q: [9, 11], f2: [2400, 2550, 1500], f2q: 12, vib: 6.5, cents: 40, breath: 0.04, tilt: 6500, peak: 0.50 },
    { f0: [780, 980, 700], dur: 0.30, peakAt: 0.18, f1: [980, 1150, 900], f1q: [8, 10], f2: [2700, 2900, 2000], f2q: 10, vib: 7.0, cents: 25, breath: 0.03, tilt: 7000, peak: 0.42 },
    { f0: [430, 520, 360], dur: 0.58, peakAt: 0.24, f1: [700, 820, 560], f1q: [5, 6.5], f2: [1350, 1450, 900], f2q: 6, vib: 4.8, cents: 18, breath: 0.12, tilt: 3400, peak: 0.46 },
    { f0: [460, 540, 420], dur: 0.34, peakAt: 0.20, f1: [740, 860, 660], f1q: [6, 7.5], f2: [1700, 1800, 1250], f2q: 8, vib: 5.0, cents: 15, breath: 0.05, tilt: 4600, peak: 0.40 },
    { f0: [600, 760, 520], dur: 0.46, peakAt: 0.20, f1: [850, 1000, 700], f1q: [8, 10], f2: [2200, 2350, 1300], f2q: 10, vib: 6.0, cents: 35, breath: 0.05, tilt: 5600, peak: 0.48, growl: { rate: 30, depth: 0.32, until: 0.18 } },
    { f0: [560, 640, 720], dur: 0.40, peakAt: 0.30, f1: [800, 900, 780], f1q: [7, 8], f2: [1900, 2000, 1700], f2q: 9, vib: 5.8, cents: 28, breath: 0.06, tilt: 5000, peak: 0.45 }
];

class MeowSoundEngine {
    constructor() {
        this.ctx = null;
        this.master = null;
        this.noiseBuf = null;
        this.activeVoices = 0;
        this.unlocked = false;
        this.enabled = true;
        this.samples = {};      // 解碼後的 AudioBuffer
        this.rawSamples = {};   // 尚未解碼的 ArrayBuffer
        this.samplesReady = false;
        try {
            this.enabled = localStorage.getItem(SOUND_KEY) !== 'false';
        } catch (error) {
            this.enabled = true;
        }
        this.prefetchSamples();
    }

    // 音檔可以在使用者手勢之前就抓（只有播放需要手勢），解碼則等 AudioContext 建立後再做
    prefetchSamples() {
        if (typeof fetch !== 'function') return;
        for (const [key, url] of Object.entries(SOUND_FILES)) {
            fetch(url)
                .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(res.status))))
                .then((buf) => {
                    this.rawSamples[key] = buf;
                    if (this.ctx) this.decodeSamples();
                })
                .catch(() => {
                    // 抓不到就維持合成音，不影響遊戲
                });
        }
    }

    decodeSamples() {
        const ctx = this.ctx;
        if (!ctx) return;
        for (const [key, raw] of Object.entries(this.rawSamples)) {
            delete this.rawSamples[key];
            try {
                const done = ctx.decodeAudioData(raw.slice(0));
                if (done && typeof done.then === 'function') {
                    done.then((buf) => { this.samples[key] = buf; this.samplesReady = true; }).catch(() => { });
                } else {
                    // 舊版 Safari 的 callback 形式
                    ctx.decodeAudioData(raw.slice(0), (buf) => { this.samples[key] = buf; this.samplesReady = true; }, () => { });
                }
            } catch (error) {
                /* 解碼失敗就用合成音 */
            }
        }
    }

    // 播放真實錄音；沒有可用的樣本時回傳 false，交給合成音接手
    playSample(key, options) {
        const opt = options || {};
        const buffer = this.samples[key];
        if (!buffer) return false;
        const ctx = this._ready(opt.force);
        if (!ctx) return false;

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = opt.rate || 1;
        const gain = ctx.createGain();
        gain.gain.value = opt.gain == null ? 1 : opt.gain;
        source.connect(gain);
        gain.connect(this.master);
        const t0 = ctx.currentTime + 0.005;
        source.start(t0);
        const endTime = t0 + buffer.duration / (opt.rate || 1) + 0.05;
        this._reap([source, gain], source, endTime);
        return true;
    }

    ensureContext() {
        if (this.ctx) return this.ctx;
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        try {
            this.ctx = new AudioCtx();
        } catch (error) {
            return null;
        }

        this.master = this.ctx.createGain();
        this.master.gain.value = 0.8;
        const limiter = this.ctx.createDynamicsCompressor();
        limiter.threshold.value = -10;
        limiter.knee.value = 6;
        limiter.ratio.value = 6;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.18;
        this.master.connect(limiter);
        limiter.connect(this.ctx.destination);
        this.decodeSamples();
        return this.ctx;
    }

    // iOS 必須在使用者手勢內建立 context，並播一個 1 frame 的靜音 buffer 才算解鎖
    unlock() {
        const ctx = this.ensureContext();
        if (!ctx) return;
        if (ctx.state === 'suspended') ctx.resume();
        if (this.unlocked) return;
        // 只有 context 真的 running 才記成已解鎖：觸控裝置的使用者啟動要等
        // touchend / pointerup 才成立，pointerdown 這一刻建出來的 context 還是
        // suspended，這時就把旗標立起來會讓解鎖用的靜音 buffer 再也補不回來。
        if (ctx.state !== 'running') return;
        this.unlocked = true;
        try {
            const source = ctx.createBufferSource();
            source.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
            source.connect(ctx.destination);
            source.start(0);
        } catch (error) {
            /* 解鎖失敗不影響其他功能 */
        }
    }

    toggle() {
        this.enabled = !this.enabled;
        try {
            localStorage.setItem(SOUND_KEY, String(this.enabled));
        } catch (error) {
            console.warn('Meowdoku sound preference could not be saved:', error);
        }
        if (this.enabled) this.unlock();
        return this.enabled;
    }

    resumeIfNeeded() {
        if (this.enabled && this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }

    suspendIfNeeded() {
        if (this.ctx && this.ctx.state === 'running') {
            this.ctx.suspend().catch(() => {});
        }
    }

    _ready(force) {
        if (!this.enabled) return null;
        const ctx = this.ensureContext();
        if (!ctx) return null;
        if (ctx.state === 'suspended') ctx.resume();
        if (!force && this.activeVoices > 12) return null;
        return ctx;
    }

    // 噪音 buffer 只建一次，用隨機起點讀取讓每次聽起來不同
    _noise() {
        if (this.noiseBuf) return this.noiseBuf;
        const ctx = this.ctx;
        const length = Math.floor(ctx.sampleRate * 2);
        const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
        this.noiseBuf = buffer;
        return buffer;
    }

    // 所有 oscillator（含 LFO）都必須 stop，漏掉 LFO 會讓整條子圖永久存活
    _reap(parts, lastSource, endTime) {
        this.activeVoices++;
        let done = false;
        const kill = () => {
            if (done) return;
            done = true;
            this.activeVoices--;
            for (let i = 0; i < parts.length; i++) {
                try {
                    parts[i].disconnect();
                } catch (error) {
                    /* 已斷開 */
                }
            }
        };
        lastSource.onended = kill;
        setTimeout(kill, Math.max(0, (endTime - this.ctx.currentTime) * 1000) + 150);
    }

    // 避免 click：指數段不能收到 0，先衰到 0.0008 再線性歸零
    _fadeOut(param, peak, tEnd) {
        param.exponentialRampToValueAtTime(Math.max(0.0008, peak * 0.002), tEnd);
        param.linearRampToValueAtTime(0, tEnd + 0.02);
    }

    /* 共用的「有聲叫聲」引擎：meow / mrrow / 滿足輕叫 / 哀鳴都由它產生 */
    _voicedCall(p, startAt, force) {
        const ctx = this._ready(force);
        if (!ctx) return 0;

        const t0 = (startAt || 0) > ctx.currentTime ? startAt : ctx.currentTime + 0.01;
        const dur = p.dur;
        const tEnd = t0 + dur;
        const tPeak = t0 + dur * p.peakAt;
        const parts = [];

        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(p.f0[0], t0);
        osc.frequency.exponentialRampToValueAtTime(p.f0[1], Math.max(tPeak, t0 + 0.01));
        osc.frequency.setValueAtTime(p.f0[1], tPeak + dur * 0.10);
        osc.frequency.exponentialRampToValueAtTime(p.f0[2], tEnd);

        const pre = ctx.createGain();
        pre.gain.value = 0.9;
        osc.connect(pre);
        parts.push(osc, pre);

        // 第二顆微離調 osc = 胸腔感（大貓專用）
        let osc2 = null;
        if (p.detune2) {
            osc2 = ctx.createOscillator();
            osc2.type = 'sawtooth';
            osc2.detune.value = p.detune2;
            osc2.frequency.setValueAtTime(p.f0[0], t0);
            osc2.frequency.exponentialRampToValueAtTime(p.f0[1], Math.max(tPeak, t0 + 0.01));
            osc2.frequency.setValueAtTime(p.f0[1], tPeak + dur * 0.10);
            osc2.frequency.exponentialRampToValueAtTime(p.f0[2], tEnd);
            const g2 = ctx.createGain();
            g2.gain.value = 0.45;
            osc2.connect(g2);
            g2.connect(pre);
            parts.push(osc2, g2);
        }

        // 顫音：深度緩慢加入，讓起音是穩的
        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.value = p.vib;
        const lfoDepth = ctx.createGain();
        lfoDepth.gain.setValueAtTime(0, t0);
        lfoDepth.gain.linearRampToValueAtTime(p.cents, t0 + Math.min(0.12, dur * 0.4));
        if (p.centsEnd) lfoDepth.gain.linearRampToValueAtTime(p.centsEnd, tEnd);
        lfo.connect(lfoDepth);
        lfoDepth.connect(osc.detune);
        if (osc2) lfoDepth.connect(osc2.detune);
        parts.push(lfo, lfoDepth);

        // 共振峰 1：張口後收合
        const f1 = ctx.createBiquadFilter();
        f1.type = 'bandpass';
        f1.frequency.setValueAtTime(p.f1[0], t0);
        f1.frequency.linearRampToValueAtTime(p.f1[1], t0 + dur * 0.30);
        f1.frequency.exponentialRampToValueAtTime(p.f1[2], tEnd);
        f1.Q.setValueAtTime(p.f1q[0], t0);
        f1.Q.linearRampToValueAtTime(p.f1q[1], tEnd);

        // 共振峰 2：那個決定性的下滑
        const f2 = ctx.createBiquadFilter();
        f2.type = 'bandpass';
        f2.frequency.setValueAtTime(p.f2[0], t0);
        f2.frequency.linearRampToValueAtTime(p.f2[1], t0 + dur * 0.20);
        f2.frequency.exponentialRampToValueAtTime(p.f2[2], tEnd);
        f2.Q.value = p.f2q;

        const f1g = ctx.createGain();
        f1g.gain.value = 1;
        const f2g = ctx.createGain();
        f2g.gain.value = 0.7;
        const body = ctx.createGain();
        body.gain.value = 0.06;

        pre.connect(f1);
        f1.connect(f1g);
        pre.connect(f2);
        f2.connect(f2g);
        pre.connect(body);
        parts.push(f1, f2, f1g, f2g, body);

        // 鼻音起音 + 收尾閉口
        const tilt = ctx.createBiquadFilter();
        tilt.type = 'lowpass';
        tilt.Q.value = 0.7;
        tilt.frequency.setValueAtTime(900, t0);
        tilt.frequency.exponentialRampToValueAtTime(p.tilt, t0 + 0.06);
        tilt.frequency.exponentialRampToValueAtTime(p.tilt * 0.55, tEnd);
        f1g.connect(tilt);
        f2g.connect(tilt);
        body.connect(tilt);
        parts.push(tilt);

        const amp = ctx.createGain();
        amp.gain.setValueAtTime(0.0001, t0);
        amp.gain.exponentialRampToValueAtTime(p.peak, t0 + 0.035);
        amp.gain.linearRampToValueAtTime(p.peak * 0.85, t0 + dur * 0.30);
        amp.gain.linearRampToValueAtTime(p.peak * 0.32, t0 + dur * 0.72);
        this._fadeOut(amp.gain, p.peak, tEnd);
        tilt.connect(amp);
        amp.connect(this.master);
        parts.push(amp);

        // 咕嚕震動（AM）
        if (p.growl) {
            const growl = ctx.createOscillator();
            growl.type = 'sine';
            growl.frequency.value = p.growl.rate;
            const growlDepth = ctx.createGain();
            growlDepth.gain.setValueAtTime(p.growl.depth, t0);
            growlDepth.gain.linearRampToValueAtTime(0, t0 + (p.growl.until || dur));
            growl.connect(growlDepth);
            growlDepth.connect(amp.gain);
            growl.start(t0);
            growl.stop(tEnd + 0.03);
            parts.push(growl, growlDepth);
        }

        // 氣息層
        const noise = ctx.createBufferSource();
        noise.buffer = this._noise();
        const nbp = ctx.createBiquadFilter();
        nbp.type = 'bandpass';
        nbp.frequency.value = 2800;
        nbp.Q.value = 0.9;
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t0);
        ng.gain.exponentialRampToValueAtTime(Math.max(0.001, p.peak * p.breath), t0 + 0.05);
        this._fadeOut(ng.gain, p.peak * p.breath, tEnd);
        noise.connect(nbp);
        nbp.connect(ng);
        ng.connect(this.master);
        parts.push(noise, nbp, ng);

        noise.start(t0, Math.random() * 1.4, dur + 0.05);
        osc.start(t0);
        lfo.start(t0);
        if (osc2) osc2.start(t0);
        osc.stop(tEnd + 0.03);
        lfo.stop(tEnd + 0.03);
        if (osc2) osc2.stop(tEnd + 0.03);

        this._reap(parts, osc, tEnd + 0.03);
        return tEnd;
    }

    /* 以下 4 個對外方法一律先試真實錄音，取不到才退回合成音 */

    playMeow(voice) {
        // 從 16 個貓叫錄音中隨機挑一個，每次音高微調避免重複感
        const idx = Math.floor(Math.random() * CAT_SOUND_COUNT) + 1;
        if (this.playSample('cat' + idx, { rate: 0.94 + Math.random() * 0.12, gain: 0.9 })) return;
        // 備援：用合成音，voice 仍決定音色
        const v = Math.max(0, Math.min(7, voice | 0));
        this.synthMeow(v);
    }

    playHiss() {
        if (this.playSample('errorBuzz', { rate: 0.97 + Math.random() * 0.06, gain: 0.85, force: true })) return;
        this.synthHiss();
    }

    playPurr() {
        if (this.playSample('winChime', { gain: 1.2, force: true })) return;
        this.synthPurr();
    }

    playGameOver() {
        if (this.playSample('failDescend', { gain: 1.15, force: true })) return;
        this.synthGameOver();
    }

    /* 放對貓咪：8 個品種各有自己的嗓音，再加上每次的隨機抖動 */
    synthMeow(voice) {
        const base = CAT_VOICES[Math.max(0, Math.min(CAT_VOICES.length - 1, voice | 0))];
        const jitter = (spread) => 1 + (Math.random() - 0.5) * 2 * spread;
        const p = {
            f0: base.f0.map((f) => f * jitter(0.03)),
            f1: base.f1.map((f) => f * jitter(0.025)),
            f2: base.f2.map((f) => f * jitter(0.025)),
            f1q: base.f1q,
            f2q: base.f2q,
            dur: base.dur * jitter(0.08),
            peakAt: Math.max(0.08, Math.min(0.45, base.peakAt + (Math.random() - 0.5) * 0.06)),
            vib: base.vib * jitter(0.10),
            cents: base.cents,
            breath: base.breath,
            tilt: base.tilt,
            peak: base.peak * jitter(0.08),
            detune2: base.detune2,
            growl: base.growl
        };
        if (Math.random() < 0.25) p.f0[1] *= 1.06;
        this._voicedCall(p, 0, false);
    }

    /* 放錯扣心：60% 嘶氣、40% 生氣的下滑 mrrow */
    synthHiss() {
        if (Math.random() < 0.4) {
            this._voicedCall({
                f0: [430, 400, 190], dur: 0.45, peakAt: 0.05,
                f1: [700, 640, 430], f1q: [5, 6], f2: [1700, 1450, 700], f2q: 7,
                vib: 7.5, cents: 55, breath: 0.30, tilt: 4000, peak: 0.44,
                growl: { rate: 28, depth: 0.30, until: 0.45 }
            }, 0, true);
            return;
        }

        const ctx = this._ready(true);
        if (!ctx) return;
        const t0 = ctx.currentTime + 0.01;
        const dur = 0.34;
        const tEnd = t0 + dur;
        const parts = [];

        // 主體：下降的帶通噪音（空氣逐漸用盡）
        const air = ctx.createBufferSource();
        air.buffer = this._noise();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 0.7;
        bp.frequency.setValueAtTime(5200, t0);
        bp.frequency.exponentialRampToValueAtTime(2600, t0 + 0.30);
        const hg = ctx.createGain();
        hg.gain.setValueAtTime(0.0001, t0);
        hg.gain.exponentialRampToValueAtTime(0.34, t0 + 0.012);
        hg.gain.linearRampToValueAtTime(0.12, t0 + 0.12);
        this._fadeOut(hg.gain, 0.34, t0 + 0.30);
        air.connect(bp);
        bp.connect(hg);
        hg.connect(this.master);
        parts.push(air, bp, hg);

        // 起音噴氣：這個子音才讓它像「嘶」而不是一片白噪
        const spit = ctx.createBufferSource();
        spit.buffer = this._noise();
        const hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 6000;
        const sg = ctx.createGain();
        sg.gain.setValueAtTime(0.0001, t0);
        sg.gain.exponentialRampToValueAtTime(0.20, t0 + 0.006);
        this._fadeOut(sg.gain, 0.2, t0 + 0.030);
        spit.connect(hp);
        hp.connect(sg);
        sg.connect(this.master);
        parts.push(spit, hp, sg);

        // 底層咕嚕
        const growlOsc = ctx.createOscillator();
        growlOsc.type = 'sawtooth';
        growlOsc.frequency.setValueAtTime(240, t0);
        growlOsc.frequency.exponentialRampToValueAtTime(150, t0 + 0.28);
        const g1 = ctx.createBiquadFilter();
        g1.type = 'bandpass';
        g1.frequency.value = 620;
        g1.Q.value = 4;
        const am = ctx.createGain();
        am.gain.value = 0.55;
        const amLfo = ctx.createOscillator();
        amLfo.type = 'sine';
        amLfo.frequency.value = 30;
        const amDepth = ctx.createGain();
        amDepth.gain.value = 0.45;
        amLfo.connect(amDepth);
        amDepth.connect(am.gain);
        const vg = ctx.createGain();
        vg.gain.setValueAtTime(0.0001, t0);
        vg.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
        this._fadeOut(vg.gain, 0.18, tEnd);
        growlOsc.connect(g1);
        g1.connect(am);
        am.connect(vg);
        vg.connect(this.master);
        parts.push(growlOsc, g1, am, amLfo, amDepth, vg);

        air.start(t0, Math.random() * 1.4, dur + 0.05);
        spit.start(t0, Math.random() * 1.4, 0.06);
        growlOsc.start(t0);
        amLfo.start(t0);
        growlOsc.stop(tEnd + 0.03);
        amLfo.stop(tEnd + 0.03);
        this._reap(parts, growlOsc, tEnd + 0.03);
    }

    /* 通關：25Hz AM 低頻呼嚕 + 疊一聲滿足的輕叫 */
    synthPurr() {
        const ctx = this._ready(true);
        if (!ctx) return;
        const t0 = ctx.currentTime + 0.01;
        const dur = 2.05;
        const parts = [];

        const rumbleNoise = ctx.createBufferSource();
        rumbleNoise.buffer = this._noise();
        rumbleNoise.loop = true;
        const lp1 = ctx.createBiquadFilter();
        lp1.type = 'lowpass';
        lp1.frequency.value = 220;
        lp1.Q.value = 1.2;
        const n1 = ctx.createGain();
        n1.gain.value = 0.55;

        const body = ctx.createOscillator();
        body.type = 'sawtooth';
        body.frequency.value = 62;
        const lp2 = ctx.createBiquadFilter();
        lp2.type = 'lowpass';
        lp2.frequency.value = 400;
        lp2.Q.value = 0.8;
        const b1 = ctx.createGain();
        b1.gain.value = 0.5;

        // 25Hz 的振幅閘門加在寬頻低鳴上才是呼嚕；單獨的 25Hz 正弦聽不見
        const am = ctx.createGain();
        am.gain.value = 0.52;
        const amLfo = ctx.createOscillator();
        amLfo.type = 'triangle';
        amLfo.frequency.value = 25;
        const amDepth = ctx.createGain();
        amDepth.gain.value = 0.42;
        // 再用 0.7Hz 慢速搖動 AM 速率，才不像效果器的 tremolo
        const rateLfo = ctx.createOscillator();
        rateLfo.type = 'sine';
        rateLfo.frequency.value = 0.7;
        const rateDepth = ctx.createGain();
        rateDepth.gain.value = 2.5;
        rateLfo.connect(rateDepth);
        rateDepth.connect(amLfo.frequency);
        amLfo.connect(amDepth);
        amDepth.connect(am.gain);

        const env = ctx.createGain();
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(0.30, t0 + 0.25);
        env.gain.setValueAtTime(0.30, t0 + 1.50);
        this._fadeOut(env.gain, 0.3, t0 + 2.00);

        rumbleNoise.connect(lp1);
        lp1.connect(n1);
        n1.connect(am);
        body.connect(lp2);
        lp2.connect(b1);
        b1.connect(am);
        am.connect(env);
        env.connect(this.master);
        parts.push(rumbleNoise, lp1, n1, body, lp2, b1, am, amLfo, amDepth, rateLfo, rateDepth, env);

        rumbleNoise.start(t0, Math.random() * 1.4);
        body.start(t0);
        amLfo.start(t0);
        rateLfo.start(t0);
        rumbleNoise.stop(t0 + dur + 0.03);
        body.stop(t0 + dur + 0.03);
        amLfo.stop(t0 + dur + 0.03);
        rateLfo.stop(t0 + dur + 0.03);
        this._reap(parts, body, t0 + dur + 0.03);

        this._voicedCall({
            f0: [500, 560, 430], dur: 0.42, peakAt: 0.25,
            f1: [740, 850, 620], f1q: [6, 7.5], f2: [1700, 1780, 900], f2q: 8,
            vib: 4.5, cents: 16, breath: 0.09, tilt: 5000, peak: 0.30
        }, t0 + 0.45, true);

        this._voicedCall({
            f0: [470, 500, 440], dur: 0.26, peakAt: 0.28,
            f1: [780, 860, 720], f1q: [6, 7], f2: [1800, 1900, 1500], f2q: 8,
            vib: 5.2, cents: 20, breath: 0.08, tilt: 5200, peak: 0.20
        }, t0 + 1.25, true);
    }

    /* 扣完 3 顆心：大幅下滑的哀鳴，顫音深度隨尾音遞增 */
    synthGameOver() {
        const ctx = this._ready(true);
        if (!ctx) return;
        const t0 = ctx.currentTime + 0.01;

        this._voicedCall({
            f0: [560, 520, 210], dur: 0.95, peakAt: 0.06,
            f1: [820, 700, 420], f1q: [6, 7], f2: [1900, 1500, 620], f2q: 7,
            vib: 4.0, cents: 8, centsEnd: 45, breath: 0.08, tilt: 4200, peak: 0.42
        }, t0, true);

        this._voicedCall({
            f0: [330, 300, 180], dur: 0.50, peakAt: 0.08,
            f1: [700, 620, 400], f1q: [5.5, 6.5], f2: [1500, 1250, 600], f2q: 7,
            vib: 4.2, cents: 12, centsEnd: 40, breath: 0.10, tilt: 3800, peak: 0.22
        }, t0 + 0.85, true);

        // 低頻陰鬱長音：只是被「感覺到」，不寫成下行旋律（那會變成街機音）
        const drone = ctx.createOscillator();
        drone.type = 'sine';
        drone.frequency.value = 130.8;
        const dg = ctx.createGain();
        dg.gain.setValueAtTime(0.0001, t0);
        dg.gain.exponentialRampToValueAtTime(0.06, t0 + 0.3);
        this._fadeOut(dg.gain, 0.06, t0 + 1.4);
        drone.connect(dg);
        dg.connect(this.master);
        drone.start(t0);
        drone.stop(t0 + 1.5);
        this._reap([drone, dg], drone, t0 + 1.5);
    }
}

const sound = new MeowSoundEngine();

// 固定 aria-label「音效」，開關狀態只放在 aria-pressed
function updateSoundButton() {
    if (!soundBtn) return;
    soundBtn.classList.toggle('active', sound.enabled);
    soundBtn.setAttribute('aria-pressed', String(sound.enabled));
    soundBtn.title = sound.enabled ? '音效：開' : '音效：關';
}

/* ==========================================================================
   2. 主題（相容首頁 bobo-home-preferences-v2 與本遊戲的 meowdoku-dark-mode-v1）
   ========================================================================== */

// 全站共用主題模組。模組沒載到（測試環境或網路失敗）時 themeKit 為 null，
// 以下每個使用點都會退回本檔案自己的等價實作，遊戲照常能玩。
const themeKit = (typeof BoboTheme !== 'undefined' && BoboTheme) ? BoboTheme : null;

// 主題一律交給 BoboTheme：載入時只「套用」偏好（首頁偏好 → 系統色），
// 只有玩家按下主題鍵才寫回 bobo-home-preferences-v2，避免一進頁面就把系統色釘死成全站偏好。
function currentTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function syncDarkModeButton() {
    darkMode = currentTheme() === 'dark';
    darkModeToggle.classList.toggle('active', darkMode);
    darkModeToggle.setAttribute('aria-pressed', String(darkMode));
    darkModeToggle.title = darkMode ? '深色模式：開' : '深色模式：關';
}

function initTheme() {
    if (themeKit) {
        themeKit.init();
    } else {
        // 模組缺席：沿用 <head> 防閃爍腳本已套上的主題，不寫入任何偏好
        document.documentElement.dataset.theme = currentTheme();
    }
    syncDarkModeButton();
}

function toggleTheme() {
    if (themeKit) {
        themeKit.toggle();
    } else {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try {
            const prefs = JSON.parse(localStorage.getItem(HOME_PREF_KEY) || '{}');
            prefs.theme = next;
            localStorage.setItem(HOME_PREF_KEY, JSON.stringify(prefs));
        } catch (error) {
            /* 隱私模式寫不進去就只切換當下畫面 */
        }
    }
    syncDarkModeButton();
}

/* ==========================================================================
   3. 狀態與持久化
   ========================================================================== */

function shuffle(array) {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function preloadCatAssets() {
    for (const src of Object.values(catAssetPaths)) {
        const image = new Image();
        image.decoding = 'async';
        image.src = src;
    }
}

function normalizeCatStyleId(style) {
    const numericStyle = Number(style) || 0;
    if (CAT_STYLE_KEYS.includes(numericStyle)) return numericStyle;
    return LEGACY_CAT_STYLE_ID_MAP[numericStyle] || 0;
}

function createEmptyCellState() {
    return { cat: false, paw: false, catStyle: 0 };
}

function createEmptyCellStates(size) {
    return Array.from({ length: size }, () => Array.from({ length: size }, createEmptyCellState));
}

// 在 8 個色階上等距取樣，任兩區塊的色差都遠高於可辨識門檻
function buildRegionTones(size) {
    const offset = Math.floor(Math.random() * REGION_TONE_COUNT);
    const used = new Set();
    const slots = [];
    for (let i = 0; i < size; i++) {
        let slot = (offset + Math.round((i * REGION_TONE_COUNT) / size)) % REGION_TONE_COUNT;
        while (used.has(slot)) slot = (slot + 1) % REGION_TONE_COUNT;
        used.add(slot);
        slots.push(slot + 1);
    }
    const shuffled = shuffle(slots);
    const tones = {};
    for (let id = 1; id <= size; id++) tones[id] = shuffled[id - 1];
    return tones;
}

function normalizeRegionTones(regionTones, size) {
    if (!regionTones || typeof regionTones !== 'object') return null;
    const used = new Set();
    const normalized = {};
    for (let id = 1; id <= size; id++) {
        const tone = Number(regionTones[id]);
        if (!REGION_TONE_IDS.includes(tone) || used.has(tone)) return null;
        used.add(tone);
        normalized[id] = tone;
    }
    return normalized;
}

function buildUniqueRegionCatStyles(size) {
    const shuffledStyles = shuffle(CAT_STYLE_KEYS).slice(0, size);
    const regionCatStyles = {};
    for (let id = 1; id <= size; id++) {
        regionCatStyles[id] = shuffledStyles[id - 1] || CAT_STYLE_KEYS[(id - 1) % CAT_STYLE_KEYS.length];
    }
    return regionCatStyles;
}

function buildDefaultRegionCatStyles(size) {
    const regionCatStyles = {};
    for (let id = 1; id <= size; id++) {
        regionCatStyles[id] = CAT_STYLE_KEYS[(id - 1) % CAT_STYLE_KEYS.length];
    }
    return regionCatStyles;
}

function normalizeRegionCatStyles(regionCatStyles, size) {
    if (!regionCatStyles || typeof regionCatStyles !== 'object') {
        return buildDefaultRegionCatStyles(size);
    }

    const usedStyles = new Set();
    const normalized = {};
    for (let id = 1; id <= size; id++) {
        const style = normalizeCatStyleId(regionCatStyles[id]);
        if (!CAT_STYLE_KEYS.includes(style) || usedStyles.has(style)) {
            return buildDefaultRegionCatStyles(size);
        }
        usedStyles.add(style);
        normalized[id] = style;
    }
    return normalized;
}

function isNumberMatrix(matrix, size, validator) {
    return Array.isArray(matrix)
        && matrix.length === size
        && matrix.every((row) => Array.isArray(row) && row.length === size && row.every(validator));
}

function clampLives(lives) {
    return Math.max(0, Math.min(3, Number(lives) || 0));
}

function loadSavedGameData() {
    const fallback = { currentSize: 6, states: {} };
    try {
        const saved = JSON.parse(localStorage.getItem(SAVE_KEY));
        if (!saved || typeof saved.states !== 'object') return fallback;
        if (saved.version !== SAVE_VERSION && saved.version !== 1) return fallback;

        const states = {};
        for (const size of VALID_SIZES) {
            const normalized = normalizeSavedState(saved.states[String(size)], size);
            if (normalized) states[size] = normalized;
        }

        return {
            currentSize: VALID_SIZES.includes(saved.currentSize) ? saved.currentSize : 6,
            states
        };
    } catch (error) {
        console.warn('Meowdoku saved state could not be loaded:', error);
        return fallback;
    }
}

function normalizeSavedState(saved, size) {
    if (!saved || saved.size !== size) return null;
    if (!isNumberMatrix(saved.solution, size, (value) => value === 0 || value === 1)) return null;
    if (!isNumberMatrix(saved.regions, size, (value) => Number.isInteger(value) && value >= 1 && value <= size)) return null;
    if (!Array.isArray(saved.cellStates) || saved.cellStates.length !== size) return null;

    // v1 存的是寫死的 hex 色（regionColors），改配一組色階即可，進行中的局不必丟掉
    const regionTones = normalizeRegionTones(saved.regionTones, size) || buildRegionTones(size);
    const regionCatStyles = normalizeRegionCatStyles(saved.regionCatStyles, size);

    const cellStates = [];
    for (let r = 0; r < size; r++) {
        if (!Array.isArray(saved.cellStates[r]) || saved.cellStates[r].length !== size) return null;
        const row = [];
        for (let c = 0; c < size; c++) {
            const cell = saved.cellStates[r][c] || {};
            const catStyle = normalizeCatStyleId(cell.catStyle);
            row.push({
                cat: Boolean(cell.cat),
                paw: Boolean(cell.paw) && !cell.cat,
                catStyle
            });
        }
        cellStates.push(row);
    }

    const status = ['playing', 'won', 'lost'].includes(saved.status) ? saved.status : 'playing';
    return {
        size,
        solution: saved.solution,
        regions: saved.regions,
        regionTones,
        regionCatStyles,
        lives: clampLives(saved.lives),
        status,
        cellStates,
        elapsed: Math.max(0, Number(saved.elapsed) || 0),
        savedAt: Number(saved.savedAt) || Date.now()
    };
}

function serializeState(state) {
    return {
        size: state.size,
        solution: state.solution,
        regions: state.regions,
        regionTones: state.regionTones,
        regionCatStyles: state.regionCatStyles,
        lives: clampLives(state.lives),
        status: state.status,
        cellStates: state.cellStates,
        elapsed: Math.max(0, Math.floor(state.elapsed || 0)),
        savedAt: Date.now()
    };
}

function saveGameStates() {
    try {
        const states = {};
        for (const size of VALID_SIZES) {
            if (gameStates[size]) states[size] = serializeState(gameStates[size]);
        }
        localStorage.setItem(SAVE_KEY, JSON.stringify({
            version: SAVE_VERSION,
            currentSize,
            states
        }));
    } catch (error) {
        console.warn('Meowdoku saved state could not be written:', error);
    }
}

/* 拖曳標記時每格都同步寫 localStorage 會嚴重卡頓，改為 debounce + 明確 flush */
const SAVE_DEBOUNCE = 400;
const SAVE_MAX_WAIT = 1500;
let saveTimer = null;
let saveDirty = false;
let saveDeadline = 0;

function scheduleSave() {
    saveDirty = true;
    const now = Date.now();
    if (!saveTimer) saveDeadline = now + SAVE_MAX_WAIT;
    else clearTimeout(saveTimer);
    const delay = Math.max(0, Math.min(SAVE_DEBOUNCE, saveDeadline - now));
    saveTimer = setTimeout(flushSave, delay);
}

function flushSave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (!saveDirty) return;
    saveDirty = false;
    saveGameStates();
}

function saveNow() {
    discardPendingSave();
    saveGameStates();
}

function discardPendingSave() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    saveDirty = false;
}

function getState(size) {
    if (!gameStates[size]) {
        gameStates[size] = createFreshState(size);
        saveGameStates();
    }
    return gameStates[size];
}

function createFreshState(size) {
    const state = {
        size,
        solution: [],
        regions: [],
        regionTones: {},
        regionCatStyles: {},
        lives: 3,
        status: 'playing',
        cellStates: [],
        elapsed: 0
    };
    generatePuzzle(state, size);
    return state;
}

/* ==========================================================================
   4. 題目生成與解算
   ========================================================================== */

function generatePuzzle(state, size) {
    const maxAttempts = 120;
    let fallback = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidate = buildPuzzleCandidate(size);
        if (!candidate) continue;
        if (!fallback) fallback = candidate;

        const testState = {
            ...candidate,
            size,
            lives: 3,
            status: 'playing',
            cellStates: createEmptyCellStates(size)
        };

        if (countSolutions(testState, 2) === 1) {
            applyPuzzleCandidate(state, candidate, size);
            return;
        }
    }

    if (!fallback) throw new Error(`Unable to generate a ${size}x${size} Meowdoku puzzle.`);
    console.warn('Meowdoku puzzle generator fell back to a candidate with multiple solutions.');
    applyPuzzleCandidate(state, fallback, size);
}

function buildPuzzleCandidate(size) {
    const solution = Array.from({ length: size }, () => Array(size).fill(0));

    function solve(row) {
        if (row === size) return true;
        const cols = shuffle(Array.from({ length: size }, (_, i) => i));
        for (const col of cols) {
            if (isValid(solution, row, col, size)) {
                solution[row][col] = 1;
                if (solve(row + 1)) return true;
                solution[row][col] = 0;
            }
        }
        return false;
    }

    if (!solve(0)) return null;

    const regions = Array.from({ length: size }, () => Array(size).fill(0));
    const catQueue = [];
    let regionId = 1;
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (solution[r][c] === 1) {
                regions[r][c] = regionId;
                catQueue.push({ r, c, id: regionId });
                regionId++;
            }
        }
    }

    while (catQueue.length > 0) {
        const idx = Math.floor(Math.random() * catQueue.length);
        const { r, c, id } = catQueue.splice(idx, 1)[0];
        const directions = shuffle([[-1, 0], [1, 0], [0, -1], [0, 1]]);

        for (const [dr, dc] of directions) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < size && nc >= 0 && nc < size && regions[nr][nc] === 0) {
                regions[nr][nc] = id;
                catQueue.push({ r: nr, c: nc, id });
            }
        }
    }

    return {
        solution,
        regions,
        regionTones: buildRegionTones(size),
        regionCatStyles: buildUniqueRegionCatStyles(size)
    };
}

function applyPuzzleCandidate(state, candidate, size) {
    state.size = size;
    state.solution = candidate.solution;
    state.regions = candidate.regions;
    state.regionTones = candidate.regionTones;
    state.regionCatStyles = candidate.regionCatStyles;
    state.cellStates = createEmptyCellStates(size);
    state.lives = 3;
    state.status = 'playing';
    state.savedAt = Date.now();
}

function isValid(board, r, c, size) {
    for (let i = 0; i < size; i++) {
        if (board[i][c] === 1) return false;
    }
    for (let i = -1; i <= 1; i++) {
        for (let j = -1; j <= 1; j++) {
            const nr = r + i;
            const nc = c + j;
            if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === 1) return false;
        }
    }
    return true;
}

// 計算在目前玩家已固定放置（貓或標記為無貓）的情況下，符合規則的解答數量
function countSolutions(state, maxCount = 2) {
    const size = state.size;
    const fixedCatInRow = Array(size).fill(-1);
    const fixedNoCat = Array.from({ length: size }, () => Array(size).fill(false));

    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            const cellState = state.cellStates[r][c];
            if (cellState.cat && cellState.paw) return 0;
            if (cellState.cat) {
                if (fixedCatInRow[r] !== -1 && fixedCatInRow[r] !== c) return 0;
                fixedCatInRow[r] = c;
            }
            if (cellState.paw) fixedNoCat[r][c] = true;
        }
    }

    let count = 0;
    const placedCols = Array(size).fill(-1);
    const colsUsed = Array(size).fill(false);
    const regionsUsed = Array(size + 1).fill(false);

    function tryPlace(row, c) {
        const regionId = state.regions[row][c];
        if (fixedNoCat[row][c]) return;
        if (colsUsed[c]) return;
        if (regionsUsed[regionId]) return;
        for (let rr = 0; rr < row; rr++) {
            const pc = placedCols[rr];
            if (pc === -1) continue;
            if (Math.abs(rr - row) <= 1 && Math.abs(pc - c) <= 1) return;
        }

        colsUsed[c] = true;
        regionsUsed[regionId] = true;
        placedCols[row] = c;
        backtrack(row + 1);
        placedCols[row] = -1;
        regionsUsed[regionId] = false;
        colsUsed[c] = false;
    }

    function backtrack(row) {
        if (count >= maxCount) return;
        if (row === size) {
            count++;
            return;
        }

        if (fixedCatInRow[row] !== -1) {
            const c = fixedCatInRow[row];
            tryPlace(row, c);
            return;
        }

        for (let c = 0; c < size; c++) {
            tryPlace(row, c);
            if (count >= maxCount) return;
        }
    }

    backtrack(0);
    return count;
}

/* ==========================================================================
   5. 棋盤渲染（常駐 DOM，拖曳期間零 DOM 異動）
   ========================================================================== */

let boardCells = [];
let renderedSize = 0;
let focusPos = { r: 0, c: 0 };

const cellAt = (r, c) => boardCells[r * renderedSize + c];

function ensureBoardDom(size) {
    if (renderedSize === size && boardCells.length === size * size) return;

    boardEl.innerHTML = '';
    boardEl.style.gridTemplateColumns = `repeat(${size}, 1fr)`;
    boardEl.style.gridTemplateRows = `repeat(${size}, 1fr)`;

    const fragment = document.createDocumentFragment();
    boardCells = new Array(size * size);
    focusPos = { r: Math.min(focusPos.r, size - 1), c: Math.min(focusPos.c, size - 1) };
    for (let r = 0; r < size; r++) {
        // 列用 display: contents，保留 grid > row > gridcell 結構又不影響排版
        const rowEl = document.createElement('div');
        rowEl.className = 'board-row';
        rowEl.setAttribute('role', 'row');
        fragment.appendChild(rowEl);
        for (let c = 0; c < size; c++) {
            const cell = document.createElement('div');
            cell.className = 'cell';
            cell.setAttribute('role', 'gridcell');
            // roving tabindex：整個盤面只有一格在 Tab 順序裡
            cell.tabIndex = (r === focusPos.r && c === focusPos.c) ? 0 : -1;
            cell.dataset.r = r;
            cell.dataset.c = c;
            cell.dataset.cat = 'false';
            cell.dataset.paw = 'false';
            cell.dataset.catStyle = '0';

            const face = document.createElement('div');
            face.className = 'cat-face';
            const img = document.createElement('img');
            img.alt = '';
            img.draggable = false;
            img.decoding = 'async';
            face.appendChild(img);

            const paw = document.createElement('div');
            paw.className = 'paw-mark';
            paw.setAttribute('aria-hidden', 'true');
            paw.textContent = '🐾';

            cell.appendChild(face);
            cell.appendChild(paw);
            rowEl.appendChild(cell);
            boardCells[r * size + c] = cell;
        }
    }
    boardEl.appendChild(fragment);
    renderedSize = size;
    geom.dirty = true;
}

function applyCellView(cellEl, cellState) {
    const style = cellState.cat ? (normalizeCatStyleId(cellState.catStyle) || 1) : 0;
    cellEl.dataset.cat = cellState.cat ? 'true' : 'false';
    cellEl.dataset.paw = cellState.paw ? 'true' : 'false';
    cellEl.dataset.catStyle = String(style);
    const what = cellState.cat ? '貓咪' : (cellState.paw ? '貓爪（沒有貓）' : '空白');
    const r = Number(cellEl.dataset.r) + 1;
    const c = Number(cellEl.dataset.c) + 1;
    cellEl.setAttribute('aria-label', `第 ${r} 列第 ${c} 行，${cellEl.dataset.regionName || ''}，${what}`);
    if (style) {
        // 只在真的需要時才給 src；不設 src="" 以免瀏覽器重新請求整份文件
        const img = cellEl.firstElementChild.firstElementChild;
        const src = catAssetPaths[style];
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    }
}

function syncBoardToState(state) {
    for (let r = 0; r < state.size; r++) {
        for (let c = 0; c < state.size; c++) {
            const cellEl = cellAt(r, c);
            const regionId = state.regions[r][c];
            const tone = state.regionTones[regionId] || ((regionId - 1) % REGION_TONE_COUNT) + 1;

            cellEl.className = 'cell region-tone-' + tone;
            cellEl.dataset.regionName = `${REGION_TONE_NAMES[(tone - 1) % REGION_TONE_NAMES.length]}色塊`;
            if (r > 0 && state.regions[r - 1][c] !== regionId) cellEl.classList.add('region-edge-top');
            if (c > 0 && state.regions[r][c - 1] !== regionId) cellEl.classList.add('region-edge-left');

            applyCellView(cellEl, state.cellStates[r][c]);
        }
    }
}

function getCatStyle(state, r, c) {
    const regionId = state.regions[r][c];
    return state.regionCatStyles?.[regionId] || CAT_STYLE_KEYS[(regionId - 1) % CAT_STYLE_KEYS.length];
}

/* ==========================================================================
   6. 互動：事件委派 + 座標命中判定 + rAF 合併
   ========================================================================== */

const geom = { size: 0, originX: 0, originY: 0, pitchX: 0, pitchY: 0, dirty: true };

// 不寫死 border/padding/gap，讓 CSS 調整不會靜默弄壞輸入
function measureBoardGeometry(size) {
    const rect = boardEl.getBoundingClientRect();
    const cs = getComputedStyle(boardEl);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0;
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    const gx = parseFloat(cs.columnGap) || 0;
    const gy = parseFloat(cs.rowGap) || 0;

    geom.size = size;
    geom.originX = rect.left + bl + pl;
    geom.originY = rect.top + bt + pt;
    // 用 getBoundingClientRect 的小數寬度，clientWidth 的整數化會在遠端累積誤差
    geom.pitchX = (rect.width - bl - br - pl - pr + gx) / size;
    geom.pitchY = (rect.height - bt - bb - pt - pb + gy) / size;
    geom.dirty = !(geom.pitchX > 0 && geom.pitchY > 0);
}

function elementFallback(clientX, clientY) {
    const target = document.elementFromPoint(clientX, clientY);
    const cellEl = target && target.closest ? target.closest('.cell') : null;
    if (!cellEl) return null;
    return { r: Number(cellEl.dataset.r), c: Number(cellEl.dataset.c) };
}

// 座標換算比 elementFromPoint 更準：後者會被圓角、:hover 的 scale 與格線間隙吃掉
function pointToCell(clientX, clientY) {
    if (geom.dirty || geom.size !== renderedSize) return elementFallback(clientX, clientY);
    const rawC = Math.floor((clientX - geom.originX) / geom.pitchX);
    const rawR = Math.floor((clientY - geom.originY) / geom.pitchY);
    if (rawR < -1 || rawC < -1 || rawR > geom.size || rawC > geom.size) return null;
    return {
        r: Math.min(geom.size - 1, Math.max(0, rawR)),
        c: Math.min(geom.size - 1, Math.max(0, rawC))
    };
}

const TAP_WINDOW = { touch: 280, pen: 280, mouse: 350 };
const drag = {
    pointerId: null,
    active: false,
    value: false,
    lastR: -1,
    lastC: -1,
    pendingX: 0,
    pendingY: 0,
    rafId: 0
};
let lastTapTime = 0;
let lastTapCellKey = '';
let lastTapArmed = false;

function resetPointerState() {
    drag.active = false;
    drag.pointerId = null;
    drag.value = false;
    drag.lastR = -1;
    drag.lastC = -1;
    if (drag.rafId) {
        cancelAnimationFrame(drag.rafId);
        drag.rafId = 0;
    }
    lastTapTime = 0;
    lastTapCellKey = '';
    lastTapArmed = false;
}

function paintPaw(state, r, c, paw) {
    state.cellStates[r][c].paw = paw;
    state.cellStates[r][c].cat = false;
    applyCellView(cellAt(r, c), state.cellStates[r][c]);
    updateClearButtonState(state);
    scheduleSave();
}

function placeCat(state, r, c) {
    const cellEl = cellAt(r, c);

    if (state.solution[r][c] === 1) {
        const styleIndex = state.cellStates[r][c].catStyle || getCatStyle(state, r, c);
        state.cellStates[r][c] = { cat: true, paw: false, catStyle: styleIndex };
        applyCellView(cellEl, state.cellStates[r][c]);
        sound.playMeow(normalizeCatStyleId(styleIndex) - 1);
        checkWin(state);
        updateGameOverUI(state);
        updateClearButtonState(state);
        saveNow();
        return;
    }

    state.lives = clampLives(state.lives - 1);
    updateLives(state.lives);
    state.cellStates[r][c] = { cat: false, paw: false, catStyle: 0 };
    applyCellView(cellEl, state.cellStates[r][c]);
    cellEl.classList.add('error');
    setTimeout(() => {
        const target = cellAt(r, c);
        if (target) target.classList.remove('error');
    }, 400);

    sound.playHiss();
    if (state.lives === 0) {
        state.status = 'lost';
        recordResult(state, false);
        saveNow();
        showToast('3 顆心用完了。', 'error');
        updateGameOverUI(state);
        setTimeout(() => sound.playGameOver(), 380);
        showResult(state, false);
    } else {
        saveNow();
        showToast(`那裡沒有貓咪，還剩 ${state.lives} 顆心。`, 'error');
    }
    updateClearButtonState(state);
}

function handleBoardPointerDown(event) {
    event.preventDefault();
    // 第二根手指不參與：否則兩指會塗出相反值並讓存檔與畫面不同步
    if (drag.pointerId !== null && event.pointerId !== drag.pointerId) return;

    const state = getState(currentSize);
    if (state.status !== 'playing') return;

    measureBoardGeometry(currentSize);
    const hit = pointToCell(event.clientX, event.clientY);
    if (!hit) return;
    const { r, c } = hit;
    if (state.cellStates[r][c].cat) return;

    setFocusCell(r, c, false);

    // 「放貓咪」工具：點一下直接放，不進入拖曳畫貓爪
    if (currentTool === 'cat') {
        resetPointerState();
        placeCat(state, r, c);
        return;
    }

    const now = event.timeStamp || performance.now();
    const key = r + '-' + c;
    const window_ = TAP_WINDOW[event.pointerType] || TAP_WINDOW.mouse;
    if (lastTapArmed && lastTapCellKey === key && now - lastTapTime < window_) {
        lastTapArmed = false;
        lastTapTime = 0;
        lastTapCellKey = '';
        placeCat(state, r, c);
        return;
    }

    drag.pointerId = event.pointerId;
    drag.active = true;
    drag.value = !state.cellStates[r][c].paw;
    drag.lastR = r;
    drag.lastC = c;
    try {
        boardEl.setPointerCapture(event.pointerId);
    } catch (error) {
        /* 沒有 capture 也還有 document 的 pointerup 保險 */
    }
    paintPaw(state, r, c, drag.value);
    lastTapTime = now;
    lastTapCellKey = key;
    lastTapArmed = true;
}

function handleBoardPointerMove(event) {
    if (!drag.active || event.pointerId !== drag.pointerId) return;
    drag.pendingX = event.clientX;
    drag.pendingY = event.clientY;
    if (!drag.rafId) drag.rafId = requestAnimationFrame(flushDrag);
}

function flushDrag() {
    drag.rafId = 0;
    if (!drag.active) return;
    const state = getState(currentSize);
    if (state.status !== 'playing') {
        endDrag();
        return;
    }

    const hit = pointToCell(drag.pendingX, drag.pendingY);
    if (!hit) return;
    if (hit.r === drag.lastR && hit.c === drag.lastC) return;

    // 一次拖曳動作不該再被判定成雙擊
    lastTapArmed = false;

    const dr = hit.r - drag.lastR;
    const dc = hit.c - drag.lastC;
    const steps = Math.max(Math.abs(dr), Math.abs(dc));
    // rAF 合併後每帧可能跨好幾格，必須插值補上中間的格子才不會漏格；
    // 但跨太遠（capture 轉移、掉帧、離開棋盤後回來）就只塗終點，避免畫出一條沒碰過的線
    if (steps <= 8) {
        for (let i = 1; i <= steps; i++) {
            const r = drag.lastR + Math.round((dr * i) / steps);
            const c = drag.lastC + Math.round((dc * i) / steps);
            if (!state.cellStates[r][c].cat && state.cellStates[r][c].paw !== drag.value) {
                paintPaw(state, r, c, drag.value);
            }
        }
    } else if (!state.cellStates[hit.r][hit.c].cat && state.cellStates[hit.r][hit.c].paw !== drag.value) {
        paintPaw(state, hit.r, hit.c, drag.value);
    }

    drag.lastR = hit.r;
    drag.lastC = hit.c;
}

function endDrag() {
    if (drag.rafId) {
        cancelAnimationFrame(drag.rafId);
        drag.rafId = 0;
    }
    if (drag.pointerId !== null) {
        try {
            boardEl.releasePointerCapture(drag.pointerId);
        } catch (error) {
            /* 已釋放 */
        }
    }
    drag.pointerId = null;
    drag.active = false;
    flushSave();
}

/* ==========================================================================
   7. 遊戲流程與 UI
   ========================================================================== */

function updateModeButtons() {
    modeBtns.forEach((btn) => {
        const on = Number(btn.dataset.size) === currentSize;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    });
}

function isBoardEmpty(state) {
    return state.cellStates.every((row) => row.every((cellState) => !cellState.cat && !cellState.paw));
}

function updateClearButtonState(state) {
    const empty = isBoardEmpty(state);
    clearBtn.disabled = empty;
    clearBtn.classList.toggle('disabled', empty);
}

function updateGameOverUI(state) {
    const isOver = state.status !== 'playing';
    boardEl.classList.toggle('frozen', isOver);
    resetBtn.classList.toggle('highlight', isOver);
}

function updateLives(lives) {
    const safeLives = clampLives(lives);
    livesEl.textContent = '❤️'.repeat(safeLives) + '🖤'.repeat(3 - safeLives);
    livesEl.setAttribute('aria-label', `剩餘 ${safeLives} 顆心`);
    livesEl.title = `剩餘 ${safeLives} 顆心`;
}

function showToast(message, type = 'info') {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = `message-toast show ${type}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toastEl.className = 'message-toast';
    }, 2400);
}

function initGame(size) {
    currentSize = size;
    resetPointerState();
    const state = getState(size);
    updateModeButtons();
    updateLives(state.lives);

    ensureBoardDom(size);
    boardEl.classList.remove('celebrate');
    syncBoardToState(state);
    updateGameOverUI(state);
    updateClearButtonState(state);
    saveNow();
}

function performReset() {
    discardPendingSave();
    gameStates[currentSize] = createFreshState(currentSize);
    saveGameStates();
    initGame(currentSize);
}

function performClear() {
    discardPendingSave();
    const state = getState(currentSize);
    state.cellStates = createEmptyCellStates(state.size);
    saveGameStates();
    initGame(currentSize);
}

function checkWin(state) {
    if (state.status !== 'playing') return;
    const complete = state.cellStates.every((row, r) => row.every((cellState, c) => {
        const shouldHaveCat = state.solution[r][c] === 1;
        return (shouldHaveCat && cellState.cat) || (!shouldHaveCat && !cellState.cat);
    }));

    // 從實際答案比對正確放置的貓咪數，而不是只信賴計數變數
    let correctCats = 0;
    for (let r = 0; r < state.size; r++) {
        for (let c = 0; c < state.size; c++) {
            if (state.solution[r][c] === 1 && state.cellStates[r][c].cat) correctCats++;
        }
    }

    if (correctCats === state.size && complete) {
        state.status = 'won';
        recordResult(state, true);
        saveNow();
        boardEl.classList.add('celebrate');
        showToast('貓咪都回家了！', 'success');
        setTimeout(() => sound.playPurr(), 260);
        const confetti = (typeof BoboConfetti !== 'undefined') ? BoboConfetti : null;
        if (confetti && confettiCanvas) confetti.burst(confettiCanvas);
        showResult(state, true);
    } else {
        scheduleSave();
    }
}

// 對話框一律用原生 <dialog>：showModal() 自帶背景 inert、Esc 關閉與焦點圈；
// 關閉時焦點回到開啟它的按鈕
function openDialog(dialog, focusTarget) {
    if (!dialog || dialog.open) return;
    const opener = document.activeElement;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    if (focusTarget) focusTarget.focus();
    dialog.addEventListener('close', () => {
        if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    }, { once: true });
}

function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
}

function openHelp() {
    openDialog(helpOverlay, helpCloseBtn);
}

function closeHelp() {
    closeDialog(helpOverlay);
}

function openConfirm(action) {
    pendingConfirmAction = action;
    if (action === 'clear') {
        confirmTitleEl.textContent = '清空盤面';
        confirmMessageEl.textContent = '確定要清空目前的標記與貓咪嗎？此動作無法復原。';
        confirmOkBtn.textContent = '清空';
    } else {
        confirmTitleEl.textContent = '換新題目';
        confirmMessageEl.textContent = '確定要換一題嗎？目前的進度會消失。';
        confirmOkBtn.textContent = '換新題目';
    }
    openDialog(confirmOverlay, confirmCancelBtn);
}

function closeConfirm() {
    closeDialog(confirmOverlay);
    pendingConfirmAction = null;
}

/* ---------- 計時、戰績與結果 ---------- */

function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function loadStats() {
    try {
        const data = JSON.parse(localStorage.getItem(STATS_KEY) || '{}');
        return (data && typeof data === 'object') ? data : {};
    } catch (error) {
        return {};
    }
}

function recordResult(state, won) {
    const stats = loadStats();
    const entry = stats[state.size] || { wins: 0, losses: 0, bestTime: null };
    if (won) {
        entry.wins += 1;
        const t = Math.floor(state.elapsed || 0);
        if (entry.bestTime === null || t < entry.bestTime) entry.bestTime = t;
    } else {
        entry.losses += 1;
    }
    stats[state.size] = entry;
    try {
        localStorage.setItem(STATS_KEY, JSON.stringify(stats));
    } catch (error) {
        /* 隱私模式存不了就只顯示這一局 */
    }
    return entry;
}

function showResult(state, won) {
    const entry = loadStats()[state.size] || { wins: 0, bestTime: null };
    resultDialog.classList.toggle('won', won);
    resultDialog.classList.toggle('lost', !won);
    resultBadgeEl.textContent = won ? '🏡' : '💔';
    resultTitleEl.textContent = won ? '貓咪都回家了！' : '心用完了';
    resultDescEl.textContent = won
        ? `${state.size}×${state.size} 的每一隻貓都放對了。`
        : '這題還沒解完。可以清掉標記再試一次，或換一題。';
    resultTimeEl.textContent = formatTime(state.elapsed || 0);
    resultLivesEl.textContent = `${clampLives(state.lives)} / 3`;
    resultBestEl.textContent = entry.bestTime === null ? '--' : formatTime(entry.bestTime);
    resultWinsEl.textContent = `${entry.wins} 次`;
    resultPrimaryBtn.textContent = won ? '下一題' : '再試一次';
    resultSecondaryBtn.textContent = won ? '看盤面' : '換一題';
    resultPrimaryBtn.dataset.action = won ? 'next' : 'retry';
    resultSecondaryBtn.dataset.action = won ? 'view' : 'next';
    // 等最後一隻貓的動畫與音效走完再跳出
    setTimeout(() => openDialog(resultDialog, resultPrimaryBtn), prefersReducedMotion() ? 0 : 700);
}

function prefersReducedMotion() {
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (error) {
        return false;
    }
}

// 失敗後「再試一次」：同一題、心數補滿、清掉所有標記
function retrySamePuzzle() {
    discardPendingSave();
    const state = getState(currentSize);
    state.cellStates = createEmptyCellStates(state.size);
    state.lives = 3;
    state.status = 'playing';
    state.elapsed = 0;
    saveGameStates();
    initGame(currentSize);
}

function handleResultAction(action) {
    closeDialog(resultDialog);
    if (action === 'next') performReset();
    else if (action === 'retry') retrySamePuzzle();
    // 'view'：關掉對話框看盤面即可
}

// 一秒累計一次用時（只在進行中且頁面可見時），每 5 秒順手排一次存檔
setInterval(() => {
    if (document.hidden) return;
    const state = gameStates[currentSize];
    if (!state || state.status !== 'playing') return;
    if (isBoardEmpty(state) && !state.elapsed) return; // 還沒開始動手就不計時
    state.elapsed = (state.elapsed || 0) + 1;
    if (state.elapsed % 5 === 0) scheduleSave();
}, 1000);

/* ---------- 工具與鍵盤 ---------- */

let currentTool = 'paw';

function loadTool() {
    try {
        return localStorage.getItem(TOOL_KEY) === 'cat' ? 'cat' : 'paw';
    } catch (error) {
        return 'paw';
    }
}

function setTool(tool) {
    currentTool = tool === 'cat' ? 'cat' : 'paw';
    toolBtns.forEach((btn) => {
        const on = btn.dataset.tool === currentTool;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
    });
    if (toolHintEl) {
        toolHintEl.textContent = currentTool === 'cat'
            ? '點一下放貓咪；放錯會扣 1 顆心。'
            : '點或拖曳畫貓爪，標出「確定沒有貓」的格子；雙擊直接放貓咪。';
    }
    boardEl.dataset.tool = currentTool;
    try {
        localStorage.setItem(TOOL_KEY, currentTool);
    } catch (error) {
        /* 寫不進去就只在這次有效 */
    }
}

function setFocusCell(r, c, focus) {
    const prev = cellAt(focusPos.r, focusPos.c);
    if (prev) prev.tabIndex = -1;
    focusPos = { r, c };
    const next = cellAt(r, c);
    if (!next) return;
    next.tabIndex = 0;
    if (focus) next.focus();
}

function handleBoardKeydown(event) {
    const cellEl = event.target.closest ? event.target.closest('.cell') : null;
    if (!cellEl) return;
    let r = Number(cellEl.dataset.r);
    let c = Number(cellEl.dataset.c);
    const size = currentSize;
    switch (event.key) {
        case 'ArrowUp': r = Math.max(0, r - 1); break;
        case 'ArrowDown': r = Math.min(size - 1, r + 1); break;
        case 'ArrowLeft': c = Math.max(0, c - 1); break;
        case 'ArrowRight': c = Math.min(size - 1, c + 1); break;
        case 'Home': c = 0; break;
        case 'End': c = size - 1; break;
        case ' ':
        case 'Enter': {
            event.preventDefault();
            const state = getState(currentSize);
            if (state.status !== 'playing' || state.cellStates[r][c].cat) return;
            if (event.key === 'Enter') placeCat(state, r, c);
            else {
                paintPaw(state, r, c, !state.cellStates[r][c].paw);
                flushSave();
            }
            return;
        }
        default:
            return;
    }
    event.preventDefault();
    setFocusCell(r, c, true);
}

// 在 Console 呼叫： checkPlayerSolutionUnique()，會輸出是否正確與是否唯一
function checkPlayerSolutionUnique() {
    const state = getState(currentSize);
    let playerMatches = true;
    for (let r = 0; r < state.size; r++) {
        for (let c = 0; c < state.size; c++) {
            const shouldHave = state.solution[r][c] === 1;
            const hasCat = state.cellStates[r][c].cat;
            if ((shouldHave && !hasCat) || (!shouldHave && hasCat)) {
                playerMatches = false;
                break;
            }
        }
        if (!playerMatches) break;
    }

    const sols = countSolutions(state, 2);
    console.log('Player matches generated solution:', playerMatches);
    if (sols === 0) console.log('No valid solutions given current fixed placements.');
    else if (sols === 1) console.log('Unique solution exists.');
    else console.log('Multiple solutions exist (>=2).');
    return { playerMatches, solutions: sols };
}

window.checkPlayerSolutionUnique = checkPlayerSolutionUnique;

/* ==========================================================================
   8. 事件綁定
   ========================================================================== */

modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
        const size = Number(btn.dataset.size);
        if (size === currentSize) return;
        flushSave();
        currentSize = size;
        updateModeButtons();
        initGame(size);
    });
});

resetBtn.addEventListener('click', () => {
    const state = getState(currentSize);
    if (state.status !== 'playing') {
        performReset();
    } else {
        openConfirm('reset');
    }
});

clearBtn.addEventListener('click', () => {
    const state = getState(currentSize);
    if (isBoardEmpty(state)) return;
    openConfirm('clear');
});

confirmCancelBtn.addEventListener('click', closeConfirm);
confirmOkBtn.addEventListener('click', () => {
    if (pendingConfirmAction === 'clear') {
        performClear();
    } else {
        performReset();
    }
    closeConfirm();
});
// 點對話框外的背景也可以關閉（點在 dialog 本身而非內容時，target 就是 dialog）
[confirmOverlay, helpOverlay].forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
        if (event.target === dialog) closeDialog(dialog);
    });
});
confirmOverlay.addEventListener('close', () => { pendingConfirmAction = null; });

helpBtn.addEventListener('click', openHelp);
helpCloseBtn.addEventListener('click', closeHelp);

resultPrimaryBtn.addEventListener('click', () => handleResultAction(resultPrimaryBtn.dataset.action));
resultSecondaryBtn.addEventListener('click', () => handleResultAction(resultSecondaryBtn.dataset.action));

toolBtns.forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

boardEl.addEventListener('keydown', handleBoardKeydown);

darkModeToggle.addEventListener('click', toggleTheme);

if (soundBtn) {
    soundBtn.addEventListener('click', () => {
        sound.toggle();
        updateSoundButton();
    });
}

boardEl.addEventListener('pointerdown', handleBoardPointerDown);
boardEl.addEventListener('pointermove', handleBoardPointerMove);
boardEl.addEventListener('pointerup', endDrag);
boardEl.addEventListener('pointercancel', () => {
    endDrag();
    resetPointerState();
});
document.addEventListener('pointerup', endDrag);

// 部分行動瀏覽器（尤其 iOS Safari）即使設定 touch-action/user-scalable，
// 仍可能在同一格快速點兩下時觸發原生「雙擊放大」手勢。棋盤互動由
// pointer events 處理，因此在 touch 事件層直接取消預設手勢最穩定。
function preventBoardTouchGesture(event) {
    event.preventDefault();
}

boardEl.addEventListener('touchstart', preventBoardTouchGesture, { passive: false });
boardEl.addEventListener('touchmove', preventBoardTouchGesture, { passive: false });
boardEl.addEventListener('touchend', preventBoardTouchGesture, { passive: false });
boardEl.addEventListener('touchcancel', preventBoardTouchGesture, { passive: false });

['pointerdown', 'touchend', 'mousedown', 'keydown'].forEach((type) => {
    document.addEventListener(type, () => sound.unlock(), { once: true, capture: true, passive: true });
});

window.addEventListener('blur', () => {
    endDrag();
    resetPointerState();
});
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        flushSave();
        sound.suspendIfNeeded();
    } else {
        sound.resumeIfNeeded();
    }
});

const invalidateGeometry = () => {
    geom.dirty = true;
};
window.addEventListener('resize', invalidateGeometry);
window.addEventListener('orientationchange', invalidateGeometry);
window.addEventListener('scroll', invalidateGeometry, { passive: true, capture: true });

/* ==========================================================================
   9. 啟動
   ========================================================================== */

preloadCatAssets();

const savedGameData = loadSavedGameData();
currentSize = savedGameData.currentSize;
gameStates = savedGameData.states;

initTheme();
updateSoundButton();
setTool(loadTool());
initGame(currentSize);
// 重新整理時若這題已經結束，盤面維持凍結；不自動再跳結果對話框

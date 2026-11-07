/**
 * 波波小遊戲 - 全站共用過關儀式 (BoboCelebrate)
 *
 * 20 款遊戲原本各自有一個結果視窗，長相、用語、按鈕順序都不同，
 * 玩家在最有記憶點的「過關那一刻」反而看不出這是同一個網站。
 * 這支模組提供單一的結果卡片：波波標誌 + 遊戲名稱、標題、統計、新紀錄徽章、
 * 「再來一局」主按鈕與次按鈕；勝利放彩帶，失敗用另一種沉穩的樣式。
 *
 * 用法（使用端一律要寫可缺席守衛）：
 *   const celebrate = (typeof BoboCelebrate !== 'undefined') ? BoboCelebrate : null;
 *   if (celebrate) celebrate.show({
 *     outcome: 'win',                     // 'win' | 'lose'
 *     gameName: '熄燈遊戲',
 *     title: '全部熄滅！',
 *     subtitle: '用了 12 步，比上次少 3 步。',
 *     stats: [{ label: '步數', value: '12', isBest: true }, { label: '時間', value: '0:48' }],
 *     extra: someElement,                 // 選用：各遊戲的個性內容（完成圖、貓咪…）
 *     accent: '#b45309',                  // 選用：遊戲主色（淺色主題用）
 *     accentDark: '#fbbf24',              // 選用：深色主題用
 *     primary: { label: '再來一局', onClick: () => game.restart() },
 *     secondary: { label: '看盤面' },     // 沒給 onClick 就只是關閉
 *     onClose: (reason) => {}             // reason: 'primary' | 'secondary' | 'dismiss'
 *   });
 *
 * 無障礙：原生 <dialog> + showModal()（自帶 inert 與 Esc），開啟時焦點落在主按鈕，
 * 關閉後焦點回到開啟前的元素（或 returnFocus 指定的元素）。
 * 減少動態效果：只淡入，不縮放、不彈跳，也不放彩帶（BoboConfetti 自己會守）。
 *
 * 零遊戲耦合：不碰盤面、分數、存檔。樣式自帶（第一次 show 時注入），
 * 類名一律 bobo-result 前綴，不會和各遊戲的 CSS 互相干擾。
 */
const BoboCelebrate = (() => {
  'use strict';

  const STYLE_ID = 'bobo-celebrate-style';
  const DEFAULT_ACCENT = '#6346ea';
  const DEFAULT_ACCENT_DARK = '#a58dff';

  const getWin = () => (typeof window !== 'undefined' ? window : null);
  const getDoc = () => (typeof document !== 'undefined' ? document : null);

  /**
   * 秒數轉成玩家看得懂的時間：59 → 「59 秒」，65 → 「1 分 05 秒」，3725 → 「1 時 02 分 05 秒」
   * @param {number} seconds
   * @returns {string}
   */
  const formatDuration = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) return `${h} 時 ${pad(m)} 分 ${pad(s)} 秒`;
    if (m > 0) return `${m} 分 ${pad(s)} 秒`;
    return `${s} 秒`;
  };

  /**
   * 判斷這次成績是不是新紀錄。沒有舊紀錄（null / undefined / 非數字）時算新紀錄。
   * @param {number|null|undefined} previous 舊紀錄
   * @param {number} current 這次成績
   * @param {{lowerIsBetter?: boolean}} [options] 步數、時間這類越少越好的要傳 true
   * @returns {boolean}
   */
  const isNewRecord = (previous, current, options) => {
    const lowerIsBetter = !!(options && options.lowerIsBetter);
    if (typeof current !== 'number' || !Number.isFinite(current)) return false;
    if (typeof previous !== 'number' || !Number.isFinite(previous)) return true;
    return lowerIsBetter ? current < previous : current > previous;
  };

  /**
   * 把呼叫端傳入的 stats 整理成固定形狀，過濾掉沒有 label 的項目。
   * @param {Array<{label:string, value:any, isBest?:boolean}>} stats
   * @returns {Array<{label:string, value:string, isBest:boolean}>}
   */
  const normalizeStats = (stats) => (Array.isArray(stats) ? stats : [])
    .filter((item) => item && typeof item.label === 'string' && item.label.trim())
    .map((item) => ({
      label: item.label.trim(),
      value: item.value === undefined || item.value === null ? '—' : String(item.value),
      isBest: !!item.isBest
    }));

  const prefersReducedMotion = () => {
    try {
      const win = getWin();
      return !!(win && typeof win.matchMedia === 'function'
        && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {
      return false;
    }
  };

  const CSS = `
.bobo-result {
  --br-accent: ${DEFAULT_ACCENT};
  --br-surface: #ffffff;
  --br-ink: #241f33;
  --br-muted: #5f586c;
  --br-line: rgba(41, 36, 58, 0.12);
  --br-tint: rgba(99, 70, 234, 0.08);
  --br-lose: #8a3b2e;
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  margin: auto;
  padding: 0;
  overflow: auto;
  border: 0;
  border-radius: 24px;
  background: var(--br-surface);
  color: var(--br-ink);
  box-shadow: 0 24px 60px rgba(20, 16, 32, 0.28);
  font-family: ui-rounded, "SF Pro Rounded", "Noto Sans TC", system-ui, -apple-system, "Segoe UI", sans-serif;
  text-align: center;
}
html[data-theme="dark"] .bobo-result {
  --br-accent: var(--br-accent-dark, ${DEFAULT_ACCENT_DARK});
  --br-surface: #211e2e;
  --br-ink: #f8f4ff;
  --br-muted: #bbb3c9;
  --br-line: rgba(236, 227, 255, 0.14);
  --br-tint: rgba(165, 141, 255, 0.12);
  --br-lose: #f0a493;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}
.bobo-result::backdrop {
  background: rgba(20, 16, 32, 0.52);
}
.bobo-result[open] {
  animation: bobo-result-in 260ms cubic-bezier(0.16, 1, 0.3, 1);
}
.bobo-result__band {
  height: 8px;
  background: var(--br-accent);
}
.bobo-result[data-outcome="lose"] .bobo-result__band {
  height: 0;
  border-top: 6px dashed var(--br-lose);
  background: none;
}
.bobo-result__body {
  padding: 22px 24px 24px;
}
.bobo-result__brand {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 14px;
  color: var(--br-muted);
  font-size: 13px;
  font-weight: 800;
}
.bobo-result__mark {
  width: 28px;
  height: 28px;
  flex: none;
}
.bobo-result[data-outcome="win"][open] .bobo-result__mark {
  animation: bobo-result-stamp 520ms cubic-bezier(0.16, 1, 0.3, 1) 120ms both;
}
.bobo-result__extra:empty {
  display: none;
}
.bobo-result__extra {
  margin: 0 auto 14px;
}
.bobo-result__title {
  margin: 0;
  font-size: 26px;
  line-height: 1.25;
  font-weight: 900;
  letter-spacing: 0.01em;
}
.bobo-result[data-outcome="lose"] .bobo-result__title {
  color: var(--br-lose);
}
.bobo-result__subtitle {
  margin: 8px 0 0;
  color: var(--br-muted);
  font-size: 15px;
  line-height: 1.6;
}
.bobo-result__subtitle:empty {
  display: none;
}
.bobo-result__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 8px;
  margin: 18px 0 0;
  padding: 0;
}
.bobo-result__stats:empty {
  display: none;
}
.bobo-result__stat {
  margin: 0;
  padding: 10px 8px;
  border-radius: 14px;
  background: var(--br-tint);
}
.bobo-result__stat dt {
  color: var(--br-muted);
  font-size: 12px;
  font-weight: 800;
}
.bobo-result__stat dd {
  margin: 4px 0 0;
  font-size: 20px;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
}
.bobo-result__best {
  display: block;
  margin-top: 4px;
  color: var(--br-accent);
  font-size: 12px;
  font-weight: 900;
}
.bobo-result__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
  margin-top: 22px;
}
.bobo-result__button {
  min-width: 128px;
  min-height: 46px;
  padding: 0 18px;
  border: 2px solid var(--br-accent);
  border-radius: 14px;
  background: transparent;
  color: var(--br-ink);
  font: inherit;
  font-size: 15px;
  font-weight: 900;
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}
.bobo-result__button--primary {
  background: var(--br-accent);
  color: #ffffff;
}
html[data-theme="dark"] .bobo-result__button--primary {
  color: #15121f;
}
.bobo-result__button:hover {
  background: var(--br-tint);
}
.bobo-result__button--primary:hover {
  background: var(--br-accent);
  filter: brightness(0.94);
}
.bobo-result__button:focus-visible {
  outline: 3px solid var(--br-accent);
  outline-offset: 3px;
}
.bobo-result__confetti {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 2147483000;
}
@keyframes bobo-result-in {
  from { opacity: 0; transform: translateY(12px); }
}
@keyframes bobo-result-stamp {
  0% { transform: scale(0.4) rotate(-14deg); opacity: 0; }
  100% { transform: none; opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .bobo-result[open] {
    animation-name: bobo-result-fade;
  }
  .bobo-result[data-outcome="win"][open] .bobo-result__mark {
    animation: none;
  }
}
@keyframes bobo-result-fade {
  from { opacity: 0; }
}
`;

  // 首頁同款的波波標誌（縮小版），讓過關畫面帶著品牌
  const MARK_SVG = '<svg class="bobo-result__mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">'
    + '<rect width="40" height="40" rx="13" fill="#7255EA"/>'
    + '<circle cx="17" cy="22" r="10" fill="#FFF8ED"/>'
    + '<path d="m14.5 16.5 10 5.5-10 5.5v-11Z" fill="#7255EA"/>'
    + '<circle cx="29" cy="10" r="5" fill="#FFB76B"/>'
    + '</svg>';

  const ensureStyle = (doc) => {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  };

  let active = null; // 目前開著的 { dialog, close }
  let idSeq = 0;

  const make = (doc, tag, className, text) => {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };

  const burstConfetti = (doc) => {
    try {
      if (typeof BoboConfetti === 'undefined' || !BoboConfetti || typeof BoboConfetti.burst !== 'function') return;
      if (prefersReducedMotion()) return;
      let canvas = doc.querySelector('canvas.bobo-result__confetti');
      if (!canvas) {
        canvas = make(doc, 'canvas', 'bobo-result__confetti');
        canvas.setAttribute('aria-hidden', 'true');
        doc.body.appendChild(canvas);
      }
      BoboConfetti.burst(canvas);
    } catch (_) {}
  };

  /**
   * 顯示結果卡片。同時只會有一張，再次呼叫會先關掉前一張。
   * @returns {{dialog: HTMLDialogElement|null, close: Function}}
   */
  const show = (options) => {
    const opts = options || {};
    const doc = getDoc();
    const noop = { dialog: null, close: () => {} };
    if (!doc || !doc.body) return noop;
    try {
      if (active) active.close('dismiss');
      ensureStyle(doc);

      const outcome = opts.outcome === 'lose' ? 'lose' : 'win';
      const returnTo = opts.returnFocus || doc.activeElement;
      const uid = `bobo-result-${++idSeq}`;

      const dialog = make(doc, 'dialog', 'bobo-result');
      dialog.dataset.outcome = outcome;
      dialog.setAttribute('aria-labelledby', `${uid}-title`);
      dialog.setAttribute('aria-describedby', `${uid}-subtitle`);
      if (opts.accent) dialog.style.setProperty('--br-accent', opts.accent);
      if (opts.accentDark) dialog.style.setProperty('--br-accent-dark', opts.accentDark);

      dialog.appendChild(make(doc, 'div', 'bobo-result__band'));
      const body = make(doc, 'div', 'bobo-result__body');
      dialog.appendChild(body);

      const brand = make(doc, 'p', 'bobo-result__brand');
      brand.innerHTML = MARK_SVG;
      brand.appendChild(doc.createTextNode(opts.gameName ? `波波小遊戲 · ${opts.gameName}` : '波波小遊戲'));
      body.appendChild(brand);

      const extra = make(doc, 'div', 'bobo-result__extra');
      if (opts.extra && typeof opts.extra === 'object' && 'nodeType' in opts.extra) extra.appendChild(opts.extra);
      body.appendChild(extra);

      const title = make(doc, 'h2', 'bobo-result__title', opts.title || (outcome === 'win' ? '過關！' : '這局沒成功'));
      title.id = `${uid}-title`;
      body.appendChild(title);

      const subtitle = make(doc, 'p', 'bobo-result__subtitle', opts.subtitle || '');
      subtitle.id = `${uid}-subtitle`;
      body.appendChild(subtitle);

      const stats = make(doc, 'dl', 'bobo-result__stats');
      normalizeStats(opts.stats).forEach((item) => {
        const box = make(doc, 'div', 'bobo-result__stat');
        box.appendChild(make(doc, 'dt', '', item.label));
        const dd = make(doc, 'dd', '', item.value);
        if (item.isBest) dd.appendChild(make(doc, 'span', 'bobo-result__best', opts.bestLabel || '新紀錄'));
        box.appendChild(dd);
        stats.appendChild(box);
      });
      body.appendChild(stats);

      const actions = make(doc, 'div', 'bobo-result__actions');
      body.appendChild(actions);

      let closed = false;
      const close = (reason) => {
        if (closed) return;
        closed = true;
        try {
          if (dialog.open && typeof dialog.close === 'function') dialog.close();
        } catch (_) {}
        try { dialog.remove(); } catch (_) {}
        if (active && active.dialog === dialog) active = null;
        try {
          if (returnTo && typeof returnTo.focus === 'function' && returnTo.isConnected
            && !returnTo.disabled && returnTo.getAttribute('aria-disabled') !== 'true') {
            returnTo.focus();
          }
        } catch (_) {}
        try {
          if (typeof opts.onClose === 'function') opts.onClose(reason || 'dismiss');
        } catch (_) {}
      };

      const addButton = (config, kind) => {
        if (!config || !config.label) return null;
        const button = make(doc, 'button', `bobo-result__button bobo-result__button--${kind}`, config.label);
        button.type = 'button';
        button.addEventListener('click', () => {
          // 先關卡片、焦點歸位，再交給遊戲處理（例如重開一局會重繪盤面）
          close(kind);
          try {
            if (typeof config.onClick === 'function') config.onClick();
          } catch (err) {
            if (typeof console !== 'undefined') console.error(err);
          }
        });
        actions.appendChild(button);
        return button;
      };
      const primaryButton = addButton(opts.primary || { label: '再來一局' }, 'primary');
      addButton(opts.secondary, 'secondary');

      // Esc：原生 dialog 會發 cancel，攔下來走同一條關閉路徑
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        close('dismiss');
      });

      doc.body.appendChild(dialog);
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
      if (primaryButton) primaryButton.focus();
      if (outcome === 'win' && opts.confetti !== false) {
        burstConfetti(doc);
      } else {
        // 失敗時把上一局還在飄的彩帶收掉，避免和「沒成功」的訊息混在一起
        try {
          const leftover = doc.querySelector('canvas.bobo-result__confetti');
          if (leftover && typeof BoboConfetti !== 'undefined' && BoboConfetti) BoboConfetti.stop(leftover);
        } catch (_) {}
      }

      active = { dialog, close };
      return active;
    } catch (_) {
      return noop;
    }
  };

  /** 關掉目前開著的結果卡片（沒有就什麼都不做） */
  const close = () => {
    if (active) active.close('dismiss');
  };

  /** 目前是否有結果卡片開著（遊戲可用來擋輸入） */
  const isOpen = () => !!active;

  return {
    show,
    close,
    isOpen,
    formatDuration,
    isNewRecord,
    normalizeStats,
    prefersReducedMotion
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = BoboCelebrate;
}

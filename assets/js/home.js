(() => {
  'use strict';

  const KEY = 'bobo-home-preferences-v2';
  const LEGACY = 'bobo-mini-games-pinned-cards';
  const root = document.documentElement;
  const body = document.body;
  const grid = document.getElementById('game-grid');
  const cards = [...grid.querySelectorAll('.game-card')];
  const ids = new Set(cards.map((c) => c.dataset.id));
  const defaults = cards.map((c) => c.dataset.id);
  const byId = new Map(cards.map((c) => [c.dataset.id, c]));
  const hrefId = new Map(cards.map((c) => [c.querySelector('a').getAttribute('href'), c.dataset.id]));

  let filter = 'all';
  let query = '';
  let dragged = null;
  let timer;
  const gameStats = new Map(); // id -> play count

  const safe = (v) => (Array.isArray(v) ? v.filter((id, i, a) => ids.has(id) && a.indexOf(id) === i) : []);

  const load = () => {
    let s = {};
    try {
      s = JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch (_) {}

    let order = [...safe(s.order), ...defaults.filter((id) => !safe(s.order).includes(id))];
    if (!safe(s.order).length) {
      try {
        const pins = JSON.parse(localStorage.getItem(LEGACY) || '[]')
          .map((h) => hrefId.get(h))
          .filter(Boolean);
        order = [...new Set([...pins, ...order])];
      } catch (_) {}
    }

    return {
      theme: ['dark', 'light'].includes(s.theme) ? s.theme : root.dataset.theme,
      order,
      hidden: safe(s.hidden)
    };
  };

  let prefs = load();

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch (e) {
      console.warn('首頁偏好無法儲存。', e);
    }
  };

  const title = (c) => c.querySelector('h3').textContent.trim();

  const toast = (m) => {
    const t = document.getElementById('toast');
    t.textContent = m;
    t.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => t.classList.remove('show'), 2200);
  };

  const applyOrder = (customOrder = null) => {
    const list = customOrder || prefs.order;
    list.forEach((id) => {
      const c = byId.get(id);
      if (c) grid.insertBefore(c, document.getElementById('empty-state'));
    });
    [...grid.querySelectorAll('.game-card')].forEach((c, i) => c.style.setProperty('--index', i));
  };

  const render = () => {
    const hidden = new Set(prefs.hidden);
    let shown = 0;

    // 若為熱門排行，依遊玩次數由高到低排序卡片
    if (filter === 'popular') {
      const sortedIds = [...ids].sort((a, b) => (gameStats.get(b) || 0) - (gameStats.get(a) || 0));
      applyOrder(sortedIds);
    } else {
      applyOrder(prefs.order);
    }

    cards.forEach((c) => {
      const matchFilter = filter === 'all' || filter === 'popular' || c.dataset.category.split(' ').includes(filter);
      const matchSearch =
        !query ||
        c.dataset.search.toLocaleLowerCase('zh-Hant').includes(query) ||
        title(c).toLocaleLowerCase('zh-Hant').includes(query);
      c.hidden = hidden.has(c.dataset.id) || !matchFilter || !matchSearch;
      if (!c.hidden) shown++;
    });

    document.getElementById('visible-count').textContent = shown;
    document.getElementById('empty-state').classList.toggle('show', !shown);

    const list = document.getElementById('hidden-list');
    list.replaceChildren();
    prefs.hidden.forEach((id) => {
      const c = byId.get(id);
      if (!c) return;
      const b = document.createElement('button');
      b.className = 'restore-button';
      b.dataset.restore = id;
      b.textContent = `＋ ${title(c)}`;
      list.append(b);
    });

    document.getElementById('hidden-panel').hidden = !(body.classList.contains('editing') && prefs.hidden.length);
  };

  const theme = (t) => {
    prefs.theme = t;
    root.dataset.theme = t;
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.content = t === 'dark' ? '#14121e' : '#fff8ed';
    }
    const b = document.getElementById('theme-toggle');
    const next = t === 'dark' ? '淺色' : '深色';
    b.ariaLabel = `切換${next}模式`;
    b.title = `切換${next}模式`;
    save();
  };

  const edit = (on) => {
    body.classList.toggle('editing', on);
    const b = document.getElementById('edit-toggle');
    b.setAttribute('aria-pressed', String(on));
    b.querySelector('.edit-label').textContent = on ? '完成編輯' : '編輯首頁';
    cards.forEach((c) => (c.draggable = on));
    render();
  };

  const persistOrder = () => {
    prefs.order = [...grid.querySelectorAll('.game-card')].map((c) => c.dataset.id);
    save();
  };

  const move = (c, d) => {
    const visible = [...grid.querySelectorAll('.game-card:not([hidden])')];
    const i = visible.indexOf(c);
    const target = visible[i + d];
    if (!target) return;
    d < 0 ? grid.insertBefore(c, target) : grid.insertBefore(target, c);
    persistOrder();
    toast(`${title(c)}已向${d < 0 ? '前' : '後'}移動`);
    c.querySelector(d < 0 ? '.move-prev' : '.move-next').focus();
  };

  // 初始化每張卡片的結構（按鈕控制器與遊玩次數標籤）
  cards.forEach((c) => {
    c.append(document.getElementById('controls-template').content.cloneNode(true));
    c.querySelector('.move-prev').onclick = () => move(c, -1);
    c.querySelector('.move-next').onclick = () => move(c, 1);
    c.querySelector('.hide-card').onclick = () => {
      prefs.hidden = [...new Set([...prefs.hidden, c.dataset.id])];
      save();
      render();
      toast(`已隱藏「${title(c)}」`);
    };

    // 將 card-top 整理為 card-tags（包含 card-badge 與 card-play-tag）
    const cardTop = c.querySelector('.card-top');
    const existingBadge = cardTop?.querySelector('.card-badge');
    if (cardTop && existingBadge) {
      const tagsWrapper = document.createElement('span');
      tagsWrapper.className = 'card-tags';

      const playTag = document.createElement('span');
      playTag.className = 'card-play-tag';
      playTag.title = '累積遊玩次數';
      playTag.innerHTML = `
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 23c-4.97 0-9-4.03-9-9 0-4.13 2.85-7.7 6.94-8.68.42-.1.82.21.82.64v2.1c0 .36.24.67.59.76 1.83.47 3.23 1.9 3.61 3.73.08.38.41.65.8.65h.05c.48 0 .85-.43.77-.9-.4-2.39-1.84-4.47-3.92-5.59-.39-.21-.49-.71-.22-1.04 1.77-2.18 4.41-3.67 7.37-3.67.31 0 .61.02.91.05.41.05.7.4.65.81C20.67 8.04 17.8 13.5 17.8 14c0 .66.54 1.2 1.2 1.2.5 0 .95-.31 1.12-.78.43-1.18.68-2.45.68-3.77 0-.41.34-.75.75-.75h.05c.38 0 .7.28.74.66.42 3.66-.75 7.3-3.18 9.87C17.39 22.06 14.8 23 12 23z"/>
        </svg>
        <span class="play-num" id="stat-game-${c.dataset.id}">--</span> 次
      `;

      cardTop.replaceChild(tagsWrapper, existingBadge);
      tagsWrapper.append(existingBadge, playTag);
    }

    // 點擊卡片時立即樂觀累加並記錄遊玩事件
    const cardLink = c.querySelector('.card-link');
    if (cardLink && typeof Stats !== 'undefined') {
      cardLink.addEventListener('click', () => {
        Stats.recordGamePlay(c.dataset.id, true);
      });
    }

    // 拖曳排序事件
    c.ondragstart = (e) => {
      if (!body.classList.contains('editing')) return e.preventDefault();
      dragged = c;
      c.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', c.dataset.id);
    };
    c.ondragend = () => {
      dragged = null;
      cards.forEach((x) => x.classList.remove('dragging', 'drag-over'));
      persistOrder();
    };
    c.ondragover = (e) => {
      if (!dragged || dragged === c || c.hidden) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      c.classList.add('drag-over');
    };
    c.ondragleave = () => c.classList.remove('drag-over');
    c.ondrop = (e) => {
      e.preventDefault();
      c.classList.remove('drag-over');
      if (!dragged || dragged === c) return;
      const r = c.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      grid.insertBefore(dragged, after ? c.nextSibling : c);
      persistOrder();
      toast('遊戲順序已儲存');
    };
  });

  // 工具列與篩選按鈕事件
  document.getElementById('theme-toggle').onclick = () => theme(root.dataset.theme === 'dark' ? 'light' : 'dark');
  document.getElementById('edit-toggle').onclick = () => edit(!body.classList.contains('editing'));
  document.getElementById('game-search').oninput = (e) => {
    query = e.target.value.trim().toLocaleLowerCase('zh-Hant');
    render();
  };
  document.querySelectorAll('.filter-button').forEach((b) => {
    b.onclick = () => {
      filter = b.dataset.filter;
      document.querySelectorAll('.filter-button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      render();
    };
  });
  document.getElementById('hidden-list').onclick = (e) => {
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    const id = b.dataset.restore;
    prefs.hidden = prefs.hidden.filter((x) => x !== id);
    save();
    render();
    toast(`「${title(byId.get(id))}」已回到遊戲櫃`);
  };
  document.getElementById('restore-all').onclick = () => {
    prefs.hidden = [];
    save();
    render();
    toast('所有遊戲都回來了');
  };
  document.getElementById('random-game').onclick = () => {
    const available = cards.filter((c) => !c.hidden);
    if (!available.length) return toast('目前沒有符合條件的遊戲');
    const c = available[Math.floor(Math.random() * available.length)];
    c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    c.animate(
      [
        { transform: 'translateY(0)' },
        { transform: 'translateY(-10px)', boxShadow: '0 0 0 5px var(--accent)' },
        { transform: 'translateY(0)' }
      ],
      { duration: 700 }
    );
    toast(`今天就玩「${title(c)}」！`);
  };
  addEventListener('scroll', () => document.getElementById('site-header').classList.toggle('scrolled', scrollY > 4), {
    passive: true
  });

  // 載入並渲染統計數據
  const initStats = async () => {
    if (typeof Stats === 'undefined') return;

    const homeViewsEl = document.getElementById('stat-home-views');
    const totalPlaysEl = document.getElementById('stat-total-plays');

    // 1. 先載入本機快取數據，實現秒開無白畫面
    const cachedHomeViews = Stats.getCached('home-views', 0);
    if (homeViewsEl && cachedHomeViews > 0) {
      homeViewsEl.textContent = Stats.formatNumber(cachedHomeViews);
    }

    let initialTotalPlays = 0;
    defaults.forEach((id) => {
      const cached = Stats.getCached(`game-${id}`, 0);
      gameStats.set(id, cached);
      initialTotalPlays += cached;
      const el = document.getElementById(`stat-game-${id}`);
      if (el && cached > 0) {
        el.textContent = Stats.formatNumber(cached);
      }
    });

    if (totalPlaysEl && initialTotalPlays > 0) {
      totalPlaysEl.textContent = Stats.formatNumber(initialTotalPlays);
    }

    // 2. 非同步向 API 記錄首頁造訪並獲取最新人次
    Stats.recordHomeVisit().then((res) => {
      if (res && typeof res.value === 'number' && homeViewsEl) {
        Stats.animateCount(homeViewsEl, res.value);
      }
    });

    // 3. 非同步向 API 批次讀取各遊戲最新遊玩數
    Stats.getMultipleGames(defaults).then((statsMap) => {
      let totalPlays = 0;
      defaults.forEach((id) => {
        const count = typeof statsMap[id] === 'number' ? statsMap[id] : (gameStats.get(id) || 0);
        gameStats.set(id, count);
        totalPlays += count;
        const el = document.getElementById(`stat-game-${id}`);
        if (el) {
          Stats.animateCount(el, count);
        }
      });
      if (totalPlaysEl) {
        Stats.animateCount(totalPlaysEl, totalPlays);
      }
      // 若當前在熱門排行篩選，重新觸發渲染排序
      if (filter === 'popular') {
        render();
      }
    });
  };

  applyOrder();
  theme(prefs.theme);
  render();
  initStats();
})();

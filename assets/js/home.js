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

  const applyOrder = () => {
    prefs.order.forEach((id) => {
      const c = byId.get(id);
      if (c) grid.insertBefore(c, document.getElementById('empty-state'));
    });
    [...grid.querySelectorAll('.game-card')].forEach((c, i) => c.style.setProperty('--index', i));
  };

  const render = () => {
    const hidden = new Set(prefs.hidden);
    let shown = 0;
    cards.forEach((c) => {
      const matchFilter = filter === 'all' || c.dataset.category.split(' ').includes(filter);
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

  applyOrder();
  theme(prefs.theme);
  render();
})();

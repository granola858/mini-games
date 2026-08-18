/**
 * 波波小遊戲 - 全站流量與遊戲遊玩統計模組 (Stats & Counter)
 * 具備 Session 防刷、本機快取秒開、離線優雅降級與平滑數字滾動動畫
 */
const Stats = (() => {
  'use strict';

  const API_BASE = 'https://countapi.mileshilliard.com/api/v1';
  const NAMESPACE = 'bobo-games-v1';
  const TIMEOUT_MS = 4000;
  // 快取在此時間內視為新鮮，直接沿用而不再打 API
  const FRESH_MS = 5 * 60 * 1000;

  // 獲取帶前綴的唯一 Key
  const getKey = (name) => `${NAMESPACE}-${name}`;

  // 讀出完整快取項目（含寫入時間），供新鮮度判斷使用
  const readCache = (name) => {
    try {
      const raw = localStorage.getItem(`bobo_cache_${getKey(name)}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed.value !== 'number') return null;
      return { value: parsed.value, updatedAt: Number(parsed.updatedAt) || 0 };
    } catch (_) {
      return null;
    }
  };

  // 快取是否仍在有效期內
  const isFresh = (entry, maxAge) => {
    if (!entry || maxAge <= 0) return false;
    const age = Date.now() - entry.updatedAt;
    // 時鐘回撥時 age 會是負數，一併視為過期以免永久命中
    return age >= 0 && age < maxAge;
  };

  // 取得快取的統計數值
  const getCached = (name, fallback = 0) => {
    const entry = readCache(name);
    return entry ? entry.value : fallback;
  };

  // 寫入快取
  const setCached = (name, value) => {
    try {
      localStorage.setItem(`bobo_cache_${getKey(name)}`, JSON.stringify({ value, updatedAt: Date.now() }));
    } catch (_) {}
  };

  // 帶逾時機制的 fetch 封裝
  // 拋出的錯誤會帶上 status，讓呼叫端能分辨「計數器不存在」與「連線失敗」
  const fetchWithTimeout = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  };

  // 讀取指定項目的統計數值（不增加計數）
  // 快取若仍新鮮就直接回傳，完全不發出請求；傳入 maxAge = 0 可強制重新讀取
  const get = async (name, options = {}) => {
    const { maxAge = FRESH_MS } = options;

    const cached = readCache(name);
    if (isFresh(cached, maxAge)) {
      return { key: name, value: cached.value, cached: true };
    }

    const key = getKey(name);
    try {
      const data = await fetchWithTimeout(`${API_BASE}/get/${encodeURIComponent(key)}`);
      const val = typeof data?.value === 'number' ? data.value : getCached(name, 0);
      setCached(name, val);
      return { key: name, value: val };
    } catch (err) {
      // 404 代表這個計數器還沒被建立（例如尚無人玩過的遊戲）。
      // 這是明確答案而非失敗，因此快取為 0；否則每次載入都會重問一次，永遠問不到。
      if (err && err.status === 404) {
        setCached(name, 0);
        return { key: name, value: 0 };
      }
      // 連線失敗或逾時屬於暫時性問題，不寫入快取，下次仍會重試
      return { key: name, value: getCached(name, 0), error: true };
    }
  };

  // 累加指定項目的統計數值（支援 session 防刷）
  const hit = async (name, options = {}) => {
    const { oncePerSession = true, force = false } = options;
    const sessionKey = `bobo_session_${getKey(name)}`;

    // 若啟用 session 防刷且本次 session 已經計數過，則改為唯讀讀取
    if (oncePerSession && !force) {
      try {
        if (sessionStorage.getItem(sessionKey)) {
          return await get(name);
        }
      } catch (_) {}
    }

    const key = getKey(name);
    try {
      const data = await fetchWithTimeout(`${API_BASE}/hit/${encodeURIComponent(key)}`);
      const val = typeof data?.value === 'number' ? data.value : getCached(name, 0) + 1;
      setCached(name, val);
      try {
        sessionStorage.setItem(sessionKey, '1');
      } catch (_) {}
      return { key: name, value: val };
    } catch (err) {
      // 離線或 API 異常時，樂觀累加本機快取
      const optimistic = getCached(name, 0) + 1;
      setCached(name, optimistic);
      return { key: name, value: optimistic, error: true };
    }
  };

  // 格式化數字顯示（如 1,234 或 12.5k）
  const formatNumber = (num) => {
    if (typeof num !== 'number' || isNaN(num)) return '0';
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    }
    if (num >= 10000) {
      return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    }
    return num.toLocaleString('zh-TW');
  };

  // 數字平滑滾動增加動畫
  const animateCount = (el, target, duration = 800) => {
    if (!el) return;
    const start = parseInt(el.textContent.replace(/[^0-9]/g, ''), 10) || 0;
    if (start === target) {
      el.textContent = formatNumber(target);
      return;
    }

    const startTime = performance.now();
    const step = (now) => {
      const progress = Math.min((now - startTime) / duration, 1);
      // easeOutExpo
      const ease = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
      const current = Math.round(start + (target - start) * ease);
      el.textContent = formatNumber(current);
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        el.textContent = formatNumber(target);
      }
    };
    requestAnimationFrame(step);
  };

  // 記錄首頁造訪
  const recordHomeVisit = async () => {
    return await hit('home-views', { oncePerSession: true });
  };

  // 記錄遊戲遊玩
  const recordGamePlay = async (gameId, force = false) => {
    if (!gameId) return null;
    return await hit(`game-${gameId}`, { oncePerSession: false, force });
  };

  // 批次讀取多個遊戲的遊玩數據
  // countapi 沒有批次端點，因此請求數靠快取新鮮度控制：
  // 五分鐘內重訪首頁時，這裡一個請求都不會發出
  const getMultipleGames = async (gameIds = [], options = {}) => {
    const promises = gameIds.map(async (id) => {
      const res = await get(`game-${id}`, options);
      return { id, value: res.value };
    });
    const results = await Promise.allSettled(promises);
    const map = {};
    results.forEach((r, idx) => {
      const id = gameIds[idx];
      map[id] = r.status === 'fulfilled' ? r.value.value : getCached(`game-${id}`, 0);
    });
    return map;
  };

  return {
    getCached,
    get,
    hit,
    formatNumber,
    animateCount,
    recordHomeVisit,
    recordGamePlay,
    getMultipleGames
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Stats;
}

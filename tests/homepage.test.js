const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const homeJs = fs.existsSync(path.join(projectRoot, 'assets', 'js', 'home.js'))
  ? fs.readFileSync(path.join(projectRoot, 'assets', 'js', 'home.js'), 'utf8')
  : '';
const combinedSource = html + '\n' + homeJs;

const cards = [...html.matchAll(/<article class="game-card"\s+data-id="([^"]+)"\s+data-category="([^"]+)"\s+data-search="([^"]+)"[^>]*>[\s\S]*?<a class="card-link" href="([^"]+)"[^>]*>[\s\S]*?<h3>([^<]+)<\/h3>[\s\S]*?<\/article>/g)]
  .map(([, id, category, search, href, title]) => ({ id, category, search, href, title }));

test('首頁列出 11 個具有唯一 ID 的完整遊戲入口', () => {
  assert.equal(cards.length, 11);
  assert.equal(new Set(cards.map(card => card.id)).size, cards.length);
  cards.forEach(card => {
    assert.ok(card.title.trim(), `${card.id} 缺少標題`);
    assert.ok(card.category.trim(), `${card.id} 缺少分類`);
    assert.ok(card.search.trim(), `${card.id} 缺少搜尋文字`);
  });
});

test('每個首頁遊戲連結都指向現有檔案', () => {
  cards.forEach(card => {
    const target = path.join(projectRoot, ...card.href.split('/'));
    assert.ok(fs.existsSync(target), `${card.title} 的連結不存在：${card.href}`);
  });
});

test('所有首頁 JavaScript 都能通過語法編譯', () => {
  const inlineScripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  inlineScripts.forEach((source, index) => {
    assert.doesNotThrow(() => new Function(source), `第 ${index + 1} 段 inline script 語法錯誤`);
  });

  const externalScriptMatches = [...html.matchAll(/<script\s+src="([^"]+)"/gi)].map(m => m[1]);
  externalScriptMatches.forEach(src => {
    const filePath = path.join(projectRoot, ...src.split('/'));
    assert.ok(fs.existsSync(filePath), `找不到外部 script 檔案: ${src}`);
    const source = fs.readFileSync(filePath, 'utf8');
    assert.doesNotThrow(() => new Function(source), `${src} 語法錯誤`);
  });
});

test('排序、隱藏與主題控制都使用同一份持久化偏好', () => {
  assert.match(combinedSource, /bobo-home-preferences-v2/);
  assert.match(combinedSource, /prefs\.order/);
  assert.match(combinedSource, /prefs\.hidden/);
  assert.match(combinedSource, /prefs\.theme/);
  assert.match(html, /class="card-controls"/);
  assert.match(html, /id="hidden-panel"/);
  assert.match(html, /id="theme-toggle"/);
});

test('搜尋、類型篩選與隨機選擇控制均存在', () => {
  assert.match(html, /id="game-search"/);
  assert.match(html, /data-filter="logic"/);
  assert.match(html, /data-filter="party"/);
  assert.match(html, /data-filter="reaction"/);
  assert.match(html, /id="random-game"/);
});

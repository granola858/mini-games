const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

const gameHtmlFiles = [
  '1a2b.html',
  'color_nonogram.html',
  'color_text_game.html',
  'lights_out.html',
  'math.html',
  'meowdoku.html',
  'nonogram.html',
  'pair_game.html',
  'puzzle_game.html',
  'sic_bo.html',
  'slap_game.html',
  'guess_songs.html',
  'index.html'
];

test('所有遊戲 HTML 引用的 CSS 檔案皆存在且非空', () => {
  gameHtmlFiles.forEach(file => {
    const htmlPath = path.join(projectRoot, file);
    assert.ok(fs.existsSync(htmlPath), `找不到檔案: ${file}`);
    const content = fs.readFileSync(htmlPath, 'utf8');
    const cssMatches = [...content.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/gi)].map(m => m[1]);
    
    cssMatches.forEach(href => {
      if (href.startsWith('http')) return; // 跳過外部 CDN
      const cssPath = path.join(projectRoot, ...href.split('/'));
      assert.ok(fs.existsSync(cssPath), `${file} 引用的 CSS 不存在: ${href}`);
      const stat = fs.statSync(cssPath);
      assert.ok(stat.size > 0, `${href} 是空檔案`);
    });
  });
});

test('所有遊戲 HTML 引用的 JS 檔案皆存在且能通過語法編譯', () => {
  gameHtmlFiles.forEach(file => {
    const htmlPath = path.join(projectRoot, file);
    const content = fs.readFileSync(htmlPath, 'utf8');
    const jsMatches = [...content.matchAll(/<script\s+src="([^"]+)"/gi)].map(m => m[1]);

    jsMatches.forEach(src => {
      if (src.startsWith('http')) return; // 跳過外部 CDN
      const jsPath = path.join(projectRoot, ...src.split('/'));
      assert.ok(fs.existsSync(jsPath), `${file} 引用的 JS 不存在: ${src}`);
      const source = fs.readFileSync(jsPath, 'utf8');
      assert.doesNotThrow(() => new Function(source), `${src} 語法編譯失敗`);
    });
  });
});

test('所有遊戲 HTML 引用的 Favicon 圖示皆存在', () => {
  gameHtmlFiles.forEach(file => {
    const htmlPath = path.join(projectRoot, file);
    const content = fs.readFileSync(htmlPath, 'utf8');
    const iconMatch = content.match(/<link\s+rel="icon"[^>]*href="([^"]+)"/i);
    if (iconMatch) {
      const iconPath = path.join(projectRoot, ...iconMatch[1].split('/'));
      assert.ok(fs.existsSync(iconPath), `${file} 的 Favicon 不存在: ${iconMatch[1]}`);
    }
  });
});

test('Meowdoku 貓咪圖片資源完整且路徑正確', () => {
  const meowdokuJs = fs.readFileSync(path.join(projectRoot, 'assets', 'js', 'meowdoku.js'), 'utf8');
  for (let i = 1; i <= 8; i++) {
    const expectedPath = `assets/images/meowdoku/${i}.svg`;
    assert.ok(meowdokuJs.includes(expectedPath), `meowdoku.js 缺少圖片路徑: ${expectedPath}`);
    assert.ok(fs.existsSync(path.join(projectRoot, expectedPath)), `找不到圖片: ${expectedPath}`);
  }
});

test('所有遊戲皆具備回首頁按鈕', () => {
  const gamesWithBackBtn = gameHtmlFiles.filter(f => f !== 'index.html');
  gamesWithBackBtn.forEach(file => {
    const content = fs.readFileSync(path.join(projectRoot, file), 'utf8');
    assert.ok(
      content.includes('href="index.html"') || content.includes("href='index.html'"),
      `${file} 缺少回首頁連結`
    );
  });
});

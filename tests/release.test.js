const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const bumpScriptPath = path.join(projectRoot, '.agents', 'skills', 'release', 'scripts', 'bump-version.js');
const skillDocPath = path.join(projectRoot, '.agents', 'skills', 'release', 'SKILL.md');

test('發版技能文件 SKILL.md 存在且具備正確 Frontmatter', () => {
  assert.ok(fs.existsSync(skillDocPath), '找不到 release/SKILL.md');
  const content = fs.readFileSync(skillDocPath, 'utf8');
  assert.match(content, /^---\s*[\r\n]+name:\s*release[\r\n]+/);
  assert.match(content, /description:/);
  assert.match(content, /ask_question/);
});

test('發版輔助腳本 bump-version.js 存在且可執行', () => {
  assert.ok(fs.existsSync(bumpScriptPath), '找不到 bump-version.js');
});

test('bump-version.js --get-current 可正確讀取 package.json 版本', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const stdout = execSync(`node "${bumpScriptPath}" --get-current`, { cwd: projectRoot, encoding: 'utf8' }).trim();
  assert.equal(stdout, pkg.version);
});

test('bump-version.js --suggest 輸出符合 SemVer 規範', () => {
  const stdout = execSync(`node "${bumpScriptPath}" --suggest`, { cwd: projectRoot, encoding: 'utf8' }).trim();
  const suggestions = JSON.parse(stdout);
  assert.ok(suggestions.current);
  assert.ok(suggestions.patch);
  assert.ok(suggestions.minor);
  assert.ok(suggestions.major);

  const [major, minor, patch] = suggestions.current.split('.').map(Number);
  assert.equal(suggestions.patch, `${major}.${minor}.${patch + 1}`);
  assert.equal(suggestions.minor, `${major}.${minor + 1}.0`);
  assert.equal(suggestions.major, `${major + 1}.0.0`);
});

test('bump-version.js --dry-run 模擬執行不影響實體檔案', () => {
  const pkgBefore = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
  const htmlBefore = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

  execSync(`node "${bumpScriptPath}" 9.9.9 --dry-run`, { cwd: projectRoot, encoding: 'utf8' });

  const pkgAfter = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
  const htmlAfter = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

  assert.equal(pkgBefore, pkgAfter);
  assert.equal(htmlBefore, htmlAfter);
});

test('專案內 package.json、package-lock.json 與 index.html 版本號保持一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

  if (fs.existsSync(path.join(projectRoot, 'package-lock.json'))) {
    const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, pkg.version, 'package-lock.json 與 package.json 版本不一致');
  }

  const footerMatch = html.match(/<footer\b[^>]*>[\s\S]*?v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)[\s\S]*?<\/footer>/i);
  assert.ok(footerMatch, 'index.html 缺少 footer 版本號');
  assert.equal(footerMatch[1], pkg.version, 'index.html 與 package.json 版本不一致');
});

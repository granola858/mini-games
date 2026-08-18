/**
 * 版本號更新輔助腳本
 * 用途：安全同步更新 package.json, package-lock.json, index.html 中的版本號
 * 使用方式：
 *   node bump-version.js <new-version> [--dry-run]
 *   node bump-version.js --get-current
 *   node bump-version.js --suggest
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '../../../..');
const packageJsonPath = path.join(projectRoot, 'package.json');
const packageLockJsonPath = path.join(projectRoot, 'package-lock.json');
const indexHtmlPath = path.join(projectRoot, 'index.html');

function getCurrentVersion() {
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`找不到 package.json: ${packageJsonPath}`);
  }
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return pkg.version;
}

function parseSemVer(version) {
  const clean = version.trim().replace(/^v/, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) {
    throw new Error(`無效的語意化版本號格式: "${version}" (範例: 1.13.0 或 v1.13.0)`);
  }
  return {
    raw: clean,
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
    prerelease: match[4] || ''
  };
}

function getSuggestions(currentVer) {
  const parsed = parseSemVer(currentVer);
  return {
    current: parsed.raw,
    patch: `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`,
    minor: `${parsed.major}.${parsed.minor + 1}.0`,
    major: `${parsed.major + 1}.0.0`
  };
}

function bumpVersion(targetVersion, isDryRun = false) {
  const parsed = parseSemVer(targetVersion);
  const newVer = parsed.raw;
  const currentVer = getCurrentVersion();

  console.log(`[Release] 當前版本: v${currentVer} -> 目標版本: v${newVer} ${isDryRun ? '(DRY-RUN 模擬執行)' : ''}`);

  // 1. 更新 package.json
  const pkgContent = fs.readFileSync(packageJsonPath, 'utf8');
  const pkg = JSON.parse(pkgContent);
  pkg.version = newVer;
  const updatedPkgContent = JSON.stringify(pkg, null, 2) + '\n';

  // 2. 更新 package-lock.json (若存在)
  let updatedLockContent = null;
  if (fs.existsSync(packageLockJsonPath)) {
    const lockContent = fs.readFileSync(packageLockJsonPath, 'utf8');
    const lock = JSON.parse(lockContent);
    lock.version = newVer;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = newVer;
    }
    updatedLockContent = JSON.stringify(lock, null, 2) + '\n';
  }

  // 3. 更新 index.html 中的 footer 版本號
  let updatedHtmlContent = null;
  if (fs.existsSync(indexHtmlPath)) {
    const htmlContent = fs.readFileSync(indexHtmlPath, 'utf8');
    // 匹配 <footer>...vX.Y.Z...</footer>
    const footerRegex = /(<footer\b[^>]*>[\s\S]*?v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)([\s\S]*?<\/footer>)/i;
    if (footerRegex.test(htmlContent)) {
      updatedHtmlContent = htmlContent.replace(footerRegex, `$1${newVer}$3`);
    } else {
      console.warn(`[Release] 警告: 未在 index.html 找到符合格式的 <footer> 版本標籤`);
    }
  }

  if (isDryRun) {
    console.log(`[DRY-RUN] package.json 版本更新為: ${newVer}`);
    if (updatedLockContent) console.log(`[DRY-RUN] package-lock.json 版本更新為: ${newVer}`);
    if (updatedHtmlContent) console.log(`[DRY-RUN] index.html footer 版本更新為: v${newVer}`);
    return { currentVer, newVer, success: true };
  }

  // 實際寫入檔案
  fs.writeFileSync(packageJsonPath, updatedPkgContent, 'utf8');
  console.log(`✓ 已更新 package.json -> v${newVer}`);

  if (updatedLockContent) {
    fs.writeFileSync(packageLockJsonPath, updatedLockContent, 'utf8');
    console.log(`✓ 已更新 package-lock.json -> v${newVer}`);
  }

  if (updatedHtmlContent) {
    fs.writeFileSync(indexHtmlPath, updatedHtmlContent, 'utf8');
    console.log(`✓ 已更新 index.html -> v${newVer}`);
  }

  return { currentVer, newVer, success: true };
}

// 命令列執行入口
const args = process.argv.slice(2);

if (args.includes('--get-current')) {
  console.log(getCurrentVersion());
  process.exit(0);
}

if (args.includes('--suggest')) {
  const current = getCurrentVersion();
  const suggestions = getSuggestions(current);
  console.log(JSON.stringify(suggestions, null, 2));
  process.exit(0);
}

const targetArg = args.find(a => !a.startsWith('--'));
const isDryRun = args.includes('--dry-run');

if (!targetArg) {
  console.error('請提供目標版本號！例如: node bump-version.js 1.13.0');
  process.exit(1);
}

try {
  bumpVersion(targetArg, isDryRun);
} catch (err) {
  console.error(`[錯誤] ${err.message}`);
  process.exit(1);
}

// 貓咪數獨的手勢與扣心規則回歸測試：開真的 Chrome、用 CDP 發觸控事件。
// 執行：npm run test:meowdoku-browser
import assert from 'node:assert/strict';
import { Driver } from '../.claude/skills/run-mini-games/driver.mjs';

const driver = new Driver({ quiet: true });
const gamePath = '/games/meowdoku/';
const cell = (r, c) => `.cell[data-r="${r}"][data-c="${c}"]`;

async function tap(selector, settle = 60) {
  const { x, y } = await driver.rect(selector);
  await driver.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await driver.s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await driver.sleep(settle);
}

// 連點兩下：只量一次座標，兩下之間不做其他 CDP 往返，確保落在 280 ms 的雙擊時間窗內
async function doubleTap(selector) {
  const { x, y } = await driver.rect(selector);
  for (let i = 0; i < 2; i++) {
    await driver.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await driver.s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    if (i === 0) await driver.sleep(30);
  }
  await driver.sleep(60);
}

function cellState(r, c) {
  return driver.eval(`(() => {
    const s = getState(currentSize);
    return { ...s.cellStates[${r}][${c}], lives: s.lives, status: s.status };
  })()`);
}

// 找一格「不是答案、也和已放的貓沒有衝突」的格子
function findFreeWrongCell(exclude = []) {
  return driver.eval(`(() => {
    const s = getState(currentSize);
    const skip = new Set(${JSON.stringify(exclude.map(([r, c]) => `${r}-${c}`))});
    for (let r = 0; r < s.size; r++) for (let c = 0; c < s.size; c++) {
      const cs = s.cellStates[r][c];
      if (s.solution[r][c] === 1 || cs.cat || cs.miss || skip.has(r + '-' + c)) continue;
      if (!findCatConflict(s, r, c)) return [r, c];
    }
    return null;
  })()`);
}

function assertNoErrors() {
  assert.deepEqual(driver.errors, [], `頁面出現錯誤：\n${driver.errors.join('\n')}`);
}

try {
  await driver.start();
  await driver.s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await driver.goto(gamePath);
  await driver.eval(`(() => {
    Object.keys(localStorage).filter(k => k.startsWith('meowdoku')).forEach(k => localStorage.removeItem(k));
    localStorage.setItem('meowdoku-tool-v1', 'paw');
    localStorage.setItem('meowdoku-sound-v1', 'false');
  })()`);
  await driver.goto(gamePath);

  // 先放一隻正確的貓咪 S，之後的衝突判斷都以牠為準
  const S = await driver.eval(`(() => {
    const s = getState(currentSize);
    for (let r = 0; r < s.size; r++) for (let c = 0; c < s.size; c++) {
      if (s.solution[r][c] === 1) { placeCat(s, r, c); return [r, c]; }
    }
  })()`);
  assert.equal((await cellState(...S)).cat, true);

  // 1. 貓爪工具：擦掉貓爪後快速再點，只會把貓爪補回來，不會變成放貓扣心
  const X = await findFreeWrongCell();
  assert.ok(X, '找不到可測試的空格');
  await tap(cell(...X));
  assert.equal((await cellState(...X)).paw, true, '點一下應該畫上貓爪');
  await driver.sleep(400);
  await doubleTap(cell(...X));
  let x = await cellState(...X);
  assert.equal(x.paw, true, '擦掉後快速再點應該只是補回貓爪');
  assert.equal(x.cat, false);
  assert.equal(x.lives, 3, '擦貓爪後的快速連點不該扣心');
  console.log('PASS 擦掉貓爪後快速再點不會放貓');
  await driver.sleep(400);

  // 對照組：空格上快速點兩下仍然會放貓（雙擊捷徑還在，上一段才不是假通過）
  const U = await driver.eval(`(() => {
    const s = getState(currentSize);
    for (let r = 0; r < s.size; r++) for (let c = 0; c < s.size; c++) {
      if (s.solution[r][c] === 1 && !s.cellStates[r][c].cat) return [r, c];
    }
  })()`);
  await doubleTap(cell(...U));
  assert.equal((await cellState(...U)).cat, true, '空格快速點兩下應該放貓');
  console.log('PASS 空格雙擊仍可放貓');
  await driver.sleep(400);

  // 2. 放貓工具點到標了貓爪的格子：先擦掉貓爪，不放貓、不扣心
  await driver.click('.tool-btn[data-tool="cat"]');
  await tap(cell(...X));
  x = await cellState(...X);
  assert.equal(x.paw, false, '放貓工具應該先擦掉貓爪');
  assert.equal(x.cat, false);
  assert.equal(x.miss, false);
  assert.equal(x.lives, 3, '擦貓爪不該扣心');
  console.log('PASS 放貓工具點到貓爪格只擦掉貓爪');

  // 3. 和 S 同一列（不相鄰）的格子：只提醒、不扣心、不打叉，並指出擋住的那隻貓
  const Y = [S[0], S[1] >= 2 ? 0 : S[1] + 2];
  await tap(cell(...Y));
  const y = await cellState(...Y);
  assert.equal(y.lives, 3, '明顯衝突不該扣心');
  assert.equal(y.cat, false);
  assert.equal(y.miss, false);
  // 盤面上已有兩隻貓，擋住 Y 的可能是 S 以外的那隻：以遊戲判定的那一隻為準
  const conflict = await driver.eval(`findCatConflict(getState(currentSize), ${Y[0]}, ${Y[1]})`);
  assert.ok(conflict, 'Y 應該和已放的貓衝突');
  assert.equal(await driver.text('#toast'), await driver.eval(`CONFLICT_MESSAGES['${conflict.reason}']`));
  assert.equal(await driver.eval(`document.querySelector('${cell(conflict.r, conflict.c)}').classList.contains('conflict-source')`), true);
  console.log('PASS 明顯衝突只提醒、不扣心，並指出擋住的貓');

  // 4. 沒有明顯衝突的錯誤位置：扣 1 顆心，留下叉叉；再點同一格不會再扣
  // （放了對照組的貓之後 X 可能變成衝突格，所以重新挑一格）
  const M = await findFreeWrongCell();
  assert.ok(M, '找不到沒有衝突的錯誤格');
  await tap(cell(...M));
  x = await cellState(...M);
  assert.equal(x.lives, 2, '放錯應該扣 1 顆心');
  assert.equal(x.miss, true, '放錯的格子應該打叉');
  assert.equal(await driver.eval(`document.querySelector('${cell(...M)}').dataset.miss`), 'true');
  await driver.sleep(300);
  await tap(cell(...M));
  assert.equal((await cellState(...M)).lives, 2, '打叉的格子再點不該再扣心');
  console.log('PASS 放錯扣心並留下叉叉，同一格不會再扣');

  // 5. 貓爪工具碰不到打叉的格子
  await driver.click('.tool-btn[data-tool="paw"]');
  await tap(cell(...M));
  x = await cellState(...M);
  assert.equal(x.paw, false);
  assert.equal(x.miss, true);
  console.log('PASS 貓爪畫不上打叉的格子');

  // 6. 放對貓咪時播報給螢幕閱讀器
  await driver.click('.tool-btn[data-tool="cat"]');
  const T = await driver.eval(`(() => {
    const s = getState(currentSize);
    for (let r = 0; r < s.size; r++) for (let c = 0; c < s.size; c++) {
      if (s.solution[r][c] === 1 && !s.cellStates[r][c].cat) return [r, c];
    }
  })()`);
  await tap(cell(...T), 200);
  assert.equal((await cellState(...T)).cat, true);
  assert.match(await driver.text('#srStatus'), /放對了，還差 \d+ 隻貓/);
  console.log('PASS 放對時播報剩幾隻');

  // 7. 清空標記只擦貓爪，貓咪與叉叉留著；重新整理後仍在
  await driver.click('.tool-btn[data-tool="paw"]');
  const Z = await findFreeWrongCell([M]);
  await tap(cell(...Z));
  assert.equal((await cellState(...Z)).paw, true);
  assert.equal(await driver.eval(`document.getElementById('clearBtn').disabled`), false);
  await driver.click('#clearBtn');
  await driver.wait('#confirmOverlay[open]');
  await driver.click('#confirmOkBtn');
  await driver.sleep(150);
  assert.equal((await cellState(...Z)).paw, false, '貓爪應該被擦掉');
  assert.equal((await cellState(...S)).cat, true, '放對的貓咪要留著');
  assert.equal((await cellState(...M)).miss, true, '叉叉要留著');
  assert.equal(await driver.eval(`document.getElementById('clearBtn').disabled`), true, '沒有貓爪時清空標記應停用');
  await driver.goto(gamePath);
  assert.equal((await cellState(...M)).miss, true, '叉叉要存進存檔');
  assert.equal((await cellState(...S)).cat, true);
  console.log('PASS 清空標記只擦貓爪，叉叉會存檔');

  // 8. 輸掉後「清空標記」變成「再試這題」，關掉結果卡片也能重玩同一題
  await driver.eval(`(() => { const s = getState(currentSize); s.lives = 1; updateLives(1); })()`);
  await driver.click('.tool-btn[data-tool="cat"]');
  const W = await findFreeWrongCell();
  await tap(cell(...W));
  assert.equal((await cellState(...W)).status, 'lost');
  await driver.wait('dialog.bobo-result[open]');
  await driver.key('Escape');
  await driver.sleep(200);
  assert.equal((await driver.text('#clearBtn')).trim(), '再試這題');
  assert.equal(await driver.eval(`document.getElementById('clearBtn').disabled`), false);
  const solutionBefore = await driver.eval(`JSON.stringify(getState(currentSize).solution)`);
  await driver.click('#clearBtn');
  await driver.sleep(150);
  const after = await driver.eval(`(() => {
    const s = getState(currentSize);
    return { status: s.status, lives: s.lives, solution: JSON.stringify(s.solution),
      marks: s.cellStates.flat().filter(c => c.cat || c.paw || c.miss).length };
  })()`);
  assert.equal(after.status, 'playing');
  assert.equal(after.lives, 3);
  assert.equal(after.solution, solutionBefore, '應該是同一題');
  assert.equal(after.marks, 0);
  assert.equal((await driver.text('#clearBtn')).trim(), '清空標記');
  console.log('PASS 輸掉後可用「再試這題」重玩同一題');

  assertNoErrors();
} finally {
  await driver.stop();
}

import assert from 'node:assert/strict';
import Core from '../games/watermelon-chess/watermelon-chess-core.js';
import { Driver } from '../.claude/skills/run-mini-games/driver.mjs';

const driver = new Driver({ quiet: true });
const gamePath = '/games/watermelon-chess/';
const saveKey = 'watermelon_chess_save_v1';
const prefKey = 'watermelon_chess_pref_v1';
const statsKey = 'watermelon_chess_stats_v1';
const localSettings = { mode: 'local', difficulty: 'normal', human: 1 };
const shots = '.claude\\skills\\run-mini-games\\_shots\\';

async function loadGame(game = Core.createGame(localSettings), selected = null) {
  await driver.eval(`localStorage.setItem(${JSON.stringify(saveKey)}, ${JSON.stringify(JSON.stringify(Core.serialize(game, selected)))})`);
  await driver.goto(gamePath);
}

async function savedGame() {
  return driver.eval(`JSON.parse(localStorage.getItem('${saveKey}'))`);
}

async function tap(selector) {
  const { x, y } = await driver.rect(selector);
  await driver.s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await driver.s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await driver.sleep(80);
}

async function enter() {
  // CDP needs carriage-return text to activate a native button, not only keyCode 13.
  await driver.s('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r'
  });
  await driver.s('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13
  });
}

async function setForm(settings) {
  await driver.eval(`(() => {
    document.getElementById('mode').value = '${settings.mode}';
    document.getElementById('mode').dispatchEvent(new Event('change'));
    document.getElementById('difficulty').value = '${settings.difficulty}';
    document.getElementById('human').value = '${settings.human}';
  })()`);
}

function completeMatch(seed) {
  let game = Core.createGame();
  let value = seed;
  for (let i = 0; i < 250 && Core.current(game).status === 'active'; i++) {
    const move = Core.chooseMove(game, 'easy', {
      random: () => { value = value * 16807 % 2147483647; return value / 2147483647; }
    });
    game = Core.playMove(game, move.from, move.to);
  }
  assert.equal(Core.current(game).status, 'finished');
  return game;
}

function beforeLast(game, settings = game.settings) {
  return {
    settings, moves: game.moves.slice(0, -1), history: game.history.slice(0, -1)
  };
}

async function play(move, touch = false) {
  const press = touch ? tap : selector => driver.click(selector);
  await press('#point-' + move.from);
  await press('#point-' + move.to);
}

function assertNoErrors() {
  assert.deepEqual(driver.errors, [], driver.errors.join('\n'));
}

try {
  await driver.start();
  await driver.theme('light');
  await driver.goto(gamePath);
  assert.equal(await driver.count('#board button'), 21);
  assert.equal(await driver.count('#board .has-piece'), 12);

  for (const [width, height] of [[320, 568], [375, 812], [768, 1024], [1280, 900], [812, 375]]) {
    await driver.s('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 850
    });
    for (const theme of ['light', 'dark']) {
      await driver.eval(`localStorage.removeItem('bobo-home-preferences-v2')`);
      await driver.theme(theme);
      await loadGame();
      await driver.click('#point-12');
      const layout = await driver.eval(`(() => {
        const nodes = [...document.querySelectorAll('.point')].map(e => {
          const r = e.getBoundingClientRect();
          return { width: r.width, x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        return {
          width: innerWidth, pageWidth: document.documentElement.scrollWidth,
          theme: document.documentElement.dataset.theme, nodes,
          legal: document.querySelectorAll('.is-legal').length
        };
      })()`);
      assert.equal(layout.theme, theme);
      assert.ok(layout.pageWidth <= width, `${width}/${theme}: horizontal overflow`);
      assert.equal(layout.legal, 1);
      if (width >= 375) assert.ok(layout.nodes.every(node => node.width >= 44), `${width}: touch target <44px`);
      for (let i = 0; i < layout.nodes.length; i++) {
        for (let j = i + 1; j < layout.nodes.length; j++) {
          const a = layout.nodes[i];
          const b = layout.nodes[j];
          assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.width - .2, 'overlapping circular hit targets');
        }
      }
      if (width === 375 || (width === 1280 && theme === 'light')) {
        await driver.screenshot(shots + 'watermelon-chess-' + width + '-' + theme + '.png');
      }
      assertNoErrors();
    }
    console.log(`PASS ${width}x${height}: both themes, all 21 points, no horizontal overflow/overlapping targets`);
  }

  await driver.s('Emulation.setDeviceMetricsOverride', {
    width: 375, height: 812, deviceScaleFactor: 1, mobile: true
  });
  await driver.s('Emulation.setTouchEmulationEnabled', { enabled: true });
  await loadGame();
  await tap('#point-12');
  assert.equal((await savedGame()).selected, 12);
  await tap('#point-6');
  assert.equal((await savedGame()).moves.length, 0);
  await driver.goto(gamePath);
  assert.equal(await driver.eval(`document.getElementById('point-12').getAttribute('aria-pressed')`), 'true');
  await tap('#point-16');
  assert.equal((await savedGame()).moves.length, 1);
  assert.equal(await driver.text('#move-count'), '1');
  assert.equal(await driver.eval(`document.getElementById('point-12').classList.contains('is-from')`), true);
  await play({ from: 14, to: 18 }, true);
  assert.equal((await savedGame()).moves.length, 2);
  await driver.click('#undo-button');
  assert.equal((await savedGame()).moves.length, 1);
  await driver.goto(gamePath);
  assert.equal(await driver.text('#move-count'), '1');
  await driver.click('#undo-button');
  assert.equal((await savedGame()).moves.length, 0);
  await driver.eval(`document.getElementById('point-12').focus()`);
  await enter();
  await driver.key('ArrowDown');
  assert.equal(await driver.eval('document.activeElement.id'), 'point-16');
  await enter();
  assert.equal((await savedGame()).moves.length, 1);
  console.log('PASS real touch, invalid moves, selected-piece restore, local undo and keyboard');

  const pos = id => driver.eval(`(() => {
    const b = document.getElementById('board').getBoundingClientRect();
    const r = document.getElementById('${id}').getBoundingClientRect();
    return { x: r.x - b.x, y: r.y - b.y };
  })()`);
  const top = await pos('point-0');
  const bottom = await pos('point-6');
  await driver.click('#rotate-button');
  assert.equal(await driver.eval(`document.getElementById('rotate-button').getAttribute('aria-pressed')`), 'true');
  assert.equal(await driver.eval(`localStorage.getItem('watermelon_chess_rotated')`), 'true');
  await driver.sleep(500);
  const rotatedTop = await pos('point-0');
  assert.ok(Math.abs(rotatedTop.y - bottom.y) < 1 && Math.abs(rotatedTop.x - bottom.x) < 1, 'point 0 moves to the bottom');
  await driver.goto(gamePath);
  assert.equal(await driver.eval(`document.getElementById('rotate-button').getAttribute('aria-pressed')`), 'true');
  assert.ok(Math.abs((await pos('point-0')).y - bottom.y) < 1, 'rotation persists after reload');
  await driver.eval(`document.getElementById('point-16').focus()`);
  await driver.key('ArrowDown');
  assert.equal(await driver.eval('document.activeElement.id'), 'point-12', 'arrow keys follow the rotated layout');
  await driver.screenshot(shots + 'watermelon-chess-rotated.png');
  await driver.click('#rotate-button');
  await driver.sleep(500);
  assert.ok(Math.abs((await pos('point-0')).y - top.y) < 1);
  console.log('PASS 180° rotation, persistence and rotated keyboard navigation');

  await driver.click('#again-button');
  assert.equal(await driver.eval(`document.getElementById('confirm-dialog').open`), true);
  await driver.click('#cancel-new');
  assert.equal((await savedGame()).moves.length, 1);
  await setForm({ mode: 'ai', difficulty: 'hard', human: -1 });
  await driver.click('#settings-form button[type="submit"]');
  await driver.click('#confirm-new');
  await driver.wait('#board[aria-busy="false"]');
  assert.equal((await savedGame()).moves.length, 1);
  assert.match(await driver.text('#match-tag'), /困難/);
  assert.equal(await driver.eval(`document.getElementById('undo-button').disabled`), true);
  const aiOpened = Core.restore(await savedGame()).game;
  const humanMove = Core.legalMoves(Core.current(aiOpened).board, -1)[0];
  await play(humanMove, true);
  await driver.click('#undo-button');
  assert.equal((await savedGame()).moves.length, 1, 'undo cancels a pending AI timer');
  await driver.sleep(450);
  assert.equal((await savedGame()).moves.length, 1, 'cancelled AI must not move later');
  await play(humanMove);
  await driver.wait('#board[aria-busy="false"]');
  assert.equal((await savedGame()).moves.length, 3);
  await driver.click('#undo-button');
  assert.equal((await savedGame()).moves.length, 1);
  assert.deepEqual(Core.current(Core.restore(await savedGame()).game).board, Core.current(aiOpened).board);
  console.log('PASS new-game confirmation, hard AI opening, pending/replied AI undo');

  await driver.click('#rules-button');
  assert.match(await driver.text('#demo-copy'), /一口氣/);
  await driver.click('#demo-next');
  assert.equal(await driver.eval(`document.getElementById('demo-target').classList.contains('is-filled')`), true);
  await driver.click('#demo-next');
  assert.equal(await driver.eval(`document.getElementById('demo-victim').classList.contains('is-captured')`), true);
  await driver.s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await driver.eval(`getComputedStyle(document.getElementById('demo-victim')).transitionDuration`), '0s');
  await driver.screenshot(shots + 'watermelon-chess-rules.png');
  await driver.key('Escape');
  assert.equal(await driver.eval(`document.getElementById('rules-dialog').open`), false);
  await driver.eval(`localStorage.setItem('bobo-home-preferences-v2', JSON.stringify({ theme: 'light', order: ['pair'], hidden: ['slap'] }))`);
  await driver.click('#theme-button');
  const homePrefs = await driver.eval(`JSON.parse(localStorage.getItem('bobo-home-preferences-v2'))`);
  assert.deepEqual(homePrefs.order, ['pair']);
  assert.deepEqual(homePrefs.hidden, ['slap']);
  await driver.click('#sound-button');
  await driver.goto(gamePath);
  assert.equal(await driver.eval(`document.getElementById('sound-button').getAttribute('aria-pressed')`), 'false');
  console.log('PASS rules demo, modal keyboard dismissal, reduced motion, theme merge and sound persistence');

  const draw = Core.createGame(localSettings);
  let repeated = draw;
  for (const [from, to] of [[12, 16], [14, 18], [16, 12], [18, 14], [12, 16], [14, 18], [16, 12], [18, 14]]) {
    repeated = Core.playMove(repeated, from, to);
  }
  await loadGame(beforeLast(repeated, localSettings));
  await play(repeated.moves.at(-1), true);
  assert.match(await driver.text('#turn-status'), /平手/);
  assert.equal(Core.current(Core.restore(await savedGame()).game).status, 'finished', 'finished game stays saved');
  assert.equal(await driver.eval(`document.getElementById('undo-button').disabled`), true);
  const afterDraw = await driver.eval(`JSON.parse(localStorage.getItem('${statsKey}'))`);
  assert.equal(afterDraw.localGames, 1);
  await driver.goto(gamePath);
  assert.match(await driver.text('#turn-status'), /平手/, 'finished board restored after reload');
  assert.equal(await driver.text('#again-button'), '再來一局');
  assert.equal(await driver.eval(`JSON.parse(localStorage.getItem('${statsKey}')).localGames`), 1);

  const winningMatch = completeMatch(2);
  assert.equal(Core.current(winningMatch).reason, 'capture');
  const winner = Core.current(winningMatch).winner;
  await loadGame(beforeLast(winningMatch, { mode: 'ai', difficulty: 'normal', human: winner }));
  await play(winningMatch.moves.at(-1));
  assert.match(await driver.text('#turn-status'), /你獲勝/);
  assert.equal(await driver.eval(`JSON.parse(localStorage.getItem('${statsKey}')).wins`), 1);
  assert.equal(Core.current(Core.restore(await savedGame()).game).status, 'finished');
  await driver.goto(gamePath);
  assert.match(await driver.text('#turn-status'), /你獲勝/);
  assert.equal(await driver.eval(`JSON.parse(localStorage.getItem('${statsKey}')).wins`), 1);
  await driver.click('#again-button');
  assert.equal(await driver.eval(`document.getElementById('confirm-dialog').open`), false);
  assert.equal((await savedGame()).moves.length, 0, 'new game replaces finished save');
  await loadGame(beforeLast(winningMatch, { mode: 'ai', difficulty: 'normal', human: -winner }));
  await driver.wait('#turn-status.is-finished');
  assert.match(await driver.text('#turn-status'), /電腦獲勝/);
  assert.equal(await driver.eval(`JSON.parse(localStorage.getItem('${statsKey}')).losses`), 1);
  console.log('PASS full legal-match fixtures: draw, capture victory/defeat, stats, cleared saves, no double count');
  assertNoErrors();

  await driver.eval(`localStorage.setItem('${saveKey}', '{"broken":');`);
  await driver.goto(gamePath);
  assert.equal(await driver.eval(`document.getElementById('storage-notice').hidden`), false);
  assert.equal(await driver.count('.has-piece'), 12);
  const { identifier } = await driver.s('Page.addScriptToEvaluateOnNewDocument', {
    source: `for (const name of ['getItem', 'setItem', 'removeItem']) {
      Storage.prototype[name] = function () { throw new DOMException('Storage denied', 'SecurityError'); };
    }`
  });
  await driver.goto(gamePath);
  assert.equal(await driver.eval(`document.getElementById('storage-notice').hidden`), false);
  await play({ from: 12, to: 16 });
  assert.equal(await driver.text('#move-count'), '1');
  await driver.wait('#board[aria-busy="false"]');
  assertNoErrors();
  await driver.s('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  await driver.goto('/index.html');
  assert.equal(await driver.count('a[href="games/watermelon-chess/index.html"]'), 1);
  assertNoErrors();
  console.log('PASS corrupt/denied storage stays playable with visible warnings; homepage entry exists');
} finally {
  await driver.stop();
}

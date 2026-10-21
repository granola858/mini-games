import assert from 'node:assert/strict';
import { Driver } from '../.claude/skills/run-mini-games/driver.mjs';

const driver = new Driver({ quiet: true });
const gamePath = '/games/nine-nine/';

async function loadFixture(playerCount, value = 90, blocked = false) {
  await driver.goto(gamePath);
  await driver.eval(`(() => {
    const game = NineNineCore.createGame({ playerCount: ${playerCount} });
    const cards = NineNineCore.createDeck();
    const ranks = ${JSON.stringify(blocked ? ['A', '2', '3', '6', '7'] : ['A', '2', '10', 'Q', '5'])};
    game.players[0].hand = ranks.map(rank => cards.splice(cards.findIndex(card => card.rank === rank), 1)[0]);
    game.players.slice(1).forEach(player => { player.hand = cards.splice(0, 5); });
    game.drawPile = cards;
    game.currentValue = ${value};
    game.history = ['4', 'A', '10', 'J', 'K'].map((rank, index) => ({
      playerId: 'p' + (index % game.playerCount),
      card: NineNineCore.createDeck().find(card => card.rank === rank),
      choice: rank === '10' ? 'minus' : null,
      targetId: null,
      value: [10, 11, 1, 1, 99][index]
    }));
    game.lastAction = game.history.at(-1);
    game.turnNumber = 5;
    if (!NineNineCore.normalizeGame(game)) throw new Error('Invalid browser fixture');
    localStorage.setItem('nine_nine_save_v1', JSON.stringify({ game, recordedMatchId: null }));
  })()`);
  await driver.goto(gamePath);
  await driver.click('#resume-button');
}

async function assertSingleScreen(label) {
  const layout = await driver.eval(`(() => {
    const rows = selector => [...document.querySelectorAll(selector)]
      .map(element => element.offsetTop);
    const panel = document.getElementById('game-panel').getBoundingClientRect();
    const controls = [...document.querySelectorAll('#game-panel button:not(:disabled)')]
      .filter(element => element.getClientRects().length)
      .map(element => ({ id: element.id, bottom: element.getBoundingClientRect().bottom }));
    return {
      width: innerWidth, height: innerHeight,
      pageWidth: document.documentElement.scrollWidth,
      pageHeight: document.documentElement.scrollHeight,
      panelBottom: panel.bottom + scrollY,
      scrollY,
      playerRows: rows('.player-tile'),
      handRows: document.getElementById('hand-panel').hidden ? [] : rows('#hand button'),
      controls
    };
  })()`);
  assert.ok(layout.pageWidth <= layout.width + 1, `${label}: horizontal overflow ${JSON.stringify(layout)}`);
  assert.ok(layout.pageHeight <= layout.height + 1, `${label}: page needs scrolling ${JSON.stringify(layout)}`);
  assert.ok(layout.panelBottom <= layout.height + 1, `${label}: game extends below screen`);
  assert.equal(layout.scrollY, 0, `${label}: browser scrolled to reach a control`);
  assert.equal(new Set(layout.playerRows).size, 1, `${label}: players wrap to a second row`);
  assert.ok(new Set(layout.handRows).size <= 1, `${label}: hand wraps to a second row`);
  for (const control of layout.controls) {
    assert.ok(control.bottom <= layout.height + 1, `${label}: control is off screen: ${control.id}`);
  }
}

try {
  await driver.start();
  const viewports = [[320, 568], [346, 750], [390, 664], [768, 1024], [1280, 720], [740, 360], [568, 320]];
  for (const [width, height] of viewports) {
    await driver.s('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 800
    });
    for (const theme of ['light', 'dark']) {
      await driver.goto(gamePath);
      await driver.eval(`localStorage.removeItem('bobo-home-preferences-v2')`);
      await driver.theme(theme);
      for (const count of [2, 3, 4]) {
        await loadFixture(count);
        await assertSingleScreen(`${width}x${height}/${count} seats/${theme}`);
        await driver.click('#hand [data-card-id$="-Q"]');
        await assertSingleScreen(`${width}x${height}/${count} seats/${theme}/Q choices`);
        const options = await driver.eval(`Array.from(document.querySelectorAll('#move-options button'),
          element => ({ text: element.textContent, disabled: element.disabled }))`);
        assert.deepEqual(options.map(option => option.disabled), [true, false]);
        assert.match(options[0].text, /爆點/);
        assert.match(options[1].text, /70/);
        const history = await driver.eval(`Array.from(document.querySelectorAll('.history-card'),
          element => ({ owner: element.querySelector('.history-owner').textContent, label: element.getAttribute('aria-label') }))`);
        assert.equal(history.length, 5);
        history.forEach((entry, index) => {
          assert.equal(entry.owner, index % count === 0 ? '你' : '電腦 ' + index % count);
          assert.match(entry.label, /出了/);
        });
        if (count > 2) {
          await driver.click('#hand [data-card-id$="-5"]');
          assert.equal(await driver.count('#move-options button'), count - 1);
          await assertSingleScreen(`${width}x${height}/${count} seats/${theme}/target choices`);
        }
        await driver.eval(`document.getElementById('status-line').textContent = '你 出了 K♠ · 點數加到 99；電腦 1、電腦 2 無牌可出，已淘汰'`);
        await assertSingleScreen(`${width}x${height}/${count} seats/${theme}/elimination announcement`);
        assert.equal(driver.errors.length, 0, driver.errors.join('\n'));
      }
    }
    console.log(`PASS ${width}x${height}: 2–4 seats, both themes, five-card history, Q choices, no scrolling`);
  }

  await driver.s('Emulation.setDeviceMetricsOverride', {
    width: 346, height: 750, deviceScaleFactor: 1, mobile: true
  });
  await loadFixture(3, 99);
  assert.equal(await driver.eval(`document.querySelector('#hand [data-card-id$="-A"]').disabled`), true);
  assert.equal(await driver.eval(`document.querySelector('#hand [data-card-id$="-2"]').disabled`), true);
  await driver.click('#hand [data-card-id$="-10"]');
  assert.deepEqual(await driver.eval(`Array.from(document.querySelectorAll('#move-options button'), e => e.disabled)`), [true, false]);
  await driver.click('#move-options button:not(:disabled)');
  assert.equal(await driver.eval(`JSON.parse(localStorage.getItem('nine_nine_save_v1')).game.currentValue`), 89);
  const playedHistory = await driver.eval(`JSON.parse(localStorage.getItem('nine_nine_save_v1')).game.history`);
  assert.equal(playedHistory.length, 5);
  assert.equal(playedHistory.at(-1).playerId, 'p0');
  assert.equal(playedHistory.at(-1).card.rank, '10');
  await driver.eval(`window.confirm = () => true`);
  await driver.click('#new-game-button');
  await driver.goto(gamePath);
  await driver.click('#resume-button');
  assert.deepEqual(await driver.eval(`JSON.parse(localStorage.getItem('nine_nine_save_v1')).game.history`), playedHistory);

  await driver.click('#rules-button');
  assert.equal(await driver.eval(`document.getElementById('rules-dialog').open`), true);
  await driver.key('Escape');
  assert.equal(await driver.eval(`document.getElementById('rules-dialog').open`), false);

  for (const [width, height] of [[320, 568], [346, 750], [740, 360], [568, 320]]) {
    await driver.s('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: true
    });
    await loadFixture(2, 99, true);
    assert.equal(await driver.eval(`document.getElementById('result-panel').hidden`), false);
    assert.equal(await driver.text('#current-value'), '99');
    assert.match(await driver.text('#status-line'), /無牌可出/);
    await assertSingleScreen(`${width}x${height}/finished`);
  }
  await driver.s('Emulation.setDeviceMetricsOverride', {
    width: 346, height: 750, deviceScaleFactor: 1, mobile: true
  });
  await loadFixture(3);
  await driver.click('#hand [data-card-id$="-Q"]');
  if (process.env.NINE_NINE_SCREENSHOT) await driver.screenshot(process.env.NINE_NINE_SCREENSHOT);
  assert.equal(driver.errors.length, 0, driver.errors.join('\n'));
  console.log('PASS bust prevention, safe subtraction, history restoration, rules dialog and single-screen results');
} finally {
  await driver.stop();
}

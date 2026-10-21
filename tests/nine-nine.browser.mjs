import assert from 'node:assert/strict';
import { Driver } from '../.claude/skills/run-mini-games/driver.mjs';

const driver = new Driver({ quiet: true });
const gamePath = '/games/nine-nine/';

async function loadFixture(playerCount, value = 70, blocked = false, handSize = 5) {
  await driver.goto(gamePath);
  await driver.eval(`(() => {
    const game = NineNineCore.createGame({ playerCount: ${playerCount}, handSize: ${handSize} });
    const cards = NineNineCore.createDeck();
    const ranks = ${JSON.stringify(blocked
      ? ['hearts-A', '2', '3', '6', '7'].slice(0, handSize)
      : handSize === 4 ? ['spades-A', '2', 'Q', '5'] : ['spades-A', '2', '10', 'Q', '5'])};
    game.players[0].hand = ranks.map(rank => cards.splice(cards.findIndex(card => card.id === rank || card.rank === rank), 1)[0]);
    game.players.slice(1).forEach(player => { player.hand = cards.splice(0, ${handSize}); });
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
        for (const handSize of [4, 5]) {
          await loadFixture(count, 70, false, handSize);
          assert.equal(await driver.count('#hand button'), handSize);
          await assertSingleScreen(`${width}x${height}/${count} seats/${theme}`);
          await driver.click('#hand [data-card-id$="-Q"]');
          await assertSingleScreen(`${width}x${height}/${count} seats/${theme}/Q choices`);
          const options = await driver.eval(`Array.from(document.querySelectorAll('#move-options button'),
            element => ({ text: element.textContent, disabled: element.disabled }))`);
          assert.deepEqual(options.map(option => option.disabled), [false, false]);
          assert.match(options[0].text, /90/);
          assert.match(options[1].text, /50/);
          await driver.click('#hand [data-card-id="spades-A"]');
          const aceOptions = await driver.eval(`Array.from(document.querySelectorAll('#move-options button'), e => e.textContent)`);
          assert.match(aceOptions[0], /\+1 → 71/);
          assert.match(aceOptions[1], /歸零 → 0/);
          await assertSingleScreen(`${width}x${height}/${count} seats/${theme}/Ace choices`);
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
    }
    console.log(`PASS ${width}x${height}: 2–4 seats, 4/5 cards, both themes, history, Ace/Q choices, no scrolling`);
  }

  await driver.s('Emulation.setDeviceMetricsOverride', {
    width: 346, height: 750, deviceScaleFactor: 1, mobile: true
  });
  await loadFixture(3, 99);
  assert.equal(await driver.eval(`document.querySelector('#hand [data-card-id$="-A"]').disabled`), false);
  assert.equal(await driver.eval(`document.querySelector('#hand [data-card-id$="-2"]').disabled`), false);
  await driver.click('#hand [data-card-id$="-10"]');
  assert.equal(await driver.eval(`JSON.parse(localStorage.getItem('nine_nine_save_v1')).game.currentValue`), 89);
  assert.equal(await driver.eval(`document.getElementById('move-options').hidden`), true);
  const playedHistory = await driver.eval(`JSON.parse(localStorage.getItem('nine_nine_save_v1')).game.history`);
  assert.equal(playedHistory.length, 5);
  assert.equal(playedHistory.at(-1).playerId, 'p0');
  assert.equal(playedHistory.at(-1).card.rank, '10');
  await driver.eval(`window.confirm = () => true`);
  await driver.click('#new-game-button');
  await driver.goto(gamePath);
  await driver.click('#resume-button');
  assert.deepEqual(await driver.eval(`JSON.parse(localStorage.getItem('nine_nine_save_v1')).game.history`), playedHistory);

  await loadFixture(3, 99);
  await driver.click('#hand [data-card-id$="-Q"]');
  assert.equal(await driver.eval(`JSON.parse(localStorage.getItem('nine_nine_save_v1')).game.currentValue`), 79);
  assert.equal(await driver.eval(`document.getElementById('move-options').hidden`), true);

  for (const choice of ['plus', 'zero']) {
    await loadFixture(2, 99);
    await driver.click('#hand [data-card-id="spades-A"]');
    assert.equal(await driver.count('#move-options button:not(:disabled)'), 2);
    await driver.click('#move-options button:nth-child(' + (choice === 'plus' ? 1 : 2) + ')');
    const saved = await driver.eval(`JSON.parse(localStorage.getItem('nine_nine_save_v1')).game`);
    assert.equal(saved.history.at(-1).choice, choice);
    assert.equal(saved.currentValue, choice === 'plus' ? 99 : 0);
    assert.equal(saved.players[0].alive, choice !== 'plus');
    if (choice === 'plus') assert.equal(saved.history.at(-1).busted, true);
  }

  await loadFixture(3, 99);
  await driver.click('#hand [data-card-id$="-2"]');
  const penalty = await driver.eval(`JSON.parse(localStorage.getItem('nine_nine_save_v1')).game`);
  assert.equal(penalty.players[0].alive, false);
  assert.equal(penalty.players[0].hand.length, 4);
  assert.equal(penalty.currentValue, 99);
  assert.equal(penalty.history.at(-1).busted, true);
  assert.match(await driver.text('#status-line'), /爆點淘汰/);

  await driver.eval(`window.confirm = () => true`);
  await driver.click('#new-game-button');
  for (const handSize of [4, 5]) {
    await driver.eval(`document.getElementById('hand-size').value = '${handSize}'; document.getElementById('hand-size').dispatchEvent(new Event('change'));`);
    await driver.goto(gamePath);
    assert.equal(await driver.eval(`document.getElementById('hand-size').value`), String(handSize));
    await driver.click('#start-button');
    assert.equal(await driver.count('#hand button'), handSize);
    const dealt = await driver.eval(`JSON.parse(localStorage.getItem('nine_nine_save_v1')).game`);
    assert.ok(dealt.players.every(player => player.hand.length === handSize));
    await driver.eval(`window.confirm = () => true`);
    await driver.click('#new-game-button');
    await driver.goto(gamePath);
    await driver.click('#resume-button');
    assert.equal(await driver.count('#hand button'), handSize);
    assert.equal(await driver.eval(`document.getElementById('hand-size').value`), String(handSize));
    await driver.eval(`window.confirm = () => true`);
    await driver.click('#new-game-button');
  }

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
  console.log('PASS Ace reset/+1, click-to-bust penalties, automatic subtraction, 4/5-card settings/restore, history and single-screen results');
} finally {
  await driver.stop();
}

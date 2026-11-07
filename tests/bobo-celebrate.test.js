const test = require('node:test');
const assert = require('node:assert/strict');
const BoboCelebrate = require('../assets/js/bobo-celebrate.js');

test('formatDuration 把秒數轉成中文時間', () => {
  assert.equal(BoboCelebrate.formatDuration(0), '0 秒');
  assert.equal(BoboCelebrate.formatDuration(59), '59 秒');
  assert.equal(BoboCelebrate.formatDuration(65), '1 分 05 秒');
  assert.equal(BoboCelebrate.formatDuration(3725), '1 時 02 分 05 秒');
  assert.equal(BoboCelebrate.formatDuration(-5), '0 秒', '負數視為 0');
  assert.equal(BoboCelebrate.formatDuration('abc'), '0 秒', '非數字視為 0');
});

test('isNewRecord 依「越大越好／越少越好」判斷新紀錄', () => {
  assert.equal(BoboCelebrate.isNewRecord(null, 10), true, '沒有舊紀錄就是新紀錄');
  assert.equal(BoboCelebrate.isNewRecord(undefined, 10, { lowerIsBetter: true }), true);
  assert.equal(BoboCelebrate.isNewRecord(10, 12), true);
  assert.equal(BoboCelebrate.isNewRecord(10, 10), false, '平手不算新紀錄');
  assert.equal(BoboCelebrate.isNewRecord(10, 8, { lowerIsBetter: true }), true);
  assert.equal(BoboCelebrate.isNewRecord(10, 12, { lowerIsBetter: true }), false);
  assert.equal(BoboCelebrate.isNewRecord(10, NaN), false, '這次成績無效就不是新紀錄');
});

test('normalizeStats 過濾空項目並統一形狀', () => {
  const out = BoboCelebrate.normalizeStats([
    { label: '步數', value: 12, isBest: true },
    { label: '  ', value: 3 },
    null,
    { label: '時間', value: null }
  ]);
  assert.deepEqual(out, [
    { label: '步數', value: '12', isBest: true },
    { label: '時間', value: '—', isBest: false }
  ]);
  assert.deepEqual(BoboCelebrate.normalizeStats(undefined), []);
});

test('沒有 DOM 的環境呼叫 show 不會丟錯', () => {
  const handle = BoboCelebrate.show({ title: '過關！' });
  assert.equal(handle.dialog, null);
  assert.doesNotThrow(() => handle.close());
  assert.equal(BoboCelebrate.isOpen(), false);
});

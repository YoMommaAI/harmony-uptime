'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { decide, probe } = require('./check');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-25T01:00:00Z'); // Sat 6 PM PT
const ok = { ok: true, reason: 'ok' };
const bad = { ok: false, reason: 'HTTP 530' };

function run(seq, opts) {
  let state = null; const sent = [];
  for (const [t, p] of seq) {
    const r = decide(state, p, t, opts);
    state = r.state;
    if (r.message) sent.push(r.message.kind);
  }
  return { state, sent };
}

test('a single failed check never alerts', () => {
  const { sent } = run([[T0, ok], [T0 + 10 * MIN, bad], [T0 + 20 * MIN, ok]]);
  assert.deepStrictEqual(sent, []);
});

test('a planned restart under 10 minutes never alerts, even if two runs bunch up', () => {
  const { sent } = run([[T0, ok], [T0 + 10 * MIN, bad], [T0 + 13 * MIN, bad], [T0 + 20 * MIN, ok]]);
  assert.deepStrictEqual(sent, []);
});

test('two consecutive failures 10 minutes apart alert once, then one back-up message', () => {
  const seq = [[T0, ok]];
  for (let i = 1; i <= 150; i++) seq.push([T0 + i * 10 * MIN, bad]); // 25 hours down
  seq.push([T0 + 151 * 10 * MIN, ok], [T0 + 152 * 10 * MIN, ok]);
  const { sent, state } = run(seq);
  assert.deepStrictEqual(sent, ['down', 'up']);
  assert.strictEqual(state.status, 'up');
});

test('down alert text names the start time; up text names the duration', () => {
  let r = decide(null, bad, T0);
  r = decide(r.state, bad, T0 + 10 * MIN);
  assert.match(r.message.title, /DOWN/);
  assert.match(r.message.body, /Sat 6:00 PM PT/);
  assert.strictEqual(r.message.priority, 'urgent');
  const up = decide(r.state, ok, T0 + 26 * 60 * MIN);
  assert.match(up.message.body, /1d 2h down/);
});

test('label marks test runs', () => {
  let r = decide(null, bad, T0, { label: '[TEST] ', minGapMinutes: 0 });
  r = decide(r.state, bad, T0 + 1000, { label: '[TEST] ', minGapMinutes: 0 });
  assert.match(r.message.title, /^\[TEST\] Harmony is DOWN/);
});

test('weekly heartbeat only when up and a week has passed', () => {
  const start = decide(null, ok, T0).state;
  assert.strictEqual(decide(start, ok, T0 + 6 * 24 * 60 * MIN).message, null);
  assert.strictEqual(decide(start, ok, T0 + 7 * 24 * 60 * MIN).message.kind, 'heartbeat');
});

test('probe retries before calling it a failure', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; if (calls < 3) throw new Error('reset'); return { status: 200, json: async () => ({ status: 'ok' }) }; };
  const r = await probe('https://x/healthz', { sleep: async () => {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls, 3);
});

test('a login redirect is a failure, not a pass', async () => {
  global.fetch = async () => ({ status: 302, json: async () => ({}) });
  const r = await probe('https://x/health', { attempts: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'HTTP 302' });
});

#!/usr/bin/env node
'use strict';
// Off-Mac uptime watcher for Harmony. Runs on GitHub's runners, never on the
// Mac, so it still works when the Mac is off. Pushes to ntfy.sh.
//
// Rules:
//   - one probe per run (3 quick attempts, so a single dropped request is not a failure)
//   - alert only after 2 consecutive failed runs at least MIN_GAP_MINUTES apart
//     (a planned restart under ~10 minutes never alerts)
//   - one DOWN alert per outage, one BACK UP message when it recovers
//   - one silent "watcher alive" heartbeat a week, so a dead watcher gets noticed

const fs = require('fs');

const MIN = 60 * 1000;
const WEEK = 7 * 24 * 60 * MIN;

function freshState(nowMs) {
  return { status: 'up', fails: 0, firstFailAt: null, downAlertedAt: null, lastHeartbeatAt: nowMs };
}

function fmtDuration(ms) {
  const mins = Math.max(1, Math.round(ms / MIN));
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function fmtPacific(ms) {
  return new Date(ms).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit',
  });
}

// Pure decision: given state, probe result and time, return the new state and
// at most one message to send.
function decide(prev, probe, nowMs, opts = {}) {
  const minGapMs = (opts.minGapMinutes ?? 9) * MIN;
  const label = opts.label || '';
  const s = { ...freshState(nowMs), ...(prev || {}) };
  let message = null;

  if (probe.ok) {
    if (s.status === 'down' && s.downAlertedAt) {
      const since = s.firstFailAt || s.downAlertedAt;
      message = {
        kind: 'up', priority: 'default', tags: 'white_check_mark',
        title: `${label}Harmony is back up`,
        body: `Back up at ${fmtPacific(nowMs)} PT after about ${fmtDuration(nowMs - since)} down (first failed check ${fmtPacific(since)} PT).`,
      };
    } else if (nowMs - (s.lastHeartbeatAt || 0) >= WEEK) {
      message = {
        kind: 'heartbeat', priority: 'min', tags: 'heartbeat',
        title: `${label}Harmony watcher is running`,
        body: 'Weekly check-in: the off-Mac watcher is alive and Harmony is up. No action needed.',
      };
    }
    return { state: { ...s, status: 'up', fails: 0, firstFailAt: null, downAlertedAt: null }, message };
  }

  const fails = s.fails + 1;
  const firstFailAt = s.firstFailAt || nowMs;
  const next = { ...s, fails, firstFailAt };
  if (s.status !== 'down' && fails >= 2 && nowMs - firstFailAt >= minGapMs) {
    message = {
      kind: 'down', priority: 'urgent', tags: 'rotating_light',
      title: `${label}Harmony is DOWN`,
      body: `Harmony has not answered since ${fmtPacific(firstFailAt)} PT (${fails} checks failed, last: ${probe.reason}). `
        + 'The Mac mini, mission-control or the Cloudflare tunnel is offline. Dispatch will not reach you until it is back.',
    };
    next.status = 'down';
    next.downAlertedAt = nowMs;
  }
  return { state: next, message };
}

async function probeOnce(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual', headers: { 'user-agent': 'harmony-uptime-watcher' } });
    if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    if (!body || body.status !== 'ok') return { ok: false, reason: 'unhealthy response' };
    return { ok: true, reason: 'ok' };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally { clearTimeout(t); }
}

async function probe(url, { attempts = 3, timeoutMs = 15000, pauseMs = 20000, sleep } = {}) {
  const wait = sleep || (ms => new Promise(r => setTimeout(r, ms)));
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await probeOnce(url, timeoutMs);
    if (last.ok) return last;
    if (i < attempts - 1) await wait(pauseMs);
  }
  return last;
}

async function sendNtfy(server, topic, msg) {
  const res = await fetch(`${server.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, {
    method: 'POST', body: msg.body,
    headers: { Title: msg.title, Priority: msg.priority, Tags: msg.tags },
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

async function main() {
  const url = process.env.CHECK_URL || 'https://harmony.storybuds.ai/healthz';
  const topic = process.env.NTFY_TOPIC;
  const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
  const stateFile = process.env.STATE_FILE || 'state.json';
  const label = process.env.LABEL || '';
  const minGapMinutes = process.env.MIN_GAP_MINUTES ? Number(process.env.MIN_GAP_MINUTES) : 9;
  if (!topic) { console.error('NTFY_TOPIC is not set'); process.exit(2); }

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {}
  const nowMs = Date.now();
  const result = await probe(url, process.env.FAST ? { attempts: 1 } : {});
  const { state, message } = decide(prev, result, nowMs, { minGapMinutes, label });
  console.log(`probe: ${result.ok ? 'ok' : 'FAIL (' + result.reason + ')'}; status ${state.status}; consecutive fails ${state.fails}`);

  let finalState = state;
  let sendFailed = false;
  if (message) {
    try {
      await sendNtfy(server, topic, message);
      console.log(`sent ${message.kind} notification`);
      if (message.kind === 'heartbeat') finalState = { ...state, lastHeartbeatAt: nowMs };
    } catch (e) {
      sendFailed = true;
      console.error(`could not send ${message.kind} notification: ${e.message}`);
      // Keep the old alert state so the next run retries the message.
      if (message.kind === 'down') finalState = { ...state, status: (prev && prev.status) || 'up', downAlertedAt: (prev && prev.downAlertedAt) || null };
      if (message.kind === 'up') finalState = { ...(prev || state) };
    }
  }
  fs.writeFileSync(stateFile, JSON.stringify(finalState, null, 2) + '\n');
  // A failed delivery fails the job, so GitHub's own failure email is a backup channel.
  if (sendFailed) process.exit(1);
}

module.exports = { decide, probe, fmtDuration, freshState };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

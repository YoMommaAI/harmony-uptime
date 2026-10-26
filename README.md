# harmony-uptime

Off-Mac alarm for Harmony. A GitHub Actions cron (every 10 minutes, on GitHub's
runners, not the Mac mini) probes `https://harmony.storybuds.ai/healthz` and pushes to
Vaughn's phone through ntfy.sh. The ntfy topic is a repository secret (`NTFY_TOPIC`);
a copy lives on the Mac at `~/.harmony/secrets/ntfy-topic` (mode 0600).

Rules (`check.js`, tests in `check.test.js`):

- 3 quick attempts per run; a run fails only if all 3 fail.
- Alert after 2 consecutive failed runs at least 9 minutes apart (~20 min), so restarts
  under 10 minutes never alert.
- One urgent "Harmony is DOWN" per outage, one "Harmony is back up" when it recovers.
- One silent weekly "watcher is running" heartbeat. If that stops arriving, the watcher is dead.
- If ntfy itself rejects a message the run fails, so GitHub's failure email is the backup channel.

State lives on the `state` branch and is only committed when it changes.

Why a separate public repo: scheduled Actions in a private repo bill against the
2,000 free minutes a month, and a 10-minute cron needs ~4,400. Public repos run free.
Nothing private is here; the topic is a secret and logs never print it.

Test without touching Harmony: Actions, "Harmony uptime watch", Run workflow, put a bad
URL in `test_url`, run it twice (DOWN arrives on the 2nd), then once with
`https://harmony.storybuds.ai/healthz` (back up). Test runs use `test-state.json` and say [TEST].

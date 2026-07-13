# Node.js compatibility

WorkerOS targets the public JavaScript API of **Node.js v22.23.1 (Jod LTS)**.
It does not embed Node or V8: `/bin/node` is a guest compatibility runtime over
the WorkerOS kernel and the browser's JavaScript engine.

## Known behavioral deviations

- **Broken pipe (`EPIPE`/`SIGPIPE`, ADR-023).** Real Node ignores `SIGPIPE`; a
  write to a departed pipe reader surfaces as an `EPIPE` `'error'` on the stream
  (unhandled → crash, exit 1). WorkerOS currently leaves `/bin/node` on the
  POSIX default disposition: an uncaught writer is killed with `128+13` (like a
  plain C program). Pipelines terminate identically; only the writer's exit code
  and error report differ. `process.on('SIGPIPE', …)` opts into delivery, after
  which writes throw `EPIPE`. Matching Node exactly (ignore + stream `'error'`)
  is a planned refinement of `node:tty`/`process.stdout`.

## Official test comparison

The compatibility harness downloads selected files directly from the
`nodejs/node` `v22.23.1` tag into the ignored `.node-compat/` cache. The cache
manifest records each source URL and SHA-256 hash.

```sh
cd packages/workeros-web
npm run compat:sync
npm run test:node-compat
```

Each runnable upstream file is executed by `/bin/node` inside a real booted
WorkerOS browser instance. Its assertions are unchanged. The adapter removes only
`require('../common')`, Node's private test-harness bootstrap.

Tests that depend on unavailable private helpers, internal bindings, native
objects, or unsupported builtins are listed as `blocked` in
`tools/node-compat-cases.json`; they are not counted as runtime failures.

Node's own `tools/test.py --report` classifier reports the following default
Linux x64 release suite for v22.23.1:

- 4,554 total
- 4 upstream-skipped
- 4,550 expected to pass on official Node

Current WorkerOS full-denominator result:

- 5 passed
- 0 failed
- 4,549 skipped/not yet runnable

Of the skipped count, 4 are skipped by upstream Node itself and 4,545 have not yet
been made runnable under WorkerOS. The committed `blocked` entries document the
first known blockers being worked through; they are not yet an exhaustive reason
map for all 4,545 cases.

Expand coverage by adding an upstream file to `runnable` only when removing the
private-common bootstrap is sufficient. Otherwise add it to `blocked` with the
exact missing dependency, then unblock it when that runtime or harness capability
lands. A test that was not executed is never counted as a pass or failure.

## Raw full-tree run

`npm run test:node-compat:full` imports the complete official `test/` tree into
one persistent headless-Chromium WorkerOS instance, then invokes every top-level
`test-*.js`/`.mjs`/`.cjs` file through `/bin/node`. Unsupported CLI flags,
private internals, and missing APIs surface as failures; hangs become timeouts.

Current raw result:

- 4,699 files launched
- 1,332 passed (28.3%)
- 2,992 failed (of which 583 timed out)
- 375 skipped

Detailed per-file output is stored in ignored
`.node-compat/v22.23.1/full-results.json`, with a live append-only event log in
`full-results.jsonl`. Narrow runs are available for fast iteration:

```sh
NODE_COMPAT_FILTER=test-fs- NODE_COMPAT_LIMIT=50 npm run test:node-compat:full
```

### Failure concentration

Failures cluster in a small number of subsystems — the top ten modules account
for roughly half of all failures. The `net → stream → http` chain dominates: http
passes only ~2%, and net/stream failing near-totally is the likely root cause,
since http, cluster, child_process, and dgram all sit on the socket/stream core.

| Module | Fail / Total | Pass % |
| --- | --- | --- |
| http | 378 / 397 | 2.3% |
| fs | 262 / 337 | 15.7% |
| stream | 190 / 209 | 6.7% |
| net | 170 / 193 | 5.2% |
| es-module | 165 / 207 | 15.5% |
| worker | 114 / 152 | 19.7% |
| process | 112 / 164 | 26.8% |
| async_hooks | 110 / 142 | 11.3% |
| child_process | 97 / 115 | 8.7% |
| vm | 92 / 125 | 25.6% |

Strong areas: tls 94%, https 98%, crypto 96%, http2 89%, inspector 89%.

### Website report

`npm run report:node-compat` re-buckets `full-results.json` with the canonical
classifier in `tools/node-compat-classify.mjs` and writes a stable, public-shaped
`.node-compat/v22.23.1/report.json` (target, overall counts, `topFailures`,
per-module and per-suite rows with pass rates) for the website to fetch. It runs
automatically at the end of `test:node-compat:full`. The classifier normalizes
every test to a canonical Node builtin, folding upstream naming quirks
(`test-h2-*` → http2, `test-runner-*` → test-runner, `test-messageport-*` →
worker); only genuine one-off feature tests fall into `misc` (~1%).

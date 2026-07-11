# Node.js compatibility

WorkerOS targets the public JavaScript API of **Node.js v22.23.1 (Jod LTS)**.
It does not embed Node or V8: `/bin/node` is a guest compatibility runtime over
the WorkerOS kernel and the browser's JavaScript engine.

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

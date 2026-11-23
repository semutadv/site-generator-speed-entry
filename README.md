# Site Generator Speed — a faster makefun-site

[![Competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounties/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/semutadv/site-generator-speed-entry/rank.svg)](https://make.fun/bounties/site-generator-speed-01-run-20261122/leaderboard)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounties/site-generator-speed-01-run-20261122)

An entry for make.fun's **site-generator-speed-01**: a drop-in replacement
for the static site generator *makefun-site 1.0.0* that returns, for every
input, exactly the reference's output tree — every page, index and tag page,
`build-report.txt` and static file, byte for byte — in less CPU time.

## Layout

- `main.ts` — the contest driver, kept as the house entry ships it: it reads
  the cases and answers each one with `run()` from `solve.js`.
- `solve.js` — the whole generator, reimplemented from the documented
  behaviour of the reference: its strict front matter (seven keys, each with
  its own grammar and refusal reasons), its Markdown subset (fences, headings
  with unique slug ids, blockquotes, flat lists, paragraphs, and the inline
  code/strong/emphasis/link scanner), its template dialect (`{{ }}`, `{{{ }}}`,
  `{% for %}`, `{% if %}`, `{% include %}`, standalone tag lines), the slug
  rule with Unicode normalisation, permalinks, collections, tags, link
  resolution and the build report.

## Approach

Correctness is the gate — one differing byte and the speed never counts — so
the semantics are mirrored exactly, including the odd corners: the order the
refusal checks run in, escapes that fail a quoted string, headings whose
closing hashes stay as text, a `---` under a paragraph becoming a break.
Speed comes from structure, not from cutting corners:

- single-pass character scanners for front matter, Markdown blocks, inline
  markup and template tags, instead of repeated regex splitting and joining;
- slugs memoised per build (tag names and headings repeat constantly across
  a site), with a code-unit fast path inside `slugify` itself;
- plain text copied in slices — inline rendering and HTML escaping only
  interrupt a run at a character that actually matters;
- template rendering accumulated into one buffer per page instead of string
  concatenation at every node, and no token or node is rebuilt per render.

Nothing is cached between cases: all memoisation lives inside one `run()`
call.

## Verification

- `check.mjs` runs both this implementation and the reference over every
  practice case and compares the answers exactly (key sets and every file's
  text); it also confirms the reference against the kit's published expected
  answers.
- `bench.mjs` times total CPU (`process.cpuUsage`) of both implementations
  over the full practice set, warm-up excluded, and prints the ratio.

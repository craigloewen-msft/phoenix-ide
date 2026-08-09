The viewer keyboard tests fail intermittently in full-suite `vitest run`, but pass reliably when the file or the `src/components/viewer/` directory is run alone. Reproduced on a clean tree with no local changes (2 of 3 full runs failed), so this predates the diff-expansion work and is not caused by it.

Observed failure site: `FileReviewDiffView.keyboard.test.tsx` around the review-keyboard assertions (a testing-library `getElementError`, i.e. an element query that resolves under isolation but not under full-suite load). `renderFixture.test.tsx` has been seen failing the same way in a `./dev.py check` run.

This matters beyond the noise: an intermittently red lane trains reviewers to re-run rather than read, which is how a real regression gets waved through.

Likely shapes to investigate:
- Cross-file leakage of a global the review keyboard depends on (focus scope registration, document-level key listeners, or a module-level singleton not reset between suites).
- A timing assumption that only holds when the machine is not saturated by parallel workers.
- Shared jsdom/happy-dom state (`document.activeElement`, registered focus scopes) surviving between test files.

Start by running the suite with a single worker to confirm it is concurrency-related, then bisect the file set that must run before it to reproduce deterministically.

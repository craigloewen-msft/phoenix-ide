The `allium specs` lane of `./dev.py check` fails on a clean tree:

    specs/browser-tool/browser-lifecycle.allium: 1 error(s)
      L414: Reference 'SseEvent/BrowserSessionState' uses unknown import alias 'SseEvent'.

Reproduced by stashing all working-tree changes and running `./dev.py check --lanes allium`,
so it is not caused by any in-flight branch. Note a separately-installed `allium check` CLI
reports no findings on the same file — the version dev.py bundles is stricter, so whichever
is authoritative, the two disagree and the lane is red for everyone.

Fix: either declare the `SseEvent` import alias in the spec header, or change L414 to
reference the type through an alias that is actually declared. Confirm afterwards that both
the bundled and standalone allium agree.

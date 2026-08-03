
# PR Side

[한국어](./README.ko.md) | English

An unofficial Chrome extension that automatically organizes your GitHub pull
requests into Chrome tab groups - an Arc-style "pinned folder" for the PRs
you authored and the ones waiting on your review.

<img width="1280" height="800" alt="02-pr-groups-dark" src="https://github.com/user-attachments/assets/24b6492b-31fa-47be-88d8-f8697e9c5351" />

## Features

- **Automatic sync** of two tab groups - PRs you authored and PRs where
  you're a requested reviewer - kept up to date on a timer and via a manual
  "Sync now" button.
- **Automatic cleanup** of tabs for PRs that have been merged or closed.
- **Activity age filter** - only show PRs updated within the last N days
  (configurable, 0 = show all).
- **Memory-friendly**: new tabs are discarded once loaded (title and favicon
  are preserved) so a large PR list doesn't burn browser memory.
- **Format-change safety net**: if GitHub's page structure changes and the
  parser suddenly finds zero PRs, the extension treats this as suspicious
  rather than trusting it - it keeps your existing tabs and only proceeds
  once the empty result is confirmed across several sync cycles, instead of
  silently closing every tab.
- **Restart-safe grouping**: Chrome tab group IDs change across browser
  restarts. PR Side detects this, adopts the correct restored group by
  title, and merges away any accidental duplicate groups.
- **Localized (English / Korean)** UI, following your browser's language.

## How it works

PR Side reads your already-logged-in `github.com` session cookie and fetches
the `/pulls` dashboard pages to find PRs you authored or were asked to
review. There is no OAuth app, no API token, and no external server - all
parsing and tab management happens locally inside your browser, and no data
is ever sent anywhere but GitHub itself.

Because this relies on parsing GitHub's HTML/embedded page data rather than
a stable public API, it can break if GitHub changes its page structure.
When that happens, the extension is designed to fail safe: it preserves
your existing tabs and shows a warning in the popup instead of silently
clearing everything.

## Install

**Chrome Web Store:** _(coming soon)_

**Manual / unpacked install:**

```bash
npm install
npm run build
```

Then in Chrome, go to `chrome://extensions`, enable "Developer mode", click
"Load unpacked", and select the generated `dist/` directory.

## Development

```bash
npm run build       # bundle with esbuild into dist/
npm test            # run the vitest suite
npm run typecheck   # tsc --noEmit
```

Project layout:

- `src/lib/parser.ts` - pure functions that parse PR data out of GitHub's
  HTML and embedded JSON (no Chrome APIs, easy to unit test).
- `src/lib/github.ts` - the data-source adapter that fetches the `/pulls`
  pages using the browser's session cookie.
- `src/lib/filter.ts` - activity-age filtering.
- `src/lib/sync.ts` - the tab group sync engine: diffing target PRs against
  existing tabs, group adoption/merge after restart, the format-change
  safety net, and title-preserving tab discarding.
- `src/background.ts` - the MV3 service worker that wires alarms and
  messages to the sync engine.
- `src/popup/`, `src/options/` - the popup UI and settings page.

## Disclaimer

This is an unofficial, community project and is not affiliated with,
endorsed by, or sponsored by GitHub, Inc.

## License

[MIT](./LICENSE)

# Deyon

A cross-platform desktop download manager that wraps [aria2](https://aria2.github.io/),
the command-line download utility. Paste any link — HTTP, HTTPS, FTP, SFTP,
or a BitTorrent magnet link — or drop in a `.torrent`/`.metalink` file, and
Deyon downloads it through a bundled, self-contained `aria2c` engine. No
separate aria2 install required.

Built with Electron. Ships for macOS (Apple Silicon, macOS 26+) and Windows (x64).

## Features

- Add downloads by URL (HTTP/HTTPS/FTP/SFTP/magnet), multiple links at once, or via `.torrent` / `.metalink` files (file picker or drag-and-drop)
- Live progress, speed, ETA, pause/resume/remove, open-containing-folder
- Persistent download queue across app restarts (aria2 session file)
- Full aria2 configurability from the Settings panel:
  - Concurrent downloads, connections-per-server, split/segments, min split size
  - Global download/upload speed limits
  - Retry count & wait, custom User-Agent, HTTP/HTTPS/FTP proxy, TLS certificate verification
  - BitTorrent: DHT, max peers, seed ratio, seed time
  - Per-download overrides (save folder, filename, connections, speed cap, referer)
  - An "Advanced" free-text field for any other aria2 command-line option

## Download

Grab the latest build from the [Releases](../../releases) page:

- **macOS (Apple Silicon, macOS 26 "Tahoe" or newer):** `Deyon-<version>-arm64.dmg`
- **Windows (x64):** `Deyon-Setup-<version>.exe` (installer) or the portable `.exe`

### Unsigned builds — first-run steps

These builds are not code-signed (no Apple Developer ID / Windows code-signing
certificate). Your OS will warn you the first time you open the app:

**macOS:** Gatekeeper will likely say the app "is damaged and can't be opened."
This is macOS's response to an unsigned app downloaded from the internet, not
an actual problem with the file. Clear the quarantine flag once, from a
terminal:

```sh
xattr -cr /Applications/Deyon.app
```

Then open it normally.

**Windows:** SmartScreen will show "Windows protected your PC." Click
**More info** → **Run anyway**.

The bundled `aria2c` for macOS is built from Homebrew's current bottle on
GitHub's `macos-latest` runner at release time, which currently means
**macOS 26 (Tahoe) or newer**. On an older macOS, the app window opens fine
but shows "Engine error" instead of "Engine ready", because the bundled
`aria2c` fails to load — it does not fail to launch. The CI run's "Smoke-test
bundled aria2c (macOS)" step logs the exact `minos` value for each release.
For older macOS, build your own `resources/bin/mac/aria2c` from source
instead of the Homebrew bottle.

## Development

Requires Node.js 20 or 22 (LTS). Node 24+ has a bug in `extract-zip` that
silently truncates Electron's own binary download — if `npm start` launches
nothing and `node_modules/electron/dist/` is a few hundred KB instead of a
few hundred MB, switch to an LTS Node version and reinstall. On macOS, also
install [Homebrew](https://brew.sh) (used to fetch aria2 for local
development and to build the bundled binary).

```sh
npm install

# Fetch/build a local aria2c so the app has something to launch:
npm run build:aria2:mac      # macOS: installs aria2 via Homebrew, bundles its
                              # dylibs and a CA bundle into resources/bin/mac/
npm run fetch:aria2:win      # Windows/any OS with `tar`: downloads the
                              # official static aria2c.exe into resources/bin/win/

npm start
```

If you skip the fetch/build step on macOS, the app falls back to an
`aria2c` found on your `PATH` (e.g. `brew install aria2`).

## Building installers

```sh
npm run build:aria2:mac && npm run dist:mac   # on macOS
npm run fetch:aria2:win && npm run dist:win   # on Windows
```

Output lands in `release/`.

## Publishing a release

Push a tag matching `v*` (e.g. `v0.1.0`). GitHub Actions
(`.github/workflows/build.yml`) builds on both `macos-latest` and
`windows-latest`, bundles aria2 for each platform, packages the app with
electron-builder, and publishes a GitHub Release with the `.dmg` and the
Windows installer/portable `.exe` attached.

## How it works

On launch, Deyon's main process starts a bundled `aria2c` with
`--enable-rpc`, a random per-launch RPC secret, and a free local port bound
to `127.0.0.1` only. The renderer (UI) never talks to aria2 directly — all
JSON-RPC calls are proxied through Electron's main process over IPC, and
polled every ~1.2s via `system.multicall` for `tellActive` / `tellWaiting` /
`tellStopped` / `getGlobalStat`.

Settings fall into two buckets:

- **Live options** (`max-concurrent-downloads`, overall speed limits) are
  applied instantly via `aria2.changeGlobalOption`, no restart needed.
- **Startup-time defaults** (split, connections-per-server, download
  directory, proxy, BitTorrent settings, etc.) are baked into the `aria2c`
  command line. Changing them saves a session snapshot and restarts the
  engine process transparently.

Per-download overrides (set in the Add Download dialog) are passed directly
as `addUri`/`addTorrent` call options and take effect immediately without
touching the engine.

## License

Deyon's source code is MIT licensed — see [LICENSE](LICENSE). It bundles the
unmodified `aria2c` executable (GPLv2, invoked as a subprocess, not linked)
from the [aria2 project](https://github.com/aria2/aria2).

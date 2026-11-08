# fluxware

## Project overview

fluxware is a keyboard-first terminal application for downloading video and audio. It is an interactive interface over yt-dlp, built with React and OpenTUI. The current package version is 1.1.7, and the command exposed by `package.json` is `fx`.

This is a local CLI/TUI application, not a web application or server. It fetches media metadata, offers format and quality choices, runs downloads in a background queue, and keeps optional history. The interface supports English and Russian, keyboard and mouse input, terminal notifications, cover previews, and single-link or batch downloads.

The current implementation is TypeScript. The root `fluxware_new_.py` is the old Python version, is explicitly ignored by Git, and is not an entry point. The only current Python integration is runtime support for `python -m yt_dlp` and migration of the old version's settings.

The application is developed and tested in Windows Terminal. It also contains explicit macOS and Linux paths for configuration, process management, and opening files.

## Technology and configuration

- **Runtime and package manager:** Bun. Running from source requires Bun 1.3.14 or newer.
- **Language:** TypeScript in strict mode, using ESNext modules and the bundler module resolution mode.
- **UI:** React 19, `@opentui/core`, `@opentui/react`, and `@opentui/keymap`, all OpenTUI packages pinned to 0.7.0. JSX uses `react-jsx` with `@opentui/react` as the JSX source.
- **Media tools:** yt-dlp is required for metadata and downloads. ffmpeg is required for merging tracks, audio extraction, and cover processing. Deno or Node.js is recommended so yt-dlp can solve YouTube JavaScript challenges.
- **Module format:** ESM (`"type": "module"`). The package is private and exposes `src/index.tsx` as the `fx` binary.

Key configuration files:

- `package.json`: dependencies and all start, development, test, typecheck, and build commands.
- `bun.lock`: locked dependency graph. Keep it updated when dependencies change.
- `tsconfig.json`: strict TypeScript checks, including `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`, and `verbatimModuleSyntax`. It includes both `src` and `test`, and never emits compiled JavaScript.
- `.gitignore`: excludes `node_modules/`, `dist/`, logs, and the old local Python implementation.

There are no formatter or linter configurations, no lint script, and no CI or release workflow files in the repository.

## Build and development commands

Run commands from the repository root:

```bash
bun install          # Install dependencies
bun start            # Run src/index.tsx
bun run dev          # Run with Bun watch mode
bun test             # Run the complete test suite
bun run typecheck    # Run tsc --noEmit over src and test
bun run build        # Compile and minify a standalone executable
```

Useful focused commands:

```bash
bun test test/core.test.ts
bun test test/queue.test.ts
bun test test/app.test.tsx
```

`bun start` starts a real interactive terminal UI. Use a capable terminal for manual verification rather than treating it as a command-line batch tool.

The build script is `bun build --compile --minify src/index.tsx --outfile dist/fx`. On Windows the resulting application is `dist/fx.exe`; `dist/` is ignored by Git. No cross-compilation target is specified.

`bun run build:linux` cross-compiles the Linux x64 binary to `dist/fx-linux-x64`. Bun skips linking OpenTUI native packages for foreign platforms, so before cross-compiling, manually extract the needed `@opentui/core-linux-*` packages into `node_modules/@opentui/` (`npm pack @opentui/core-linux-x64@<version>` plus the `-musl`/`-arm64` variants the bundler asks for, then untar and rename `package` to the package name). All variants are recorded in `package.json` devDependencies and `bun.lock`.

## Runtime architecture

### Composition root

`src/index.tsx` creates the long-lived application services: `SettingsStore`, `DownloadQueue`, `HistoryStore`, the OpenTUI renderer, keymap, clipboard service, and logo-intro state. It detects external tools asynchronously, injects services into React through `ServicesProvider`, and owns shutdown.

Shutdown cancels active jobs, briefly waits for cancellation cleanup, kills remaining child processes, disposes the clipboard, and restores the terminal. While downloads are active, the UI requires a second quit request before calling this path.

### Download flow

1. `DownloadScreen` extracts one or more URLs. For a single non-audio-only URL, `fetchInfo` runs yt-dlp with JSON output and converts the result to `MediaInfo`.
2. The user chooses video quality or audio. Audio-only sources start without a quality menu. Multiple pasted links use one shared video/audio choice.
3. `DownloadQueue.add` creates immutable job snapshots. Its pump starts jobs up to the configured concurrency limit.
4. `ytdlp.ts` builds the argument vector. `process.ts` spawns yt-dlp directly, without a shell, and forwards stdout and stderr line by line.
5. `parseLine` converts structured `FLUXPROG`, `FLUXPP`, and `FLUXFILE` output into typed events. The queue updates progress, post-processing state, output paths, errors, and quality warnings.
6. Successful jobs are converted to history entries. React receives store changes through subscriptions and `useSyncExternalStore`.
7. Cancellation aborts the process tree and removes partial files created by that run. Failed and canceled jobs can be retried.

Batch mode extracts links from arbitrary text or a UTF-8/Windows-1251 text file and enqueues them directly. Video and audio use separate destination folders.

### Core modules (`src/core/`)

These modules contain application logic without React or OpenTUI rendering dependencies:

- `ytdlp.ts`: tool detection, custom-option parsing and validation, metadata retrieval, format selectors, yt-dlp arguments, and output-event parsing. yt-dlp is found on `PATH` first, then through Python, Python 3, or the Windows `py` launcher.
- `queue.ts`: in-memory job state machine (`queued`, `running`, `done`, `failed`, `canceled`), concurrency, throttled subscriptions, run summaries, retries, cancellation, and idle/finish events. Concurrency is normalized to 1 through 4.
- `process.ts`: child-process execution, UTF-8 Python environments, line splitting, timeouts, Windows process-tree termination with `taskkill`, and platform-specific file-manager integration.
- `media.ts`: typed subsets of yt-dlp metadata, media-card data, available heights, platform labels, fallback-format detection, and quality-drop warnings.
- `settings.ts`: defaults, validation, normalization, platform paths, synchronous temporary-file-plus-rename persistence, and migration from `~/.fluxware_config.json`.
- `history.ts`: session history, optional JSONL persistence, removal, and newest-first grouping by local day.
- `cleanup.ts`: candidate discovery and guarded deletion of files left by canceled downloads.
- `urls.ts`: URL extraction, deduplication, platform checks, and removal of URL schemes for terminal display.
- `format.ts`: byte, speed, duration, pluralization, truncation, and ANSI helpers.
- `i18n.ts`: process-wide current language, Russian/English translation selection, locale detection, and language-aware noun counts.
- `intro.ts`: deterministic logo-animation models and rotation persisted in `state.json`.

### UI modules (`src/ui/`)

- `App.tsx`: five sections (`download`, `batch`, `history`, `settings`, `about`), tab and content focus, global key bindings, key hints, queue status, notices, terminal title/progress, and notifications. All screens stay mounted so partially entered state survives section changes.
- `context.tsx`: dependency injection and external-store hooks for settings, jobs, and history; also toasts, spinner timing, and clipboard URL prefill.
- `screens/DownloadScreen.tsx`: URL submission, metadata cards, quality selection, automatic audio-only downloads, progress, and cancellation.
- `screens/BatchScreen.tsx`: multiline text, link extraction, file import, format/quality controls, and aggregate progress.
- `screens/HistoryScreen.tsx`: current jobs plus persisted history, file/folder opening, retry, cancellation, and removal.
- `screens/SettingsScreen.tsx`: format, folder, custom yt-dlp option, concurrency, thumbnail, history, and language editing.
- `screens/AboutScreen.tsx`: package, dependency, runtime, and external-tool information.
- `components.tsx`: shared OpenTUI controls, local keymap layers, menus, buttons, inputs, progress bars, and job rows.
- `Logo.tsx`: FLX pixel rendering and OpenTUI timeline playback.
- `theme.ts`: monochrome palette with distinct warning and error colors.
- `screens/shared.tsx`: common screen props, focus-entry handling, and error display.

## Persistent files and defaults

`configPath()` selects the configuration directory:

- Windows: `%APPDATA%\fluxware` (with a per-user roaming-profile fallback).
- macOS: `~/Library/Application Support/fluxware`.
- Linux and other platforms: `$XDG_CONFIG_HOME/fluxware`, or `~/.config/fluxware` when that variable is unset.

The directory contains:

- `config.json`: normalized settings, written through a temporary file and rename.
- `history.jsonl`: one JSON object per successfully finished download when history logging is enabled.
- `state.json`: the last logo animation.

Default download folders are `~/Videos` and `~/Music`. Null directory settings mean these defaults. Existing legacy settings are migrated only when the new config file does not exist.

`FLUXWARE_INTRO` can select `flicker`, `contour`, or `drop`, or disable the animation with `none`, `off`, or `0`.

## Code style and project conventions

- Match the existing TypeScript style: two-space indentation, double quotes, no semicolons, trailing commas in multiline structures, and extensionless relative imports.
- Use `import type` for type-only imports. Preserve strict-null and unchecked-index handling rather than weakening `tsconfig.json`.
- Keep process, queue, persistence, parsing, and formatting logic in `src/core/`; keep rendering and focus behavior in `src/ui/`.
- Stores return stable snapshots and replace changed arrays/objects instead of mutating snapshots in place. This is required by their `useSyncExternalStore` consumers.
- Use OpenTUI elements such as `box`, `text`, `input`, `textarea`, `scrollbox`, and `image`, not HTML elements. Shared controls and key bindings should follow the existing focus-zone model. Binding descriptions feed the bottom key-hint line.
- Support both keyboard and mouse interactions where the surrounding control does. Preserve screen state when switching tabs.
- Source comments are in English. User-facing strings use `tr(russian, english)` with Russian first; use `count` for translated noun forms. Update both language strings and, for documented behavior changes, both `README.md` and `README.ru.md`.
- Custom yt-dlp arguments deliberately come after fluxware's generated arguments so they can override defaults. Preserve the `--` separator before URLs.
- Avoid weakening cancellation, cleanup, and shutdown behavior. Windows process trees and temporarily locked partial files have explicit handling.

## Testing instructions

The project uses Bun's built-in `bun:test` runner. Tests do not contact real media sites or require a real yt-dlp installation.

- `test/core.test.ts`: unit tests for URL extraction, formatting, labels, quality warnings, yt-dlp argument construction and parsing, settings and migration, localization, history grouping, logo animation, and cancellation cleanup.
- `test/queue.test.ts`: queue behavior through the real child-process pipeline, including concurrency, errors, retry, and cancellation of queued jobs.
- `test/app.test.tsx`: rendered UI integration tests using `createTestRenderer`, React `act`, mock keyboard/mouse input, and captured terminal frames/spans.
- `test/fixtures/fake-ytdlp.ts`: a Bun-run yt-dlp stand-in that emits the same metadata and structured progress records as the real integration. It also creates partial files for cancellation tests.
- `test/fixtures/tools.ts`: points tool detection consumers at the fake yt-dlp script.

Use temporary directories and the existing fake process for new download/UI tests. Do not replace deterministic tests with live network downloads. UI tests disable the random logo intro with `FLUXWARE_INTRO=none`. Setting `SHOW_FRAMES` makes relevant UI tests print captured frames for debugging.

Before finishing a change, run:

```bash
bun run typecheck
bun test
```

Run `bun run build` when changing packaging, the entry point, dependency bundling, or release behavior. Manually exercise interactive changes in a terminal when the test renderer cannot cover the behavior.

## Release and deployment

The primary distribution is npm: users install with `npm i -g fluxware` (needs Node.js) and run `fx`; the READMEs document exactly that. The GitHub release assets back the manual `bin/install.cjs` download of the binaries. Users still install yt-dlp and ffmpeg separately; Deno or Node.js is recommended for YouTube. There is no checked-in automated release pipeline, so do not assume that building locally publishes anything.

The package is also published to npm as `fluxware`. The npm tarball contains only `bin/`, both READMEs, and `LICENSE`: `bin/fx.cjs` is a Node wrapper that launches the prebuilt binary for the current platform (Windows x64 or Linux x64), and `bin/bin-path.cjs` decides which file to run. It looks for the copy in `bin/` first, then for the platform-specific `fluxware-bin-win-x64` / `fluxware-bin-linux-x64` npm package installed as an optional dependency (gated by `os`/`cpu`, so each user downloads only their own ~108 MB binary through the npm registry, independent of GitHub connectivity). The package itself is enough to run: `bin/install.cjs` (the `postinstall` hook) only adds a convenience copy, because npm 12 and newer, Bun and pnpm block dependency install scripts by default, so the hook often never runs and must not be required for `fx` to work. When the resolved file is not executable, `fx.cjs` retries after `chmod` and otherwise copies it into `$XDG_CACHE_HOME/fluxware` (or `%LOCALAPPDATA%luxware`), which keeps a root-owned global install working. OpenTUI and React are devDependencies; they are build-time only and must not move back into runtime dependency fields. Consequences:

- Every release publishes three npm packages in order: `npm-bin/win-x64` as `fluxware-bin-win-x64`, `npm-bin/linux-x64` as `fluxware-bin-linux-x64` (both already containing the built binaries, same version), then `fluxware` itself with the version bump and matching `optionalDependencies` pins.
- The Linux binary must ship with mode `755`. `npm pack` on Windows drops the executable bit, so repack before publishing: unpack the tarball from `npm pack`, `chmod 755 package/fx-linux-x64`, tar it again with the `package/` prefix, check with `tar -tvzf` and publish that tarball (`npm publish <file>.tgz`).
- Keep the GitHub release with both binary assets (`fx-win-x64.exe`, `fx-linux-x64`) under the matching `v<version>` tag as the manual `bin/install.cjs` download source and for direct downloaders.
- npm no longer lets 2FA-bypass granular tokens publish: `npm publish` answers `EOTP` and wants a WebAuthn ceremony in the browser. From a non-interactive shell, read `error.authUrl` and `error.doneUrl` out of `npm publish --json`, open the first URL so the maintainer can touch the security key, poll the second for the one-time value and retry with `npm publish --otp=<value>`. Each package needs its own ceremony, so expect three.
- A freshly published version shows up in the registry packument before its tarball becomes downloadable; `npm install` and `npm view ... dist.tarball` can fail for a few minutes. Publish the two `fluxware-bin-*` packages before `fluxware` so nobody installs a version whose optional dependency is still missing.

`dist/`, dependencies, logs, user configuration, and downloaded media are not source artifacts and should not be committed.

## Security and data-safety considerations

- Treat URLs, custom yt-dlp options, file paths, and text-file contents as untrusted input. Continue passing process arguments as arrays through `spawn`; do not introduce shell command concatenation.
- Custom yt-dlp options are an intentional advanced feature. They are validated by invoking yt-dlp without a URL, then persisted and applied to downloads. They can override generated options, including output behavior.
- yt-dlp runs with `--ignore-config` and `--no-playlist` in generated calls. Preserve these unless intentionally changing behavior, and update tests and documentation accordingly.
- History stores URLs, titles, authors, output directories, and filenames in plaintext JSONL. Settings can also contain paths and custom command-line options. Never copy real user files into test fixtures or commits.
- Cancellation deletes files. `cleanup.ts` limits deletion to known partial/output candidates and skips files older than the current run. Preserve that guard and its regression tests when changing cleanup logic.
- Settings and history intentionally tolerate write failures by keeping state for the current session. Do not turn best-effort clipboard, notification, or file-manager failures into fatal application errors.

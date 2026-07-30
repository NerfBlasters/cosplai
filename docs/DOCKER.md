# Docker packaging

The image bakes in the bridge plus the **npm-sourced pinned CLIs** from
`cli-pins.json` (`claude`, `codex`, `copilot` at their manifest-exact
versions), fully decoupled from anything installed on the host. External pins
(`agy`, which has no public registry) are bind-mounted at runtime.

## Build & run

```bash
docker build -t pty-web-bridge .

docker run -d --init --name bridge \
  -p 127.0.0.1:7681:7681 \
  -e BRIDGE_TOKEN=some-long-random-string \
  -v ~/.claude:/home/node/.claude \
  -v ~/.codex:/home/node/.codex \
  -v ~/.copilot:/home/node/.copilot \
  pty-web-bridge
```

The container runs as the base image's `node` user (uid/gid 1000) so
bind-mounted credential dirs from a typical single-user host stay readable;
if your host user isn't uid 1000, add `--user $(id -u):$(id -g)`. `--init`
matters here: the PTY-spawned CLIs fork subprocesses, and without an init
process orphaned grandchildren never get reaped.

Keep the port published on loopback (`127.0.0.1:7681:7681`) — the container
sets `HOST=0.0.0.0` internally so the port mapping works, which means the
*publish address* is your only network boundary. The README's security
section applies unchanged.

## Auth state

The bridge never performs logins — it drives already-authenticated CLIs, so
each CLI's credential state must reach the container:

- **claude** — mount `~/.claude` (holds `.credentials.json`). One-time login
  inside the container instead: `docker exec -it bridge claude /login` (the
  vendored CLIs are on the image's `PATH`).
- **codex** — mount `~/.codex` (holds `auth.json`).
- **agy** (external pin) — mount the pinned binary *and* its auth state:
  `-v /path/to/pinned/agy-dir:/app/vendor/bin` (the binary at
  `/app/vendor/bin/agy`), plus whatever Google session state your `agy`
  login uses in `$HOME`.
- **copilot** / **copilot-headless** — mount `~/.copilot` (holds `config.json`,
  the device-code login). Copilot authenticates via its **own** credential
  store there, *not* the `gh` keyring (the earlier "rides the gh keyring" note
  was wrong — the `gh` keyring is only for the `gh` tool). If the host uses a
  keyring-backed `gh` login but a plain `~/.copilot` device login, only the
  latter needs to reach the container. One-time login inside the container
  instead: `docker exec -it bridge copilot login` (device flow) into a
  persistent `~/.copilot` volume. For the cloud-API facade prefer
  `copilot-headless` (exact output; the PTY `copilot` profile's facade
  extraction is best-effort/empty since 1.0.75). Disable both with
  `-e BRIDGE_PROFILES=claude,codex,claude-headless,antigravity,generic` if
  copilot can't authenticate in your setup.

A fresh container is an untrusted working directory for `claude` — expect
the trust dialog on first session (`startup-only` dialog policy answers it;
see README "The trust-dialog reality").

## Pins inside the image

`docker build` runs `node scripts/pin-clis.mjs --npm-only`, so for the
npm-sourced pins a host CLI update cannot leak in — the image holds the
manifest versions and nothing else. Bind-mounted external pins (`agy`) are
whatever you mount; the boot handshake still `--version`-checks them against
the manifest and warns (or refuses under `BRIDGE_STRICT_VERSIONS=1`). To
walk a pin forward: edit `cli-pins.json`, follow the README bump workflow
(live canary first), then rebuild the image.

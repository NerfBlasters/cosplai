# Security Policy

## Reporting a vulnerability

Please report privately through GitHub's
[private vulnerability reporting](https://github.com/NerfBlasters/cosplai/security/advisories/new)
— the **Report a vulnerability** button under this repository's Security tab.
Please do not open a public issue for something exploitable.

Expect an initial response within a week. This is a personal project
maintained by one person, not a funded product; there is no paid bounty and no
guaranteed remediation SLA.

## Supported versions

The `master` branch is the only supported version. There are no maintained
release branches and no backports — fixes land on `master`.

## Threat model — read this before reporting

`cosplai` deliberately does things that look like vulnerabilities in
isolation. The following are **by design** and are not accepted as reports:

- **The bridge token is equivalent to shell access.** It grants full
  interactive control of every enabled AI CLI, and those CLIs can run tools and
  execute code. This is the documented purpose, not a privilege-escalation bug.
- **PTY children execute arbitrary commands.** That is what an interactive AI
  CLI does. "The tool can run commands" is the feature.
- **`envScrub` is best-effort.** It strips documented API-key environment
  variables so the child uses subscription auth. It does not, and cannot,
  cover file-based credentials (`~/.claude/.credentials.json`,
  `~/.codex/auth.json`, gcloud ADC, the `gh` keyring). This limitation is
  stated in the README.
- **Plain HTTP on loopback, no TLS.** The service binds `127.0.0.1` and is
  intended to be reached directly or through an SSH tunnel. HSTS is emitted
  only when a request genuinely arrives over TLS; see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why an unconditional header
  would be a no-op here.
- **Single-operator scope.** The bridge is designed for one operator driving
  their own sessions on their own machine. Findings that assume a shared or
  multi-tenant deployment are out of scope — the README already states what
  must be added before exposing it beyond one operator.

## In scope

Things that genuinely break the model above, for example:

- Bypassing the token gate on any route or the WebSocket upgrade.
- Escaping the `/vendor/*` path-traversal guard to read arbitrary files.
- Making the browser shell open a WebSocket to an origin other than its own.
- Causing a spawned CLI to authenticate with an API key that `envScrub` claims
  to strip.
- Any route leaking the bridge token to a third party.

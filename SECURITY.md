# Security Policy

## Supported versions

TokenFault is pre-release (`0.x`). Security fixes are made on the `main` branch only.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub's **private vulnerability reporting**: open the repository's **Security** tab
and choose **Report a vulnerability**. If that option is not available, open a minimal public issue asking the
maintainers for a private contact channel. Do not include any vulnerability details in it.

Please include:

- the affected component (proxy, control API, Studio, CLI, recording/replay, mock) and version or commit;
- steps to reproduce, ideally against `tokenfault proxy --mock`;
- the impact you expect (for example credential exposure, SSRF, remote access, denial of service).

This is a volunteer-maintained project, so there is no guaranteed response time.
We aim to acknowledge reports promptly and to credit reporters who want to be credited.

## Scope

Of particular interest:

- ways to make the proxy contact a host other than the configured target (SSRF / open proxy);
- access to the control API or Studio from a non-loopback peer, a non-loopback `Host`, or another origin;
- leakage of `Authorization`/API keys or prompts into logs, sessions, recordings or the Studio;
- path traversal in Studio static serving or recording handling;
- malicious recording files causing code execution or unbounded resource use;
- XSS in the Studio from stream content.

The design, the mitigations and the known residual risks are documented in
[docs/engineering/THREAT_MODEL.md](docs/engineering/THREAT_MODEL.md). Behaviour listed there as an accepted
residual risk (for example, `--allow-remote` exposing the data path) is not a vulnerability by itself.

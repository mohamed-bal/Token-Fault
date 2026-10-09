# tokenfault

Command-line tool for debugging, inspecting and fault-testing OpenAI-compatible streaming (SSE) applications.
**Inspect. Replay. Break. Harden.**

> **Status:** pre-release (`0.x`). Not published to npm yet; build from source as described in the
> [repository README](https://github.com/mohamed-bal/Token-Fault#readme). Requires Node.js ≥ 22.12.

```bash
tokenfault proxy --mock                      # proxy + embedded mock LLM + Studio on http://127.0.0.1:8787
tokenfault inspect --scenario mid-stream-disconnect
tokenfault replay broken.tfrec.json          # reproduce a recorded failure, no model contacted
tokenfault scenarios                         # list built-in fault scenarios
tokenfault doctor                            # environment checks
```

The package ships the Studio web UI (`studio/`). The proxy prints a per-run **control token**; sign in to the Studio
with it, or send it as `Authorization: Bearer <token>` to the control API.

Run `tokenfault <command> --help` for every option. Documentation, security model and threat model:
<https://github.com/mohamed-bal/Token-Fault>.

## License

MIT. The bundled Studio includes third-party code listed in `studio/THIRD_PARTY_LICENSES.txt`.

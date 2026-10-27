# Bundled runtimes

`apps/desktop/resources/axle` is copied into the packaged app as `resources/axle`.

## Axle Offline

Run `pnpm local-runtime:install` from the repository root to download the official
llama.cpp `llama-server` build for this machine into:

```
apps/desktop/resources/axle/llama/<platform>-<arch>/
```

`pnpm build:desktop` copies this directory into the installer. At runtime the
server resolves the binary from `AXLE_LLAMA_SERVER_PATH`, then the bundled
resources, then `PATH`.

Supported directory names: `win32-x64`, `win32-arm64`, `darwin-x64`,
`darwin-arm64`, `linux-x64`, `linux-arm64`.

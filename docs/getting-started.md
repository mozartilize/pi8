# Getting started

[Overview](overview.md) · [Next: Configuration](configuration.md)

## Requirements

You need:

- A working [Pi installation](https://github.com/earendil-works/pi-coding-agent).
- At least one authenticated provider in Pi.
- A free [Artificial Analysis API key](https://artificialanalysis.ai/).
- Chromium for the `playwright-core` version that pi8 installs.
- Network access to the Artificial Analysis API and public models page during sync.

The package declares Pi peer dependencies of `>=0.87.0`. See [package.json](../package.json) for the exact dependency declarations.

Chromium is necessary for benchmark sync. Routed turns use the saved benchmark store and do not need Chromium.

## Install pi8

1. Open `~/.pi/agent/settings.json` for a user installation.
2. Add the package to the existing `packages` array:

   ```json
   {
     "packages": ["git:github.com/mozartilize/pi8"]
   }
   ```

3. Start Pi with that configuration.

For a project installation, use `.pi/settings.json` instead. Preserve other packages and settings when you edit the file.

For local development, use a checkout:

```sh
pi -e /path/to/pi8/index.ts
```

## Install Chromium

1. Open a terminal in the installed pi8 package directory.
2. Install the matching browser:

   ```sh
   npx playwright-core install --no-shell chromium
   ```

3. On Linux, install system libraries if Chromium cannot start:

   ```sh
   npx playwright-core install --no-shell --with-deps chromium
   ```

The system-library installation can require elevated privileges. Pi does not need a restart after the browser installation.

## Sync benchmark data

1. Run this command in Pi:

   ```text
   /router-sync <your-api-key>
   ```

2. Inspect the result:

   ```text
   /router-status
   ```

3. Check that the sync reports matched registry models.

The command saves the API key in the pi8 configuration. Do not share that file without removing the key.

Alternatively, set `ARTIFICIAL_ANALYSIS_API_KEY` before you start Pi. Then run `/router-sync` without an argument.

Sync reads both the API and the public models page. A source failure preserves the previous store.

Automatic routing needs data that includes models-page measurements. Without that data, the router returns a setup error before it calls a model.

## Start a routed session

1. Select `router/auto` in Pi's model picker.
2. Send a request.
3. Inspect the selection:

   ```text
   /router-why
   ```

With no serving model, the request starts as `gather`. The model inspects context before it declares the next task type.

You do not need to call the router's lifecycle tools yourself. The serving model uses them during the request.

## Control the model pool

The router can use all available providers when the `models` allowlist is empty.

To limit automatic routing, create `~/.pi/agent/pi8/config.json`:

```json
{
  "models": ["github-copilot/*"],
  "prompt": true
}
```

Check the allowlist:

```text
/router-models
```

See [Configuration](configuration.md) for exclusions and additional options.

## Use a concrete model

Select a concrete model in Pi to stop automatic turn routing. pi8 does not delegate that session's turns.

To pin a model while retaining `router/auto`, use `/router-manual`. See the [Command reference](commands.md#manual-model-control).

Use `/router-status` to inspect setup failures. See [Benchmark data](benchmark-data.md#refresh-behavior) for readiness requirements and refresh recovery.

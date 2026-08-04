# Andrey's Helper

The extension (`src/**`, TypeScript) and the orchestrator app (`orchestrator/Sources/**`,
Swift) ship together in one .vsix — `orchestrator/INTEGRATION.md`.

## Rebuild + reinstall every change — never ask, never just suggest it

Touched `src/**`, `cli/**`, `media/**`, `package.json` contributions,
`orchestrator/Sources/**`, `Package.swift`, `esbuild.js`, `build.sh`? Run this in the
same turn (~5s, covers both parts). Docs/`*.test.ts`-only changes: skip it.

```bash
npm test                        # fails → install nothing
# bump the patch version in package.json
./build.sh                      # type-check, bundle, rebuild the .app, package
cursor --install-extension andreys-helper-<version>.vsix --force
```

Never `SKIP_ORCHESTRATOR=1` here — ships a .vsix with no app, toggle silently hides.

**Orchestrator change + it was running:** `pkill -x AndreysOrchestrator`, then
`open orchestrator/build/AndreysOrchestrator.app`. Quit before launching — LaunchServices
dedupes per bundle path, so two paths = two circles. Was closed? Leave it closed.

**Extension change:** ask them to reload the window; never do it for them (restarts
webviews, kills live Claude panes). Don't call the change visible until they have.
New `contributes` entry needs the reinstall, not just a reload.

Report the version installed + what's left for them. `*.vsix` and `resources/orchestrator/`
are gitignored artifacts; building never touches git.

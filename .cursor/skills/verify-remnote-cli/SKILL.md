---
name: verify-remnote-cli
description: 验证 remnote-cli 仓库：用 node>=22 构建、跑 vitest 单测，并在隔离的 REMNOTE_CLI_CONFIG 里驱动 --version/--help、pair（私有配对文件）和 status 未连接路径。改本仓库后、提 PR 之前使用；不连真实 RemNote，也不覆盖已安装的 remnote-cli。插件在独立仓库 https://github.com/zeefan1555/remnote-cli-bridge。
---

# 验证 remnote-cli

用户界面是 `remnote-cli` 命令行：CLI 在本机回环端口开 WebSocket，RemNote 桌面端里的 [RemNote CLI Bridge](https://github.com/zeefan1555/remnote-cli-bridge) 连上来后才能读写知识库。box/CI 上没有已登录的 RemNote 和已配对插件，所以这里只驱动不需要插件的路径；读写 RemNote 的命令（search、create、flashcards apply、wiki…）属于真机验收，见 Gotchas。

## Launch

短命 CLI，无服务。在仓库根：

```bash
.cursor/skills/verify-remnote-cli/scripts/verify.sh all
```

- 需要 node >= 22.13（`package.json` engines）。脚本按顺序找：`$REMNOTE_NODE_BIN/node`、`~/.local/opt/node-v24.21.0-linux-x64/bin/node`、PATH 里的 `node`。
- `build` 模式在仓库根缺 `node_modules` 时先 `npm ci`，再 `npm run build`，产物 `dist/remnote-cli/index.js`。验证直接用这个产物，不用全局 `remnote-cli`（box 上 `~/.local/bin/remnote-cli` 指向另一个 checkout）。
- 每次运行用临时 `REMNOTE_CLI_CONFIG`（`remnote-verify.*/connection.json`）和一个空闲回环端口，可并行，不碰真实 `~/.config/remnote-cli/connection.json`。

## Doctor

```bash
node --version && test -f dist/remnote-cli/index.js && node dist/remnote-cli/index.js --version
```

node 必须 ≥ 22.13，版本号应等于根目录 `package.json` 的 `version`。

## Drive

`verify.sh <模式>`：

| 模式 | 驱动 | 断言 | feature |
|---|---|---|---|
| `build` | `npm ci`（按需）+ `npm run build` | 退出码 0 | [cli-surface](features/cli-surface.md) |
| `unit` | `npm test`（vitest） | `Test Files … passed` | [cli-surface](features/cli-surface.md) |
| `cli` | `--version`、`--help`、`flashcards --help` | 版本号、`Direct RemNote SDK automation`、`Preview a flashcards plan` | [cli-surface](features/cli-surface.md) |
| `pair` | `--kb-id verify-kb --port <空闲端口> pair` | 输出 `"paired":false`，不打印 token；配对文件权限 600，回读 kb/port/token | [pairing](features/pairing.md) |
| `status` | `--port <端口> status`（无插件） | 约 15 秒后退出码 1，`Plugin connection timed out` | [connection-status](features/connection-status.md) |
| `all` | 以上全部 | — | — |

需要更严格的代码门禁时，在仓库根另跑 `npm run quality`（eslint + prettier + typecheck，本地质量脚本同款）。

## Evidence

证据目录：`$VERIFY_EVIDENCE_ROOT/remnote-cli/<时间戳>/`（默认根 `/workspace/verify-evidence`，不可写时 `~/verify-evidence`），或第二个参数。每步一个日志，记录每条命令、输出（token 已打码）和退出码；`manifest.json` 记录 head、模式、node 版本、outcome。PR 贴 `outcome=… evidence=…` 和 vitest 汇总行。

证明标准：配对要回读文件内容和权限，不是只看命令输出；"未连接"要看到真实超时错误和退出码 1。离线检查不证明持久化（见仓库 AGENTS.md）。

## Cleanup

脚本 `trap` 删除临时配置目录；CLI 在命令结束时自行关闭端口，不留进程。`dist/` 和 `node_modules/` 是构建产物（已被 gitignore），可保留。证据目录保留。

## Helpers

- `scripts/verify.sh [all|build|unit|cli|pair|status] [证据目录]`：主入口，退出码 0 = passed。环境变量：`REMNOTE_NODE_BIN`（node 目录）、`VERIFY_PORT`（指定端口）、`VERIFY_EVIDENCE_ROOT`。

## Gotchas

- 读写 RemNote 的命令（search、read、create、journal、flashcards/wiki apply、sdk…）需要 RemNote 桌面端登录 + [RemNote CLI Bridge](https://github.com/zeefan1555/remnote-cli-bridge) 配对，box 上不跑；真机验收用仓库根的 `run-agent-integration-test.sh`，由能操作 RemNote 的 bot/用户执行，PR 里写 not-run。
- `status` 会等满 15 秒超时，属正常。
- 不要运行 `link-cli.sh` / `unlink-cli.sh` / `publish-to-npm.sh`：会改全局命令或发布包（发布未授权）。
- 插件改动在 [remnote-cli-bridge](https://github.com/zeefan1555/remnote-cli-bridge) 里测试和构建；插件只能在 RemNote 里真机验证。

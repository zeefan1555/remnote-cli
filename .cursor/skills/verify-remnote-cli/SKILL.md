---
name: verify-remnote-cli
description: 验证 remnote-cli 仓库：用 Node 22.13.0+ 构建、跑 vitest 单测，并在隔离的 REMNOTE_CLI_STATE_HOME 中驱动离线 help、schema、SDK help 和 doctor。改本仓库后、提 PR 之前使用；不连真实 RemNote，也不覆盖已安装的 remnote-cli。插件在独立仓库 https://github.com/zeefan1555/remnote-cli-bridge。
---

# 验证 remnote-cli

用户界面是 `remnote-cli` 命令行：CLI 在本机回环端口开 WebSocket，RemNote 桌面端里的 [RemNote CLI Bridge](https://github.com/zeefan1555/remnote-cli-bridge) 连上来后才能读写知识库。box/CI 上没有已登录的 RemNote，所以这里只驱动不需要 Bridge 的路径；读写 RemNote 的命令属于真机验收，见 Gotchas。

## Launch

短命 CLI，无服务。在仓库根：

```bash
.cursor/skills/verify-remnote-cli/scripts/verify.sh all
```

- 需要 node >= 22.13（`package.json` engines）。脚本按顺序找：`$REMNOTE_NODE_BIN/node`、`~/.local/opt/node-v24.21.0-linux-x64/bin/node`、PATH 里的 `node`。
- `build` 模式在仓库根缺 `node_modules` 时先 `npm ci`，再 `npm run build`，产物 `dist/remnote-cli/index.js`。验证直接用这个产物，不用全局 `remnote-cli`（box 上 `~/.local/bin/remnote-cli` 指向另一个 checkout）。
- 每次运行用临时 `REMNOTE_CLI_STATE_HOME`，不碰真实 journal、snapshot 或连接状态。

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
| `cli` | `--version`、`--help`、`rem create --help`、`rem update --help`、`rem update-answer --help`、`rem inspect --help`、拒绝旧 card 命令、`schema rem.search`、`sdk card --help` | 版本号、help 分区、Rem 命令帮助、旧命令未知和离线 SDK help | [cli-surface](features/cli-surface.md) |
| `offline` | `doctor --offline` | exit 0，Bridge check 为 skip | [connection-status](features/connection-status.md) |
| `all` | 以上全部 | — | — |

需要更严格的代码门禁时，在仓库根另跑 `npm run quality`（eslint + prettier + typecheck，本地质量脚本同款）。

## Evidence

证据目录：`$VERIFY_EVIDENCE_ROOT/remnote-cli/<时间戳>/`（默认根 `/workspace/verify-evidence`，不可写时 `~/verify-evidence`），或第二个参数。每步一个日志，记录每条命令、输出（token 已打码）和退出码；`manifest.json` 记录 head、模式、node 版本、outcome。PR 贴 `outcome=… evidence=…` 和 vitest 汇总行。

证明标准：离线检查必须看到 `--offline` 跳过了 Bridge。离线检查不证明持久化（见仓库 AGENTS.md）。

## Cleanup

脚本 `trap` 删除临时状态目录；CLI 在命令结束时自行关闭端口，不留进程。`dist/` 和 `node_modules/` 是构建产物（已被 gitignore），可保留。证据目录保留。

## Helpers

- `scripts/verify.sh [all|build|unit|cli|offline] [证据目录]`：主入口，退出码 0 = passed。环境变量：`REMNOTE_NODE_BIN`（node 目录）、`VERIFY_EVIDENCE_ROOT`。

## Gotchas

- 读写 RemNote 的命令需要 RemNote 桌面端登录 + [RemNote CLI Bridge](https://github.com/zeefan1555/remnote-cli-bridge)，box 上不跑；真机验收用仓库根的 `run-agent-integration-test.sh`，由能操作 RemNote 的 bot/用户执行，PR 里写 not-run。
- 不要运行 `link-cli.sh` / `unlink-cli.sh` / `publish-to-npm.sh`：会改全局命令或发布包（发布未授权）。
- 插件改动在 [remnote-cli-bridge](https://github.com/zeefan1555/remnote-cli-bridge) 里测试和构建；插件只能在 RemNote 里真机验证。

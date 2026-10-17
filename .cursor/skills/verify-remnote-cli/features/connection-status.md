# 连接状态

用户运行 `status` 确认插件已连上；未连上时得到明确错误而不是挂起。

## Sub-features

- `status-timeout` 无插件时 15 秒超时，退出码 1，提示打开 RemNote 检查配对。
- `status-connected` 插件在线时返回知识库与版本（真机）。

## How to get to it (user POV)

- `remnote-cli status`

## Driving it with verify.sh

Preconditions:

- 已有临时配对文件（脚本缺失时自动 `pair`），端口上没有插件。

- **未连接。** `verify.sh status`。约 15 秒后日志 `Plugin connection timed out` 与 `[exit 1]`。
- **已连接（真机）。** RemNote 打开且插件已配对时运行 `remnote-cli status`；box 上记 not-run。

## Gotchas

- `--port` 指定一个空闲端口，避免撞上机器上正在用的真实 CLI 端口。

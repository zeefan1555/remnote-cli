# 连接状态

用户运行 `doctor --offline` 确认安装和状态，不要求 RemNote 在线。

## Sub-features

- `doctor-offline` 不构造 client，Bridge 检查标记为 skip。
- `status-connected` 是单独的 live 真机检查。

## How to get to it (user POV)

- `remnote-cli doctor --offline`

## Driving it with verify.sh

Preconditions:

- **离线。** `verify.sh offline`。exit 0，输出 `offline: true`，Bridge check 为 skip。
- **已连接（真机）。** RemNote 打开时运行 `remnote-cli status`；box 上记 not-run。

## Gotchas

- 离线检查不证明 Bridge、权限、KB 绑定或写入。

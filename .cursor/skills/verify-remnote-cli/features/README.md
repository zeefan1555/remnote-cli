# remnote-cli 验证地图

本目录是验证 remnote-cli 用户可见行为的维护源。先读本索引，再按 feature 文件操作。插件仓库是 [remnote-cli-bridge](https://github.com/zeefan1555/remnote-cli-bridge)。

## 基线

- 仓库根运行 `.cursor/skills/verify-remnote-cli/scripts/verify.sh`；node ≥ 22.13。
- 临时 `REMNOTE_CLI_CONFIG` 与空闲回环端口，不碰真实配对文件和已安装的 remnote-cli。
- 用 `dist/remnote-cli/index.js` 驱动。

## 证明与跳过

- 记录命令、输出（token 打码）、退出码。
- 需要 RemNote 插件的读写路径记 not-run，不以单测冒充。

## Features

- [CLI 表面](./cli-surface.md)：构建、单测、版本和帮助。
- [配对](./pairing.md)：`pair` 生成私有配对文件。
- [连接状态](./connection-status.md)：`status` 在已配对/未连接时的行为。
- [闪卡计划与写入](./flashcards.md)：`flashcards apply` 预览与受控写入（真机）。

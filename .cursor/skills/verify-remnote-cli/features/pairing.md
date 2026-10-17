# 配对

用户为指定知识库生成私有配对文件，把 token 填进 RemNote 插件一次，之后 CLI 只接受该知识库。

## Sub-features

- `pair-create` 写配对文件（600），包含 protocolVersion、token、knowledgeBaseId、port。
- `pair-quiet` 命令输出不包含 token。

## How to get to it (user POV)

- `remnote-cli --kb-id <id> [--port <n>] pair`

## Driving it with verify.sh

Preconditions:

- 临时 `REMNOTE_CLI_CONFIG`（脚本自动设置）。

- **配对。** `verify.sh pair`。日志 `"paired":false` 和 `next` 提示；`pairing 文件权限 600`；回读 keys 为四项且 kb、port 与参数一致。

## Gotchas

- 真实配对文件在 `~/.config/remnote-cli/connection.json`，验证中绝不覆盖。
- token 只在文件里；不要把文件内容贴进 PR 或日志。

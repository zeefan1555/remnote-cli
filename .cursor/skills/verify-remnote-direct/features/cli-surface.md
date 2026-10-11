# CLI 表面

用户安装后能看到版本、全部命令和各子命令帮助；构建与单测是任何改动的基线。

## Sub-features

- `cli-build` `npm run build` 产出可执行入口。
- `cli-unit` vitest 全部通过。
- `cli-help` `--version`、`--help`、子命令 `--help` 正常输出。

## How to get to it (user POV)

- `remnote-cli --version`、`remnote-cli --help`、`remnote-cli flashcards --help`

## Driving it with verify.sh

Preconditions:

- node ≥ 22.13。

- **构建。** `verify.sh build`，日志末尾 tsc 无错误、退出码 0。
- **单测。** `verify.sh unit`，日志含 `Test Files  N passed`。
- **帮助。** `verify.sh cli`，日志含版本号、`Direct RemNote SDK automation`、`Preview a flashcards plan`。

## Gotchas

- node 20 能编译但不满足 engines；单测和运行用 node ≥ 22.13。

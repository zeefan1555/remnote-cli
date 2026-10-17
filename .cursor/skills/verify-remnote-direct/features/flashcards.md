# 闪卡计划与写入

RemNote bot 按 `skills/remnote/` 与 `fanloop-workflow/remnote-flashcards` 生成闪卡计划，先预览，再用 `--apply` 受控写入今日笔记。

## Sub-features

- `flashcards-preview` 不带 `--apply` 只输出计划。
- `flashcards-apply` 带 `--apply` 写入并回读。
- 答案行可以是单个代码块片段 `{"code","language?"}`；apply 后回执含 `answerLines`（`remId`、`isCardItem`、`hasCardStructure`）。
- 新建卡片和补丁都会在写文本前、以及 `setIsCardItem` 后再比对卡片事实。失败时该 `answerLines` 项为 `verified: false` 并带 `error`，回执不是 verified。代码块改回纯文本后仍保持 `isCardItem` true。
- 多条命令用 `batch --file` 共用一条 bridge。子命令帮助和用法错误留在 JSON 信封里，后面的命令继续执行。`batch --allow-destructive` 授权内部 `sdk`。
- `read` / `list-children` 可一次传多个 Rem ID，结果按 id 保留（包括 `__proto__`）。

## How to get to it (user POV)

- `remnote-cli flashcards apply --help` 查看输入格式；`remnote-cli flashcards apply ...` 预览；加 `--apply` 写入。

## Driving it with verify.sh

Preconditions:

- 需要 RemNote 桌面端已登录、插件已配对；box 上不具备。

- **帮助。** `verify.sh cli` 已覆盖 `flashcards --help`。
- **预览/写入（真机）。** 由 RemNote bot 在有 RemNote 的机器上按 `verify-remnote`（skills 仓库 remnote-flashcards 包内）执行并回读；box 上记 not-run。

## Gotchas

- 写入后必须回读目标状态；未知写入失败不要盲目重试（见仓库 AGENTS.md）。

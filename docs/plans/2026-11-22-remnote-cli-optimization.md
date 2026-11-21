# RemNote CLI 优化改造计划

目标是让 CLI 成为可独立迭代的操作运行时。Bridge 继续只提供状态、capability 和通用 SDK 调用。CLI 负责计划类型、读取编排、写入、恢复、验证和机器可读合同。

本计划只定义改造。它不授权改代码、写 RemNote 数据或发包。

## 交付结果

- 新卡、补丁和复用计划使用不同合法状态，字段错配在解析时失败。
- CLI 在写入前检查当前 SDK capabilities。
- 读密集型命令在一次执行内复用不可变快照。
- 写命令共享 precondition、journal、unknown outcome 和 verify 规则。
- Codex 插件可以读取 CLI schema 和 capability，不比较产品版本。
- 只有 BRIDGE-0 修改 RemNote CLI Bridge。合入后，Bridge 对 CLI 业务演进保持冻结。

## 落地顺序

| PR | 单一改动 | 依赖 | 分支基点 | 审查门禁 |
| --- | --- | --- | --- | --- |
| BRIDGE-0 | 协议 2，删除配对和 Bridge 设置，启用固定端口自动连接 | 无 | remnote-cli-bridge 最新 main | 安全与操作者审查 |
| CLI-0 | 采用协议 2，删除 pair 与持久连接配置 | BRIDGE-0 | remnote-cli 最新 main | 操作者审查 |
| CLI-1 | 固定 Bridge action，分发改为类型注册表 | CLI-0 | CLI-0 合入后的 main | 代码审查 |
| CLI-2 | 计划改成合法状态变体，加入 capability preflight | CLI-1 | CLI-1 合入后的 main | 操作者审查 |
| CLI-3 | 增加命令内只读 Session 和读取编排 | CLI-2 | CLI-2 合入后的 main | 代码审查 |
| CLI-4 | 抽出共享 mutation kernel | CLI-2 和 CLI-3 | CLI-3 合入后的 main | 操作者审查 |
| CLI-5 | 增加机器可读 contract | CLI-2、CLI-3 和 CLI-4 | CLI-4 合入后的 main | 操作者审查 |

七个 PR 串行落地。BRIDGE-0 在 Bridge 仓库完成，CLI-0 到 CLI-5 在 CLI 仓库完成。`direct-client.ts`、`task-operations.ts` 和 schema 文件跨多个 CLI PR，并行会增加冲突和验收歧义。

## 全局验收规则

每个 PR 只改一个主题，并包含对应测试和必要文档。性能基线先在同环境 main 上测量。记录运行数、中位数、范围、SDK 调用数和限制因素。live 测试使用明确测试对象和可逆操作。写入结果不明时保留 receipt 和精确 ID，先只读对账。

## 零配置安全边界

默认信任边界是当前操作系统用户。Bridge 安装并批准 RemNote 官方权限后，同一用户运行的任何本地进程都能调用 RemNote SDK。这是删除配对 token 后的明确代价。

CLI 仍拒绝来自普通网页 Origin 的连接。BRIDGE-0 记录 RemNote 实际发送的 Origin，并只允许该 Origin。原生本地进程可以伪造 Origin，因此这一检查隔离浏览器页面，不隔离同用户恶意程序。

RemNote 安装时的官方 scope 授权保留。它属于 RemNote 权限模型，不是 Bridge 自定义设置。

## BRIDGE-0 零配置本地信任

- [x] 依赖为 Bridge 仓库最新 main（`d80ff3a`）。
- [x] 允许文件：manifest/version、protocol、runtime、WebSocket client、SDK executor、widgets、测试、README/AGENTS、连接文档、ADR 和 CHANGELOG；删除 `src/settings.ts`。
- [x] 改动：协议升到 2。删除 token、HMAC 配对、CLI URL 设置、写开关和破坏性开关。Bridge 固定连接 `ws://127.0.0.1:3002/`，报告当前活动 KB 和 live SDK catalog，通过 `sdk_call` 暴露 catalog 内全部获授权的 SDK 方法。
- [x] 用户可见结果：安装并批准 RemNote 权限后，不再打开设置页，不输入 token，不填端口或 KB。CLI 命令启动时 Bridge 自动连接。侧边栏只显示连接状态。
- [x] 安全门禁：实际 RemNote upgrade Origin 记录为字面值 `null`；CLI 只允许该值，缺失/未知 Origin 返回 403。文档明确同用户本地进程信任边界。
- [x] 单测：覆盖协议 2 handshake、固定 URL、活动 KB 变化、无 token、无写开关、完整 SDK catalog、未知/私有/unsupported 能力拒绝、Origin 检查和资源上限。Bridge 86/86，完整 coverage 行 91.57%。
- [x] live：已把旧 pairing 文件移入备份、重载本地插件源并以 0.26.0 连接。`status` 为 protocol 2、KB `byte`、SDK 0.0.46；RemNote 侧无自定义 Bridge 设置。
- [x] 性能：稳定环境连续 10 次 status；shell/version p95 161ms，端口绑定 p95 4ms，Bridge ready p95 407ms，整条命令 p95 568.5ms；每次 2 个 SDK 调用。RemNote 刚重启后的首个命令另记约 3.6s，属于桌面插件启动，不计稳定 p95。

## CLI-0 删除配对和连接设置

- [x] 依赖为 BRIDGE-0 已构建并发布到本机插件源。
- [x] 允许文件：CLI/options、connection、direct client、state path、相关 unit/integration tests、README/AGENTS/architecture/installation/command/troubleshooting/task docs、`skills/remnote/SKILL.md`；删除 `connection-config.ts`。
- [x] 改动：删除 `pair` 命令、token schema 和持久连接配置。CLI 固定监听 `127.0.0.1:3002`。客户端读取 Bridge 报告的活动 KB，可选 `--kb-id` 仅用于显式校验。文件状态改放 `$XDG_STATE_HOME/remnote-cli`，测试用 `REMNOTE_CLI_STATE_HOME` 隔离。
- [x] 用户可见结果：全新机器只安装 Bridge、批准 RemNote 权限、安装 CLI。任意 CLI 命令直接工作，没有初始化步骤，没有配置文件，没有 token，没有端口或 KB 设置。
- [x] 单测：删除 pairing 测试，覆盖无配置启动、协议 2、活动 KB、错误 Origin、固定端口占用、可选 KB、请求 ID 和资源上限。CLI 1283/1283，完整 coverage 行 91.02%。
- [x] live：旧 pairing 文件已移到保留备份；321 个旧状态文件和 journal 合并到标准状态目录。`status`、精确读取和同文本 patch-only apply 均通过；patch=`verified`，CardID `B0ImItzQdm8XG6Fc9` 与复习历史不变，命令后无新 token 文件。
- [x] 性能：无配置 status 连续 10 次，shell/version p95 161ms，ready p95 407ms，整条命令 p95 568.5ms；SDK 调用保持 2 个。

## CLI-1 固定 Bridge action

- [x] 依赖：CLI-0 已合入（`f4c58f9`）。
- [x] 允许文件：connection、direct client、新增 `remote-actions.ts`、相关 tests、architecture 和版本/CHANGELOG。
- [x] 改动：定义只含 `get_status`、`get_sdk_capabilities`、`sdk_call` 的类型注册表。每项绑定 payload schema 和 handler；未知 action/非法 payload 在建监听器前失败。
- [x] 用户可见结果：现有帮助和输出不变。第四个 Bridge action 被拒绝；漏绑由 `satisfies Record` 在 typecheck 时失败。
- [x] 单测：typecheck、lint、format、SDK constants、build 和 targeted tests 均通过；新增 registry/未知 action/payload 测试。
- [x] live：本地 0.26.1 连接 protocol 2；精确读取 `w8Ya0iydcYplkx1a9`，标题、KB 和卡方向一致。
- [x] 性能：status 10 次 p50 wall 282.4ms、p95 wall 1157.5ms；ready p50 91ms、p95 970ms；每次 2 个 SDK 调用。

## CLI-2 合法计划状态

- [ ] 依赖：CLI-1 已合入。
- [ ] 允许文件：`src/schemas/task-schemas.ts`、`src/business/task-operations.ts`、`src/remnote-cli/commands/task.ts`、新增 `src/business/operation-capabilities.ts`、`test/unit/task-schemas.test.ts`、`test/unit/business/task-operations.test.ts`、`docs/guides/task-plans.md`、`skills/remnote/SKILL.md`。
- [ ] 改动：把 flashcard plan 内部模型拆成 `create`、`patch`、`reuse` 和显式 `mixed`。每种变体只拥有合法字段。边界 parse 返回该变体，执行器不再重复验证。每个变体声明所需 SDK capabilities，首个 mutation 前统一核对。
- [ ] 用户可见结果：只有 `schemaVersion` 和 `answerPatches` 的 patch plan 合法。create plan 缺少 daily 或标签时返回字段级错误。缺 capability 时在写入前失败。
- [ ] 单测：覆盖全部变体、非法组合、缺 capability、catalog 变化和重复校验删除。运行完整质量命令及 coverage。
- [ ] live：用已有测试卡执行同文本 patch-only apply，不传 daily、HOME、Term、标题或新卡字段。通过条件是 receipt=verified，CardID 和可读复习历史不变。
- [ ] 性能：100 条 answer patch 的解析和预览各跑 20 次。p95 比 main 基线上涨超过 10% 即失败。SDK 调用数不得增加。

## CLI-3 命令内只读 Session

- [ ] 依赖：CLI-2 已合入。
- [ ] 允许文件：新增 `src/remnote-cli/client/session.ts`、新增 `src/business/read-session.ts`、`src/remnote-cli/client/connection.ts`、`src/remnote-cli/client/direct-client.ts`、`src/business/rem-adapter.ts`、`src/business/inspection.ts`、`src/business/workspace/read-pool.ts`、相关 unit tests、新增 `scripts/bench-cli-read-session.mjs`、`docs/architecture.md`。
- [ ] 改动：新增命令生命周期内的只读 Session，按 Rem、字段和 capability 去重读取，依赖调度有界并发，并在 mutation 后失效相关快照。先只迁移 `context` 和 `inspect`。
- [ ] 用户可见结果：相同输入返回相同对象顺序、ID 和 hash。缓存不跨命令，不保存 SDK 句柄。mutation 后最终验证重新读取。
- [ ] 单测：覆盖重复 ID、重叠字段、读取失败、并发上限、mutation 后失效和最终验证绕过缓存。运行完整质量命令及 coverage。
- [ ] live：对已知父子子树运行旧版和候选版 `context`，比较完整 JSON 语义。再执行同文本 patch，随后重新读取并确认新值可见。
- [ ] 性能：固定 20 个已知 Rem，main 先跑 10 次。候选版必须减少至少 20% SDK 调用，输出语义一致，p95 不得上涨超过 10%。否则失败，不增加更多缓存层。

## CLI-4 共享 mutation kernel

- [ ] 依赖：CLI-2 和 CLI-3 已合入。
- [ ] 允许文件：新增 `src/business/operation-kernel.ts`、`src/business/task-operations.ts`、`src/business/workspace/resume.ts`、`src/business/workspace/local.ts`、`test/unit/business/operation-kernel.test.ts`、`test/unit/business/task-operations.test.ts`、`test/unit/business/workspace-resume.test.ts`、`docs/guides/task-plans.md`。
- [ ] 改动：抽出 precondition、mutation 顺序、journal、unknown outcome 对账和 verify。flashcard 计划先迁移到 kernel。workspace sync 只复用 journal 和 reconcile 接口。
- [ ] 用户可见结果：每次 mutation 前 journal 已持久化。receipt 区分 verified、partial、unknown、incomplete 和 conflict。同 key 重放不产生重复卡，未知结果不自动重试。
- [ ] 单测：用 in-memory backend 在每一步前后注入失败，覆盖崩溃恢复、重复执行、stale precondition 和 disconnect。运行完整质量命令及 coverage。
- [ ] live：在批准测试主题中执行 patch-only apply、同 key 重放和 create preview。通过条件是 patch=verified，重放不新增卡，CardID 和复习历史不变。
- [ ] 性能：同一 live 场景记录 mutation 数、读调用数和 p95。mutation 数必须与 main 相同。p95 上涨超过 10% 即失败。

## CLI-5 机器可读 contract

- [ ] 依赖：CLI-2、CLI-3 和 CLI-4 已合入。
- [ ] 允许文件：新增 `src/remnote-cli/commands/contract.ts`、新增 `src/schemas/contract.ts`、`src/remnote-cli/cli.ts`、新增 `scripts/generate-cli-contract.mjs`、`test/unit/remnote-cli/contract-command.test.ts`、`test/unit/cli-contract.test.ts`、`README.md`、`docs/guides/remnote-cli-command-reference.md`。
- [ ] 改动：增加 `remnote-cli contract --json` 和 `remnote-cli contract --schema flashcards|wiki|workspace`。输出协议、plan schema、所需 capabilities、receipt 和退出码。命令不连接 RemNote。
- [ ] 用户可见结果：Codex 插件可读取 contract。缺少 pairing file 或 RemNote 未运行时命令仍成功。参考文档由 contract 生成或校验。
- [ ] 单测：校验 JSON Schema、每个 plan 的 schema、文档生成无差异和未知 schema 退出码。运行完整质量命令及 coverage。
- [ ] live：使用空的临时状态目录运行构建后的 `contract --json`。通过条件是命令成功、包含全部 plan 标识且不监听 loopback 端口。
- [ ] 性能：`contract --json` 冷启动 10 次。p50 超过 300 ms 或发生任何 Bridge 请求时失败。记录 shell 启动和 JSON 生成耗时。

## 不在本计划

- BRIDGE-0 之后不再给 Bridge 增加制卡、标签、恢复或 batch 业务 action。
- 不加 daemon、持久正文快照或 SDK 句柄缓存。
- 不一次性重写 `rem-adapter.ts`。先只优化 `context` 和 `inspect`，有收益再扩面。
- 不立即增加 Bridge 批量 RPC。只有 CLI 去重和 Session 完成后，远程调用时间仍占 p50 主要部分，且独立调用仍超过 20 次，才另立 Bridge 实验 PR。
- 不把 task 和 sync 合成巨型业务模块。只共享 precondition、journal、reconcile 和 verify。

## 未证明事项

- CLI-3 的实际 SDK 调用降幅和延迟收益要由 main 基线测量。
- CLI-4 是否增加 p95 要由 live 场景决定。
- Bridge 批量 RPC 是否有价值要等 CLI 优化后再测。
- 零配置连接的 p95 和 RemNote 实际 Origin 要由 BRIDGE-0 真实测试取得。
- Codex remnote 插件改用 contract 是 CLI-5 合入后的独立变更。


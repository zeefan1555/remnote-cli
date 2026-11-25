# Rem 卡片文本与检查

卡片使用 RemNote 官方文本，通过 `card create` 创建。题面使用 `rem update`，
已有直接答案使用 `rem update-answer`，卡片和复习事实使用 `rem inspect`。

## 离线验证

- `verify.sh cli` 检查 card create、update、update-answer、inspect 和低层 SDK card help。
- 行为测试确认 card create 只接收直接官方文本，旧的 apply、review-stats 和任务 schema 已消失。
- `native-card-commands.test.ts` 通过真实命令解析和 mock SDK 回读，检查
  `rem inspect --fields cards,rawCards` 的 CardID、类型、创建时间、调度和可读历史。
- `rem-text-update.test.ts` 保留题面与答案更新的 hash、身份和历史保护测试。

## 真机边界

真机读写需要 RemNote 桌面端登录、协议 2 Bridge 和明确授权。
离线 mock 不证明原生持久化。真机验收未获授权时记 not-run。
未知写入先按精确 ID 回读，不盲目重试。

export const title = '局部读回不能代替首尾完整证明';

export function state({ s }) {
  if (s.missingRelations) return '错误：用旧字段填补了本次缺失事实';
  if (s.badCard) return '错误：认可了已变的 Card ID';
  if (s.badHistory) return '错误：认可了已变的复习历史';
  if (s.writes > 0 && s.initialCover.length !== 3) return '错误：首写缺少完整范围检查';
  if (s.published && s.finalCover.length !== 3) return '错误：局部读回冒充完整证明';
  if (s.verified.includes(1) && !s.postCover[1].includes(2))
    return '错误：本步核验漏掉已移除 Tag 的目标';
  if (s.phase === 'blocked') return '观测冲突后保留 journal 并停止';
  if (
    ['select', 'nextRem', 'readRevision', 'readCards', 'readTags', 'readPowerup', 'check'].includes(
      s.phase
    )
  )
    return {
      initial: '首写前完整范围读回',
      before: '下一步按当前关联范围读回',
      after: '写后核对写前与写后关联范围的并集',
      final: '完成前重新读回完整范围',
    }[s.round];
  return {
    write: '本步写前检查通过',
    reply: '一次原子写已生效并等待答复',
    persistVerified: '本步关联范围已精确观测',
    advance: '本步核验已落盘',
    persistProof: '完整范围观测符合预期',
    publish: '完整完成证明已落盘',
    done: '允许发布观测快照',
  }[s.phase];
}

export function step(action) {
  return (
    {
      SelectReadSet: '选择本轮读取范围',
      NextRem: '进入下一精确 ID',
      ReadRevision: '读取内容与结构',
      ReadCards: '读取原生 Card ID 和历史',
      ReadTags: '读取原生 Tag',
      ReadPowerup: '读取已知 Powerup',
      CheckObserved: '核对本轮原始观测',
      SdkWrite: '提交一次原子关系写',
      ReceiveReply: '收到答复后更新预期',
      PersistVerified: '持久化本步已核验',
      Advance: '继续后续步骤或最终检查',
      PersistProof: '持久化完整观测证明',
      Publish: '授权发布观测快照',
      ExternalEdit: '发生外部变化或读回缺项',
      Stopped: '保持停止',
    }[action] ?? action
  );
}

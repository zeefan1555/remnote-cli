export const title = '精确观测不是远端事务';
const names = {
  guard: '写前检查',
  write: '准备写入',
  reply: '写入已生效，等待答复',
  readback: '写入已完成',
  verify: '已读回',
  persistProof: '观测符合预期',
  publish: '已保存观测证明',
  done: '已发布',
  blocked: '发现冲突并停止',
};
export function state({ s }) {
  if (s.published && s.atPublication !== s.proof) return '快照已发布，远端已经变化';
  return `${names[s.phase]}${s.edited ? '，发生过外部编辑' : ''}`;
}
export const step = (action) =>
  ({
    ReadGuard: '读取写前状态',
    SdkWrite: '单次 SDK 写入',
    ReceiveReply: '收到答复并更新预期',
    ReadBack: '读取写后状态',
    Verify: '校验观测',
    PersistProof: '保存证明',
    ExternalEdit: '用户编辑原生内容',
    Publish: '发布已观察的快照',
    Stopped: '保持停止',
  })[action] ?? action;

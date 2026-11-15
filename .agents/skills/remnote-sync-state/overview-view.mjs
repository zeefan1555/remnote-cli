export const title = '同步写入与完成证明';

export function state({ s }) {
  if (s.phase.startsWith('before')) return '核对写前输入与观测';
  if (s.phase.startsWith('after')) return '核对写后输入与观测';
  if (s.phase.startsWith('final')) return '重新读取完整结果';
  if (s.phase === 'awaitReply')
    return s.applied[s.i] < s.sends[s.i] ? '等待原子写生效' : '写已生效 等待答复';
  return (
    {
      persistStarted: '准备记录本步开始',
      send: '本步开始已落盘',
      persistId: '收到新 ID 尚未保存',
      acceptEffect: '已保存 ID 或收到关系答复',
      persistVerified: '准备记录本步已核验',
      advance: '本步核验已落盘',
      persistFinal: '完整结果已观测',
      publicationInput: '完成证明已落盘',
      publish: '发布前再次检查原输入',
      done: '允许发布观测快照',
      blocked: '停止并保留 journal',
    }[s.phase] ?? s.phase
  );
}

export { step } from './view.mjs';

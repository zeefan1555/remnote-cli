import { state as compactState } from './readset-view.mjs';
export { step, title } from './readset-view.mjs';

const rounds = {
  initial: '首写完整检查',
  before: '下一步局部检查',
  after: '本步写后并集检查',
  final: '最终完整检查',
};
const phases = {
  select: '选择读取范围',
  nextRem: '选择下一个精确 ID',
  readRevision: '准备读取内容与结构',
  readCards: '准备读取 Card ID 与历史',
  readTags: '准备读取原生 Tag',
  readPowerup: '准备读取已知 Powerup',
  check: '准备核对本轮观测',
};
const rems = { 1: '被改卡片', 2: '旧 Tag 目标', 3: '另一分支', 4: '本轮读取结束' };

export function state({ s }) {
  const compact = compactState({ s });
  if (compact.startsWith('错误')) return compact;
  const phase = phases[s.phase];
  const label = phase
    ? `${rounds[s.round]} 第${s.i}步 ${rems[s.cursor]} ${phase}`
    : `第${s.i}步 ${compact}`;
  return s.edited ? `${label} 已发生外部变化` : label;
}

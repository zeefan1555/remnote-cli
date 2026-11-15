export const title = '同步中断与精确恢复';

const labels = {
  beforeInput: '读取写前本地输入',
  beforeNew: '准备检查本次写入',
  beforeTags: '读取已有关系',
  beforeGuard: '核对预期状态',
  persistStarted: '准备记录已开始',
  send: '已记录开始，尚未调用',
  awaitReply: '等待写入答复',
  persistId: '拿到新 ID，尚未保存',
  acceptEffect: '保存已知 ID 或写入效果',
  afterInput: '读取写后本地输入',
  afterNew: '读取写后状态',
  afterTags: '读取写后关系',
  afterGuard: '核对写后状态',
  persistVerified: '准备记录已核验',
  advance: '本步已核验',
  resumeOffline: '按原 journal 恢复',
  resumeNew: '按已知 ID 读取',
  resumeTags: '读取已尝试关系',
  resumeGuard: '只认可完整写后状态',
  resumePersist: '准备保存已认可的前缀',
  finalNew: '最终核验',
  finalTags: '最终核验',
  finalGuard: '最终核验',
  persistFinal: '保存精确观测证明',
  publicationInput: '重新检查本地输入',
  publish: '准备发布已核验快照',
  done: '发布已获授权',
  blocked: '停止，保留 journal 与已知 ID',
};

export function state({ s }) {
  if (s.authorized && !s.proofExact) return '错误，未经精确核验就发布';
  if (s.authorized && s.publicationInput !== 0) return '错误，输入已变仍发布';
  if (s.known !== s.firstKnown && s.firstKnown !== 0) return '错误，丢失原有 ID';
  if (s.created.length > 1) return '错误，重复创建';
  if (Object.values(s.sends).some((n) => n > 1)) return '错误，重放已尝试写入';
  return labels[s.phase] ?? s.phase;
}

const actions = {
  ReadGuardInput: '读取冻结输入的当前状态',
  ReadNew: '按已知 ID 读取',
  ReadTags: '读取原生 Tag 集合',
  CheckBefore: '核对内容和输入',
  PersistStarted: '持久化已开始',
  SendSdkCall: '提交一次原子 SDK 调用',
  SdkCreate: 'SDK 创建节点',
  SdkAddTag: 'SDK 添加关系',
  ReceiveReply: '收到写入答复',
  PersistId: '持久化新 ID',
  AcceptEffect: '更新本轮预期',
  CheckAfter: '核对写后观测',
  PersistVerified: '持久化已核验',
  Advance: '进入后续步骤',
  Interrupt: '进程或连接中断',
  ResumeOffline: '校验原输入和 journal',
  CheckResume: '核对完整已尝试前缀',
  PersistRecognized: '保存已核验前缀，不重放',
  CheckFinalObservation: '核对最终观测',
  PersistFinal: '持久化完成证明',
  ReadPublicationInput: '读取本地输入',
  AuthorizePublication: '授权发布原输入的快照',
  ExternalTag: '用户修改原生关系',
  LocalEdit: '用户修改本地内容',
  Stopped: '保持停止',
};

export const step = (action) => actions[action] ?? action;

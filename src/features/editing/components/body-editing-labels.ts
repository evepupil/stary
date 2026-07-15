import type { BodyEditingPhase } from '../use-body-editing';

export const BODY_EDITING_PHASE_LABELS: Record<BodyEditingPhase, string> = {
  syncing: '同步正式快照',
  editing: '等待有效参数',
  previewing: '轨道试算中',
  'preview-error': '试算失败',
  ready: '可以写入模拟',
  'delete-ready': '等待删除确认',
  submitting: '正在写入物理核心',
  conflicted: '正式状态已变化',
};

import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 分项支出台账的专用规则：逐级流转、编号去重、凭证号拦截、审批回写派工，都收在这一个文件里。
const EXPENSE_KEY = 'expense'
const LABOR_KEY = 'labor'

// 状态只能逐级走：已登记 → 已复核 → 已审批 → 已入账，动作与前置状态一一对应，不许跳着改。
const FLOW: Record<string, { from: string; to: string }> = {
  提交复核: { from: '已登记', to: '已复核' },
  通过审批: { from: '已复核', to: '已审批' },
  确认入账: { from: '已审批', to: '已入账' },
}
const FINAL_STATUS = '已入账'

export type ExpenseInput = {
  支出编号: string
  经费科目: string
  报销金额: number
  凭证号: string
  经办人: string
}

export type SubjectSummary = {
  经费科目: string
  笔数: number
  金额合计: number
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function today(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/** 当前状态下一步唯一可走的动作；已入账返回 null 表示办结。 */
export function nextAction(status: string): string | null {
  for (const [action, step] of Object.entries(FLOW)) {
    if (step.from === status) {
      return action
    }
  }
  return null
}

/** 登记一条支出：支出编号只受理第一次，重复提交保留先受理的那一版。 */
export function registerExpense(input: ExpenseInput): ActionResult {
  const 支出编号 = input.支出编号.trim()
  const 经费科目 = input.经费科目.trim()
  const 经办人 = input.经办人.trim()
  const 凭证号 = input.凭证号.trim()
  if (!支出编号 || !经费科目 || !经办人) {
    return { ok: false, message: '支出编号、经费科目、经办人都要填，凭证号可在入账前补齐' }
  }
  if (!Number.isFinite(input.报销金额) || input.报销金额 <= 0) {
    return { ok: false, message: '报销金额要填大于 0 的数字' }
  }
  const rows = listRows(EXPENSE_KEY)
  if (rows.some((row) => String(row.支出编号) === 支出编号)) {
    return { ok: false, message: `支出编号 ${支出编号} 已受理过，只保留先受理的那一版，本次不重复登记` }
  }
  const row: EntryRow = {
    id: nextId(rows),
    status: '已登记',
    pending: true,
    abnormal: false,
    支出编号,
    经费科目,
    报销金额: round2(input.报销金额),
    凭证号,
    经办人,
    登记日期: today(),
    支出状态: '已登记',
  }
  saveRows(EXPENSE_KEY, [...rows, row])
  return { ok: true, message: `支出 ${支出编号} 已登记，当前状态「已登记」，下一步提交复核` }
}

/** 推进状态：只允许走下一步，审批通过时回写用工派工清单，入账前拦下缺凭证号的记录。 */
export function advanceExpense(id: number, action: string): ActionResult {
  const step = FLOW[action]
  if (!step) {
    return { ok: false, message: `支出记录没有登记「${action}」这个动作` }
  }
  const rows = listRows(EXPENSE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的支出记录` }
  }
  const current = String(rows[index].status)
  if (current !== step.from) {
    return {
      ok: false,
      message: `报销状态只能逐级流转：当前「${current}」，不能跳着做「${action}」，请先完成上一环节`,
    }
  }
  if (action === '确认入账' && String(rows[index].凭证号 ?? '').trim() === '') {
    return { ok: false, message: '凭证号缺失，先挡下：补齐凭证号后才能入账' }
  }
  const updated: EntryRow = {
    ...rows[index],
    status: step.to,
    支出状态: step.to,
    pending: step.to !== FINAL_STATUS,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(EXPENSE_KEY, next)
  if (action === '通过审批') {
    writeBackLabor(updated)
  }
  return { ok: true, message: `支出记录已${action}，当前状态「${step.to}」` }
}

/** 补录凭证号：入账前随时可以补，入账后不再改动。 */
export function updateVoucher(id: number, voucher: string): ActionResult {
  const value = voucher.trim()
  if (!value) {
    return { ok: false, message: '凭证号不能为空' }
  }
  const rows = listRows(EXPENSE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的支出记录` }
  }
  if (String(rows[index].status) === FINAL_STATUS) {
    return { ok: false, message: '这笔支出已入账，凭证号不再改动' }
  }
  const next = [...rows]
  next[index] = { ...rows[index], 凭证号: value }
  saveRows(EXPENSE_KEY, next)
  return { ok: true, message: `支出 ${String(rows[index].支出编号)} 已补录凭证号 ${value}` }
}

/** 按科目归总：汇总永远由明细现算，两处金额天然一致。 */
export function summarizeBySubject(rows: EntryRow[]): SubjectSummary[] {
  const grouped = new Map<string, SubjectSummary>()
  for (const row of rows) {
    const subject = String(row.经费科目 ?? '').trim() || '未分科目'
    const amount = Number(row.报销金额) || 0
    const item = grouped.get(subject) ?? { 经费科目: subject, 笔数: 0, 金额合计: 0 }
    item.笔数 += 1
    item.金额合计 = round2(item.金额合计 + amount)
    grouped.set(subject, item)
  }
  return [...grouped.values()].sort((a, b) => a.经费科目.localeCompare(b.经费科目, 'zh'))
}

export function totalAmount(rows: EntryRow[]): number {
  return round2(rows.reduce((sum, row) => sum + (Number(row.报销金额) || 0), 0))
}

// 审批通过后往用工派工清单落一条待结算工日；同一支出编号只落一次，不产生两条记录。
function writeBackLabor(expense: EntryRow): void {
  const 支出编号 = String(expense.支出编号)
  const rows = listRows(LABOR_KEY)
  if (rows.some((row) => String(row.关联支出编号 ?? '') === 支出编号)) {
    return
  }
  const id = nextId(rows)
  let 派工编号 = `LABO-${String(id).padStart(4, '0')}`
  while (rows.some((row) => String(row.派工编号) === 派工编号)) {
    派工编号 = `LABO-${String(Number(派工编号.slice(5)) + 1).padStart(4, '0')}`
  }
  const row: EntryRow = {
    id,
    status: '待派工',
    pending: true,
    abnormal: false,
    派工编号,
    作业区域: '支出台账回写',
    用工类别: String(expense.经费科目),
    出工人数: 1,
    带队人: String(expense.经办人),
    出工日期: today(),
    结算工日: '待结算',
    派工状态: '待结算',
    关联支出编号: 支出编号,
  }
  saveRows(LABOR_KEY, [...rows, row])
}

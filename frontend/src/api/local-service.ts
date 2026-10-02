import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 审批通过后要回写的目标清单：分项支出审批一过，用工派工就落一条待结算工日。
const APPROVAL_WRITEBACK: Record<string, { module: string; status: string }> = {
  expense: { module: 'labor', status: '已审批' },
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function createEntry(key: string, values: Record<string, string | number>): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const codeField = meta.fields[0]
  const code = String(values[codeField] ?? '').trim()
  if (!code) {
    return { ok: false, message: `${codeField}不能为空` }
  }
  // 同一笔编号重复提交只保留先受理的那一版，后面的一律挡下，不产生两条记录。
  if (rows.some((row) => String(row[codeField]) === code)) {
    return { ok: false, message: `${codeField} ${code} 已受理，重复提交只保留先登记的那一版` }
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const entry: EntryRow = {
    id: nextId,
    status: meta.statuses[0],
    pending: true,
    abnormal: false,
  }
  for (const field of meta.fields) {
    entry[field] = values[field] ?? ''
  }
  saveRows(key, [...rows, entry])
  return { ok: true, message: `${meta.entity}已登记，当前状态「${meta.statuses[0]}」` }
}

export function updateEntry(
  key: string,
  id: number,
  patch: Record<string, string | number>,
): ActionResult {
  const meta = moduleMeta(key)
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  if (String(rows[index].status) === lastStatus) {
    return { ok: false, message: `${meta.entity}已经「${lastStatus}」，落定后的记录不能再改` }
  }
  const next = [...rows]
  next[index] = { ...rows[index], ...patch }
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已更新` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 逐级流转：登记了起始状态的动作只能从那一档走，中途不许跳着改。
  const source = meta.actionSources?.[action]
  if (source && current !== source) {
    return {
      ok: false,
      message: `${meta.entity}只能逐级流转：「${action}」要从「${source}」走，当前是「${current}」`,
    }
  }
  // 前置要件：比如凭证号缺失时先挡下，补齐后才能入账。
  const missing = (meta.actionRequires?.[action] ?? []).filter(
    (field) => String(rows[index][field] ?? '').trim() === '',
  )
  if (missing.length > 0) {
    return { ok: false, message: `${missing.join('、')}缺失，先补齐才能${action}` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  const writeback = syncApprovalWriteback(key, target, updated)
  const suffix = writeback ? '，用工派工清单已落一条待结算工日' : ''
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${suffix}` }
}

// 审批通过的回写：往用工派工清单补一条待结算工日；同一笔支出只落一条，不重复入账。
function syncApprovalWriteback(key: string, target: string, row: EntryRow): boolean {
  const rule = APPROVAL_WRITEBACK[key]
  if (!rule || rule.status !== target) {
    return false
  }
  const rows = listRows(rule.module)
  const dispatchCode = `SETT-${String(row['支出编号'] ?? row.id)}`
  if (rows.some((item) => item['派工编号'] === dispatchCode)) {
    return false
  }
  const nextId = rows.reduce((max, item) => Math.max(max, Number(item.id)), 0) + 1
  const today = new Date().toISOString().slice(0, 10)
  saveRows(rule.module, [
    ...rows,
    {
      id: nextId,
      status: '待派工',
      pending: true,
      abnormal: false,
      派工编号: dispatchCode,
      作业区域: '报销回写',
      用工类别: String(row['经费科目'] ?? '—'),
      出工人数: 1,
      带队人: String(row['经办人'] ?? '—'),
      出工日期: today,
      结算工日: '待结算',
      派工状态: '待结算',
    },
  ])
  return true
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

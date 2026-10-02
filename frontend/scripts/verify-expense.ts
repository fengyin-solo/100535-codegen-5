// 规则验证脚本：模拟浏览器 localStorage，把台账的关键规则逐条跑一遍。
const store = new Map<string, string>()
;(globalThis as any).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
  },
}

import { createEntry, listEntries, runAction, updateEntry } from '../src/api/local-service'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`PASS  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}`, extra ?? '')
  }
}

// 1. 逐级流转：登记 → 复核 → 审批 → 入账，不许跳着改
let r = createEntry('expense', { 支出编号: 'EXP-1001', 经费科目: '发掘用工', 报销金额: 500, 凭证号: 'VCH-1', 经办人: '张三' })
check('登记新支出', r.ok, r)
const id = Number(listEntries('expense', { 支出编号: 'EXP-1001' }).items[0].id)

r = runAction('expense', id, '提交审批')
check('登记后直接审批被挡下（不许跳档）', !r.ok, r)
r = runAction('expense', id, '登记入账')
check('登记后直接入账被挡下（不许跳档）', !r.ok, r)
r = runAction('expense', id, '提交复核')
check('登记→复核 放行', r.ok, r)
r = runAction('expense', id, '登记入账')
check('复核后直接入账被挡下', !r.ok, r)
r = runAction('expense', id, '提交审批')
check('复核→审批 放行', r.ok, r)

// 2. 审批通过回写用工派工：落一条待结算工日
const labor = listEntries('labor', { 派工编号: 'SETT-EXP-1001' })
check('审批后用工派工落一条待结算工日', labor.total === 1 && labor.items[0]['结算工日'] === '待结算', labor.items)
r = runAction('expense', id, '登记入账')
check('审批→入账 放行', r.ok, r)
check('入账后不再有待办（入账后的那一档）', listEntries('expense', { 支出编号: 'EXP-1001' }).items[0].pending === false)

// 3. 同一支出编号重复提交：只保留先受理的一版
const before = listEntries('expense', { 支出编号: 'EXP-1001' }).total
r = createEntry('expense', { 支出编号: 'EXP-1001', 经费科目: '材料耗材', 报销金额: 999, 凭证号: 'VCH-X', 经办人: '李四' })
const after = listEntries('expense', { 支出编号: 'EXP-1001' })
check('重复支出编号被挡下', !r.ok, r)
check('重复提交不产生第二条记录', before === 1 && after.total === 1)
check('保留先受理的那一版', after.items[0]['报销金额'] === 500 && after.items[0]['经办人'] === '张三')

// 4. 凭证号缺失先挡下，补齐后才能入账
r = createEntry('expense', { 支出编号: 'EXP-1002', 经费科目: '差旅交通', 报销金额: 200, 凭证号: '', 经办人: '王五' })
const id2 = Number(listEntries('expense', { 支出编号: 'EXP-1002' }).items[0].id)
runAction('expense', id2, '提交复核')
runAction('expense', id2, '提交审批')
r = runAction('expense', id2, '登记入账')
check('凭证号缺失时入账被挡下', !r.ok && listEntries('expense', { 支出编号: 'EXP-1002' }).items[0].status === '已审批', r)
r = updateEntry('expense', id2, { 凭证号: 'VCH-2026-1002' })
check('补录凭证号', r.ok, r)
r = runAction('expense', id2, '登记入账')
check('补齐凭证号后入账放行', r.ok, r)
r = updateEntry('expense', id2, { 凭证号: 'VCH-改' })
check('入账后的记录不能再改', !r.ok, r)

// 5. 明细与汇总同源：按科目归总与明细合计一致
const items = listEntries('expense').items
const detailTotal = items.reduce((s, row) => s + Number(row['报销金额'] || 0), 0)
const bySubject = new Map<string, number>()
for (const row of items) {
  bySubject.set(String(row['经费科目']), (bySubject.get(String(row['经费科目'])) ?? 0) + Number(row['报销金额'] || 0))
}
const summaryTotal = [...bySubject.values()].reduce((s, v) => s + v, 0)
check('明细合计与按科目汇总一致', Math.abs(detailTotal - summaryTotal) < 0.005, { detailTotal, summaryTotal })

// 6. 持久化：重新读 storage（模拟关掉再打开）仍是入账后的状态
const raw = JSON.parse(store.get('archaeology-field:entries')!)
const persisted = (raw.expense as any[]).find((row) => row['支出编号'] === 'EXP-1001')
check('台账关掉再打开仍是入账后的那一档', persisted?.status === '已入账', persisted)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条未通过`)
process.exit(failures === 0 ? 0 : 1)

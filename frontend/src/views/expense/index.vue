<template>
  <section class="page" data-module="expense">
    <header class="page-head">
      <div>
        <h2>分项支出台账</h2>
        <p class="page-desc">逐条登记支出编号、经费科目、报销金额、凭证号与经办人，按科目归总；状态沿登记、复核、审批、入账逐级流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showCreate = !showCreate">
          {{ showCreate ? '收起登记' : '登记支出' }}
        </button>
        <button class="btn" type="button" @click="exportRows">导出分项支出清单</button>
      </div>
    </header>

    <form v-if="showCreate" class="filter-bar create-bar" @submit.prevent="submitCreate">
      <label class="filter-item">
        <span>支出编号</span>
        <input v-model="draft.支出编号" placeholder="如 EXP-0005" />
      </label>
      <label class="filter-item">
        <span>经费科目</span>
        <select v-model="draft.经费科目">
          <option v-for="item in categories" :key="item" :value="item">{{ item }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>报销金额</span>
        <input v-model="draft.报销金额" type="number" min="0" step="0.01" placeholder="0.00" />
      </label>
      <label class="filter-item">
        <span>凭证号</span>
        <input v-model="draft.凭证号" placeholder="可后补，入账前必须补齐" />
      </label>
      <label class="filter-item">
        <span>经办人</span>
        <input v-model="draft.经办人" placeholder="经办人姓名" />
      </label>
      <button class="btn primary" type="submit">受理登记</button>
    </form>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <span
              v-if="column === '凭证号' && !row['凭证号'] && row.status !== '已入账'"
              class="voucher-fix"
            >
              <input v-model="voucherDrafts[Number(row.id)]" placeholder="补录凭证号" />
              <button class="link" type="button" @click="saveVoucher(row)">补录</button>
            </span>
            <template v-else-if="column === '报销金额'">¥{{ fmtAmount(row[column]) }}</template>
            <template v-else>{{ row[column] || '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="nextAction(row)"
              class="link"
              type="button"
              @click="runAction(nextAction(row) as string, row)"
            >
              {{ nextAction(row) }}
            </button>
            <span v-else>已结清</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无分项支出数据，可先登记支出</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">按科目归总</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>经费科目</th>
          <th>笔数</th>
          <th>报销金额合计</th>
          <th>其中已入账</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in categorySummary" :key="item.category">
          <td>{{ item.category }}</td>
          <td>{{ item.count }}</td>
          <td>¥{{ fmtAmount(item.total) }}</td>
          <td>¥{{ fmtAmount(item.posted) }}</td>
        </tr>
        <tr v-if="categorySummary.length">
          <td><strong>合计</strong></td>
          <td><strong>{{ summaryCount }}</strong></td>
          <td><strong>¥{{ fmtAmount(summaryTotal) }}</strong></td>
          <td><strong>¥{{ fmtAmount(summaryPosted) }}</strong></td>
        </tr>
        <tr v-if="!categorySummary.length">
          <td colspan="4" class="empty-state">暂无归总数据</td>
        </tr>
      </tbody>
    </table>
    <p class="consistency" :class="{ 'error-text': !totalsMatch }">
      明细合计 ¥{{ fmtAmount(detailTotal) }} 与汇总合计 ¥{{ fmtAmount(summaryTotal) }}{{ totalsMatch ? '一致' : '不一致，请核查' }}
    </p>

    <footer class="page-foot">
      <span>共 {{ total }} 条分项支出记录</span>
      <span v-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createEntry,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  updateEntry,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('expense')
const columns = meta.fields
const statuses = meta.statuses
const categories = ['发掘用工', '差旅交通', '材料耗材', '设备租赁', '检测化验', '资料印制', '其他支出']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['支出编号', '经费科目', '经办人']
const showCreate = ref(false)
const voucherDrafts = ref<Record<number, string>>({})
const draft = ref({ 支出编号: '', 经费科目: categories[0], 报销金额: '', 凭证号: '', 经办人: '' })

// 逐级流转：每行只亮出当前这一档能走的下一个动作，服务层同样把守，跳档改不动。
const actionSources = meta.actionSources ?? {}

function nextAction(row: EntryRow): string | null {
  for (const [action, source] of Object.entries(actionSources)) {
    if (String(row.status) === source) {
      return action
    }
  }
  return null
}

function amountOf(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function fmtAmount(value: unknown): string {
  return amountOf(value).toFixed(2)
}

const stats = computed(() => {
  const posted = rows.value.filter((row) => row.status === '已入账')
  return [
    { label: '在途支出', value: rows.value.length - posted.length },
    { label: '已入账支出', value: posted.length },
    { label: '已入账金额', value: `¥${fmtAmount(posted.reduce((sum, row) => sum + amountOf(row['报销金额']), 0))}` },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 归总直接从明细行算出来，两处同一来源，金额天然对得上。
const categorySummary = computed(() => {
  const buckets = new Map<string, { count: number; total: number; posted: number }>()
  for (const row of rows.value) {
    const category = String(row['经费科目'] || '未分类')
    const bucket = buckets.get(category) ?? { count: 0, total: 0, posted: 0 }
    bucket.count += 1
    bucket.total += amountOf(row['报销金额'])
    if (row.status === '已入账') {
      bucket.posted += amountOf(row['报销金额'])
    }
    buckets.set(category, bucket)
  }
  return [...buckets.entries()].map(([category, bucket]) => ({ category, ...bucket }))
})

const detailTotal = computed(() => rows.value.reduce((sum, row) => sum + amountOf(row['报销金额']), 0))
const summaryTotal = computed(() => categorySummary.value.reduce((sum, item) => sum + item.total, 0))
const summaryCount = computed(() => categorySummary.value.reduce((sum, item) => sum + item.count, 0))
const summaryPosted = computed(() => categorySummary.value.reduce((sum, item) => sum + item.posted, 0))
const totalsMatch = computed(() => Math.abs(detailTotal.value - summaryTotal.value) < 0.005)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function submitCreate() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const amount = Number(draft.value.报销金额)
  if (!draft.value.支出编号.trim()) {
    errorMessage.value = '支出编号不能为空'
    return
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    errorMessage.value = '报销金额要是大于 0 的数字'
    return
  }
  if (!draft.value.经办人.trim()) {
    errorMessage.value = '经办人不能为空'
    return
  }
  const result = createEntry(meta.key, {
    支出编号: draft.value.支出编号.trim(),
    经费科目: draft.value.经费科目,
    报销金额: amount,
    凭证号: draft.value.凭证号.trim(),
    经办人: draft.value.经办人.trim(),
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  draft.value = { 支出编号: '', 经费科目: categories[0], 报销金额: '', 凭证号: '', 经办人: '' }
  reload()
}

function saveVoucher(row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const value = (voucherDrafts.value[Number(row.id)] ?? '').trim()
  if (!value) {
    errorMessage.value = '凭证号不能为空'
    return
  }
  const result = updateEntry(meta.key, Number(row.id), { 凭证号: value })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = `凭证号已补齐：${value}`
  voucherDrafts.value[Number(row.id)] = ''
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '分项支出台账读取失败'
  }
}

onMounted(reload)
</script>

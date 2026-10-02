<template>
  <section class="page" data-module="expense">
    <header class="page-head">
      <div>
        <h2>分项支出台账</h2>
        <p class="page-desc">逐条登记支出编号、经费科目、报销金额、凭证号与经办人，按 已登记→已复核→已审批→已入账 逐级流转，并按科目归总。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleCreate">
          {{ showCreate ? '收起登记' : '登记支出' }}
        </button>
        <button class="btn" type="button" @click="exportRows">导出支出台账</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form v-if="showCreate" class="filter-bar" @submit.prevent="submitCreate">
      <label class="filter-item">
        <span>支出编号</span>
        <input v-model="form.支出编号" placeholder="如 EXPE-0005" />
      </label>
      <label class="filter-item">
        <span>经费科目</span>
        <input v-model="form.经费科目" list="expense-subjects" placeholder="如 人工费" />
        <datalist id="expense-subjects">
          <option v-for="subject in subjectOptions" :key="subject" :value="subject" />
        </datalist>
      </label>
      <label class="filter-item">
        <span>报销金额</span>
        <input v-model="form.报销金额" type="number" min="0" step="0.01" placeholder="0.00" />
      </label>
      <label class="filter-item">
        <span>凭证号（可后补）</span>
        <input v-model="form.凭证号" placeholder="入账前必须补齐" />
      </label>
      <label class="filter-item">
        <span>经办人</span>
        <input v-model="form.经办人" placeholder="经办人姓名" />
      </label>
      <button class="btn primary" type="submit">提交登记</button>
    </form>

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
            <template v-if="column === '报销金额'">{{ formatAmount(row[column]) }}</template>
            <template v-else-if="column === '凭证号'">
              <span v-if="row.凭证号">{{ row.凭证号 }}</span>
              <span v-else-if="String(row.status) === '已入账'">—</span>
              <span v-else class="voucher-fix">
                <input
                  v-model="voucherDrafts[String(row.id)]"
                  placeholder="补录凭证号"
                  @keyup.enter="submitVoucher(row)"
                />
                <button class="link" type="button" @click="submitVoucher(row)">补录</button>
              </span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="nextAction(String(row.status))"
              class="link"
              type="button"
              @click="runNext(row)"
            >
              {{ nextAction(String(row.status)) }}
            </button>
            <span v-else>已办结</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无支出记录，可先登记支出</td>
        </tr>
      </tbody>
    </table>

    <h3 class="summary-title">按科目归总</h3>
    <table class="data-table">
      <thead>
        <tr><th>经费科目</th><th>笔数</th><th>报销金额合计</th></tr>
      </thead>
      <tbody>
        <tr v-for="item in summary" :key="item.经费科目">
          <td>{{ item.经费科目 }}</td>
          <td>{{ item.笔数 }}</td>
          <td>{{ formatAmount(item.金额合计) }}</td>
        </tr>
        <tr v-if="summary.length">
          <td><strong>合计</strong></td>
          <td><strong>{{ total }}</strong></td>
          <td><strong>{{ formatAmount(summaryTotal) }}</strong></td>
        </tr>
        <tr v-if="!summary.length">
          <td colspan="3" class="empty-state">暂无明细，归总为空</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条支出记录 · 归总由上方明细实时计算，两处金额一致</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="notice" class="ok-text">{{ notice }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  advanceExpense,
  nextAction,
  registerExpense,
  summarizeBySubject,
  totalAmount,
  updateVoucher,
} from '@/api/expense-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('expense')
const columns = ["支出编号", "经费科目", "报销金额", "凭证号", "经办人", "登记日期"]
const statuses = ["已登记", "已复核", "已审批", "已入账"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const notice = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["支出编号", "经费科目", "经办人"]
const showCreate = ref(false)
const blankForm = () => ({ 支出编号: '', 经费科目: '', 报销金额: '', 凭证号: '', 经办人: '' })
const form = ref(blankForm())
const voucherDrafts = ref<Record<string, string>>({})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '待复核支出', value: statusSummary.value[0]?.count ?? 0 },
  { label: '待审批支出', value: statusSummary.value[1]?.count ?? 0 },
  { label: '待入账支出', value: statusSummary.value[2]?.count ?? 0 },
  {
    label: '已入账总额',
    value: formatAmount(
      totalAmount(rows.value.filter((row) => String(row.status) === '已入账')),
    ),
  },
])
const summary = computed(() => summarizeBySubject(rows.value))
const summaryTotal = computed(() => totalAmount(rows.value))
const subjectOptions = computed(() => summary.value.map((item) => item.经费科目))

function formatAmount(value: unknown): string {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount.toFixed(2) : '0.00'
}

function toggleCreate() {
  showCreate.value = !showCreate.value
}

function submitCreate() {
  errorMessage.value = ''
  notice.value = ''
  const result = registerExpense({
    支出编号: form.value.支出编号,
    经费科目: form.value.经费科目,
    报销金额: Number(form.value.报销金额),
    凭证号: form.value.凭证号,
    经办人: form.value.经办人,
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  notice.value = result.message
  form.value = blankForm()
  showCreate.value = false
  reload()
}

function runNext(row: EntryRow) {
  const action = nextAction(String(row.status))
  if (!action) {
    return
  }
  errorMessage.value = ''
  notice.value = ''
  const result = advanceExpense(Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  notice.value = result.message
  reload()
}

function submitVoucher(row: EntryRow) {
  errorMessage.value = ''
  notice.value = ''
  const draft = voucherDrafts.value[String(row.id)] ?? ''
  const result = updateVoucher(Number(row.id), draft)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  notice.value = result.message
  delete voucherDrafts.value[String(row.id)]
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '支出台账读取失败'
  }
}

onMounted(reload)
</script>

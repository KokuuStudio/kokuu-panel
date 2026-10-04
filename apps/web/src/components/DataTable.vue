<script setup lang="ts" generic="Row extends Record<string, unknown> = Record<string, unknown>">
/**
 * 统一表格壳：加载态 / 错误态 / 空态 + 分页。
 *
 * 目的很直接：任何列表页都不允许出现「白屏什么都不显示」。
 * 三种状态优先级：错误 > 加载 > 数据（含空）。
 *
 * 列的取值规则（值单元格）：
 *   column.slot   → 用同名 scoped slot 渲染，slot 收到 { row, index, value }
 *   column.format → 用 (value, row) 渲染
 *   否则          → null/undefined 显示「—」，其余 String()
 *
 * 泛型 Row 让调用方写 `:rows="nodes"` 就能拿到类型化的 slot 参数（如 `row.name`）。
 */
import { computed } from 'vue';

export interface DataTableColumn {
  key: string;
  label: string;
  width?: number | string;
  minWidth?: number | string;
  fixed?: boolean | 'left' | 'right';
  align?: 'left' | 'center' | 'right';
  slot?: string;
  format?: (value: unknown, row: Record<string, unknown>) => string;
  /** 关闭「null → —」的兜底（比如你自己在 format 里处理）。 */
  rawNull?: boolean;
}

const props = withDefaults(
  defineProps<{
    columns: DataTableColumn[];
    rows: Row[];
    loading?: boolean;
    error?: string;
    emptyText?: string;
    rowKey?: string;
    total?: number;
    page?: number;
    size?: number;
    sizeOptions?: number[];
    showPager?: boolean;
    /** 表格最小宽度，窄屏下横向滚动而不是把列挤成一团。 */
    minWidth?: number;
    stripe?: boolean;
    /** 行可点击（配合 @row-click）：鼠标变手型。 */
    clickable?: boolean;
  }>(),
  {
    loading: false,
    error: '',
    emptyText: '暂无数据',
    rowKey: 'id',
    total: 0,
    page: 1,
    size: 20,
    showPager: true,
    stripe: true,
    clickable: false,
  },
);

const emit = defineEmits<{
  retry: [];
  'update:page': [value: number];
  'update:size': [value: number];
  'row-click': [row: Row];
}>();

const sizeOptions = computed(() => props.sizeOptions ?? [10, 20, 50, 100]);

const emptyText = computed(() => {
  if (props.loading) return '加载中…';
  return props.emptyText;
});

function cellValue(row: Row, column: DataTableColumn): unknown {
  return row[column.key];
}

function renderValue(row: Row, column: DataTableColumn): string {
  const value = cellValue(row, column);
  if (value === null || value === undefined || value === '') {
    return column.rawNull ? '' : '—';
  }
  if (column.format) return column.format(value, row);
  return String(value);
}

function onPageChange(page: number): void {
  emit('update:page', page);
}

function onSizeChange(size: number): void {
  emit('update:size', size);
}

function onRowClick(row: Row): void {
  emit('row-click', row);
}
</script>

<template>
  <div class="data-table">
    <el-alert
      v-if="error"
      type="error"
      :closable="false"
      show-icon
      class="data-table__error"
      data-testid="table-error"
    >
      <template #title>数据加载失败</template>
      <template #default>
        <div class="data-table__error-body">
          <span>{{ error }}</span>
          <el-button size="small" type="primary" plain @click="emit('retry')">重试</el-button>
        </div>
      </template>
    </el-alert>

    <el-skeleton v-if="loading && rows.length === 0" :rows="5" animated class="data-table__skeleton" />

    <el-table
      v-else
      v-loading="loading"
      :data="rows"
      :row-key="rowKey"
      :empty-text="emptyText"
      :stripe="stripe"
      :style="minWidth ? { minWidth: `${minWidth}px` } : undefined"
      border
      size="default"
      :class="{ 'data-table--clickable': clickable }"
      @row-click="onRowClick"
    >
      <el-table-column
        v-for="column in columns"
        :key="column.key"
        :label="column.label"
        :width="column.width"
        :min-width="column.minWidth"
        :fixed="column.fixed"
        :align="column.align ?? 'left'"
        show-overflow-tooltip
      >
        <template #default="scope">
          <slot
            v-if="column.slot"
            :name="column.slot"
            :row="scope.row as Row"
            :index="scope.$index as number"
            :value="cellValue(scope.row as Row, column)"
          />
          <span v-else>{{ renderValue(scope.row as Row, column) }}</span>
        </template>
      </el-table-column>
    </el-table>

    <div v-if="showPager && total > 0" class="kp-pager">
      <el-pagination
        :current-page="page"
        :page-size="size"
        :page-sizes="sizeOptions"
        :total="total"
        layout="total, sizes, prev, pager, next, jumper"
        background
        @current-change="onPageChange"
        @size-change="onSizeChange"
      />
    </div>
  </div>
</template>

<style scoped>
.data-table__error {
  margin-bottom: 12px;
}

.data-table__error-body {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.data-table__skeleton {
  padding: 16px;
  border: 1px solid var(--kp-border);
  border-radius: var(--kp-radius);
}

.data-table--clickable :deep(.el-table__row) {
  cursor: pointer;
}
</style>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LineElement,
  LinearScale,
  PointElement,
  Title,
  Tooltip
} from 'chart.js'
import type { ChartData, ChartDataset, ChartOptions, TooltipItem } from 'chart.js'
import { Line } from 'vue-chartjs'
import type { ChartComponentRef } from 'vue-chartjs'

ChartJS.register(Title, Tooltip, Legend, LineElement, LinearScale, PointElement, CategoryScale, Filler)

type DatasetInput = {
  label: string
  data: number[]
  color: string
  fill?: boolean
  yAxisID?: 'y' | 'y1'
  unit?: string
}

const props = defineProps<{
  title: string
  labels: string[]
  datasets: DatasetInput[]
  activeIndex: number | null
  rightAxis?: boolean
  yTickFormatter?: (value: number) => string
  tooltipFormatter?: (value: number, label: string, unit?: string) => string
}>()

const emit = defineEmits<{
  (event: 'hoverIndex', value: number | null): void
}>()

const chartRef = ref<ChartComponentRef | null>(null)
const isDarkMode = computed(() => document.documentElement.classList.contains('dark'))
const colors = computed(() => ({
  grid: isDarkMode.value ? '#374151' : '#f3f4f6',
  text: isDarkMode.value ? '#9ca3af' : '#6b7280',
  tooltipBg: isDarkMode.value ? '#1f2937' : '#ffffff',
  tooltipTitle: isDarkMode.value ? '#f3f4f6' : '#111827',
  tooltipBody: isDarkMode.value ? '#d1d5db' : '#4b5563'
}))

function alpha(color: string, value = '20') {
  return color.startsWith('#') && color.length === 7 ? `${color}${value}` : color
}

function defaultTooltipValue(value: number, label: string, unit?: string) {
  const suffix = unit ? ` ${unit}` : ''
  if (label.toLowerCase().includes('memory')) return `${label}: ${value.toFixed(2)}${suffix}`
  if (Math.abs(value) >= 10) return `${label}: ${value.toFixed(1)}${suffix}`
  return `${label}: ${value.toFixed(3)}${suffix}`
}

const chartData = computed<ChartData<'line'>>(() => ({
  labels: props.labels,
  datasets: props.datasets.map((dataset): ChartDataset<'line'> => ({
    label: dataset.label,
    data: dataset.data,
    borderColor: dataset.color,
    backgroundColor: alpha(dataset.color),
    fill: dataset.fill ?? true,
    tension: 0.4,
    pointRadius: 0,
    pointHoverRadius: 3,
    pointHitRadius: 14,
    borderWidth: 2,
    yAxisID: dataset.yAxisID ?? 'y'
  }))
}))

const options = computed<ChartOptions<'line'>>(() => {
  const c = colors.value
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: 'index' },
    onHover: (_event, elements) => {
      const nextIndex = elements[0]?.index
      emit('hoverIndex', typeof nextIndex === 'number' ? nextIndex : null)
    },
    plugins: {
      legend: {
        position: 'top',
        align: 'end',
        labels: {
          color: c.text,
          usePointStyle: true,
          boxWidth: 6,
          font: { size: 10 }
        }
      },
      tooltip: {
        enabled: true,
        backgroundColor: c.tooltipBg,
        titleColor: c.tooltipTitle,
        bodyColor: c.tooltipBody,
        borderColor: c.grid,
        borderWidth: 1,
        padding: 10,
        displayColors: true,
        callbacks: {
          label: (context: TooltipItem<'line'>) => {
            const raw = typeof context.parsed.y === 'number' ? context.parsed.y : 0
            const source = props.datasets[context.datasetIndex]
            const label = source?.label ?? context.dataset.label ?? ''
            return props.tooltipFormatter?.(raw, label, source?.unit) ?? defaultTooltipValue(raw, label, source?.unit)
          }
        }
      }
    },
    scales: {
      x: {
        type: 'category',
        grid: { display: false },
        ticks: {
          color: c.text,
          font: { size: 10 },
          maxTicksLimit: 8,
          autoSkip: true,
          autoSkipPadding: 10
        }
      },
      y: {
        type: 'linear',
        display: true,
        position: 'left',
        grid: { color: c.grid, borderDash: [4, 4] },
        ticks: {
          color: c.text,
          font: { size: 10 },
          callback: (value) => props.yTickFormatter?.(Number(value)) ?? String(value)
        }
      },
      y1: {
        type: 'linear',
        display: props.rightAxis ?? false,
        position: 'right',
        grid: { display: false },
        ticks: {
          color: props.datasets.find((dataset) => dataset.yAxisID === 'y1')?.color ?? c.text,
          font: { size: 10 },
          callback: (value) => props.yTickFormatter?.(Number(value)) ?? String(value)
        }
      }
    }
  }
})

watch(
  () => props.activeIndex,
  (index) => {
    const chart = chartRef.value?.chart
    if (!chart) return
    if (index === null || index < 0 || index >= props.labels.length) {
      chart.setActiveElements([])
      chart.tooltip?.setActiveElements([], { x: 0, y: 0 })
      chart.update('none')
      return
    }
    const activeElements = props.datasets.map((_, datasetIndex) => ({ datasetIndex, index }))
    chart.setActiveElements(activeElements)
    const meta = chart.getDatasetMeta(0)
    const point = meta.data[index]?.getProps(['x', 'y'], true)
    chart.tooltip?.setActiveElements(activeElements, {
      x: typeof point?.x === 'number' ? point.x : chart.chartArea.left,
      y: typeof point?.y === 'number' ? point.y : chart.chartArea.top
    })
    chart.update('none')
  },
  { flush: 'post' }
)
</script>

<template>
  <section class="flex h-80 flex-col rounded-3xl bg-white p-6 shadow-sm ring-1 ring-gray-900/5 dark:bg-dark-800 dark:ring-dark-700">
    <div class="mb-4 flex shrink-0 items-center justify-between">
      <h3 class="text-sm font-bold text-gray-900 dark:text-white">{{ title }}</h3>
    </div>
    <div class="min-h-0 flex-1" @mouseleave="emit('hoverIndex', null)">
      <Line ref="chartRef" :data="chartData" :options="options" />
    </div>
  </section>
</template>

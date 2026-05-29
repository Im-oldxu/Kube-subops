<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BaseDialog from '@/components/common/BaseDialog.vue'
import DataTable from '@/components/common/DataTable.vue'
import Select from '@/components/common/Select.vue'
import { Icon } from '@/components/icons'
import type { Column } from '@/components/common/types'
import KubeMonitoringChart from './KubeMonitoringChart.vue'
import {
  applyObjectToForm,
  createDefaultForm,
  createSchemas,
  validateCreateForm
} from '@/template/kube-create/schemas'
import type { AppContainerEntry, CreateField, CreateFieldOption, CreateFormState, InitContainerEntry, KeyValuePair, PodVolumeEntry, PortEntry, VolumeMountEntry } from '@/template/kube-create/types'
import { asRecord, parseKubeYaml, parseKubeYamlDocuments, readPath, stringifyKubeObject, stringifyKubeObjects } from '@/template/kube-create/yaml'
import * as templateApi from '@/template/api'
import * as templateData from '@/template/data'

type ApiFn<TArgs extends unknown[], TResult> = (...args: TArgs) => Promise<TResult> | TResult
type ResourceStatus = 'Running' | 'Ready' | 'Pending' | 'Warning' | 'Error' | 'Succeeded' | 'Bound' | 'Active' | 'Available' | 'Degraded' | 'Complete' | 'CrashLoopBackOff' | 'Terminating'
type DetailTab = 'overview' | 'status' | 'metadata' | 'relations' | 'mounts' | 'monitoring' | 'events' | 'yaml'
type ContainerDetailTab = 'details' | 'env' | 'mounts'
type EditMode = 'create' | 'edit'
type CreateMode = 'form' | 'yaml'
type ResourcePanel = 'cpu' | 'memory'
type ProbePanel = 'readiness' | 'liveness' | 'startup'
type MountPanel = PodVolumeEntry['type']
type DeploymentPanel = 'basic' | 'metadata'
type PodTemplatePanel = 'app' | 'init'
type AppContainerPanel = 'basic' | 'env' | 'resources' | 'security' | 'probes' | 'mounts' | 'lifecycle'
type InitContainerPanel = 'basic' | 'command' | 'env' | 'resources' | 'security' | 'mounts'
type PodSecurityPanel = 'identity' | 'pod'
type PodSchedulePanel = 'affinity' | 'antiAffinity'
type NodeSchedulePanel = 'selector' | 'affinity' | 'tolerations'
type LifecyclePanel = 'postStart' | 'preStop'
type StrategyPanel = 'strategy' | 'history'
type YamlTemplateId = 'web' | 'api' | 'worker' | 'db'
type RelatedCreateType = 'configmaps' | 'secrets' | 'persistent-volume-claims'
type RelatedTargetKind = 'pod-volume' | 'app-mount' | 'image-pull-secret'
type CreateDialogSize = 'regular' | 'wide'
type YamlValidationStatus = 'ok' | 'warning' | 'error' | 'info'
type MonitoringRange = '15m' | '30m' | '1h' | '6h' | '12h' | 'today'
type MonitoringStep = '15s' | '30s' | '60s' | '5m' | '15m'
type ConfigSourceOption = {
  label: string
  value: string
  secretType?: string
  usage?: 'volume' | 'imagePullSecret' | 'both'
}
type RelatedResourceItem = {
  kind: string
  name: string
  namespace?: string
  status?: string
  resourceType?: string
  relation?: string
  ready?: string
}
type ConfirmAction =
  | 'delete'
  | 'bulk-delete'
  | 'scale'
  | 'restart'
  | 'update-image'
  | 'rollback'
  | 'terminal'
  | 'drain'
  | 'cordon'
  | 'uncordon'
  | 'reveal-secret'

interface ClusterOption {
  id: string
  name: string
}

interface ResourceDefinition {
  type: string
  title: string
  kind: string
  namespaced: boolean
  description: string
  createDisabled?: boolean
  editDisabled?: boolean
  deleteDisabled?: boolean
  workload?: boolean
  pod?: boolean
  node?: boolean
  secret?: boolean
  supportsScale?: boolean
  supportsImageUpdate?: boolean
  supportsRollback?: boolean
}

interface KubeResourceItem {
  id: string
  clusterId: string
  type: string
  kind: string
  namespace?: string
  name: string
  labels: Record<string, string>
  annotations: Record<string, string>
  status: ResourceStatus
  age: string
  ready?: string
  restarts?: number
  nodeName?: string
  podIP?: string
  cpuUsage?: string
  memoryUsage?: string
  cpuRequest?: string
  cpuLimit?: string
  memoryRequest?: string
  memoryLimit?: string
  resourceType?: string
  node?: string
  image?: string
  images?: string[]
  replicas?: number
  desiredReplicas?: number
  owner?: string
  ownerReferences?: Array<{ kind: string; name: string; resourceType?: string }>
  related: RelatedResourceItem[]
  events: Array<{ id: string; type: 'Normal' | 'Warning'; reason: string; message: string; lastSeen: string }>
  yaml: string
  details: Record<string, string | number | boolean | string[] | undefined>
}

interface PendingConfirm {
  action: ConfirmAction
  title: string
  message: string
  resource?: KubeResourceItem
  resources?: KubeResourceItem[]
  payload?: Record<string, unknown>
}

interface WorkloadActionForm {
  action: ConfirmAction
  replicas: number
  image: string
  rollbackRevision: string
}

interface YamlValidationItem {
  status: YamlValidationStatus
  text: string
}

const route = useRoute()
const router = useRouter()
const apiBag = templateApi as Record<string, unknown>
const dataBag = templateData as Record<string, unknown>

const resourceDefinitions: Record<string, ResourceDefinition> = {
  pods: { type: 'pods', title: 'Pod', kind: 'Pod', namespaced: true, description: 'Pod 列表、详情、容器、实时日志、终端和 YAML。', pod: true },
  deployments: { type: 'deployments', title: 'Deployment', kind: 'Deployment', namespaced: true, description: 'Deployment 工作负载管理。', workload: true, supportsScale: true, supportsImageUpdate: true, supportsRollback: true },
  statefulsets: { type: 'statefulsets', title: 'StatefulSet', kind: 'StatefulSet', namespaced: true, description: 'StatefulSet 工作负载管理。', workload: true, supportsScale: true, supportsImageUpdate: true, supportsRollback: true },
  daemonsets: { type: 'daemonsets', title: 'DaemonSet', kind: 'DaemonSet', namespaced: true, description: 'DaemonSet 节点守护进程管理。', workload: true, supportsImageUpdate: true, supportsRollback: true },
  replicasets: { type: 'replicasets', title: 'ReplicaSet', kind: 'ReplicaSet', namespaced: true, description: 'ReplicaSet 查看和关联 Pod 管理。', workload: true },
  jobs: { type: 'jobs', title: 'Job', kind: 'Job', namespaced: true, description: 'Job 任务资源管理。', workload: true },
  cronjobs: { type: 'cronjobs', title: 'CronJob', kind: 'CronJob', namespaced: true, description: 'CronJob 调度状态和关联 Job。', workload: true },
  services: { type: 'services', title: 'Service', kind: 'Service', namespaced: true, description: 'Service 网络资源管理。' },
  ingresses: { type: 'ingresses', title: 'Ingress', kind: 'Ingress', namespaced: true, description: 'Ingress 路由规则管理。' },
  endpoints: { type: 'endpoints', title: 'Endpoint', kind: 'Endpoint', namespaced: true, description: 'Endpoint 查看和兼容处理。' },
  'endpoint-slices': { type: 'endpoint-slices', title: 'EndpointSlice', kind: 'EndpointSlice', namespaced: true, description: 'EndpointSlice 查看和管理。' },
  'network-policies': { type: 'network-policies', title: 'NetworkPolicy', kind: 'NetworkPolicy', namespaced: true, description: 'NetworkPolicy 网络策略管理。' },
  configmaps: { type: 'configmaps', title: 'ConfigMap', kind: 'ConfigMap', namespaced: true, description: 'ConfigMap 配置数据管理。' },
  secrets: { type: 'secrets', title: 'Secret', kind: 'Secret', namespaced: true, description: 'Secret 管理和受控明文查看。', secret: true },
  'storage-classes': { type: 'storage-classes', title: 'StorageClass', kind: 'StorageClass', namespaced: false, description: 'StorageClass 集群级存储类管理。' },
  'persistent-volumes': { type: 'persistent-volumes', title: 'PersistentVolume', kind: 'PersistentVolume', namespaced: false, description: 'PV 集群级存储资源管理。' },
  'persistent-volume-claims': { type: 'persistent-volume-claims', title: 'PersistentVolumeClaim', kind: 'PersistentVolumeClaim', namespaced: true, description: 'PVC 命名空间级存储声明管理。' },
  'service-accounts': { type: 'service-accounts', title: 'ServiceAccount', kind: 'ServiceAccount', namespaced: true, description: 'ServiceAccount 访问身份管理。' },
  roles: { type: 'roles', title: 'Role', kind: 'Role', namespaced: true, description: 'Role 命名空间权限管理。' },
  'cluster-roles': { type: 'cluster-roles', title: 'ClusterRole', kind: 'ClusterRole', namespaced: false, description: 'ClusterRole 集群级权限管理。' },
  'role-bindings': { type: 'role-bindings', title: 'RoleBinding', kind: 'RoleBinding', namespaced: true, description: 'RoleBinding 命名空间授权绑定。' },
  'cluster-role-bindings': { type: 'cluster-role-bindings', title: 'ClusterRoleBinding', kind: 'ClusterRoleBinding', namespaced: false, description: 'ClusterRoleBinding 集群级授权绑定。' },
  nodes: { type: 'nodes', title: 'Node', kind: 'Node', namespaced: false, description: 'Node 状态、容量、Pod、事件和节点操作。', node: true },
  namespaces: { type: 'namespaces', title: 'Namespace', kind: 'Namespace', namespaced: false, description: 'Namespace 生命周期管理。' },
  events: { type: 'events', title: 'Event', kind: 'Event', namespaced: true, description: 'Kubernetes Event 查看页。', createDisabled: true, editDisabled: true, deleteDisabled: true }
}

const routeAliases: Record<string, string> = {
  Pods: 'pods',
  WorkloadDeployments: 'deployments',
  WorkloadStatefulSets: 'statefulsets',
  WorkloadDaemonSets: 'daemonsets',
  WorkloadReplicaSets: 'replicasets',
  WorkloadJobs: 'jobs',
  WorkloadCronJobs: 'cronjobs',
  NetworkServices: 'services',
  NetworkIngresses: 'ingresses',
  NetworkEndpoints: 'endpoints',
  NetworkEndpointSlices: 'endpoint-slices',
  NetworkPolicies: 'network-policies',
  ConfigMaps: 'configmaps',
  Secrets: 'secrets',
  StorageClasses: 'storage-classes',
  PersistentVolumes: 'persistent-volumes',
  PersistentVolumeClaims: 'persistent-volume-claims',
  ServiceAccounts: 'service-accounts',
  Roles: 'roles',
  ClusterRoles: 'cluster-roles',
  RoleBindings: 'role-bindings',
  ClusterRoleBindings: 'cluster-role-bindings',
  Nodes: 'nodes',
  Namespaces: 'namespaces',
  Events: 'events'
}

const resourceRoutes: Record<string, string> = {
  pods: '/pods',
  deployments: '/workloads/deployments',
  statefulsets: '/workloads/statefulsets',
  daemonsets: '/workloads/daemonsets',
  replicasets: '/workloads/replicasets',
  jobs: '/workloads/jobs',
  cronjobs: '/workloads/cronjobs',
  services: '/network/services',
  ingresses: '/network/ingresses',
  endpoints: '/network/endpoints',
  'endpoint-slices': '/network/endpoint-slices',
  'network-policies': '/network/network-policies',
  configmaps: '/config/configmaps',
  secrets: '/config/secrets',
  'storage-classes': '/storage/storage-classes',
  'persistent-volumes': '/storage/persistent-volumes',
  'persistent-volume-claims': '/storage/persistent-volume-claims',
  'service-accounts': '/access/service-accounts',
  roles: '/access/roles',
  'cluster-roles': '/access/cluster-roles',
  'role-bindings': '/access/role-bindings',
  'cluster-role-bindings': '/access/cluster-role-bindings',
  nodes: '/other/nodes',
  namespaces: '/other/namespaces',
  events: '/other/events'
}

const kindResourceTypes: Record<string, string> = Object.fromEntries(
  Object.values(resourceDefinitions).map((definition) => [definition.kind, definition.type])
)

const fallbackClusters: ClusterOption[] = [
  { id: 'cluster-prod', name: 'prod-east' },
  { id: 'staging', name: 'staging' },
  { id: 'dev-sandbox', name: 'dev-sandbox' }
]
const namespaceOptions = ['all-namespaces', 'default', 'kube-system', 'platform', 'observability']
const statusOptions = ['all', 'Running', 'Ready', 'Pending', 'Warning', 'Error', 'Succeeded', 'Bound', 'Active', 'Terminating']
const pageSizeOptions = [
  { label: '10 条 / 页', value: 10 },
  { label: '20 条 / 页', value: 20 },
  { label: '50 条 / 页', value: 50 }
]
const monitoringRangeOptions: Array<{ label: string; value: MonitoringRange; seconds: number }> = [
  { label: 'Last 15 min', value: '15m', seconds: 15 * 60 },
  { label: 'Last 30 min', value: '30m', seconds: 30 * 60 },
  { label: 'Last 1 hour', value: '1h', seconds: 60 * 60 },
  { label: 'Last 6 hours', value: '6h', seconds: 6 * 60 * 60 },
  { label: 'Last 12 hours', value: '12h', seconds: 12 * 60 * 60 },
  { label: 'Today', value: 'today', seconds: 24 * 60 * 60 }
]
const monitoringStepOptions: Array<{ label: string; value: MonitoringStep; seconds: number }> = [
  { label: '15 seconds', value: '15s', seconds: 15 },
  { label: '30 seconds', value: '30s', seconds: 30 },
  { label: '60 seconds', value: '60s', seconds: 60 },
  { label: '5 minutes', value: '5m', seconds: 5 * 60 },
  { label: '15 minutes', value: '15m', seconds: 15 * 60 }
]

const filters = reactive({
  clusterId: 'cluster-prod',
  namespace: 'all-namespaces',
  name: '',
  labels: '',
  nodeName: 'all-nodes',
  status: 'all',
  keyword: ''
})
const clusters = ref<ClusterOption[]>(fallbackClusters)
const resources = ref<KubeResourceItem[]>([])
const selectedResource = ref<KubeResourceItem | null>(null)
const selectedResourceIds = reactive(new Set<string>())
const detailPanelOpen = ref(false)
const activeDetailTab = ref<DetailTab>('overview')
const detailYamlDraft = ref('')
const detailYamlError = ref('')
const selectedContainerName = ref('')
const containerDetailOpen = ref(false)
const activeContainerDetailTab = ref<ContainerDetailTab>('details')
const activeMonitoringTarget = ref('all')
const activeMonitoringIndex = ref<number | null>(null)
const activeMonitoringRange = ref<MonitoringRange>('30m')
const activeMonitoringStep = ref<MonitoringStep>('30s')
const page = ref(1)
const pageSize = ref(10)
const loading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const editDialogOpen = ref(false)
const editMode = ref<EditMode>('create')
const actionDialogOpen = ref(false)
const logsDialogOpen = ref(false)
const terminalDialogOpen = ref(false)
const secretDialogOpen = ref(false)
const pendingConfirm = ref<PendingConfirm | null>(null)
const formState = reactive({
  name: '',
  namespace: 'default',
  yaml: ''
})
const createMode = ref<CreateMode>('form')
const activeDeploymentPanel = ref<DeploymentPanel>('basic')
const activePodTemplatePanel = ref<PodTemplatePanel>('app')
const activeAppContainerId = ref('')
const activeAppContainerPanel = ref<AppContainerPanel>('basic')
const activeInitContainerId = ref('')
const activeInitContainerPanel = ref<InitContainerPanel>('basic')
const activeResourcePanel = ref<ResourcePanel>('cpu')
const activeProbePanel = ref<ProbePanel>('readiness')
const activeMountPanel = ref<MountPanel>('configMap')
const activePodSecurityPanel = ref<PodSecurityPanel>('identity')
const activePodSchedulePanel = ref<PodSchedulePanel>('affinity')
const activeNodeSchedulePanel = ref<NodeSchedulePanel>('selector')
const activeLifecyclePanel = ref<LifecyclePanel>('postStart')
const activeStrategyPanel = ref<StrategyPanel>('strategy')
const collapsedSections = reactive<Record<string, boolean>>({})
const createDialogSize = ref<CreateDialogSize>('regular')
const yamlFontSize = ref(13)
const activeYamlTemplate = ref<YamlTemplateId>('web')
const activeYamlDocumentIndex = ref(0)
const yamlTextareaRef = ref<HTMLTextAreaElement | null>(null)
const createForm = reactive<CreateFormState>(createDefaultForm('pods', 'Pod', 'default'))
const formErrors = ref<string[]>([])
const yamlParseError = ref('')
const syncingFromYaml = ref(false)
const showLegacyAppSections = false
const logsText = ref('')
const terminalContainerName = ref('')
const terminalCommandPreset = ref('/bin/sh')
const terminalCustomCommand = ref('')
const terminalSessionMessage = ref('')
const secretPlaintext = ref<Record<string, string>>({})
const actionForm = reactive<WorkloadActionForm>({
  action: 'scale',
  replicas: 1,
  image: '',
  rollbackRevision: 'previous'
})
const relatedDialogOpen = ref(false)
const relatedMountType = ref<Exclude<MountPanel, 'emptyDir'>>('configMap')
const relatedMountTargetId = ref<string | null>(null)
const relatedPodVolumeTargetId = ref<string | null>(null)
const relatedTargetKind = ref<RelatedTargetKind>('app-mount')
const imagePullSecretDropdownOpen = ref(false)
const relatedCreateMode = ref<CreateMode>('form')
const relatedForm = reactive<CreateFormState>(createDefaultForm('configmaps', 'ConfigMap', 'default'))
const relatedFormState = reactive({
  name: '',
  namespace: 'default',
  yaml: ''
})
const relatedFormErrors = ref<string[]>([])
const relatedYamlParseError = ref('')
const hiddenColumns = reactive(new Set<string>())
const showColumnDropdown = ref(false)
const columnDropdownRef = ref<HTMLElement | null>(null)
const resourceColumnStorageKey = computed(() => `kube-${currentDefinition.value.type}-hidden-columns-v2`)
const metricsAvailable = computed(() => resources.value.some((resource) => resource.type === 'pods' && Boolean(
  resource.cpuUsage ||
  resource.memoryUsage ||
  resource.details.cpuUsage ||
  resource.details.memoryUsage
)))
const metricsUnavailableMessage = computed(() => '当前未返回 metrics.k8s.io 实时用量；CPU/内存只展示 requests/limits。需要实时用量时，请确认集群已安装并启用 Kubernetes Metrics Server，且 APIService v1beta1.metrics.k8s.io 为 Available。')
const monitoringSelectedRange = computed(() => monitoringRangeOptions.find((option) => option.value === activeMonitoringRange.value) ?? monitoringRangeOptions[1])
const monitoringSelectedStep = computed(() => monitoringStepOptions.find((option) => option.value === activeMonitoringStep.value) ?? monitoringStepOptions[1])
const monitoringChartKey = computed(() => `${activeMonitoringRange.value}-${activeMonitoringStep.value}-${activeMonitoringTarget.value}`)
const defaultHiddenColumnKeys = computed(() => new Set<string>(currentDefinition.value.pod ? ['namespace', 'labels'] : []))

const baseTableColumns = computed<Column[]>(() => [
  { key: 'select', label: '', class: 'w-12 min-w-12' },
  { key: 'name', label: '名称', sortable: true, class: currentDefinition.value.pod ? 'min-w-64 whitespace-nowrap' : 'min-w-56 whitespace-nowrap' },
  ...(currentDefinition.value.namespaced ? [{ key: 'namespace', label: 'Namespace', sortable: true }] : []),
  { key: 'status', label: '状态', sortable: true, class: 'whitespace-nowrap' },
  { key: 'ready', label: '就绪', sortable: true, class: 'whitespace-nowrap' },
  ...(currentDefinition.value.pod ? [
    { key: 'restarts', label: '重启', sortable: true, class: 'whitespace-nowrap' },
    { key: 'podIP', label: 'Pod IP', sortable: true, class: 'min-w-32 whitespace-nowrap' },
    { key: 'nodeName', label: '节点', sortable: true, class: 'min-w-44 whitespace-nowrap' },
    { key: 'cpu', label: 'CPU', sortable: true, class: 'min-w-28 whitespace-nowrap' },
    { key: 'memory', label: '内存', sortable: true, class: 'min-w-32 whitespace-nowrap' }
  ] : []),
  { key: 'labels', label: '标签', class: currentDefinition.value.pod ? 'min-w-56 whitespace-nowrap' : 'min-w-48' },
  { key: 'age', label: '年龄', sortable: true, class: 'whitespace-nowrap' },
  { key: 'actions', label: '操作', class: currentDefinition.value.pod ? 'min-w-48 whitespace-nowrap !px-2' : currentDefinition.value.type === 'deployments' ? 'min-w-72 whitespace-nowrap' : 'min-w-96' }
])
const toggleableColumns = computed(() => baseTableColumns.value.filter((column) => !['select', 'actions'].includes(column.key)))
const tableColumns = computed(() => baseTableColumns.value.filter((column) => ['select', 'actions'].includes(column.key) || !hiddenColumns.has(column.key)))

const currentResourceType = computed(() => resolveResourceType())
const currentDefinition = computed(() => resourceDefinitions[currentResourceType.value] ?? resourceDefinitions.pods)
const createDefinition = computed(() => currentDefinition.value)
const currentCreateSchema = computed(() => createSchemas[createDefinition.value.type])
const visibleCreateSections = computed(() => (
  currentCreateSchema.value?.sections.filter((section) => {
    if (createDefinition.value.type === 'deployments' && section.title === '基本信息') return false
    if (usesPodSpecCreateForm.value && ['Pod 模板', 'Pod 配置'].includes(section.title)) return true
    return true
  }) ?? []
))
const hasCreateSchema = computed(() => Boolean(currentCreateSchema.value))
const usesPodSpecCreateForm = computed(() => createDefinition.value.type === 'deployments' || createDefinition.value.type === 'pods')
const createPodSpecTitle = computed(() => createDefinition.value.type === 'pods' ? 'Pod 配置' : 'Pod 模板')
const createPodSpecDescription = computed(() => createDefinition.value.type === 'pods'
  ? '创建单个 Pod 的 spec：普通容器、Init 容器、安全、网络、存储卷和调度都会直接写入 Pod。'
  : 'Deployment Pod 模板统一纳管普通容器与 Init 容器；这些配置会写入 spec.template。')
const relatedResourceType = computed<RelatedCreateType>(() => relatedMountType.value === 'configMap' ? 'configmaps' : relatedMountType.value === 'secret' ? 'secrets' : 'persistent-volume-claims')
const relatedDefinition = computed(() => resourceDefinitions[relatedResourceType.value])
const relatedCreateSchema = computed(() => createSchemas[relatedDefinition.value.type])
const hasRelatedCreateSchema = computed(() => Boolean(relatedCreateSchema.value))
const relatedFillTargetText = computed(() => {
  if (relatedTargetKind.value === 'pod-volume') return 'Pod 存储卷'
  if (relatedTargetKind.value === 'image-pull-secret') return '镜像拉取密钥'
  return '当前容器挂载配置'
})
const activeAppContainer = computed(() => createForm.appContainers.find((item) => item.id === activeAppContainerId.value) ?? createForm.appContainers[0])
const activeInitContainer = computed(() => createForm.initContainers.find((item) => item.id === activeInitContainerId.value) ?? createForm.initContainers[0])
const createDialogWidth = computed(() => createDialogSize.value === 'wide' ? 'workspace' : 'full')
const createDialogSplitClass = computed(() => (
  createDialogSize.value === 'wide'
    ? 'xl:grid-cols-[minmax(0,1.08fr)_minmax(420px,0.92fr)]'
    : '2xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]'
))
const yamlValidationItems = computed<YamlValidationItem[]>(() => validateYamlContent(formState.yaml, createDefinition.value, formState.namespace || createForm.namespace))
const yamlDocumentSummaries = computed(() => {
  const parsed = parseKubeYamlDocuments(formState.yaml)
  if (!parsed.ok || !parsed.values || parsed.values.length <= 1) return []
  return parsed.values.map((object, index) => {
    const kind = String(object.kind ?? createDefinition.value.kind)
    const name = yamlObjectName(object) || `未命名-${index + 1}`
    const namespace = yamlObjectNamespace(object, '')
    return {
      index,
      label: `${index + 1}. ${kind}/${name}`,
      description: namespace ? `Namespace: ${namespace}` : 'Cluster scope / 未设置 Namespace'
    }
  })
})
const highlightedYaml = computed(() => highlightYaml(formState.yaml))
const clusterOptions = computed(() => clusters.value.map((cluster) => ({ label: cluster.name, value: cluster.id })))
const imagePullSecretOptions = computed(() => {
  const options = configSourceOptions.secret.filter((option) => {
    const secretType = option.secretType ?? ''
    return option.usage === 'imagePullSecret' || option.usage === 'both' || secretType === 'kubernetes.io/dockerconfigjson' || secretType === 'kubernetes.io/dockercfg'
  })
  imagePullSecretNames().forEach((name) => {
    if (!options.some((option) => option.value === name)) options.push({ label: `${name}（YAML 原始值）`, value: name })
  })
  return options
})
const imagePullSecretTriggerText = computed(() => {
  const names = imagePullSecretNames()
  if (!names.length) return '请选择镜像仓库认证 Secret'
  if (names.length === 1) return names[0]
  return `已选择 ${names.length} 个：${names.join(', ')}`
})
const workloadActionLabels: Record<ConfirmAction, string> = {
  'bulk-delete': '批量删除',
  scale: '扩缩容',
  restart: '重启',
  'update-image': '更新镜像',
  rollback: '回滚',
  delete: '删除',
  terminal: '进入终端',
  drain: 'drain 节点',
  cordon: 'cordon 节点',
  uncordon: 'uncordon 节点',
  'reveal-secret': '查看 Secret 明文'
}
const workloadActionDialogTitle = computed(() => `确认${workloadActionLabels[actionForm.action] ?? '操作'}`)
const workloadActionConfirmText = computed(() => {
  if (!selectedResource.value) return ''
  const target = `${selectedResource.value.kind}/${selectedResource.value.name}`
  if (actionForm.action === 'scale') return `确认将 ${target} 调整为 ${actionForm.replicas} 个副本。`
  if (actionForm.action === 'update-image') return `确认将 ${target} 更新为指定镜像。`
  if (actionForm.action === 'rollback') return `确认将 ${target} 回滚到指定版本。`
  if (actionForm.action === 'restart') return `确认重启 ${target}。`
  return `确认执行 ${target} 操作。`
})
const computedNamespaceOptions = computed(() => {
  const options = currentDefinition.value.namespaced ? namespaceOptions : ['cluster-scope']
  return options.map((namespace) => ({ label: namespace, value: namespace }))
})
const computedNodeOptions = computed(() => {
  const nodeNames = new Set<string>()
  resources.value
    .filter((item) => item.clusterId === filters.clusterId)
    .filter((item) => item.type === 'pods')
    .forEach((item) => {
      const nodeName = String(item.nodeName || item.node || item.details.nodeName || '').trim()
      if (nodeName) nodeNames.add(nodeName)
    })
  return [
    { label: '全部节点', value: 'all-nodes' },
    ...Array.from(nodeNames).sort().map((nodeName) => ({ label: nodeName, value: nodeName }))
  ]
})
const filteredResources = computed(() => {
  const keyword = filters.keyword.trim().toLowerCase()
  const name = filters.name.trim().toLowerCase()
  const labelFilter = filters.labels.trim().toLowerCase()
  return resources.value
    .filter((item) => item.clusterId === filters.clusterId)
    .filter((item) => item.type === currentDefinition.value.type)
    .filter((item) => !currentDefinition.value.namespaced || filters.namespace === 'all-namespaces' || item.namespace === filters.namespace)
    .filter((item) => !currentDefinition.value.pod || filters.nodeName === 'all-nodes' || String(item.nodeName || item.node || item.details.nodeName || '') === filters.nodeName)
    .filter((item) => filters.status === 'all' || item.status === filters.status)
    .filter((item) => !name || item.name.toLowerCase().includes(name))
    .filter((item) => {
      if (!labelFilter) return true
      return Object.entries(item.labels).some(([key, value]) => `${key}=${value}`.toLowerCase().includes(labelFilter))
    })
    .filter((item) => {
      if (!keyword) return true
      return `${item.name} ${item.namespace ?? ''} ${item.kind} ${item.status} ${item.nodeName ?? ''} ${item.node ?? ''} ${item.details.nodeName ?? ''}`.toLowerCase().includes(keyword)
    })
})
const visibleSelectableResources = computed(() => filteredResources.value.filter(() => !currentDefinition.value.deleteDisabled))
const selectedResources = computed(() => filteredResources.value.filter((item) => selectedResourceIds.has(item.id)))
const allVisibleSelected = computed(() => visibleSelectableResources.value.length > 0 && visibleSelectableResources.value.every((item) => selectedResourceIds.has(item.id)))
const someVisibleSelected = computed(() => visibleSelectableResources.value.some((item) => selectedResourceIds.has(item.id)))
const totalPages = computed(() => Math.max(1, Math.ceil(filteredResources.value.length / pageSize.value)))
const pagedResources = computed(() => filteredResources.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
const detailTabs = [
  { id: 'overview', label: '基本信息' },
  { id: 'status', label: '状态' },
  { id: 'metadata', label: '标签与注解' },
  { id: 'relations', label: '关联资源' },
  { id: 'mounts', label: '挂载' },
  { id: 'monitoring', label: '监控' },
  { id: 'events', label: '事件' },
  { id: 'yaml', label: 'YAML' }
] as const
const containerDetailTabs: Array<{ id: ContainerDetailTab; label: string }> = [
  { id: 'details', label: '详情' },
  { id: 'env', label: '环境变量' },
  { id: 'mounts', label: '挂载' }
]
const visibleDetailTabs = computed(() => {
  if (isPodResource(selectedResource.value)) {
    return detailTabs.filter((tab) => ['overview', 'mounts', 'monitoring', 'events', 'yaml'].includes(tab.id))
  }
  if (isDeploymentResource(selectedResource.value)) {
    return detailTabs.filter((tab) => ['overview', 'monitoring', 'events', 'yaml'].includes(tab.id))
  }
  return detailTabs
})
const resourceDetailTitle = computed(() => selectedResource.value ? `${selectedResource.value.kind} 资源详情` : '资源详情')
const isTemplateContainerDetail = computed(() => isDeploymentResource(selectedResource.value))
const containerDetailTitle = computed(() => isTemplateContainerDetail.value ? `模板容器详情 / ${selectedContainerName.value}` : `容器详情 / ${selectedContainerName.value}`)
watch(activeMonitoringTarget, () => {
  activeMonitoringIndex.value = null
})
watch([activeMonitoringRange, activeMonitoringStep], () => {
  const rangeSeconds = monitoringSelectedRange.value.seconds
  const stepSeconds = monitoringSelectedStep.value.seconds
  if (rangeSeconds / stepSeconds > 240) {
    activeMonitoringStep.value = rangeSeconds >= 12 * 60 * 60 ? '15m' : rangeSeconds >= 6 * 60 * 60 ? '5m' : '60s'
  }
  activeMonitoringIndex.value = null
})
const podTemplatePanels: Array<{ id: PodTemplatePanel; label: string; help: string }> = [
  { id: 'app', label: '普通容器', help: 'Pod 中长期运行的业务容器，可配置多个容器，并分别维护基础、环境变量、资源、安全、探针、挂载和生命周期。' },
  { id: 'init', label: 'Init 容器', help: 'Pod 启动前顺序执行的初始化容器，支持命令、环境变量、资源和挂载；普通 init 容器不配置探针和生命周期钩子。' }
]
const appContainerPanels: Array<{ id: AppContainerPanel; label: string; help: string }> = [
  { id: 'basic', label: '基础', help: '配置普通容器名称、镜像、拉取策略和 ports。' },
  { id: 'env', label: '环境变量', help: '写入当前普通容器 env。' },
  { id: 'resources', label: '资源', help: '按 CPU 与内存配置当前普通容器 requests / limits。' },
  { id: 'security', label: '安全', help: '配置当前普通容器 securityContext，可覆盖 Pod 级默认安全上下文。' },
  { id: 'probes', label: '健康检查', help: '配置当前普通容器 readiness、liveness 和 startup probe。' },
  { id: 'mounts', label: '挂载', help: '从 Pod 存储卷中选择 volume，并配置当前普通容器 volumeMounts。' },
  { id: 'lifecycle', label: '生命周期', help: '配置当前普通容器 PostStart / PreStop 钩子。' }
]
const imagePullPolicyOptions = [
  { label: 'IfNotPresent', value: 'IfNotPresent' },
  { label: 'Always', value: 'Always' },
  { label: 'Never', value: 'Never' }
]
const terminalCommandOptions = [
  { label: '/bin/sh', value: '/bin/sh' },
  { label: '/bin/bash', value: '/bin/bash' },
  { label: '/busybox/sh', value: '/busybox/sh' },
  { label: '/bin/ash', value: '/bin/ash' },
  { label: '自定义', value: 'custom' }
]
const terminalCommand = computed(() => terminalCommandPreset.value === 'custom' ? terminalCustomCommand.value.trim() || '/bin/sh' : terminalCommandPreset.value)
const deploymentPanels: Array<{ id: DeploymentPanel; label: string; help: string }> = [
  { id: 'basic', label: '基本信息', help: '配置 Deployment 名称、Namespace 和副本数。' },
  { id: 'metadata', label: '元数据信息', help: '默认标签 key 为 app，value 跟随名称；注解默认为空。' }
]
const podSecurityPanels: Array<{ id: PodSecurityPanel; label: string; help: string }> = [
  { id: 'identity', label: '身份', help: 'ServiceAccount 与 token 自动挂载属于 Pod spec。' },
  { id: 'pod', label: 'Pod SecurityContext', help: 'runAsUser、runAsGroup、fsGroup、runAsNonRoot 和 seccompProfile 作用于整个 Pod。' }
]
const initContainerPanels: Array<{ id: InitContainerPanel; label: string; help: string }> = [
  { id: 'basic', label: '基础', help: '配置 Init 容器名称、镜像和拉取策略。' },
  { id: 'command', label: '命令', help: 'command 和 args 使用逗号分隔，会分别写入 Kubernetes command / args 数组。' },
  { id: 'env', label: '环境变量', help: '写入 Init 容器 env。' },
  { id: 'resources', label: '资源', help: '写入 Init 容器 resources.requests / limits。' },
  { id: 'security', label: '安全', help: '配置 Init 容器 securityContext；常规 Init 容器不支持探针和生命周期钩子。' },
  { id: 'mounts', label: '挂载', help: '从 Pod 存储卷中选择 volume，并配置 Init 容器 volumeMounts。' }
]
const resourcePanels: Array<{ id: ResourcePanel; label: string; help: string }> = [
  { id: 'cpu', label: 'CPU', help: 'CPU requests / limits' },
  { id: 'memory', label: '内存', help: 'Memory requests / limits' }
]
const probePanels: Array<{ id: ProbePanel; label: string; help: string }> = [
  { id: 'readiness', label: 'Readiness', help: '控制服务是否接收流量' },
  { id: 'liveness', label: 'Liveness', help: '控制容器是否需要重启' },
  { id: 'startup', label: 'Startup', help: '控制慢启动容器启动期探测' }
]
const mountPanels: Array<{ id: MountPanel; label: string; help: string }> = [
  { id: 'configMap', label: 'ConfigMap', help: '挂载配置数据' },
  { id: 'secret', label: 'Secret', help: '挂载敏感配置' },
  { id: 'persistentVolumeClaim', label: 'PVC', help: '挂载 PersistentVolumeClaim 存储卷' },
  { id: 'emptyDir', label: 'emptyDir', help: 'Pod 临时目录' }
]
const podSchedulePanels: Array<{ id: PodSchedulePanel; label: string; help: string }> = [
  { id: 'affinity', label: 'Pod 亲和', help: '让当前 Pod 倾向或要求与匹配标签的 Pod 落在同一拓扑域，例如同一节点或同一可用区。' },
  { id: 'antiAffinity', label: 'Pod 反亲和', help: '让当前 Pod 避开匹配标签的 Pod，常用于副本分散到不同节点或可用区。' }
]
const nodeSchedulePanels: Array<{ id: NodeSchedulePanel; label: string; help: string }> = [
  { id: 'selector', label: '节点标签选择', help: 'nodeSelector 是最直接的节点筛选：节点必须同时具备这里填写的全部标签键值。' },
  { id: 'affinity', label: '节点亲和', help: '节点亲和使用匹配表达式描述节点标签条件；当前表单写入 requiredDuringSchedulingIgnoredDuringExecution。' },
  { id: 'tolerations', label: '污点容忍', help: '容忍允许 Pod 调度到带有匹配污点的节点；是否最终调度仍取决于其它调度条件。' }
]
const lifecyclePanels: Array<{ id: LifecyclePanel; label: string; help: string }> = [
  { id: 'postStart', label: 'PostStart', help: '容器启动后立即触发的钩子。' },
  { id: 'preStop', label: 'PreStop', help: '容器停止前触发的钩子。' }
]
const strategyPanels: Array<{ id: StrategyPanel; label: string; help: string }> = [
  { id: 'strategy', label: '更新方式', help: '默认不写入 spec.strategy，使用 Kubernetes 默认 RollingUpdate。需要显式控制时再配置。' },
  { id: 'history', label: '历史与进度', help: '配置 minReadySeconds、revisionHistoryLimit、progressDeadlineSeconds 和 paused，默认不写入。' }
]
const yamlTemplates: Array<{ id: YamlTemplateId; label: string; description: string; patch: Partial<CreateFormState> }> = [
  {
    id: 'web',
    label: 'Web 服务',
    description: 'Nginx/HTTP 服务，模板只预填最小 Deployment、镜像和端口字段。',
    patch: {
      replicas: 2,
      containerName: 'app',
      image: 'nginx:1.27',
      cpuRequest: '',
      cpuLimit: '',
      memoryRequest: '',
      memoryLimit: '',
      readinessPath: '',
      livenessPath: '',
      startupPath: '',
      ports: [{ id: 'http', name: 'http', port: 80, targetPort: 8080, protocol: 'TCP', hostPortEnabled: false, hostPort: null, hostIP: '' }],
      env: []
    }
  },
  {
    id: 'api',
    label: 'API 服务',
    description: '后端 API 服务，模板只预填最小 Deployment、镜像和端口字段。',
    patch: {
      replicas: 3,
      containerName: 'api',
      image: 'registry.example.com/app/api:1.0.0',
      serviceAccountName: '',
      cpuRequest: '',
      cpuLimit: '',
      memoryRequest: '',
      memoryLimit: '',
      readinessPath: '',
      livenessPath: '',
      startupPath: '',
      ports: [{ id: 'http', name: 'http', port: 80, targetPort: 8080, protocol: 'TCP', hostPortEnabled: false, hostPort: null, hostIP: '' }],
      env: []
    }
  },
  {
    id: 'worker',
    label: '后台任务',
    description: '后台消费任务样例，只预填最小 Deployment 和镜像字段。',
    patch: {
      replicas: 1,
      containerName: 'worker',
      image: 'registry.example.com/app/worker:1.0.0',
      cpuRequest: '',
      cpuLimit: '',
      memoryRequest: '',
      memoryLimit: '',
      readinessPath: '',
      livenessPath: '',
      startupPath: '',
      ports: [],
      env: []
    }
  },
  {
    id: 'db',
    label: '轻量 DB',
    description: '开发/测试态单副本数据库样例，只预填最小 Deployment、镜像和端口字段；生产有状态服务建议使用 StatefulSet。',
    patch: {
      replicas: 1,
      containerName: 'db',
      image: 'postgres:16',
      cpuRequest: '',
      cpuLimit: '',
      memoryRequest: '',
      memoryLimit: '',
      readinessPath: '',
      livenessPath: '',
      startupPath: '',
      ports: [{ id: 'postgres', name: 'postgres', port: 5432, targetPort: 5432, protocol: 'TCP', hostPortEnabled: false, hostPort: null, hostIP: '' }],
      env: []
    }
  }
]
const configSourceOptions = reactive<Record<Exclude<MountPanel, 'emptyDir'>, ConfigSourceOption[]>>({
  configMap: [
    { label: 'app-config', value: 'app-config' },
    { label: 'nginx-conf', value: 'nginx-conf' },
    { label: 'feature-flags', value: 'feature-flags' }
  ],
  secret: [
    { label: 'app-secret', value: 'app-secret', secretType: 'Opaque', usage: 'volume' },
    { label: 'db-password', value: 'db-password', secretType: 'Opaque', usage: 'volume' },
    { label: 'registry-credential', value: 'registry-credential', secretType: 'kubernetes.io/dockerconfigjson', usage: 'imagePullSecret' }
  ],
  persistentVolumeClaim: [
    { label: 'app-data', value: 'app-data' },
    { label: 'logs-pvc', value: 'logs-pvc' },
    { label: 'cache-pvc', value: 'cache-pvc' }
  ]
})
const resourceFieldGroups: Record<ResourcePanel, Array<{ key: keyof CreateFormState; label: string; placeholder: string; help: string }>> = {
  cpu: [
    { key: 'cpuRequest', label: 'CPU Request', placeholder: '100m', help: '调度时预留的 CPU。' },
    { key: 'cpuLimit', label: 'CPU Limit', placeholder: '500m', help: '容器可使用的 CPU 上限。' }
  ],
  memory: [
    { key: 'memoryRequest', label: 'Memory Request', placeholder: '128Mi', help: '调度时预留的内存。' },
    { key: 'memoryLimit', label: 'Memory Limit', placeholder: '512Mi', help: '容器可使用的内存上限。' }
  ]
}
const probeFieldGroups: Record<ProbePanel, Array<{ key: keyof CreateFormState; label: string; type: 'text' | 'number'; placeholder?: string; min?: number; help: string }>> = {
  readiness: [
    { key: 'readinessPath', label: 'HTTP 路径', type: 'text', placeholder: '/readyz', help: '为空时不生成 readinessProbe。' },
    { key: 'readinessPort', label: '端口', type: 'number', min: 1, help: '通常与容器端口一致。' },
    { key: 'readinessInitialDelaySeconds', label: '启动延迟', type: 'number', min: 0, help: '容器启动后等待多少秒开始探测。' },
    { key: 'readinessPeriodSeconds', label: '探测周期', type: 'number', min: 1, help: '两次探测之间的间隔秒数。' },
    { key: 'readinessTimeoutSeconds', label: '超时时间', type: 'number', min: 1, help: '单次探测超时秒数。' },
    { key: 'readinessFailureThreshold', label: '失败阈值', type: 'number', min: 1, help: '连续失败多少次后标记为未就绪。' },
    { key: 'readinessSuccessThreshold', label: '成功阈值', type: 'number', min: 1, help: '连续成功多少次后恢复就绪。' }
  ],
  liveness: [
    { key: 'livenessPath', label: 'HTTP 路径', type: 'text', placeholder: '/healthz', help: '为空时不生成 livenessProbe。' },
    { key: 'livenessPort', label: '端口', type: 'number', min: 1, help: '通常与容器端口一致。' },
    { key: 'livenessInitialDelaySeconds', label: '启动延迟', type: 'number', min: 0, help: '容器启动后等待多少秒开始探测。' },
    { key: 'livenessPeriodSeconds', label: '探测周期', type: 'number', min: 1, help: '两次探测之间的间隔秒数。' },
    { key: 'livenessTimeoutSeconds', label: '超时时间', type: 'number', min: 1, help: '单次探测超时秒数。' },
    { key: 'livenessFailureThreshold', label: '失败阈值', type: 'number', min: 1, help: '连续失败多少次后重启容器。' },
    { key: 'livenessSuccessThreshold', label: '成功阈值', type: 'number', min: 1, help: '连续成功多少次后恢复健康。' }
  ],
  startup: [
    { key: 'startupPath', label: 'HTTP 路径', type: 'text', placeholder: '/startupz', help: '为空时不生成 startupProbe。' },
    { key: 'startupPort', label: '端口', type: 'number', min: 1, help: '通常与容器端口一致。' },
    { key: 'startupInitialDelaySeconds', label: '启动延迟', type: 'number', min: 0, help: '容器启动后等待多少秒开始探测。' },
    { key: 'startupPeriodSeconds', label: '探测周期', type: 'number', min: 1, help: '两次探测之间的间隔秒数。' },
    { key: 'startupTimeoutSeconds', label: '超时时间', type: 'number', min: 1, help: '单次探测超时秒数。' },
    { key: 'startupFailureThreshold', label: '失败阈值', type: 'number', min: 1, help: '慢启动容器允许失败的次数。' },
    { key: 'startupSuccessThreshold', label: '成功阈值', type: 'number', min: 1, help: '连续成功多少次后结束启动探测。' }
  ]
}

function getExport<T>(name: string): T | undefined {
  return apiBag[name] as T | undefined
}

function getDataExport<T>(name: string): T | undefined {
  return dataBag[name] as T | undefined
}

async function callApi<TArgs extends unknown[], TResult>(names: string[], args: TArgs, fallback: TResult): Promise<TResult> {
  for (const name of names) {
    const fn = getExport<ApiFn<TArgs, TResult>>(name)
    if (typeof fn === 'function') return await fn(...args)
  }
  return fallback
}

function resolveResourceType() {
  const fromMeta = String(route.meta.resourceType ?? '')
  if (fromMeta && resourceDefinitions[fromMeta]) return fromMeta
  const fromName = route.name ? routeAliases[String(route.name)] : ''
  if (fromName) return fromName
  const segments = route.path.split('/').filter(Boolean)
  const path = segments[segments.length - 1] ?? 'pods'
  return resourceDefinitions[path] ? path : 'pods'
}

function queryStringValue(value: unknown) {
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')
}

function applyRouteFiltersFromQuery() {
  const namespace = queryStringValue(route.query.namespace)
  const nodeName = queryStringValue(route.query.nodeName || route.query.node)
  const detailName = queryStringValue(route.query.detail)
  const name = queryStringValue(route.query.name)
  const labels = queryStringValue(route.query.labels)
  const status = queryStringValue(route.query.status)
  const keyword = queryStringValue(route.query.keyword)
  if (namespace) filters.namespace = namespace
  if (nodeName) filters.nodeName = nodeName
  if (name || detailName) filters.name = name || detailName
  if (labels) filters.labels = labels
  if (status) filters.status = status
  if (keyword) filters.keyword = keyword
}

function sampleYaml(kind: string, name: string, namespace?: string) {
  return [
    'apiVersion: v1',
    `kind: ${kind}`,
    'metadata:',
    `  name: ${name}`,
    namespace ? `  namespace: ${namespace}` : '',
    '  labels:',
    '    app.kubernetes.io/managed-by: kube-subops',
    'spec:',
    '  # 由后端返回完整 YAML；当前为前端 mock 示例'
  ].filter(Boolean).join('\n')
}

function makeResource(definition: ResourceDefinition, index: number): KubeResourceItem {
  const namespace = definition.namespaced ? ['default', 'platform', 'observability'][index % 3] : undefined
  const baseName = {
    pods: ['gateway-668b7d9b77-kw7mx', 'payment-api-7f6cdd5f65-2kqvc', 'console-6f5fbcc8b6-nv2sq'],
    deployments: ['gateway', 'payment-api', 'console'],
    statefulsets: ['postgres', 'redis', 'victoria-metrics'],
    daemonsets: ['node-exporter', 'fluent-bit', 'csi-node'],
    nodes: ['worker-a', 'worker-b', 'control-plane-1'],
    secrets: ['registry-credential', 'db-password', 'webhook-token'],
    services: ['gateway', 'payment-api', 'console']
  }[definition.type]?.[index] ?? `${definition.type}-${index + 1}`
  const status: ResourceStatus = index === 1 ? 'Warning' : definition.type === 'jobs' ? 'Succeeded' : definition.type === 'persistent-volume-claims' ? 'Bound' : 'Running'
  return {
    id: `${definition.type}-${baseName}`,
    clusterId: filters.clusterId,
    type: definition.type,
    kind: definition.kind,
    namespace,
    name: baseName,
    labels: {
      app: baseName.split('-')[0] || definition.type,
      tier: index % 2 ? 'backend' : 'platform'
    },
    annotations: {
      'kube-subops.io/last-sync': '2026-05-27T10:30:00+08:00',
      'kubectl.kubernetes.io/last-applied-configuration': 'managed'
    },
    status,
    age: `${index + 2}d`,
    ready: definition.pod ? (index === 1 ? '0/1' : '1/1') : definition.workload ? (index === 1 ? '2/3' : '3/3') : '-',
    node: definition.pod ? ['worker-a', 'worker-b', 'worker-c'][index % 3] : undefined,
    image: definition.pod || definition.workload ? `registry.internal/${baseName}:v1.${index + 2}.0` : undefined,
    replicas: definition.workload ? (index === 1 ? 2 : 3) : undefined,
    desiredReplicas: definition.workload ? 3 : undefined,
    owner: definition.pod ? 'ReplicaSet/console-6f5fbcc8b6' : undefined,
    related: [
      { kind: 'Pod', name: `${baseName}-pod-a`, namespace, status: index === 1 ? 'Warning' : 'Running' },
      { kind: 'Service', name: baseName, namespace, status: 'Ready' }
    ],
    events: [
      { id: `${baseName}-evt-1`, type: index === 1 ? 'Warning' : 'Normal', reason: index === 1 ? 'Unhealthy' : 'Pulled', message: index === 1 ? 'readiness probe failed' : 'Container image pulled', lastSeen: '5 分钟前' },
      { id: `${baseName}-evt-2`, type: 'Normal', reason: 'Scheduled', message: 'Successfully assigned resource', lastSeen: '1 小时前' }
    ],
    yaml: sampleYaml(definition.kind, baseName, namespace),
    details: {
      API版本: 'v1',
      创建时间: '2026-05-24 10:12',
      所属节点: definition.pod ? ['worker-a', 'worker-b', 'worker-c'][index % 3] : '-',
      镜像: definition.pod || definition.workload ? `registry.internal/${baseName}:v1.${index + 2}.0` : '-'
    }
  }
}

function buildFallbackResources(type = currentDefinition.value.type) {
  const definition = resourceDefinitions[type] ?? resourceDefinitions.pods
  return [0, 1, 2].map((index) => makeResource(definition, index))
}

function stringDetailValue(value: unknown) {
  if (Array.isArray(value)) return value.join(',')
  if (value === undefined || value === null) return ''
  return String(value)
}

const detailFieldLabels: Record<string, string> = {
  phase: '阶段',
  ready: '容器就绪',
  restarts: '重启次数',
  restartCount: '重启次数',
  podIP: 'Pod IP',
  hostIP: '宿主机 IP',
  nodeName: '节点',
  nodeInternalIP: '节点内网 IP',
  nodeExternalIP: '节点外网 IP',
  owner: '所属控制器',
  containers: '容器',
  initContainers: 'Init 容器',
  images: '镜像',
  containerPorts: '容器端口',
  cpuUsage: 'CPU 用量',
  memoryUsage: '内存用量',
  cpuRequest: 'CPU Request',
  cpuLimit: 'CPU Limit',
  memoryRequest: '内存 Request',
  memoryLimit: '内存 Limit',
  serviceAccountName: 'ServiceAccount',
  qosClass: 'QoS',
  conditions: 'Conditions',
  volumes: '存储卷',
  dnsPolicy: 'DNS 策略',
  hostNetwork: '宿主机网络',
  nodeSelector: '节点选择器',
  imagePullSecrets: '镜像拉取密钥',
  lastError: '最近错误',
  replicas: '副本数',
  strategy: '更新策略',
  maxSurge: 'maxSurge',
  maxUnavailable: 'maxUnavailable',
  rollingUpdateNote: '滚动更新提示',
  minReadySeconds: '最小就绪时间',
  revisionHistoryLimit: '历史版本保留',
  progressDeadlineSeconds: '进度超时时间',
  paused: '暂停发布',
  selector: '选择器',
  serviceName: 'Service 名称',
  updateStrategy: '更新策略',
  desired: '期望数量',
  current: '当前数量'
}

function detailFieldLabel(key: string) {
  return detailFieldLabels[key] ?? key
}

function detailFieldValue(value: unknown) {
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.join(',')
  if (value === undefined || value === null || value === '') return '-'
  return String(value)
}

function isPodResource(resource: KubeResourceItem | null | undefined) {
  return resource?.type === 'pods' || resource?.kind === 'Pod'
}

function isDeploymentResource(resource: KubeResourceItem | null | undefined) {
  return resource?.type === 'deployments' || resource?.kind === 'Deployment'
}

function splitDetailList(value: unknown) {
  return stringDetailValue(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function yamlObjectFromResource(resource: KubeResourceItem) {
  const parsed = parseKubeYaml(resource.yaml)
  return parsed.ok && parsed.value ? parsed.value : null
}

function podSpecFromResource(resource: KubeResourceItem) {
  const object = yamlObjectFromResource(resource)
  const spec = object ? readPath(object, ['spec']) : undefined
  return asRecord(spec)
}

function podContainersFromResource(resource: KubeResourceItem) {
  const containers = podSpecFromResource(resource).containers
  return Array.isArray(containers) ? containers.map((container) => asRecord(container)) : []
}

function podVolumesFromResource(resource: KubeResourceItem) {
  const volumes = podSpecFromResource(resource).volumes
  return Array.isArray(volumes) ? volumes.map((volume) => asRecord(volume)) : []
}

function csvFromRecordValue(value: unknown) {
  const record = asRecord(value)
  return Object.entries(record).map(([key, item]) => `${key}=${item}`).join(', ')
}

function containerFieldList(container: Record<string, unknown>, key: string, formatter: (item: Record<string, unknown>) => string) {
  const values = container[key]
  if (!Array.isArray(values)) return ''
  return values
    .map((item) => formatter(asRecord(item)))
    .filter(Boolean)
    .join(', ')
}

function volumeSourceSummary(volume: Record<string, unknown>) {
  const name = String(volume.name ?? '').trim()
  if (!name) return ''
  if (volume.configMap) return `${name}（ConfigMap/${asRecord(volume.configMap).name ?? '-'}）`
  if (volume.secret) return `${name}（Secret/${asRecord(volume.secret).secretName ?? '-'}）`
  if (volume.persistentVolumeClaim) return `${name}（PVC/${asRecord(volume.persistentVolumeClaim).claimName ?? '-'}）`
  if (volume.emptyDir) return `${name}（emptyDir）`
  if (volume.projected) return `${name}（projected）`
  if (volume.hostPath) return `${name}（hostPath/${asRecord(volume.hostPath).path ?? '-'}）`
  return name
}

function volumeSourceResource(volume: Record<string, unknown>, namespace?: string): RelatedResourceItem | null {
  if (volume.configMap) {
    const name = String(asRecord(volume.configMap).name ?? '').trim()
    return name ? { kind: 'ConfigMap', name, namespace, resourceType: 'configmaps', relation: 'mounted' } : null
  }
  if (volume.secret) {
    const name = String(asRecord(volume.secret).secretName ?? '').trim()
    return name ? { kind: 'Secret', name, namespace, resourceType: 'secrets', relation: 'mounted' } : null
  }
  if (volume.persistentVolumeClaim) {
    const name = String(asRecord(volume.persistentVolumeClaim).claimName ?? '').trim()
    return name ? { kind: 'PersistentVolumeClaim', name, namespace, resourceType: 'persistent-volume-claims', relation: 'mounted' } : null
  }
  return null
}

function volumeSourceKind(volume: Record<string, unknown>) {
  if (volume.configMap) return 'ConfigMap'
  if (volume.secret) return 'Secret'
  if (volume.persistentVolumeClaim) return 'PVC'
  if (volume.emptyDir) return 'emptyDir'
  if (volume.projected) return 'projected'
  if (volume.hostPath) return 'hostPath'
  return 'Volume'
}

function containerYamlObject(resource: KubeResourceItem, containerName: string) {
  return podContainersFromResource(resource).find((container) => String(container.name ?? '') === containerName) ?? null
}

function containerStatusObject(resource: KubeResourceItem, containerName: string) {
  const object = yamlObjectFromResource(resource)
  const statuses = object ? readPath(object, ['status', 'containerStatuses']) : undefined
  if (!Array.isArray(statuses)) return null
  return statuses.map((status) => asRecord(status)).find((status) => String(status.name ?? '') === containerName) ?? null
}

function containerStateText(status: Record<string, unknown> | null, fallback: string) {
  const state = asRecord(status?.state)
  if (state.running) {
    const startedAt = asRecord(state.running).startedAt
    return startedAt ? `Running since ${startedAt}` : 'Running'
  }
  if (state.waiting) {
    const waiting = asRecord(state.waiting)
    return String(waiting.reason ?? waiting.message ?? 'Waiting')
  }
  if (state.terminated) {
    const terminated = asRecord(state.terminated)
    return String(terminated.reason ?? terminated.exitCode ?? 'Terminated')
  }
  return fallback
}

function containerResourceRows(container: Record<string, unknown>) {
  const requests = asRecord(asRecord(container.resources).requests)
  const limits = asRecord(asRecord(container.resources).limits)
  return {
    requests: [
      `CPU: ${requests.cpu ?? '-'}`,
      `Memory: ${requests.memory ?? '-'}`
    ],
    limits: [
      `CPU: ${limits.cpu ?? '-'}`,
      `Memory: ${limits.memory ?? '-'}`
    ]
  }
}

function selectedContainerYamlObject() {
  const resource = selectedResource.value
  if (!resource) return null
  if (isDeploymentResource(resource)) {
    return workloadTemplateContainers(resource).find((container) => String(container.name ?? '') === selectedContainerName.value) ?? null
  }
  return containerYamlObject(resource, selectedContainerName.value)
}

function selectedContainerStatusObject() {
  const resource = selectedResource.value
  if (isDeploymentResource(resource)) return null
  return resource ? containerStatusObject(resource, selectedContainerName.value) : null
}

function podContainerRows(resource: KubeResourceItem) {
  const names = splitDetailList(resource.details.containers)
  const images = splitDetailList(resource.details.images)
  const ports = splitDetailList(resource.details.containerPorts)
  const yamlContainers = podContainersFromResource(resource)
  const sourceNames = yamlContainers.map((container) => String(container.name ?? '')).filter(Boolean)
  const containerNames = Array.from(new Set([...sourceNames, ...names]))
  return (containerNames.length ? containerNames : ['app']).map((name, index) => {
    const yamlContainer = yamlContainers.find((container) => String(container.name ?? '') === name)
    const yamlPorts = containerFieldList(yamlContainer ?? {}, 'ports', (port) => `${port.name ? `${port.name}:` : ''}${port.containerPort ?? '-'}${port.protocol ? `/${port.protocol}` : '/TCP'}`)
    return {
    name,
    image: String(yamlContainer?.image ?? images[index] ?? images[0] ?? '-'),
    status: resource.status,
    restarts: resource.restarts ?? resource.details.restartCount ?? 0,
    cpu: podMetricValue(resource, 'cpuUsage', 'cpuRequest', 'cpuLimit'),
    memory: podMetricValue(resource, 'memoryUsage', 'memoryRequest', 'memoryLimit'),
    port: yamlPorts || ports[index] || ports[0] || '-'
    }
  })
}

function podTerminalContainerOptions(resource: KubeResourceItem | null) {
  if (!resource || !isPodResource(resource)) return []
  return podContainerRows(resource).map((container) => ({
    label: container.name,
    value: container.name
  }))
}

function selectedContainerRow() {
  const resource = selectedResource.value
  if (!resource) return null
  if (isDeploymentResource(resource)) {
    const templateContainer = deploymentContainerRows(resource).find((container) => container.name === selectedContainerName.value)
    return templateContainer
      ? {
          name: templateContainer.name,
          image: templateContainer.image,
          status: 'Template',
          restarts: '不适用',
          cpu: templateContainer.cpu,
          memory: templateContainer.memory,
          port: templateContainer.ports
        }
      : null
  }
  return podContainerRows(resource).find((container) => container.name === selectedContainerName.value) ?? null
}

function openContainerDetail(containerName: string) {
  selectedContainerName.value = containerName
  activeContainerDetailTab.value = 'details'
  containerDetailOpen.value = true
}

function closeContainerDetail() {
  containerDetailOpen.value = false
  activeContainerDetailTab.value = 'details'
}

function selectedContainerDetailRows() {
  const resource = selectedResource.value
  const container = selectedContainerRow()
  if (!resource || !container) return []
  const yamlContainer = selectedContainerYamlObject() ?? {}
  const status = selectedContainerStatusObject()
  if (isDeploymentResource(resource)) {
    return [
      { label: 'Image', value: container.image },
      { label: 'Image Pull Policy', value: yamlContainer.imagePullPolicy || 'IfNotPresent' },
      { label: 'Ports', value: container.port },
      { label: 'Command', value: Array.isArray(yamlContainer.command) ? yamlContainer.command.join(' ') : yamlContainer.command },
      { label: 'Args', value: Array.isArray(yamlContainer.args) ? yamlContainer.args.join(' ') : yamlContainer.args },
      { label: 'Env Count', value: selectedContainerEnvRows().length },
      { label: 'Volume Mounts', value: selectedContainerMountRows().length }
    ]
  }
  return [
    { label: 'Image', value: container.image },
    { label: 'Image Pull Policy', value: yamlContainer.imagePullPolicy || 'IfNotPresent' },
    { label: 'State', value: containerStateText(status, container.status) },
    { label: 'Ports', value: container.port },
    { label: 'Restart Count', value: status?.restartCount ?? container.restarts },
    { label: 'Image ID', value: status?.imageID || '未返回' },
    { label: 'Container ID', value: status?.containerID || '未返回' }
  ]
}

function selectedContainerEnvRows() {
  const container = selectedContainerYamlObject()
  if (!container || !Array.isArray(container.env)) return []
  return container.env.map((item) => {
    const env = asRecord(item)
    const name = String(env.name ?? '').trim()
    const valueFrom = asRecord(env.valueFrom)
    let value = env.value !== undefined ? String(env.value) : ''
    let source = 'value'
    if (!value && valueFrom.configMapKeyRef) {
      const ref = asRecord(valueFrom.configMapKeyRef)
      value = `${ref.name ?? '-'}/${ref.key ?? '-'}`
      source = 'ConfigMap'
    } else if (!value && valueFrom.secretKeyRef) {
      const ref = asRecord(valueFrom.secretKeyRef)
      value = `${ref.name ?? '-'}/${ref.key ?? '-'}`
      source = 'Secret'
    } else if (!value && valueFrom.fieldRef) {
      value = String(asRecord(valueFrom.fieldRef).fieldPath ?? '-')
      source = 'FieldRef'
    } else if (!value && valueFrom.resourceFieldRef) {
      value = String(asRecord(valueFrom.resourceFieldRef).resource ?? '-')
      source = 'ResourceFieldRef'
    }
    return { name, source, value: value || '-' }
  }).filter((item) => item.name)
}

function selectedContainerMountRows() {
  const resource = selectedResource.value
  const container = selectedContainerYamlObject()
  if (!resource || !container || !Array.isArray(container.volumeMounts)) return []
  const volumes = isDeploymentResource(resource) ? workloadTemplateVolumes(resource) : podVolumesFromResource(resource)
  return container.volumeMounts.map((item) => {
    const mount = asRecord(item)
    const name = String(mount.name ?? '').trim()
    const volume = volumes.find((candidate) => String(candidate.name ?? '') === name)
    return {
      name,
      mountPath: String(mount.mountPath ?? '-'),
      subPath: String(mount.subPath ?? ''),
      readOnly: mount.readOnly === true,
      source: volume ? volumeSourceSummary(volume) : name,
      sourceResource: volume ? volumeSourceResource(volume, resource.namespace) : null
    }
  }).filter((item) => item.name)
}

function podVolumeDetailRows(resource: KubeResourceItem) {
  return podVolumesFromResource(resource).map((volume) => {
    const name = String(volume.name ?? '').trim()
    return {
      name,
      kind: volumeSourceKind(volume),
      summary: volumeSourceSummary(volume),
      sourceResource: volumeSourceResource(volume, resource.namespace)
    }
  }).filter((item) => item.name)
}

function podContainerMountMatrix(resource: KubeResourceItem) {
  const volumes = podVolumesFromResource(resource)
  return podContainersFromResource(resource).map((container) => {
    const name = String(container.name ?? '').trim()
    const mounts = Array.isArray(container.volumeMounts)
      ? container.volumeMounts.map((item) => {
        const mount = asRecord(item)
        const volumeName = String(mount.name ?? '').trim()
        const volume = volumes.find((candidate) => String(candidate.name ?? '') === volumeName)
        return {
          name: volumeName,
          mountPath: String(mount.mountPath ?? '-'),
          subPath: String(mount.subPath ?? ''),
          readOnly: mount.readOnly === true,
          source: volume ? volumeSourceSummary(volume) : volumeName,
          sourceKind: volume ? volumeSourceKind(volume) : 'Volume',
          sourceResource: volume ? volumeSourceResource(volume, resource.namespace) : null
        }
      }).filter((mount) => mount.name)
      : []
    return { name, mounts }
  }).filter((item) => item.name)
}

function podInfoRows(resource: KubeResourceItem) {
  return [
    { label: '所有者', value: resource.details.owner || resource.owner || '-' },
    { label: 'ServiceAccount', value: resource.details.serviceAccountName || '-' },
    { label: '重启策略', value: resource.details.restartPolicy || 'Always' },
    { label: 'DNS 策略', value: resource.details.dnsPolicy || 'ClusterFirst' },
    { label: 'QoS 类', value: resource.details.qosClass || '-' },
    { label: '主机网络', value: detailFieldValue(resource.details.hostNetwork || '否') },
    { label: '节点内网 IP', value: nodeInternalIP(resource) || '-' },
    { label: '节点外网 IP', value: nodeExternalIP(resource) || '-' },
    { label: '存储卷', value: resource.details.volumes || '-' },
    { label: 'Conditions', value: resource.details.conditions || '-' }
  ]
}

function podPortRows(resource: KubeResourceItem) {
  return splitDetailList(resource.details.containerPorts).map((port) => {
    const [number = port, protocol = 'TCP'] = port.split('/')
    return { number, protocol }
  })
}

function podRelatedRows(resource: KubeResourceItem) {
  const rows = [...resource.related]
  const owner = stringDetailValue(resource.details.owner || resource.owner)
  const deploymentName = owner.startsWith('Deployment/') ? owner.slice('Deployment/'.length) : ''
  if (deploymentName && !rows.some((item) => item.kind === 'Deployment' && item.name === deploymentName)) {
    rows.unshift({
      kind: 'Deployment',
      name: deploymentName,
      namespace: resource.namespace,
      status: 'Available',
      resourceType: 'deployments',
      relation: 'owner'
    })
  }
  const replicaSet = resource.ownerReferences?.find((item) => item.kind === 'ReplicaSet')?.name
  if (replicaSet && !rows.some((item) => item.kind === 'ReplicaSet' && item.name === replicaSet)) {
    rows.push({
      kind: 'ReplicaSet',
      name: replicaSet,
      namespace: resource.namespace,
      status: 'Ready',
      resourceType: 'replicasets',
      relation: 'ownerReference'
    })
  }
  return rows.slice(0, 5)
}

function podVolumeRows(resource: KubeResourceItem) {
  const yamlVolumes = podVolumesFromResource(resource).map(volumeSourceSummary).filter(Boolean)
  return yamlVolumes.length ? yamlVolumes : splitDetailList(resource.details.volumes)
}

function workloadSpecFromResource(resource: KubeResourceItem) {
  const object = yamlObjectFromResource(resource)
  return object ? asRecord(readPath(object, ['spec'])) : {}
}

function workloadTemplateSpecFromResource(resource: KubeResourceItem) {
  return asRecord(readPath(workloadSpecFromResource(resource), ['template', 'spec']))
}

function workloadTemplateContainers(resource: KubeResourceItem) {
  const containers = workloadTemplateSpecFromResource(resource).containers
  if (Array.isArray(containers)) return containers.map((container) => asRecord(container))
  const names = splitDetailList(resource.details.containers)
  const images = splitDetailList(resource.details.images || resource.image)
  return names.map((name, index) => ({ name, image: images[index] ?? images[0] ?? '-' } as Record<string, unknown>))
}

function workloadTemplateVolumes(resource: KubeResourceItem) {
  const volumes = workloadTemplateSpecFromResource(resource).volumes
  if (Array.isArray(volumes)) return volumes.map((volume) => asRecord(volume))
  return []
}

function workloadTemplateVolumeRows(resource: KubeResourceItem) {
  const yamlVolumes = workloadTemplateVolumes(resource).map(volumeSourceSummary).filter(Boolean)
  return yamlVolumes.length ? yamlVolumes : splitDetailList(resource.details.volumes)
}

function deploymentReplicas(resource: KubeResourceItem) {
  const desired = Number(resource.desiredReplicas ?? resource.details.desiredReplicas ?? resource.details.replicas ?? resource.replicas ?? 0)
  const updated = Number(resource.details.updatedReplicas ?? desired)
  const available = Number(resource.details.availableReplicas ?? String(resource.ready ?? '').split('/')[0] ?? 0)
  const unavailable = Number(resource.details.unavailableReplicas ?? Math.max(0, desired - available))
  return { desired, updated, available, unavailable }
}

function deploymentConditionRows(resource: KubeResourceItem) {
  const object = yamlObjectFromResource(resource)
  const conditions = object ? readPath(object, ['status', 'conditions']) : undefined
  if (Array.isArray(conditions)) {
    return conditions.map((condition) => {
      const item = asRecord(condition)
      return {
        type: String(item.type ?? '-'),
        status: String(item.status ?? '-'),
        reason: String(item.reason ?? '-'),
        message: String(item.message ?? '')
      }
    })
  }
  return splitDetailList(resource.details.conditions).map((condition) => {
    const match = condition.match(/^([^=]+)=([^(]+)(?:\(([^)]+)\))?/)
    return {
      type: match?.[1] ?? condition,
      status: match?.[2] ?? '-',
      reason: match?.[3] ?? '-',
      message: ''
    }
  })
}

function deploymentInfoRows(resource: KubeResourceItem) {
  return [
    { label: 'Selector', value: resource.details.selector || '-' },
    { label: 'Strategy', value: resource.details.strategy || 'RollingUpdate' },
    { label: 'maxSurge', value: resource.details.strategy === 'Recreate' ? '不适用' : resource.details.maxSurge || '-' },
    { label: 'maxUnavailable', value: resource.details.strategy === 'Recreate' ? '不适用' : resource.details.maxUnavailable || '-' },
    { label: 'minReadySeconds', value: resource.details.minReadySeconds ?? '-' },
    { label: 'progressDeadlineSeconds', value: resource.details.progressDeadlineSeconds ?? '-' },
    { label: 'revisionHistoryLimit', value: resource.details.revisionHistoryLimit ?? '-' },
    { label: 'paused', value: detailFieldValue(resource.details.paused ?? false) },
    { label: 'observedGeneration', value: resource.details.observedGeneration ?? '-' },
    { label: 'ServiceAccount', value: resource.details.serviceAccountName || '-' },
    { label: 'imagePullSecrets', value: resource.details.imagePullSecrets || '-' }
  ]
}

function deploymentContainerRows(resource: KubeResourceItem) {
  return workloadTemplateContainers(resource).map((container, index) => {
    const ports = Array.isArray(container.ports)
      ? container.ports.map((port: unknown) => {
        const item = asRecord(port)
        return `${item.name ? `${item.name}:` : ''}${item.containerPort ?? '-'}${item.protocol ? `/${item.protocol}` : '/TCP'}`
      }).join(', ')
      : splitDetailList(resource.details.containerPorts)[index] || splitDetailList(resource.details.containerPorts)[0] || '-'
    const requests = asRecord(asRecord(container.resources).requests)
    const limits = asRecord(asRecord(container.resources).limits)
    return {
      name: String(container.name ?? `container-${index + 1}`),
      image: String(container.image ?? resource.images?.[index] ?? resource.image ?? '-'),
      policy: String(container.imagePullPolicy ?? 'IfNotPresent'),
      ports,
      cpu: `${requests.cpu ?? '-'} / ${limits.cpu ?? '-'}`,
      memory: `${requests.memory ?? '-'} / ${limits.memory ?? '-'}`
    }
  })
}

function deploymentRelatedRows(resource: KubeResourceItem) {
  const rows = [...resource.related]
  return rows
    .filter((item) => ['ReplicaSet', 'Pod', 'Service', 'Endpoint', 'EndpointSlice'].includes(item.kind))
    .slice(0, 8)
}

function labelsFromYamlObject(object: Record<string, unknown>, fallbackName: string) {
  const labels = asRecord(readPath(object, ['metadata', 'labels']))
  if (!Object.keys(labels).length) return { app: fallbackName, 'app.kubernetes.io/managed-by': 'kube-subops' }
  return Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)]))
}

function annotationsFromYamlObject(object: Record<string, unknown>) {
  const annotations = asRecord(readPath(object, ['metadata', 'annotations']))
  return Object.fromEntries(Object.entries(annotations).map(([key, value]) => [key, String(value)]))
}

function imagesFromYamlObject(object: Record<string, unknown>) {
  const containers = String(object.kind ?? '') === 'Pod'
    ? readPath(object, ['spec', 'containers'])
    : readPath(object, ['spec', 'template', 'spec', 'containers'])
  if (!Array.isArray(containers)) return []
  return containers
    .map((container) => String(asRecord(container).image ?? '').trim())
    .filter(Boolean)
}

function ownerReferencesFromYamlObject(object: Record<string, unknown>) {
  const owners = readPath(object, ['metadata', 'ownerReferences'])
  if (!Array.isArray(owners)) return []
  return owners
    .map((owner) => {
      const item = asRecord(owner)
      const kind = String(item.kind ?? '').trim()
      const name = String(item.name ?? '').trim()
      return kind && name ? { kind, name, resourceType: resourceTypeForKind(kind) } : null
    })
    .filter((owner): owner is { kind: string; name: string; resourceType: string } => Boolean(owner))
}

function podDetailsFromYamlObject(object: Record<string, unknown>) {
  const spec = asRecord(readPath(object, ['spec']))
  const status = asRecord(readPath(object, ['status']))
  const containers = Array.isArray(spec.containers) ? spec.containers.map((container) => asRecord(container)) : []
  const initContainers = Array.isArray(spec.initContainers) ? spec.initContainers.map((container) => asRecord(container)) : []
  const containerStatuses = Array.isArray(status.containerStatuses) ? status.containerStatuses.map((container) => asRecord(container)) : []
  const volumes = Array.isArray(spec.volumes) ? spec.volumes.map((volume) => asRecord(volume)) : []
  const ports = containers.flatMap((container) =>
    (Array.isArray(container.ports) ? container.ports : []).map((port) => {
      const item = asRecord(port)
      return `${item.name ? `${item.name}:` : ''}${item.containerPort ?? '-'}/${item.protocol ?? 'TCP'}`
    })
  )
  const conditions = (Array.isArray(status.conditions) ? status.conditions : []).map((condition) => {
    const item = asRecord(condition)
    return `${item.type}=${item.status}${item.reason ? `(${item.reason})` : ''}`
  })
  const imagePullSecrets = (Array.isArray(spec.imagePullSecrets) ? spec.imagePullSecrets : [])
    .map((secret) => String(asRecord(secret).name ?? '').trim())
    .filter(Boolean)
  const restartCount = containerStatuses.reduce((sum, item) => sum + Number(item.restartCount ?? 0), 0)
  const readyCount = containerStatuses.filter((container) => container.ready === true).length
  const details: KubeResourceItem['details'] = {}
  const firstOwner = ownerReferencesFromYamlObject(object)[0]
  if (status.phase !== undefined) details.phase = String(status.phase)
  if (containers.length) details.ready = containerStatuses.length ? `${readyCount}/${containers.length}` : `${containers.length}/${containers.length}`
  if (restartCount) details.restartCount = restartCount
  if (status.podIP !== undefined) details.podIP = String(status.podIP)
  if (status.hostIP !== undefined) details.hostIP = String(status.hostIP)
  if (spec.nodeName !== undefined) details.nodeName = String(spec.nodeName)
  if (firstOwner) details.owner = `${firstOwner.kind}/${firstOwner.name}`
  if (containers.length) details.containers = containers.map((container) => String(container.name ?? '')).filter(Boolean).join(', ')
  if (initContainers.length) details.initContainers = initContainers.map((container) => String(container.name ?? '')).filter(Boolean).join(', ')
  const images = imagesFromYamlObject(object)
  if (images.length) details.images = images.join(', ')
  if (ports.length) details.containerPorts = ports.join(', ')
  if (spec.serviceAccountName !== undefined) details.serviceAccountName = String(spec.serviceAccountName)
  if (status.qosClass !== undefined) details.qosClass = String(status.qosClass)
  if (conditions.length) details.conditions = conditions.join(', ')
  if (volumes.length) details.volumes = volumes.map(volumeSourceSummary).join(', ')
  if (spec.dnsPolicy !== undefined) details.dnsPolicy = String(spec.dnsPolicy)
  if (spec.hostNetwork !== undefined) details.hostNetwork = Boolean(spec.hostNetwork)
  const nodeSelector = csvFromRecordValue(spec.nodeSelector)
  if (nodeSelector) details.nodeSelector = nodeSelector
  if (imagePullSecrets.length) details.imagePullSecrets = imagePullSecrets.join(', ')
  return details
}

function applyYamlObjectToResource(resource: KubeResourceItem, object: Record<string, unknown>, yaml: string) {
  const name = yamlObjectName(object) || resource.name
  const namespace = currentDefinition.value.namespaced ? yamlObjectNamespace(object, resource.namespace ?? '') || resource.namespace : undefined
  const kind = String(object.kind ?? resource.kind)
  const details = kind === 'Pod' ? podDetailsFromYamlObject(object) : resource.details
  const images = imagesFromYamlObject(object)
  resource.name = name
  resource.kind = kind
  resource.namespace = namespace
  resource.labels = labelsFromYamlObject(object, name)
  resource.annotations = annotationsFromYamlObject(object)
  resource.ownerReferences = ownerReferencesFromYamlObject(object)
  resource.yaml = yaml
  resource.details = { ...resource.details, ...details }
  if (kind === 'Pod') {
    resource.status = String(readPath(object, ['status', 'phase']) ?? resource.status) as ResourceStatus
    resource.ready = String(details.ready ?? resource.ready ?? '-')
    resource.restarts = Number(details.restartCount ?? resource.restarts ?? 0)
    resource.podIP = String(details.podIP ?? '') || undefined
    resource.nodeName = String(details.nodeName ?? '') || undefined
    resource.image = images[0] ?? resource.image
  }
}

function onDetailYamlInput(event: Event) {
  detailYamlDraft.value = inputValue(event)
  detailYamlError.value = ''
}

async function saveDetailYaml() {
  const resource = selectedResource.value
  if (!resource) return
  const parsed = parseKubeYaml(detailYamlDraft.value)
  if (!parsed.ok || !parsed.value) {
    detailYamlError.value = parsed.error ?? 'YAML 解析失败。'
    return
  }
  const errors = validateYamlObject(parsed.value, resourceDefinitions[resource.type] ?? currentDefinition.value, resource.namespace)
  if (errors.length) {
    detailYamlError.value = errors.join(' ')
    return
  }
  const yaml = detailYamlDraft.value
  applyYamlObjectToResource(resource, parsed.value, yaml)
  await callApi(
    ['updateKubeResource', 'updateResource'],
    [{
      clusterId: resource.clusterId,
      resourceType: resource.type,
      namespace: resource.namespace,
      name: resource.name,
      yaml
    }],
    { ok: true }
  )
  successMessage.value = `${resource.kind}/${resource.name} YAML 已保存到当前列表数据。`
  detailYamlError.value = ''
}

function isColumnVisible(key: string) {
  return !hiddenColumns.has(key)
}

function saveHiddenColumns() {
  localStorage.setItem(resourceColumnStorageKey.value, JSON.stringify([...hiddenColumns]))
}

function loadHiddenColumns() {
  hiddenColumns.clear()
  try {
    const raw = localStorage.getItem(resourceColumnStorageKey.value)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) parsed.forEach((key) => hiddenColumns.add(String(key)))
      return
    }
  } catch {
    hiddenColumns.clear()
  }
  defaultHiddenColumnKeys.value.forEach((key) => hiddenColumns.add(key))
}

function toggleColumn(key: string) {
  if (hiddenColumns.has(key)) {
    hiddenColumns.delete(key)
  } else {
    hiddenColumns.add(key)
  }
  saveHiddenColumns()
}

function resetVisibleColumns() {
  hiddenColumns.clear()
  defaultHiddenColumnKeys.value.forEach((key) => hiddenColumns.add(key))
  saveHiddenColumns()
}

function handleClickOutside(event: MouseEvent) {
  const target = event.target as Node
  if (columnDropdownRef.value && !columnDropdownRef.value.contains(target)) showColumnDropdown.value = false
}

function podMetricValue(resource: KubeResourceItem, usageKey: 'cpuUsage' | 'memoryUsage', requestKey: 'cpuRequest' | 'memoryRequest', limitKey: 'cpuLimit' | 'memoryLimit') {
  const usage = resource[usageKey] || resource.details[usageKey]
  const request = resource[requestKey] || resource.details[requestKey]
  const limit = resource[limitKey] || resource.details[limitKey]
  if (usage) return `${usage} / ${limit || request || '-'}`
  if (request || limit) return `req ${request || '-'} / lim ${limit || '-'}`
  return '-'
}

function resourceMetricParts(resource: KubeResourceItem, kind: 'cpu' | 'memory') {
  const usageKey = kind === 'cpu' ? 'cpuUsage' : 'memoryUsage'
  const requestKey = kind === 'cpu' ? 'cpuRequest' : 'memoryRequest'
  const limitKey = kind === 'cpu' ? 'cpuLimit' : 'memoryLimit'
  const usage = String(resource[usageKey] || resource.details[usageKey] || '')
  const request = String(resource[requestKey] || resource.details[requestKey] || '')
  const limit = String(resource[limitKey] || resource.details[limitKey] || '')
  return { usage, request, limit }
}

function parseMetricQuantity(value: string, kind: 'cpu' | 'memory') {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (kind === 'cpu') {
    if (trimmed.endsWith('m')) {
      const numeric = Number(trimmed.slice(0, -1))
      return Number.isFinite(numeric) ? numeric : null
    }
    const numeric = Number(trimmed)
    return Number.isFinite(numeric) ? numeric * 1000 : null
  }

  const units: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4
  }
  const matched = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)?$/)
  if (!matched) return null
  const numeric = Number(matched[1])
  if (!Number.isFinite(numeric)) return null
  const unit = matched[2] || ''
  return numeric * (units[unit] ?? 1)
}

function metricPercent(resource: KubeResourceItem, kind: 'cpu' | 'memory') {
  const { usage, request, limit } = resourceMetricParts(resource, kind)
  const denominator = parseMetricQuantity(limit || request, kind)
  const numerator = parseMetricQuantity(usage, kind)
  if (numerator === null || denominator === null || denominator <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)))
}

function metricRequestPercent(resource: KubeResourceItem, kind: 'cpu' | 'memory') {
  const { request, limit } = resourceMetricParts(resource, kind)
  const denominator = parseMetricQuantity(limit || request, kind)
  const numerator = parseMetricQuantity(request, kind)
  if (numerator === null || denominator === null || denominator <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)))
}

function metricBarClass(percent: number) {
  if (percent >= 90) return 'bg-red-500'
  if (percent >= 70) return 'bg-amber-500'
  return 'bg-primary-500'
}

function metricRequestText(resource: KubeResourceItem, kind: 'cpu' | 'memory') {
  return resourceMetricParts(resource, kind).request || '-'
}

function metricLimitText(resource: KubeResourceItem, kind: 'cpu' | 'memory') {
  return resourceMetricParts(resource, kind).limit || '-'
}

function metricUsageText(resource: KubeResourceItem, kind: 'cpu' | 'memory') {
  return resourceMetricParts(resource, kind).usage || '未返回'
}

function metricPercentText(resource: KubeResourceItem, kind: 'cpu' | 'memory') {
  return `${metricPercent(resource, kind)}%`
}

function metricTooltipRows(resource: KubeResourceItem, kind: 'cpu' | 'memory') {
  return [
    { label: 'Usage', value: metricUsageText(resource, kind) },
    { label: 'Request', value: metricRequestText(resource, kind) },
    { label: 'Limit', value: metricLimitText(resource, kind) }
  ]
}

function formatMetricQuantity(value: number, kind: 'cpu' | 'memory') {
  if (!Number.isFinite(value) || value <= 0) return ''
  if (kind === 'cpu') return `${Math.round(value)}m`
  return `${Math.round(value / (1024 ** 2))}Mi`
}

function deploymentMetricPods(resource: KubeResourceItem) {
  const app = resourceSelectorApp(resource)
  const relatedPodNames = new Set(deploymentRelatedRows(resource).filter((item) => item.kind === 'Pod').map((item) => item.name))
  return resources.value.filter((item) => {
    if (!isPodResource(item) || item.clusterId !== resource.clusterId || item.namespace !== resource.namespace) return false
    if (relatedPodNames.has(item.name)) return true
    return Boolean(app && item.labels.app === app)
  })
}

function monitoringTargets(resource: KubeResourceItem) {
  if (isPodResource(resource)) return [resource]
  if (isDeploymentResource(resource)) return deploymentMetricPods(resource)
  return []
}

function aggregateMetricParts(targets: KubeResourceItem[], kind: 'cpu' | 'memory') {
  const totals = { usage: 0, request: 0, limit: 0 }
  const seen = { usage: false, request: false, limit: false }
  targets.forEach((target) => {
    const parts = resourceMetricParts(target, kind)
    ;(['usage', 'request', 'limit'] as const).forEach((key) => {
      const parsed = parseMetricQuantity(parts[key], kind)
      if (parsed !== null) {
        totals[key] += parsed
        seen[key] = true
      }
    })
  })
  return {
    usage: seen.usage ? formatMetricQuantity(totals.usage, kind) : '',
    request: seen.request ? formatMetricQuantity(totals.request, kind) : '',
    limit: seen.limit ? formatMetricQuantity(totals.limit, kind) : ''
  }
}

function splitMetricQuantity(value: string, kind: 'cpu' | 'memory', divisor: number) {
  const parsed = parseMetricQuantity(value, kind)
  if (parsed === null || divisor <= 0) return ''
  return formatMetricQuantity(parsed / divisor, kind)
}

function podContainerMetricParts(resource: KubeResourceItem, containerName: string, kind: 'cpu' | 'memory') {
  const containers = podContainersFromResource(resource)
  const index = Math.max(0, containers.findIndex((container) => String(container.name ?? '') === containerName))
  const container = containers[index] ?? {}
  const total = Math.max(1, containers.length)
  const resources = asRecord(container.resources)
  const requests = asRecord(resources.requests)
  const limits = asRecord(resources.limits)
  const podParts = resourceMetricParts(resource, kind)
  const totalUsage = parseMetricQuantity(podParts.usage, kind)
  const weight = total === 1 ? 1 : index === 0 ? 0.62 : 0.38 / Math.max(1, total - 1)
  return {
    usage: totalUsage === null ? '' : formatMetricQuantity(totalUsage * weight, kind),
    request: String(requests[kind] ?? '') || splitMetricQuantity(podParts.request, kind, total),
    limit: String(limits[kind] ?? '') || splitMetricQuantity(podParts.limit, kind, total)
  }
}

function monitoringTargetOptions(resource: KubeResourceItem) {
  if (isPodResource(resource)) {
    return [
      { label: 'All Containers', value: 'all' },
      ...podContainerRows(resource).map((container) => ({ label: container.name, value: `container:${container.name}` }))
    ]
  }
  if (isDeploymentResource(resource)) {
    return [
      { label: 'All Pods', value: 'all' },
      ...deploymentMetricPods(resource).map((pod) => ({ label: pod.name, value: `pod:${pod.name}` }))
    ]
  }
  return [{ label: 'All', value: 'all' }]
}

function ensureMonitoringTarget(resource: KubeResourceItem) {
  const options = monitoringTargetOptions(resource)
  if (!options.some((option) => option.value === activeMonitoringTarget.value)) {
    activeMonitoringTarget.value = options[0]?.value ?? 'all'
  }
}

function monitoringSelectedTargets(resource: KubeResourceItem) {
  ensureMonitoringTarget(resource)
  if (isDeploymentResource(resource) && activeMonitoringTarget.value.startsWith('pod:')) {
    const podName = activeMonitoringTarget.value.slice('pod:'.length)
    return deploymentMetricPods(resource).filter((pod) => pod.name === podName)
  }
  return monitoringTargets(resource)
}

function monitoringSelectionParts(resource: KubeResourceItem, kind: 'cpu' | 'memory') {
  ensureMonitoringTarget(resource)
  if (isPodResource(resource) && activeMonitoringTarget.value.startsWith('container:')) {
    return podContainerMetricParts(resource, activeMonitoringTarget.value.slice('container:'.length), kind)
  }
  return aggregateMetricParts(monitoringSelectedTargets(resource), kind)
}

function monitoringMetricPercent(resource: KubeResourceItem, kind: 'cpu' | 'memory') {
  const parts = monitoringSelectionParts(resource, kind)
  const denominator = parseMetricQuantity(parts.limit || parts.request, kind)
  const numerator = parseMetricQuantity(parts.usage, kind)
  if (numerator === null || denominator === null || denominator <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)))
}

type MonitoringChartKind = 'cpu' | 'memory' | 'network' | 'disk'
type MonitoringChartDefinition = {
  kind: MonitoringChartKind
  title: string
  color: string
  secondaryColor?: string
  primaryLabel: string
  secondaryLabel?: string
  fill: string
  unit: string
  floor: number
  shape: 'spike' | 'area' | 'dual'
}
type KubeMonitoringDataset = {
  label: string
  data: number[]
  color: string
  fill?: boolean
  yAxisID?: 'y' | 'y1'
  unit?: string
}

function monitoringSeriesValues(resource: KubeResourceItem, kind: MonitoringChartKind, channel: 'primary' | 'secondary' = 'primary') {
  const seedSource = `${resource.name}-${activeMonitoringTarget.value}-${kind}-${channel}`
  const seed = Array.from(seedSource).reduce((sum, char) => sum + char.charCodeAt(0), 0)
  const percent = kind === 'cpu' || kind === 'memory' ? monitoringMetricPercent(resource, kind) : 0
  const base = kind === 'cpu'
    ? Math.max(0.02, percent / 100)
    : kind === 'memory'
      ? Math.max(1, parseMetricQuantity(monitoringSelectionParts(resource, 'memory').usage, 'memory') ?? 0) / (1024 ** 2)
      : 0
  return monitoringSampleIndexes().map((index) => {
    if (kind === 'network') {
      const spike = [2, 5, 8].includes((index + seed) % 11) ? 2 + ((seed + index) % 5) : 0
      return channel === 'secondary' ? spike * 0.45 : spike
    }
    if (kind === 'disk') {
      const spike = [3, 9].includes((index + seed) % 13) ? 0.8 + ((seed + index) % 4) * 0.4 : 0
      return channel === 'secondary' ? spike * 0.6 : spike
    }
    const wave = Math.sin((seed + index * 13) / 11) * (kind === 'cpu' ? 0.04 : 18)
    return Math.max(0, base + wave)
  })
}

function monitoringSampleIndexes() {
  const rangeSeconds = monitoringSelectedRange.value.seconds
  const stepSeconds = monitoringSelectedStep.value.seconds
  const rawCount = Math.max(2, Math.floor(rangeSeconds / stepSeconds) + 1)
  const stride = Math.max(1, Math.ceil(rawCount / 240))
  const indexes = Array.from({ length: rawCount }, (_, index) => index).filter((index) => index % stride === 0 || index === rawCount - 1)
  return indexes
}

function monitoringTimeLabels() {
  const rangeSeconds = monitoringSelectedRange.value.seconds
  const stepSeconds = monitoringSelectedStep.value.seconds
  const end = new Date('2026-05-30T02:00:00+08:00')
  const start = new Date(end.getTime() - rangeSeconds * 1000)
  return monitoringSampleIndexes().map((index) => {
    const time = new Date(start.getTime() + index * stepSeconds * 1000)
    const hh = String(time.getHours()).padStart(2, '0')
    const mm = String(time.getMinutes()).padStart(2, '0')
    const ss = String(time.getSeconds()).padStart(2, '0')
    return `${hh}:${mm}:${ss}`
  })
}

function monitoringChartCards(resource: KubeResourceItem) {
  const chartDefinitions: MonitoringChartDefinition[] = [
    { kind: 'cpu', title: 'CPU Usage', color: '#14b8a6', primaryLabel: 'Usage', fill: 'rgba(20, 184, 166, 0.10)', unit: 'cores', floor: 0.5, shape: 'spike' },
    { kind: 'memory', title: 'Memory Usage', color: '#3b82f6', primaryLabel: 'Usage', fill: 'rgba(59, 130, 246, 0.16)', unit: 'MiB', floor: 512, shape: 'area' },
    { kind: 'network', title: 'Network I/O', color: '#3b82f6', secondaryColor: '#14b8a6', primaryLabel: 'Ingress', secondaryLabel: 'Egress', fill: 'rgba(59, 130, 246, 0.14)', unit: 'B/s', floor: 30, shape: 'dual' },
    { kind: 'disk', title: 'Disk I/O', color: '#8b5cf6', secondaryColor: '#f59e0b', primaryLabel: 'Read', secondaryLabel: 'Write', fill: 'rgba(139, 92, 246, 0.12)', unit: 'B/s', floor: 20, shape: 'dual' }
  ]
  const labels = monitoringTimeLabels()
  return chartDefinitions.map((card) => {
    const primary = monitoringSeriesValues(resource, card.kind)
    const secondary = card.secondaryColor ? monitoringSeriesValues(resource, card.kind, 'secondary') : []
    const datasets: KubeMonitoringDataset[] = [
      {
        label: card.primaryLabel,
        data: primary,
        color: card.color,
        fill: card.shape !== 'spike',
        unit: card.unit
      }
    ]
    if (card.secondaryColor && card.secondaryLabel) {
      datasets.push({
        label: card.secondaryLabel,
        data: secondary,
        color: card.secondaryColor,
        fill: true,
        yAxisID: 'y1',
        unit: card.unit
      })
    }
    return {
      ...card,
      labels,
      datasets,
      rightAxis: datasets.some((dataset) => dataset.yAxisID === 'y1')
    }
  })
}

function monitoringTickLabel(value: number, kind: MonitoringChartKind) {
  if (kind === 'cpu') return value.toFixed(3)
  if (kind === 'memory') return `${value.toFixed(1)}Mi`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return value >= 10 ? value.toFixed(0) : value.toFixed(1)
}

function monitoringTooltipLabel(value: number, label: string, unit = '', kind: MonitoringChartKind) {
  const suffix = unit ? ` ${unit}` : ''
  if (kind === 'cpu') return `${label}: ${value.toFixed(3)}${suffix}`
  if (kind === 'memory') return `${label}: ${value.toFixed(2)}${suffix}`
  return `${label}: ${value.toFixed(2)}${suffix}`
}

function monitoringSampleSummary() {
  return `${monitoringSampleIndexes().length} points · ${monitoringSelectedStep.value.label}`
}

function monitoringHasUsage(resource: KubeResourceItem) {
  return monitoringSelectedTargets(resource).some((target) => Boolean(
    resourceMetricParts(target, 'cpu').usage ||
    resourceMetricParts(target, 'memory').usage
  ))
}

function monitoringUnavailableTitle(resource: KubeResourceItem) {
  return isDeploymentResource(resource) ? '当前 Deployment 未返回 Pod 实时用量' : '当前 Pod 未返回实时用量'
}

function nodeDisplayName(resource: KubeResourceItem) {
  return resource.nodeName || resource.node || String(resource.details.nodeName || '') || '-'
}

function nodeInternalIP(resource: KubeResourceItem) {
  return String(resource.details.nodeInternalIP || resource.details.internalIP || resource.details.hostIP || '').trim()
}

function nodeExternalIP(resource: KubeResourceItem) {
  return String(resource.details.nodeExternalIP || resource.details.externalIP || '').trim()
}

function visibleLabelPairs(resource: KubeResourceItem) {
  const labels = labelPairs(resource.labels)
  return currentDefinition.value.pod ? labels.slice(0, 2) : labels.slice(0, 3)
}

function hiddenLabelCount(resource: KubeResourceItem) {
  const labels = labelPairs(resource.labels)
  return Math.max(0, labels.length - (currentDefinition.value.pod ? 2 : 3))
}

function isRowSelected(resource: KubeResourceItem) {
  return selectedResourceIds.has(resource.id)
}

function toggleResourceSelection(resource: KubeResourceItem) {
  if (selectedResourceIds.has(resource.id)) {
    selectedResourceIds.delete(resource.id)
  } else {
    selectedResourceIds.add(resource.id)
  }
}

function toggleSelectAllVisible() {
  if (allVisibleSelected.value) {
    visibleSelectableResources.value.forEach((item) => selectedResourceIds.delete(item.id))
    return
  }
  visibleSelectableResources.value.forEach((item) => selectedResourceIds.add(item.id))
}

function clearSelectedResources() {
  selectedResourceIds.clear()
}

function resourceTypeForKind(kind: string) {
  return kindResourceTypes[kind] ?? ''
}

function resourceSelectorApp(resource: KubeResourceItem) {
  const selector = stringDetailValue(resource.details.selector)
  const appSelector = selector.split(',').map((item) => item.trim()).find((item) => item.startsWith('app='))
  return appSelector?.slice(4) || resource.labels.app || resource.name
}

function relationLabel(source: KubeResourceItem, target: KubeResourceItem) {
  if (source.ownerReferences?.some((owner) => owner.name === target.name)) return '上级控制器'
  if (target.ownerReferences?.some((owner) => owner.name === source.name)) return '直接拥有'
  if (target.kind === 'Pod') return '匹配 Pod'
  if (target.kind === 'Service') return '服务选择器'
  if (target.kind === 'Endpoint' || target.kind === 'EndpointSlice') return '服务端点'
  if (target.kind === 'ReplicaSet') return '副本集'
  return '关联'
}

function buildRelatedResources(resource: KubeResourceItem, allResources: KubeResourceItem[]): RelatedResourceItem[] {
  const directOwnerNames = new Set((resource.ownerReferences ?? []).map((owner) => owner.name))
  const app = resourceSelectorApp(resource)
  const childReplicaSets = allResources.filter((item) =>
    item.kind === 'ReplicaSet' &&
    item.namespace === resource.namespace &&
    item.ownerReferences?.some((owner) => owner.name === resource.name && owner.kind === resource.kind)
  )
  const childReplicaSetNames = new Set(childReplicaSets.map((item) => item.name))

  const related = allResources.filter((item) => {
    if (item.id === resource.id || item.clusterId !== resource.clusterId || item.namespace !== resource.namespace) return false
    if (directOwnerNames.has(item.name)) return true
    if (item.ownerReferences?.some((owner) => owner.name === resource.name)) return true
    if (childReplicaSetNames.has(item.name)) return true
    if (item.ownerReferences?.some((owner) => childReplicaSetNames.has(owner.name))) return true
    if (resource.kind === 'Deployment' && app && item.labels.app === app && ['Pod', 'Service', 'Endpoint', 'EndpointSlice'].includes(item.kind)) return true
    return false
  })

  return related.map((item) => ({
    kind: item.kind,
    name: item.name,
    namespace: item.namespace,
    status: item.status,
    resourceType: item.type,
    relation: relationLabel(resource, item),
    ready: item.ready
  }))
}

function normalizeResourceItem(item: unknown, index: number, fallbackDefinition = currentDefinition.value): KubeResourceItem {
  const partial = item as Partial<KubeResourceItem> & { resourceType?: string }
  const type = partial.type ?? partial.resourceType ?? fallbackDefinition.type
  const definition = resourceDefinitions[type] ?? fallbackDefinition
  return {
    ...makeResource(definition, index),
    ...partial,
    type,
    resourceType: type,
    kind: partial.kind ?? definition.kind,
    clusterId: partial.clusterId ?? filters.clusterId,
    labels: partial.labels ?? {},
    annotations: partial.annotations ?? {},
    ownerReferences: partial.ownerReferences ?? [],
    related: partial.related ?? [],
    events: partial.events ?? [],
    yaml: partial.yaml ?? sampleYaml(definition.kind, partial.name ?? `resource-${index + 1}`, partial.namespace)
  }
}

function normalizeKnownResources(currentItems: KubeResourceItem[]) {
  const knownResources = getDataExport<unknown[]>('kubeResourceSummaries')
  if (!Array.isArray(knownResources)) return currentItems
  return knownResources.map((item, index) => {
    const partial = item as { resourceType?: string; type?: string }
    const type = partial.type ?? partial.resourceType ?? currentDefinition.value.type
    return normalizeResourceItem(item, index, resourceDefinitions[type] ?? currentDefinition.value)
  })
}

function normalizeResourceList(value: unknown): KubeResourceItem[] {
  const candidate = Array.isArray(value) ? value : typeof value === 'object' && value !== null ? (value as { items?: unknown }).items : undefined
  if (!Array.isArray(candidate)) return buildFallbackResources()
  const normalized = candidate.map((item, index) => normalizeResourceItem(item, index))
  const relatedSource = normalizeKnownResources(normalized)
  return normalized.map((item) => ({
    ...item,
    related: item.related.length ? item.related : buildRelatedResources(item, relatedSource)
  }))
}

function statusClass(status: ResourceStatus | string) {
  if (['Running', 'Ready', 'Succeeded', 'Bound', 'Active', 'Available', 'Complete'].includes(status)) return 'badge-success'
  if (status === 'Pending') return 'badge-primary'
  if (['Warning', 'Terminating', 'Degraded'].includes(status)) return 'badge-warning'
  return 'badge-danger'
}

function labelPairs(labels: Record<string, string>) {
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`)
}

function inputValue(event: Event) {
  return (event.target as HTMLInputElement | HTMLTextAreaElement).value
}

function nextEntryId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

function scalarValue(key: keyof CreateFormState) {
  const value = createForm[key]
  return Array.isArray(value) ? '' : String(value ?? '')
}

function numberValue(key: keyof CreateFormState) {
  const value = createForm[key]
  return typeof value === 'number' ? value : Number(value) || 0
}

function fieldOptions(field: CreateField): Array<Record<string, string>> {
  return (field.options ?? []).map((option: CreateFieldOption) => ({ label: option.label, value: option.value }))
}

function markFormSource() {
  if (editMode.value === 'create' && hasCreateSchema.value && createMode.value !== 'form') {
    createMode.value = 'form'
    formErrors.value = []
  }
}

function updateScalarField(key: keyof CreateFormState, value: string | number | boolean | null) {
  markFormSource()
  const target = createForm as unknown as Record<keyof CreateFormState, unknown>
  target[key] = key === 'replicas' ? Number(value) || 0 : String(value ?? '')
}

function updateTextField(key: keyof CreateFormState, event: Event) {
  const previousName = key === 'name' ? createForm.name : ''
  updateScalarField(key, inputValue(event))
  if (key === 'name' && usesPodSpecCreateForm.value) {
    const appLabel = createForm.labels.find((pair) => pair.key === 'app')
    if (!appLabel) {
      createForm.labels.unshift({ id: nextEntryId('pair'), key: 'app', value: createForm.name })
    } else if (!appLabel.value || appLabel.value === previousName) {
      appLabel.value = createForm.name
    }
  }
}

function updateNumberField(key: keyof CreateFormState, event: Event) {
  updateScalarField(key, Number(inputValue(event)) || 0)
}

function updateNullableNumberFormField(key: keyof CreateFormState, event: Event) {
  markFormSource()
  const value = inputValue(event).trim()
  const target = createForm as unknown as Record<keyof CreateFormState, unknown>
  target[key] = value === '' ? null : Number(value)
}

function pairList(key: keyof CreateFormState) {
  const value = createForm[key]
  return Array.isArray(value) ? (value as KeyValuePair[]) : []
}

function addPair(key: keyof CreateFormState) {
  markFormSource()
  const value = createForm[key]
  if (Array.isArray(value)) {
    const list = value as KeyValuePair[]
    list.push({ id: nextEntryId('pair'), key: '', value: '' })
  }
}

function removePair(key: keyof CreateFormState, id: string) {
  markFormSource()
  const value = createForm[key]
  if (!Array.isArray(value)) return
  const list = value as KeyValuePair[]
  if (list.length <= 1 && ['configData', 'secretData'].includes(String(key))) return
  const index = list.findIndex((item) => item.id === id)
  if (index >= 0) list.splice(index, 1)
}

function addPort() {
  markFormSource()
  createForm.ports.push(createEmptyPortEntry('port'))
}

function removePort(id: string) {
  markFormSource()
  const index = createForm.ports.findIndex((item) => item.id === id)
  if (index >= 0) createForm.ports.splice(index, 1)
}

function createEmptyPortEntry(prefix: string): PortEntry {
  return {
    id: nextEntryId(prefix),
    name: '',
    port: null,
    targetPort: null,
    protocol: 'TCP',
    hostPortEnabled: false,
    hostPort: null,
    hostIP: ''
  }
}

function updatePortNumberField(port: PortEntry, key: 'port' | 'targetPort' | 'hostPort', event: Event) {
  markFormSource()
  const value = inputValue(event).trim()
  port[key] = value === '' ? null : Number(value)
  syncLegacyFieldsFromActiveAppContainer()
}

function addEnv() {
  markFormSource()
  createForm.env.push({ id: nextEntryId('env'), name: '', value: '' })
}

function removeEnv(id: string) {
  markFormSource()
  const index = createForm.env.findIndex((item) => item.id === id)
  if (index >= 0) createForm.env.splice(index, 1)
}

function createAppContainerEntry(name = `app-${createForm.appContainers.length + 1}`): AppContainerEntry {
  return {
    id: nextEntryId('app-container'),
    name,
    image: 'nginx:1.27',
    imagePullPolicy: 'IfNotPresent',
    ports: [],
    env: [],
    cpuRequest: '',
    memoryRequest: '',
    cpuLimit: '',
    memoryLimit: '',
    readinessPath: '',
    readinessPort: 8080,
    readinessInitialDelaySeconds: 10,
    readinessPeriodSeconds: 10,
    readinessTimeoutSeconds: 1,
    readinessFailureThreshold: 3,
    readinessSuccessThreshold: 1,
    livenessPath: '',
    livenessPort: 8080,
    livenessInitialDelaySeconds: 30,
    livenessPeriodSeconds: 10,
    livenessTimeoutSeconds: 1,
    livenessFailureThreshold: 3,
    livenessSuccessThreshold: 1,
    startupPath: '',
    startupPort: 8080,
    startupInitialDelaySeconds: 0,
    startupPeriodSeconds: 10,
    startupTimeoutSeconds: 1,
    startupFailureThreshold: 30,
    startupSuccessThreshold: 1,
    volumeMounts: [],
    lifecycleHooks: [],
    containerRunAsUser: null,
    containerRunAsGroup: null,
    containerRunAsNonRoot: '',
    privileged: '',
    allowPrivilegeEscalation: '',
    readOnlyRootFilesystem: ''
  }
}

function seedAppContainersFromLegacyFields() {
  if (createForm.appContainers.length) return
  createForm.appContainers.push({
    ...createAppContainerEntry(createForm.containerName || createForm.name || 'app'),
    id: nextEntryId('app-container'),
    image: createForm.image,
    imagePullPolicy: createForm.imagePullPolicy,
    ports: createForm.ports,
    env: createForm.env,
    cpuRequest: createForm.cpuRequest,
    memoryRequest: createForm.memoryRequest,
    cpuLimit: createForm.cpuLimit,
    memoryLimit: createForm.memoryLimit,
    readinessPath: createForm.readinessPath,
    readinessPort: createForm.readinessPort,
    readinessInitialDelaySeconds: createForm.readinessInitialDelaySeconds,
    readinessPeriodSeconds: createForm.readinessPeriodSeconds,
    readinessTimeoutSeconds: createForm.readinessTimeoutSeconds,
    readinessFailureThreshold: createForm.readinessFailureThreshold,
    readinessSuccessThreshold: createForm.readinessSuccessThreshold,
    livenessPath: createForm.livenessPath,
    livenessPort: createForm.livenessPort,
    livenessInitialDelaySeconds: createForm.livenessInitialDelaySeconds,
    livenessPeriodSeconds: createForm.livenessPeriodSeconds,
    livenessTimeoutSeconds: createForm.livenessTimeoutSeconds,
    livenessFailureThreshold: createForm.livenessFailureThreshold,
    livenessSuccessThreshold: createForm.livenessSuccessThreshold,
    startupPath: createForm.startupPath,
    startupPort: createForm.startupPort,
    startupInitialDelaySeconds: createForm.startupInitialDelaySeconds,
    startupPeriodSeconds: createForm.startupPeriodSeconds,
    startupTimeoutSeconds: createForm.startupTimeoutSeconds,
    startupFailureThreshold: createForm.startupFailureThreshold,
    startupSuccessThreshold: createForm.startupSuccessThreshold,
    volumeMounts: createForm.volumeMounts,
    lifecycleHooks: createForm.lifecycleHooks,
    containerRunAsUser: createForm.containerRunAsUser,
    containerRunAsGroup: createForm.containerRunAsGroup,
    containerRunAsNonRoot: createForm.containerRunAsNonRoot,
    privileged: createForm.privileged,
    allowPrivilegeEscalation: createForm.allowPrivilegeEscalation,
    readOnlyRootFilesystem: createForm.readOnlyRootFilesystem
  })
}

function syncLegacyFieldsFromActiveAppContainer() {
  const container = activeAppContainer.value
  if (!container) return
  createForm.containerName = container.name
  createForm.image = container.image
  createForm.imagePullPolicy = container.imagePullPolicy
  createForm.ports = container.ports
  createForm.env = container.env
  createForm.cpuRequest = container.cpuRequest
  createForm.memoryRequest = container.memoryRequest
  createForm.cpuLimit = container.cpuLimit
  createForm.memoryLimit = container.memoryLimit
  createForm.readinessPath = container.readinessPath
  createForm.readinessPort = container.readinessPort
  createForm.readinessInitialDelaySeconds = container.readinessInitialDelaySeconds
  createForm.readinessPeriodSeconds = container.readinessPeriodSeconds
  createForm.readinessTimeoutSeconds = container.readinessTimeoutSeconds
  createForm.readinessFailureThreshold = container.readinessFailureThreshold
  createForm.readinessSuccessThreshold = container.readinessSuccessThreshold
  createForm.livenessPath = container.livenessPath
  createForm.livenessPort = container.livenessPort
  createForm.livenessInitialDelaySeconds = container.livenessInitialDelaySeconds
  createForm.livenessPeriodSeconds = container.livenessPeriodSeconds
  createForm.livenessTimeoutSeconds = container.livenessTimeoutSeconds
  createForm.livenessFailureThreshold = container.livenessFailureThreshold
  createForm.livenessSuccessThreshold = container.livenessSuccessThreshold
  createForm.startupPath = container.startupPath
  createForm.startupPort = container.startupPort
  createForm.startupInitialDelaySeconds = container.startupInitialDelaySeconds
  createForm.startupPeriodSeconds = container.startupPeriodSeconds
  createForm.startupTimeoutSeconds = container.startupTimeoutSeconds
  createForm.startupFailureThreshold = container.startupFailureThreshold
  createForm.startupSuccessThreshold = container.startupSuccessThreshold
  createForm.volumeMounts = container.volumeMounts
  createForm.lifecycleHooks = container.lifecycleHooks
  createForm.containerRunAsUser = container.containerRunAsUser
  createForm.containerRunAsGroup = container.containerRunAsGroup
  createForm.containerRunAsNonRoot = container.containerRunAsNonRoot
  createForm.privileged = container.privileged
  createForm.allowPrivilegeEscalation = container.allowPrivilegeEscalation
  createForm.readOnlyRootFilesystem = container.readOnlyRootFilesystem
}

function syncActiveAppContainer() {
  seedAppContainersFromLegacyFields()
  if (!createForm.appContainers.some((container) => container.id === activeAppContainerId.value)) {
    activeAppContainerId.value = createForm.appContainers[0]?.id ?? ''
  }
  syncLegacyFieldsFromActiveAppContainer()
}

function addAppContainer() {
  markFormSource()
  const container = createAppContainerEntry(`app-${createForm.appContainers.length + 1}`)
  createForm.appContainers.push(container)
  activeAppContainerId.value = container.id
  activePodTemplatePanel.value = 'app'
  activeAppContainerPanel.value = 'basic'
  syncLegacyFieldsFromActiveAppContainer()
}

function removeAppContainer(id: string) {
  markFormSource()
  if (createForm.appContainers.length <= 1) return
  const index = createForm.appContainers.findIndex((item) => item.id === id)
  if (index >= 0) createForm.appContainers.splice(index, 1)
  if (activeAppContainerId.value === id) {
    activeAppContainerId.value = createForm.appContainers[0]?.id ?? ''
  }
  syncLegacyFieldsFromActiveAppContainer()
}

function appScalarValue(container: AppContainerEntry, key: keyof AppContainerEntry) {
  const value = container[key]
  return Array.isArray(value) ? '' : String(value ?? '')
}

function updateAppScalarField(container: AppContainerEntry, key: keyof AppContainerEntry, value: string | number | boolean | null) {
  markFormSource()
  const target = container as unknown as Record<keyof AppContainerEntry, unknown>
  const numberKeys = new Set<keyof AppContainerEntry>([
    'readinessPort',
    'readinessInitialDelaySeconds',
    'readinessPeriodSeconds',
    'readinessTimeoutSeconds',
    'readinessFailureThreshold',
    'readinessSuccessThreshold',
    'livenessPort',
    'livenessInitialDelaySeconds',
    'livenessPeriodSeconds',
    'livenessTimeoutSeconds',
    'livenessFailureThreshold',
    'livenessSuccessThreshold',
    'startupPort',
    'startupInitialDelaySeconds',
    'startupPeriodSeconds',
    'startupTimeoutSeconds',
    'startupFailureThreshold',
    'startupSuccessThreshold'
  ])
  target[key] = numberKeys.has(key) ? Number(value) || 0 : String(value ?? '')
  syncLegacyFieldsFromActiveAppContainer()
}

function updateAppTextField(container: AppContainerEntry, key: keyof AppContainerEntry, event: Event) {
  updateAppScalarField(container, key, inputValue(event))
}

function updateAppNumberField(container: AppContainerEntry, key: keyof AppContainerEntry, event: Event) {
  updateAppScalarField(container, key, Number(inputValue(event)) || 0)
}

function updateAppNullableNumberField(container: AppContainerEntry, key: 'containerRunAsUser' | 'containerRunAsGroup', event: Event) {
  markFormSource()
  const value = inputValue(event).trim()
  container[key] = value === '' ? null : Number(value)
  syncLegacyFieldsFromActiveAppContainer()
}

function updateInitNullableNumberField(container: InitContainerEntry, key: 'containerRunAsUser' | 'containerRunAsGroup', event: Event) {
  markFormSource()
  const value = inputValue(event).trim()
  container[key] = value === '' ? null : Number(value)
}

function updateNullableNumberField(key: keyof CreateFormState, event: Event) {
  markFormSource()
  const value = inputValue(event)
  const target = createForm as unknown as Record<keyof CreateFormState, unknown>
  target[key] = value === '' ? null : Number(value) || 0
}

function addAppPort(container: AppContainerEntry) {
  markFormSource()
  container.ports.push(createEmptyPortEntry('app-port'))
  syncLegacyFieldsFromActiveAppContainer()
}

function removeAppPort(container: AppContainerEntry, id: string) {
  markFormSource()
  const index = container.ports.findIndex((item) => item.id === id)
  if (index >= 0) container.ports.splice(index, 1)
  syncLegacyFieldsFromActiveAppContainer()
}

function addAppEnv(container: AppContainerEntry) {
  markFormSource()
  container.env.push({ id: nextEntryId('app-env'), name: '', value: '' })
  syncLegacyFieldsFromActiveAppContainer()
}

function removeAppEnv(container: AppContainerEntry, id: string) {
  markFormSource()
  const index = container.env.findIndex((item) => item.id === id)
  if (index >= 0) container.env.splice(index, 1)
  syncLegacyFieldsFromActiveAppContainer()
}

function addInitContainer() {
  markFormSource()
  const id = nextEntryId('init')
  createForm.initContainers.push({
    id,
    name: `init-${createForm.initContainers.length + 1}`,
    image: 'busybox:1.36',
    imagePullPolicy: 'IfNotPresent',
    command: '/bin/sh, -c',
    args: 'echo init',
    cpuRequest: '',
    memoryRequest: '',
    cpuLimit: '',
    memoryLimit: '',
    env: [],
    volumeMounts: [],
    containerRunAsUser: null,
    containerRunAsGroup: null,
    containerRunAsNonRoot: '',
    privileged: '',
    allowPrivilegeEscalation: '',
    readOnlyRootFilesystem: ''
  })
  activeInitContainerId.value = id
  activePodTemplatePanel.value = 'init'
  activeInitContainerPanel.value = 'basic'
}

function removeInitContainer(id: string) {
  markFormSource()
  const index = createForm.initContainers.findIndex((item) => item.id === id)
  if (index >= 0) createForm.initContainers.splice(index, 1)
  if (activeInitContainerId.value === id) {
    activeInitContainerId.value = createForm.initContainers[0]?.id ?? ''
  }
}

function initScalarValue(container: InitContainerEntry, key: keyof InitContainerEntry) {
  const value = container[key]
  return Array.isArray(value) ? '' : String(value ?? '')
}

function updateInitScalarField(container: InitContainerEntry, key: keyof InitContainerEntry, value: string | number | boolean | null) {
  markFormSource()
  const target = container as unknown as Record<keyof InitContainerEntry, unknown>
  target[key] = String(value ?? '')
}

function updateInitTextField(container: InitContainerEntry, key: keyof InitContainerEntry, event: Event) {
  updateInitScalarField(container, key, inputValue(event))
}

function addInitEnv(container: InitContainerEntry) {
  markFormSource()
  container.env.push({ id: nextEntryId('init-env'), name: '', value: '' })
}

function removeInitEnv(container: InitContainerEntry, id: string) {
  markFormSource()
  const index = container.env.findIndex((item) => item.id === id)
  if (index >= 0) container.env.splice(index, 1)
}

function resizeYamlTextarea() {
  const textarea = yamlTextareaRef.value
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = `${Math.max(420, textarea.scrollHeight + 8)}px`
}

function scheduleYamlResize() {
  void nextTick(resizeYamlTextarea)
}

function segmentButtonClass(active: boolean) {
  return active
    ? 'bg-primary-600 text-white shadow-sm shadow-primary-600/25'
    : 'text-gray-600 hover:bg-white hover:text-gray-900 dark:text-dark-300 dark:hover:bg-dark-800 dark:hover:text-white'
}

function validationStatusClass(status: YamlValidationStatus) {
  const classes: Record<YamlValidationStatus, string> = {
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300',
    warning: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300',
    error: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300',
    info: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-300'
  }
  return classes[status]
}

function setCreateDialogSize(size: CreateDialogSize) {
  createDialogSize.value = size
  scheduleYamlResize()
}

function sectionKey(title: string) {
  return title.replace(/\s+/g, '-')
}

function isSectionCollapsed(key: string) {
  return Boolean(collapsedSections[key])
}

function toggleSection(key: string) {
  collapsedSections[key] = !collapsedSections[key]
  scheduleYamlResize()
}

function setPodTemplatePanel(panel: PodTemplatePanel) {
  activePodTemplatePanel.value = panel
  if (panel === 'app') syncActiveAppContainer()
}

function setAppContainerPanel(panel: AppContainerPanel) {
  activeAppContainerPanel.value = panel
}

function setInitContainerPanel(panel: InitContainerPanel) {
  activeInitContainerPanel.value = panel
}

function setResourcePanel(panel: ResourcePanel) {
  activeResourcePanel.value = panel
}

function setProbePanel(panel: ProbePanel) {
  activeProbePanel.value = panel
}

function setMountPanel(panel: MountPanel) {
  activeMountPanel.value = panel
}

function setPodSecurityPanel(panel: PodSecurityPanel) {
  activePodSecurityPanel.value = panel
}

function setPodSchedulePanel(panel: PodSchedulePanel) {
  activePodSchedulePanel.value = panel
}

function setNodeSchedulePanel(panel: NodeSchedulePanel) {
  activeNodeSchedulePanel.value = panel
}

function setLifecyclePanel(panel: LifecyclePanel) {
  activeLifecyclePanel.value = panel
}

function setStrategyPanel(panel: StrategyPanel) {
  activeStrategyPanel.value = panel
}

function resetCollapsedSections() {
  for (const key of Object.keys(collapsedSections)) delete collapsedSections[key]
  if (usesPodSpecCreateForm.value) {
    const initiallyCollapsedSections = ['deployment', 'pod-template', 'pod-security', 'pod-network', 'pod-storage', 'deployment-strategy', 'pod-scheduling', 'node-scheduling', 'yaml-template']
    initiallyCollapsedSections.forEach((key) => {
      collapsedSections[key] = true
    })
    currentCreateSchema.value?.sections.forEach((section) => {
      collapsedSections[sectionKey(section.title)] = true
    })
  }
}

function closeEditDialog() {
  editDialogOpen.value = false
  closeRelatedDialog()
}

function defaultNamespaceFor(definition: ResourceDefinition) {
  return definition.namespaced ? (filters.namespace === 'all-namespaces' ? 'default' : filters.namespace) : ''
}

function mountListByType(type: MountPanel) {
  return (activeAppContainer.value?.volumeMounts ?? createForm.volumeMounts).filter((item) => item.type === type)
}

function initMountListByType(container: InitContainerEntry, type: MountPanel) {
  return container.volumeMounts.filter((item) => item.type === type)
}

function podVolumeListByType(type: MountPanel) {
  return createForm.podVolumes.filter((item) => item.type === type)
}

function podVolumeSourceSummary(volume: PodVolumeEntry) {
  if (volume.type === 'emptyDir') return 'emptyDir'
  return volume.sourceName || '未选择资源'
}

function podVolumeOptions(type: MountPanel, currentName = '') {
  const options = podVolumeListByType(type)
    .filter((volume) => volume.name.trim())
    .map((volume) => ({
      label: `${volume.name}${volume.type === 'emptyDir' ? '' : ` -> ${podVolumeSourceSummary(volume)}`}`,
      value: volume.name
    }))
  if (currentName && !options.some((option) => option.value === currentName)) {
    options.unshift({ label: `${currentName}（YAML 原始卷）`, value: currentName })
  }
  return options
}

function addPodVolume(type: MountPanel = activeMountPanel.value) {
  markFormSource()
  const sourceName = type === 'emptyDir' ? '' : sourceOptions(type)[0]?.value ?? ''
  createForm.podVolumes.push({
    id: nextEntryId('pod-volume'),
    type,
    name: sourceName || `${type === 'persistentVolumeClaim' ? 'pvc' : type}-volume`,
    sourceName
  })
}

function removePodVolume(id: string) {
  markFormSource()
  const index = createForm.podVolumes.findIndex((item) => item.id === id)
  if (index < 0) return
  const volumeName = createForm.podVolumes[index].name
  createForm.podVolumes.splice(index, 1)
  if (volumeName) {
    createForm.appContainers.forEach((container) => {
      container.volumeMounts = container.volumeMounts.filter((mount) => mount.name !== volumeName)
    })
    createForm.initContainers.forEach((container) => {
      container.volumeMounts = container.volumeMounts.filter((mount) => mount.name !== volumeName)
    })
  }
  syncLegacyFieldsFromActiveAppContainer()
}

function onPodVolumeSourceSelect(volume: PodVolumeEntry, value: string | number | boolean | null) {
  markFormSource()
  const sourceName = String(value ?? '')
  volume.sourceName = sourceName
  if (!volume.name.trim()) volume.name = sourceName
}

function onVolumeMountSelect(mount: VolumeMountEntry, value: string | number | boolean | null) {
  markFormSource()
  const volumeName = String(value ?? '')
  mount.name = volumeName
  const volume = createForm.podVolumes.find((item) => item.name === volumeName)
  if (volume) {
    mount.type = volume.type
    mount.sourceName = volume.sourceName
    if (!mount.mountPath.trim()) mount.mountPath = mountDefaultPath(volume.type)
    if (volume.type === 'configMap' || volume.type === 'secret') mount.readOnly = true
  }
  syncLegacyFieldsFromActiveAppContainer()
}

function updateVolumeMountReadOnly(mount: VolumeMountEntry, event: Event) {
  markFormSource()
  mount.readOnly = (event.target as HTMLInputElement | null)?.checked ?? false
  syncLegacyFieldsFromActiveAppContainer()
  syncYamlFromForm()
}

function addVolumeMount(type: MountPanel = activeMountPanel.value) {
  markFormSource()
  const targetMounts = activeAppContainer.value?.volumeMounts ?? createForm.volumeMounts
  const volume = podVolumeListByType(type)[0]
  targetMounts.push({
    id: nextEntryId('mount'),
    type,
    name: volume?.name ?? '',
    sourceName: volume?.sourceName ?? '',
    mountPath: mountDefaultPath(type),
    subPath: '',
    readOnly: type === 'configMap' || type === 'secret'
  })
  syncLegacyFieldsFromActiveAppContainer()
}

function addInitVolumeMount(container: InitContainerEntry, type: MountPanel = activeMountPanel.value) {
  markFormSource()
  const volume = podVolumeListByType(type)[0]
  container.volumeMounts.push({
    id: nextEntryId('init-mount'),
    type,
    name: volume?.name ?? '',
    sourceName: volume?.sourceName ?? '',
    mountPath: mountDefaultPath(type),
    subPath: '',
    readOnly: type === 'configMap' || type === 'secret'
  })
}

function removeVolumeMount(id: string) {
  markFormSource()
  const targetMounts = activeAppContainer.value?.volumeMounts ?? createForm.volumeMounts
  const index = targetMounts.findIndex((item) => item.id === id)
  if (index >= 0) targetMounts.splice(index, 1)
  syncLegacyFieldsFromActiveAppContainer()
}

function removeInitVolumeMount(container: InitContainerEntry, id: string) {
  markFormSource()
  const index = container.volumeMounts.findIndex((item) => item.id === id)
  if (index >= 0) container.volumeMounts.splice(index, 1)
}

function sourceOptions(type: MountPanel) {
  return type === 'emptyDir' ? [] : configSourceOptions[type]
}

function mountSourceLabel(type: MountPanel) {
  if (type === 'configMap') return 'ConfigMap 名称'
  if (type === 'secret') return 'Secret 名称'
  if (type === 'persistentVolumeClaim') return 'PVC 名称'
  return '资源名称'
}

function mountCreateLabel(type: MountPanel) {
  if (type === 'configMap') return 'ConfigMap'
  if (type === 'secret') return 'Secret'
  if (type === 'persistentVolumeClaim') return 'PVC'
  return '资源'
}

function mountDefaultPath(type: MountPanel) {
  if (type === 'configMap') return '/etc/config'
  if (type === 'secret') return '/etc/secret'
  if (type === 'persistentVolumeClaim') return '/data'
  return '/tmp/cache'
}

function ensureConfigSourceOption(type: Exclude<MountPanel, 'emptyDir'>, name: string) {
  const trimmedName = name.trim()
  if (!trimmedName) return
  const options = configSourceOptions[type]
  if (!options.some((option) => option.value === trimmedName)) {
    options.unshift({ label: trimmedName, value: trimmedName })
  }
}

function markSecretAsImagePullSecret(name: string) {
  const option = configSourceOptions.secret.find((item) => item.value === name)
  if (!option) return
  option.usage = 'imagePullSecret'
  option.secretType = option.secretType || 'kubernetes.io/dockerconfigjson'
}

function imagePullSecretNames() {
  return createForm.imagePullSecrets.split(',').map((item) => item.trim()).filter(Boolean)
}

function isImagePullSecretSelected(name: string) {
  return imagePullSecretNames().includes(name)
}

function setImagePullSecretNames(names: string[]) {
  markFormSource()
  createForm.imagePullSecrets = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).join(', ')
}

function toggleImagePullSecret(name: string) {
  const current = imagePullSecretNames()
  setImagePullSecretNames(current.includes(name) ? current.filter((item) => item !== name) : [...current, name])
}

function clearImagePullSecrets() {
  setImagePullSecretNames([])
  imagePullSecretDropdownOpen.value = false
}

function addImagePullSecretName(name: string) {
  setImagePullSecretNames([...imagePullSecretNames(), name])
}

function onMountSourceSelect(mount: VolumeMountEntry, value: string | number | boolean | null) {
  markFormSource()
  const sourceName = String(value ?? '')
  mount.sourceName = sourceName
  if (!mount.name.trim()) mount.name = sourceName
  syncLegacyFieldsFromActiveAppContainer()
}

function syncRelatedYamlFromForm() {
  const schema = relatedCreateSchema.value
  const definition = relatedDefinition.value
  if (!schema) return
  relatedFormState.name = relatedForm.name
  relatedFormState.namespace = definition.namespaced ? relatedForm.namespace : ''
  relatedFormState.yaml = stringifyKubeObject(schema.toObject(relatedForm))
  relatedYamlParseError.value = ''
}

function applyRelatedYamlToForm(object: Record<string, unknown>) {
  const definition = relatedDefinition.value
  const namespace = definition.namespaced ? (relatedFormState.namespace || relatedForm.namespace || 'default') : ''
  Object.assign(relatedForm, createDefaultForm(definition.type, definition.kind, namespace))
  applyObjectToForm(relatedForm, object, definition.type)
  relatedFormState.name = relatedForm.name
  relatedFormState.namespace = definition.namespaced ? relatedForm.namespace : ''
}

function syncRelatedFormFromYaml() {
  const parsed = parseKubeYaml(relatedFormState.yaml)
  if (!parsed.ok || !parsed.value) {
    relatedYamlParseError.value = parsed.error ?? 'YAML 解析失败。'
    return null
  }
  relatedYamlParseError.value = ''
  if (hasRelatedCreateSchema.value) {
    applyRelatedYamlToForm(parsed.value)
  }
  return parsed.value
}

function openRelatedConfigResource(type: Exclude<MountPanel, 'emptyDir'>, targetId?: string, targetKind: RelatedTargetKind = 'app-mount') {
  const targetType: RelatedCreateType = type === 'configMap' ? 'configmaps' : type === 'secret' ? 'secrets' : 'persistent-volume-claims'
  const definition = resourceDefinitions[targetType]
  relatedMountType.value = type
  relatedTargetKind.value = targetKind
  relatedMountTargetId.value = targetKind === 'app-mount' ? targetId ?? null : null
  relatedPodVolumeTargetId.value = targetKind === 'pod-volume' ? targetId ?? null : null
  relatedFormErrors.value = []
  relatedYamlParseError.value = ''
  const namespace = defaultNamespaceFor(definition)
  const nextForm = createDefaultForm(definition.type, definition.kind, namespace)
  const baseName = createForm.name.trim() || 'app'
  nextForm.name = type === 'configMap' ? `${baseName}-config` : type === 'secret' ? `${baseName}-secret` : `${baseName}-data`
  Object.assign(relatedForm, nextForm)
  relatedFormState.name = nextForm.name
  relatedFormState.namespace = namespace
  relatedCreateMode.value = createSchemas[definition.type] ? 'form' : 'yaml'
  if (createSchemas[definition.type]) {
    relatedFormState.yaml = stringifyKubeObject(createSchemas[definition.type].toObject(relatedForm))
    relatedYamlParseError.value = ''
  } else {
    relatedFormState.yaml = sampleYaml(definition.kind, nextForm.name, relatedFormState.namespace)
  }
  relatedDialogOpen.value = true
}

function closeRelatedDialog() {
  relatedDialogOpen.value = false
  relatedMountTargetId.value = null
  relatedPodVolumeTargetId.value = null
  relatedTargetKind.value = 'app-mount'
  relatedFormErrors.value = []
  relatedYamlParseError.value = ''
}

function setRelatedCreateMode(mode: CreateMode) {
  relatedCreateMode.value = mode
  relatedFormErrors.value = []
  if (mode === 'form') {
    syncRelatedYamlFromForm()
  } else {
    syncRelatedFormFromYaml()
  }
}

function relatedPairList(key: keyof CreateFormState) {
  const value = relatedForm[key]
  return Array.isArray(value) ? (value as KeyValuePair[]) : []
}

function addRelatedPair(key: keyof CreateFormState) {
  const value = relatedForm[key]
  if (Array.isArray(value)) {
    const list = value as KeyValuePair[]
    list.push({ id: nextEntryId('related-pair'), key: '', value: '' })
  }
}

function removeRelatedPair(key: keyof CreateFormState, id: string) {
  const value = relatedForm[key]
  if (!Array.isArray(value)) return
  const list = value as KeyValuePair[]
  if (list.length <= 1 && ['configData', 'secretData'].includes(String(key))) return
  const index = list.findIndex((item) => item.id === id)
  if (index >= 0) list.splice(index, 1)
}

function relatedScalarValue(key: keyof CreateFormState) {
  const value = relatedForm[key]
  return Array.isArray(value) ? '' : String(value ?? '')
}

function updateRelatedScalarField(key: keyof CreateFormState, value: string | number | boolean | null) {
  const target = relatedForm as unknown as Record<keyof CreateFormState, unknown>
  target[key] = key === 'replicas' ? Number(value) || 0 : String(value ?? '')
  if (relatedCreateMode.value !== 'form') relatedCreateMode.value = 'form'
}

function updateRelatedTextField(key: keyof CreateFormState, event: Event) {
  updateRelatedScalarField(key, inputValue(event))
}

function onRelatedYamlInput(event: Event) {
  relatedCreateMode.value = 'yaml'
  relatedFormState.yaml = inputValue(event)
  relatedFormErrors.value = []
  syncRelatedFormFromYaml()
}

function ensurePodVolumeForResource(type: Exclude<MountPanel, 'emptyDir'>, name: string, targetVolumeId?: string | null) {
  let volume = targetVolumeId
    ? createForm.podVolumes.find((item) => item.id === targetVolumeId)
    : createForm.podVolumes.find((item) => item.type === type && (item.sourceName === name || item.name === name))
  if (!volume) {
    volume = {
      id: nextEntryId('pod-volume'),
      type,
      name,
      sourceName: name
    }
    createForm.podVolumes.push(volume)
  }
  volume.type = type
  volume.name = volume.name.trim() || name
  volume.sourceName = name
  return volume
}

function fillCreatedRelatedResource(name: string) {
  const mountType = relatedMountType.value
  ensureConfigSourceOption(mountType, name)
  if (relatedTargetKind.value === 'image-pull-secret') {
    markSecretAsImagePullSecret(name)
    addImagePullSecretName(name)
    return
  }
  const podVolume = ensurePodVolumeForResource(mountType, name, relatedPodVolumeTargetId.value)
  if (relatedTargetKind.value === 'app-mount') {
    const targetMounts = activeAppContainer.value?.volumeMounts ?? createForm.volumeMounts
    let mount = relatedMountTargetId.value
      ? targetMounts.find((item) => item.id === relatedMountTargetId.value)
      : undefined
    if (!mount) {
      mount = {
        id: nextEntryId('mount'),
        type: mountType,
        name: podVolume.name,
        sourceName: name,
        mountPath: mountDefaultPath(mountType),
        subPath: '',
        readOnly: mountType === 'configMap' || mountType === 'secret'
      }
      targetMounts.push(mount)
      activeMountPanel.value = mountType
    }
    mount.type = mountType
    mount.name = podVolume.name
    mount.sourceName = name
    if (!mount.mountPath.trim()) mount.mountPath = mountDefaultPath(mountType)
    mount.readOnly = mountType === 'configMap' || mountType === 'secret' ? true : mount.readOnly
  }
  markFormSource()
  syncLegacyFieldsFromActiveAppContainer()
}

function podVolumeUsage(volume: PodVolumeEntry) {
  const volumeName = volume.name.trim()
  if (!volumeName) return []
  return [
    ...createForm.appContainers.flatMap((container) => container.volumeMounts
      .filter((mount) => mount.name === volumeName)
      .map((mount) => ({
        id: `${container.id}-${mount.id}`,
        label: `普通容器 / ${container.name || '未命名'}`,
        path: mount.mountPath || '未设置路径'
      }))),
    ...createForm.initContainers.flatMap((container) => container.volumeMounts
      .filter((mount) => mount.name === volumeName)
      .map((mount) => ({
        id: `${container.id}-${mount.id}`,
        label: `Init 容器 / ${container.name || '未命名'}`,
        path: mount.mountPath || '未设置路径'
      })))
  ]
}

async function submitRelatedForm() {
  relatedFormErrors.value = []
  const definition = relatedDefinition.value
  let yaml = relatedFormState.yaml
  let name = relatedFormState.name
  let namespace = relatedFormState.namespace

  if (hasRelatedCreateSchema.value && relatedCreateMode.value === 'form') {
    const errors = validateCreateForm(relatedForm, definition.type)
    if (errors.length) {
      relatedFormErrors.value = errors
      return
    }
    syncRelatedYamlFromForm()
    yaml = relatedFormState.yaml
    name = relatedForm.name
    namespace = definition.namespaced ? relatedForm.namespace : ''
  } else {
    const object = syncRelatedFormFromYaml()
    if (!object) {
      relatedFormErrors.value = [relatedYamlParseError.value || 'YAML 解析失败。']
      return
    }
    const errors = validateYamlObject(object, definition, relatedFormState.namespace || relatedForm.namespace)
    if (errors.length) {
      relatedFormErrors.value = errors
      return
    }
    name = relatedForm.name || name
    namespace = definition.namespaced ? (relatedForm.namespace || namespace) : ''
  }

  await callApi(
    ['createKubeResource', 'createResource'],
    [{ clusterId: filters.clusterId, resourceType: definition.type, namespace: namespace || undefined, name, yaml }],
    { ok: true }
  )
  const fillTargetText = relatedFillTargetText.value
  fillCreatedRelatedResource(name)
  syncYamlFromForm()
  closeRelatedDialog()
  successMessage.value = `已创建 ${definition.title}/${name}，并回填到${fillTargetText}`
}

function addNodeAffinity() {
  markFormSource()
  createForm.nodeAffinity.push({ id: nextEntryId('node-affinity'), key: '', operator: 'In', values: '' })
}

function removeNodeAffinity(id: string) {
  markFormSource()
  const index = createForm.nodeAffinity.findIndex((item) => item.id === id)
  if (index >= 0) createForm.nodeAffinity.splice(index, 1)
}

function affinityList(panel: 'podAffinity' | 'podAntiAffinity') {
  return createForm[panel]
}

function addPodAffinity(panel: 'podAffinity' | 'podAntiAffinity') {
  markFormSource()
  createForm[panel].push({
    id: nextEntryId(panel),
    topologyKey: 'kubernetes.io/hostname',
    labelKey: 'app',
    operator: 'In',
    values: ''
  })
}

function removePodAffinity(panel: 'podAffinity' | 'podAntiAffinity', id: string) {
  markFormSource()
  const list = createForm[panel]
  const index = list.findIndex((item) => item.id === id)
  if (index >= 0) list.splice(index, 1)
}

function addToleration() {
  markFormSource()
  createForm.tolerations.push({ id: nextEntryId('toleration'), key: '', operator: 'Equal', value: '', effect: '', tolerationSeconds: null })
}

function removeToleration(id: string) {
  markFormSource()
  const index = createForm.tolerations.findIndex((item) => item.id === id)
  if (index >= 0) createForm.tolerations.splice(index, 1)
}

function lifecycleList(type: LifecyclePanel, container: AppContainerEntry | null | undefined = activeAppContainer.value) {
  return (container?.lifecycleHooks ?? createForm.lifecycleHooks).filter((item) => item.type === type)
}

function addLifecycleHook(type: LifecyclePanel = activeLifecyclePanel.value, container: AppContainerEntry | null | undefined = activeAppContainer.value) {
  markFormSource()
  const hooks = container?.lifecycleHooks ?? createForm.lifecycleHooks
  if (hooks.some((item) => item.type === type)) return
  hooks.push({
    id: nextEntryId('lifecycle'),
    type,
    handlerType: 'exec',
    command: type === 'postStart' ? '/bin/sh, -c, echo started' : '/bin/sh, -c, sleep 5',
    path: '',
    port: 8080
  })
  syncLegacyFieldsFromActiveAppContainer()
}

function ensureLifecycleHook(type: LifecyclePanel) {
  addLifecycleHook(type)
}

function removeLifecycleHook(id: string, container: AppContainerEntry | null | undefined = activeAppContainer.value) {
  markFormSource()
  const hooks = container?.lifecycleHooks ?? createForm.lifecycleHooks
  const index = hooks.findIndex((item) => item.id === id)
  if (index >= 0) hooks.splice(index, 1)
  syncLegacyFieldsFromActiveAppContainer()
}

function applyYamlTemplate(templateId: YamlTemplateId | string | number | boolean | null) {
  const template = yamlTemplates.find((item) => item.id === templateId)
  if (!template) return
  activeYamlTemplate.value = template.id
  formErrors.value = []
  const previousName = createForm.name.trim()
  const patch = JSON.parse(JSON.stringify(template.patch)) as Partial<CreateFormState>
  Object.assign(createForm, patch)
  if (previousName) {
    createForm.name = previousName
  } else {
    createForm.name = template.id === 'db' ? 'db-sample' : `${template.id}-${createDefinition.value.type}`
  }
  createForm.appContainers = []
  seedAppContainersFromLegacyFields()
  activeAppContainerId.value = createForm.appContainers[0]?.id ?? ''
  syncLegacyFieldsFromActiveAppContainer()
  activeProbePanel.value = template.patch.startupPath ? 'startup' : 'readiness'
  syncYamlFromForm()
}

function yamlSyntaxStatus() {
  if (!formState.yaml.trim()) return { status: 'warning' as const, text: 'YAML 为空' }
  const parsed = parseKubeYamlDocuments(formState.yaml)
  if (!parsed.ok || !parsed.value) return { status: 'error' as const, text: 'YAML 语法错误' }
  return { status: 'ok' as const, text: parsed.values && parsed.values.length > 1 ? `YAML ${parsed.values.length} 个资源` : 'YAML 语法有效' }
}

function syncActiveInitContainer() {
  if (!createForm.initContainers.length) {
    activeInitContainerId.value = ''
    return
  }
  if (!createForm.initContainers.some((container) => container.id === activeInitContainerId.value)) {
    activeInitContainerId.value = createForm.initContainers[0].id
  }
}

function syncYamlFromForm() {
  const schema = currentCreateSchema.value
  const definition = createDefinition.value
  if (!schema) return
  syncLegacyFieldsFromActiveAppContainer()
  formState.name = createForm.name
  formState.namespace = definition.namespaced ? createForm.namespace : ''
  const object = schema.toObject(createForm)
  const documents = currentYamlDocuments()
  if (documents.length > 1) {
    const index = Math.min(Math.max(activeYamlDocumentIndex.value, 0), documents.length - 1)
    activeYamlDocumentIndex.value = index
    const nextDocuments = documents.map((item, itemIndex) => itemIndex === index ? object : item)
    formState.yaml = stringifyKubeObjects(nextDocuments)
  } else {
    formState.yaml = stringifyKubeObject(object)
  }
  yamlParseError.value = ''
  scheduleYamlResize()
}

function setCreateForm(nextForm: CreateFormState) {
  Object.assign(createForm, nextForm)
}

function applyYamlToCreateForm(object: Record<string, unknown>) {
  const definition = createDefinition.value
  const namespace = definition.namespaced ? (formState.namespace || createForm.namespace || 'default') : ''
  setCreateForm(createDefaultForm(definition.type, definition.kind, namespace))
  applyObjectToForm(createForm, object, definition.type)
  syncActiveAppContainer()
  syncActiveInitContainer()
  formState.name = createForm.name
  formState.namespace = definition.namespaced ? createForm.namespace : ''
}

function currentYamlDocuments() {
  const parsed = parseKubeYamlDocuments(formState.yaml)
  return parsed.ok && parsed.values?.length ? parsed.values : []
}

function activeYamlObjectFromDocuments(values: Record<string, unknown>[]) {
  const index = Math.min(Math.max(activeYamlDocumentIndex.value, 0), Math.max(values.length - 1, 0))
  activeYamlDocumentIndex.value = index
  return values[index]
}

function setActiveYamlDocument(index: number) {
  const values = currentYamlDocuments()
  if (!values.length) return
  activeYamlDocumentIndex.value = Math.min(Math.max(index, 0), values.length - 1)
  syncingFromYaml.value = true
  applyYamlToCreateForm(values[activeYamlDocumentIndex.value])
  void nextTick(() => {
    syncingFromYaml.value = false
  })
}

function syncFormFromYaml() {
  const parsed = parseKubeYamlDocuments(formState.yaml)
  if (!parsed.ok || !parsed.values?.length) {
    yamlParseError.value = parsed.error ?? 'YAML 解析失败。'
    return null
  }

  yamlParseError.value = ''
  const object = activeYamlObjectFromDocuments(parsed.values)
  if (currentCreateSchema.value) {
    syncingFromYaml.value = true
    applyYamlToCreateForm(object)
    void nextTick(() => {
      syncingFromYaml.value = false
    })
  }
  return object
}

function onYamlInput(event: Event) {
  createMode.value = 'yaml'
  formState.yaml = inputValue(event)
  formErrors.value = []
  syncFormFromYaml()
  scheduleYamlResize()
}

function onRawYamlInput(event: Event) {
  formState.yaml = inputValue(event)
  yamlParseError.value = ''
  formErrors.value = []
  scheduleYamlResize()
}

function setCreateMode(mode: CreateMode) {
  const previousMode = createMode.value
  createMode.value = mode
  formErrors.value = []
  if (mode === 'form') {
    if (previousMode === 'yaml') {
      syncFormFromYaml()
    } else {
      syncYamlFromForm()
    }
  } else {
    syncFormFromYaml()
    scheduleYamlResize()
  }
}

function expectedApiVersionFor(definition: ResourceDefinition) {
  if (['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(definition.kind)) return 'apps/v1'
  if (definition.kind === 'Ingress') return 'networking.k8s.io/v1'
  if (definition.kind === 'NetworkPolicy') return 'networking.k8s.io/v1'
  if (definition.kind === 'CronJob') return 'batch/v1'
  if (definition.kind === 'Job') return 'batch/v1'
  if (definition.kind === 'EndpointSlice') return 'discovery.k8s.io/v1'
  return 'v1'
}

function yamlMetadata(object: Record<string, unknown>) {
  return object.metadata && typeof object.metadata === 'object' && !Array.isArray(object.metadata)
    ? object.metadata as Record<string, unknown>
    : {}
}

function yamlObjectName(object: Record<string, unknown>) {
  return String(yamlMetadata(object).name ?? '').trim()
}

function yamlObjectNamespace(object: Record<string, unknown>, namespaceFallback = formState.namespace || createForm.namespace) {
  return String(yamlMetadata(object).namespace ?? namespaceFallback ?? '').trim()
}

function validateYamlObject(object: Record<string, unknown>, targetDefinition = createDefinition.value, namespaceFallback = formState.namespace || createForm.namespace) {
  const errors: string[] = []
  const definition = targetDefinition
  const metadata = yamlMetadata(object)
  const name = String(metadata.name ?? '').trim()
  const namespace = String(metadata.namespace ?? namespaceFallback ?? '').trim()
  const kind = String(object.kind ?? '').trim()
  const apiVersion = String(object.apiVersion ?? '').trim()
  const expectedApiVersion = expectedApiVersionFor(definition)

  if (!apiVersion) errors.push('YAML apiVersion 不能为空。')
  if (apiVersion && apiVersion !== expectedApiVersion) errors.push(`${definition.kind} 推荐 apiVersion 为 ${expectedApiVersion}，当前为 ${apiVersion}。`)
  if (!kind) errors.push('YAML kind 不能为空。')
  if (kind && kind !== definition.kind) errors.push(`当前弹窗创建 ${definition.kind}，YAML kind 为 ${kind}。`)
  if (!name) errors.push('YAML metadata.name 不能为空。')
  if (definition.namespaced && !namespace) errors.push('Namespace 不能为空。')

  return errors
}

function validateYamlContent(value: string, targetDefinition = createDefinition.value, namespaceFallback = formState.namespace || createForm.namespace): YamlValidationItem[] {
  if (!value.trim()) {
    return [{ status: 'warning', text: 'YAML 为空。' }]
  }
  const parsed = parseKubeYamlDocuments(value)
  if (!parsed.ok || !parsed.value || !parsed.values?.length) {
    return [{ status: 'error', text: parsed.error ?? 'YAML 解析失败。' }]
  }
  const values = parsed.values
  const errors = values.flatMap((object, index) =>
    validateYamlObject(object, targetDefinition, namespaceFallback).map((error) => values.length > 1 ? `第 ${index + 1} 个资源：${error}` : error)
  )
  return [
    { status: 'ok', text: values.length > 1 ? `YAML 语法有效，检测到 ${values.length} 个资源；可通过资源切换条编辑任一资源，提交会保留完整 YAML。` : 'YAML 语法有效。' },
    ...errors.map((error) => ({ status: 'warning' as const, text: error }))
  ]
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function highlightYamlLine(line: string) {
  const escaped = escapeHtml(line)
  if (/^\s*#/.test(line)) return `<span class="yaml-token-comment">${escaped}</span>`
  const commentIndex = escaped.indexOf('#')
  const codePart = commentIndex >= 0 ? escaped.slice(0, commentIndex) : escaped
  const commentPart = commentIndex >= 0 ? escaped.slice(commentIndex) : ''
  const highlighted = codePart
    .replace(/^(\s*-?\s*)([A-Za-z0-9_.-]+)(\s*:)/, '$1<span class="yaml-token-key">$2</span>$3')
    .replace(/(:\s*)(true|false|null)(\s*)$/i, '$1<span class="yaml-token-bool">$2</span>$3')
    .replace(/(:\s*)(-?\d+(?:\.\d+)?)(\s*)$/, '$1<span class="yaml-token-number">$2</span>$3')
    .replace(/(:\s*)(&quot;.*?&quot;|'.*?')(\s*)$/, '$1<span class="yaml-token-string">$2</span>$3')
  return `${highlighted}${commentPart ? `<span class="yaml-token-comment">${commentPart}</span>` : ''}`
}

function highlightYaml(value: string) {
  return value.split('\n').map(highlightYamlLine).join('\n')
}

function setSelectedResource(resource: KubeResourceItem) {
  selectedResource.value = resource
}

function openResourceDetail(resource: KubeResourceItem) {
  setSelectedResource(resource)
  activeDetailTab.value = 'overview'
  detailYamlDraft.value = resource.yaml
  detailYamlError.value = ''
  selectedContainerName.value = ''
  containerDetailOpen.value = false
  activeMonitoringTarget.value = 'all'
  activeMonitoringIndex.value = null
  detailPanelOpen.value = true
}

function closeResourceDetail() {
  detailPanelOpen.value = false
  containerDetailOpen.value = false
}

function relatedResourcePath(resource: RelatedResourceItem | KubeResourceItem) {
  const type = resource.resourceType || resourceTypeForKind(resource.kind)
  return resourceRoutes[type] ?? ''
}

async function navigateToResource(resource: RelatedResourceItem | KubeResourceItem) {
  const path = relatedResourcePath(resource)
  if (!path) return
  detailPanelOpen.value = false
  await router.push({
    path,
    query: {
      namespace: resource.namespace,
      name: resource.name,
      detail: resource.name
    }
  })
}

async function navigateToNodeDetail(resource: KubeResourceItem) {
  const name = nodeDisplayName(resource)
  if (!name || name === '-') return
  detailPanelOpen.value = false
  await router.push({
    path: '/other/nodes',
    query: {
      name,
      detail: name
    }
  })
}

async function navigateToWorkloadPods(resource: KubeResourceItem) {
  const app = resourceSelectorApp(resource)
  detailPanelOpen.value = false
  await router.push({
    path: '/pods',
    query: {
      namespace: resource.namespace,
      labels: app ? `app=${app}` : undefined
    }
  })
}

async function refreshResources() {
  loading.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const dataFallback = getDataExport<unknown>('kubeResources') ?? buildFallbackResources()
    const result = await callApi(['listKubeResources', 'listResources', 'getKubeResourceList'], [{ resourceType: currentDefinition.value.type, ...filters, page: page.value, pageSize: pageSize.value }], dataFallback)
    resources.value = normalizeResourceList(result)
    selectedResourceIds.forEach((id) => {
      if (!resources.value.some((item) => item.id === id)) selectedResourceIds.delete(id)
    })
    if (selectedResource.value) {
      const refreshedResource = filteredResources.value.find((item) => item.id === selectedResource.value?.id && item.clusterId === selectedResource.value?.clusterId)
      if (refreshedResource) {
        selectedResource.value = refreshedResource
      } else {
        selectedResource.value = null
        detailPanelOpen.value = false
      }
    }
    const detailName = queryStringValue(route.query.detail)
    if (detailName) {
      const detailResource = filteredResources.value.find((item) => item.name === detailName)
      if (detailResource) openResourceDetail(detailResource)
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '资源列表加载失败'
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editMode.value = 'create'
  formErrors.value = []
  yamlParseError.value = ''
  resetCollapsedSections()
  activeDeploymentPanel.value = 'basic'
  activeResourcePanel.value = 'cpu'
  activePodTemplatePanel.value = 'app'
  activeAppContainerId.value = ''
  activeAppContainerPanel.value = 'basic'
  activeInitContainerId.value = ''
  activeInitContainerPanel.value = 'basic'
  activeProbePanel.value = 'readiness'
  activeMountPanel.value = 'configMap'
  activePodSecurityPanel.value = 'identity'
  activePodSchedulePanel.value = 'affinity'
  activeNodeSchedulePanel.value = 'selector'
  activeLifecyclePanel.value = 'postStart'
  activeStrategyPanel.value = 'strategy'
  activeYamlTemplate.value = 'web'
  activeYamlDocumentIndex.value = 0
  const definition = createDefinition.value
  const namespace = defaultNamespaceFor(definition)
  const nextForm = createDefaultForm(definition.type, definition.kind, namespace)
  nextForm.name = `${definition.type}-sample`
  if (definition.type === 'deployments' || definition.type === 'pods') {
    nextForm.labels = [{ id: 'app', key: 'app', value: nextForm.name }]
  }
  setCreateForm(nextForm)
  syncActiveAppContainer()
  formState.name = nextForm.name
  formState.namespace = namespace
  createMode.value = hasCreateSchema.value ? 'form' : 'yaml'
  if (hasCreateSchema.value) {
    syncYamlFromForm()
  } else {
    formState.yaml = sampleYaml(definition.kind, nextForm.name, formState.namespace)
    scheduleYamlResize()
  }
  editDialogOpen.value = true
  scheduleYamlResize()
}

function openEdit(resource: KubeResourceItem) {
  editMode.value = 'edit'
  createMode.value = 'yaml'
  activeYamlDocumentIndex.value = 0
  formErrors.value = []
  yamlParseError.value = ''
  formState.name = resource.name
  formState.namespace = resource.namespace ?? ''
  formState.yaml = resource.yaml
  if (hasCreateSchema.value) {
    const parsed = parseKubeYaml(resource.yaml)
    if (parsed.ok && parsed.value) {
      setCreateForm(createDefaultForm(currentDefinition.value.type, currentDefinition.value.kind, formState.namespace || 'default'))
      applyObjectToForm(createForm, parsed.value, currentDefinition.value.type)
      syncActiveAppContainer()
      syncActiveInitContainer()
    }
  }
  editDialogOpen.value = true
  scheduleYamlResize()
}

async function submitForm() {
  formErrors.value = []
  const definition = createDefinition.value
  let yaml = formState.yaml
  let name = formState.name
  let namespace = formState.namespace
  let createdNames: string[] = []
  let createdNamespaces: string[] = []

  if (editMode.value === 'create' && hasCreateSchema.value) {
    if (createMode.value === 'form') {
      const errors = validateCreateForm(createForm, definition.type)
      if (errors.length) {
        formErrors.value = errors
        return
      }
      syncYamlFromForm()
      yaml = formState.yaml
      name = createForm.name
      namespace = definition.namespaced ? createForm.namespace : ''
      createdNames = name ? [name] : []
      createdNamespaces = namespace ? [namespace] : []
    } else {
      const parsed = parseKubeYamlDocuments(formState.yaml)
      if (!parsed.ok || !parsed.value || !parsed.values?.length) {
        yamlParseError.value = parsed.error ?? 'YAML 解析失败。'
        formErrors.value = [yamlParseError.value || 'YAML 解析失败。']
        return
      }
      const objects = parsed.values
      const errors = objects.flatMap((object, index) =>
        validateYamlObject(object).map((error) => objects.length > 1 ? `第 ${index + 1} 个资源：${error}` : error)
      )
      if (errors.length) {
        formErrors.value = errors
        return
      }
      syncingFromYaml.value = true
      const object = activeYamlObjectFromDocuments(objects)
      applyYamlToCreateForm(object)
      await nextTick()
      syncingFromYaml.value = false
      const names = objects.map(yamlObjectName).filter(Boolean)
      const namespaces = definition.namespaced
        ? Array.from(new Set(objects.map((object) => yamlObjectNamespace(object)).filter(Boolean)))
        : []
      createdNames = names
      createdNamespaces = namespaces
      name = names.length > 1 ? names.join(', ') : (names[0] || createForm.name || name)
      namespace = definition.namespaced && namespaces.length === 1 ? namespaces[0] : (definition.namespaced ? '' : '')
    }
  } else {
    const parsed = parseKubeYaml(formState.yaml)
    if (!parsed.ok || !parsed.value) {
      yamlParseError.value = parsed.error ?? 'YAML 解析失败。'
      formErrors.value = [yamlParseError.value]
      return
    }
    const errors = validateYamlObject(parsed.value)
    if (errors.length) {
      formErrors.value = errors
      return
    }
  }

  const payload = {
    clusterId: filters.clusterId,
    resourceType: definition.type,
    namespace: namespace || undefined,
    name,
    yaml,
    resourceCount: createMode.value === 'yaml' && editMode.value === 'create'
      ? parseKubeYamlDocuments(yaml).values?.length ?? 1
      : 1
  }
  await callApi(
    editMode.value === 'create' ? ['createKubeResource', 'createResource'] : ['updateKubeResource', 'updateResource'],
    [payload],
    { ok: true }
  )
  editDialogOpen.value = false
  const resourceCount = Number(payload.resourceCount ?? 1)
  successMessage.value = editMode.value === 'create'
    ? (resourceCount > 1 ? `批量创建请求已提交（${resourceCount} 个资源）` : '创建请求已提交')
    : '编辑请求已提交'
  if (editMode.value === 'create' && definition.namespaced) {
    if (resourceCount > 1 || (createdNamespaces.length && !createdNamespaces.includes(filters.namespace))) {
      filters.namespace = 'all-namespaces'
    } else if (namespace) {
      filters.namespace = namespace
    }
  }
  filters.status = 'all'
  filters.name = ''
  filters.labels = ''
  filters.keyword = ''
  await refreshResources()
  if (createdNames.length && selectedResource.value && !createdNames.includes(selectedResource.value.name)) {
    selectedResource.value = null
    detailPanelOpen.value = false
  }
}

function openDelete(resource: KubeResourceItem) {
  pendingConfirm.value = {
    action: 'delete',
    title: '确认删除资源',
    message: `确认删除 ${resource.kind}/${resource.name}？`,
    resource
  }
}

function openBulkDelete() {
  if (!selectedResources.value.length) return
  pendingConfirm.value = {
    action: 'bulk-delete',
    title: '确认批量删除资源',
    message: `确认批量删除已选中的 ${selectedResources.value.length} 个${currentDefinition.value.title}资源？`,
    resources: [...selectedResources.value]
  }
}

function openWorkloadAction(resource: KubeResourceItem, action: ConfirmAction) {
  actionForm.action = action
  actionForm.replicas = resource.desiredReplicas ?? resource.replicas ?? 1
  actionForm.image = resource.image ?? ''
  actionForm.rollbackRevision = 'previous'
  setSelectedResource(resource)
  actionDialogOpen.value = true
}

async function confirmWorkloadAction() {
  if (!selectedResource.value) return
  const payload = {
    replicas: actionForm.replicas,
    image: actionForm.image,
    revision: actionForm.rollbackRevision
  }
  await performConfirmedAction(actionForm.action, selectedResource.value, payload, workloadActionDialogTitle.value)
  actionDialogOpen.value = false
}

async function openLogs(resource: KubeResourceItem, follow = false) {
  setSelectedResource(resource)
  logsDialogOpen.value = true
  const fallback = [
    `[${new Date().toISOString()}] ${resource.name} container started`,
    `[${new Date().toISOString()}] readiness probe ${resource.status === 'Warning' ? 'failed' : 'succeeded'}`,
    follow ? '[stream] 实时日志连接已建立，等待后端 SSE / WebSocket 接入。' : '[tail] 最近 200 行日志已加载。'
  ].join('\n')
  logsText.value = '日志加载中...'
  const text = await callApi(
    ['getKubePodLogs', 'getPodLogs'],
    [{ clusterId: filters.clusterId, namespace: resource.namespace, podName: resource.name, follow, tailLines: 200 }],
    fallback
  )
  logsText.value = typeof text === 'string' && text.trim() ? text : fallback
}

function openTerminal(resource: KubeResourceItem) {
  setSelectedResource(resource)
  const containers = podTerminalContainerOptions(resource)
  terminalContainerName.value = containers[0]?.value ?? ''
  terminalCommandPreset.value = '/bin/sh'
  terminalCustomCommand.value = ''
  terminalSessionMessage.value = ''
  terminalDialogOpen.value = true
}

async function connectTerminal() {
  if (!selectedResource.value) return
  terminalSessionMessage.value = '正在提交终端连接请求...'
  await performHighRiskAction({
    confirm: true,
    action: 'terminal',
    clusterId: filters.clusterId,
    resourceType: selectedResource.value.type,
    kind: selectedResource.value.kind,
    namespace: selectedResource.value.namespace,
    name: selectedResource.value.name,
    container: terminalContainerName.value,
    command: terminalCommand.value
  })
  terminalSessionMessage.value = '终端连接请求已提交，WebSocket 将由后端 API-017 接入。'
}

function openNodeAction(resource: KubeResourceItem, action: 'drain' | 'cordon' | 'uncordon') {
  const labels = { drain: 'drain 节点', cordon: 'cordon 节点', uncordon: 'uncordon 节点' }
  pendingConfirm.value = {
    action,
    title: `确认${labels[action]}`,
    message: `${labels[action]} ${resource.name} 会影响调度或驱逐 Pod，请确认维护窗口和影响范围。`,
    resource
  }
}

function openSecretReveal(resource: KubeResourceItem) {
  pendingConfirm.value = {
    action: 'reveal-secret',
    title: '确认查看 Secret 明文',
    message: `Secret/${resource.name} 明文只会短暂展示在当前弹窗中，关闭后即清空。`,
    resource
  }
}

async function performHighRiskAction(payload: Record<string, unknown>) {
  const generic = getExport<ApiFn<[Record<string, unknown>], unknown>>('performHighRiskAction')
  if (typeof generic === 'function') return await generic(payload)

  const action = String(payload.action ?? '')
  if (action === 'delete') return await callApi(['deleteKubeResource', 'deleteResource'], [payload], { ok: true })
  if (action === 'reveal-secret') {
    return await callApi(['revealKubeSecret', 'revealSecret'], [payload], { data: { username: 'admin', password: '临时明文示例' } })
  }
  if (['drain', 'cordon', 'uncordon'].includes(action)) return await callApi(['performKubeNodeAction', 'performNodeAction'], [payload], { ok: true })
  if (action === 'terminal') return await callApi(['openKubePodTerminal', 'openPodTerminal'], [payload], { sessionId: 'mock-terminal-session' })
  return await callApi(['performKubeWorkloadAction', 'performWorkloadAction'], [payload], { ok: true })
}

async function performConfirmedAction(action: ConfirmAction, resource: KubeResourceItem | undefined, payload: Record<string, unknown> = {}, title = '确认操作') {
  const response = await performHighRiskAction({
    confirm: true,
    action,
    clusterId: filters.clusterId,
    resourceType: resource?.type ?? currentDefinition.value.type,
    kind: resource?.kind ?? currentDefinition.value.kind,
    namespace: resource?.namespace,
    name: resource?.name,
    ...payload
  })

  if (action === 'reveal-secret') {
    const data = response && typeof response === 'object' && 'data' in response ? (response as { data?: Record<string, string> }).data : undefined
    secretPlaintext.value = data ?? { username: 'admin', password: '临时明文示例' }
    secretDialogOpen.value = true
  } else if (action === 'terminal') {
    terminalDialogOpen.value = true
  } else {
    successMessage.value = `${title}请求已提交`
  }

  await refreshResources()
}

async function performBulkDelete(resourcesToDelete: KubeResourceItem[], title = '确认批量删除资源') {
  for (const resource of resourcesToDelete) {
    await performHighRiskAction({
      confirm: true,
      action: 'delete',
      clusterId: filters.clusterId,
      resourceType: resource.type,
      kind: resource.kind,
      namespace: resource.namespace,
      name: resource.name
    })
  }
  clearSelectedResources()
  await refreshResources()
  successMessage.value = `${title}请求已提交`
}

async function confirmHighRisk() {
  if (!pendingConfirm.value) return
  const action = pendingConfirm.value.action
  if (action === 'bulk-delete') {
    await performBulkDelete(pendingConfirm.value.resources ?? [], pendingConfirm.value.title)
  } else {
    await performConfirmedAction(action, pendingConfirm.value.resource, pendingConfirm.value.payload ?? {}, pendingConfirm.value.title)
  }

  pendingConfirm.value = null
  actionDialogOpen.value = false
}

function closeSecretDialog() {
  secretDialogOpen.value = false
  secretPlaintext.value = {}
}

function goPrevPage() {
  page.value = Math.max(1, page.value - 1)
}

function goNextPage() {
  page.value = Math.min(totalPages.value, page.value + 1)
}

watch(currentResourceType, () => {
  filters.status = 'all'
  filters.name = ''
  filters.labels = ''
  filters.keyword = ''
  filters.namespace = currentDefinition.value.namespaced ? 'all-namespaces' : 'cluster-scope'
  applyRouteFiltersFromQuery()
  page.value = 1
  selectedResource.value = null
  detailPanelOpen.value = false
  showColumnDropdown.value = false
  loadHiddenColumns()
  refreshResources()
})

watch(() => route.query, () => {
  applyRouteFiltersFromQuery()
  page.value = 1
  selectedResource.value = null
  detailPanelOpen.value = false
  refreshResources()
})

watch([() => filters.namespace, () => filters.nodeName, () => filters.name, () => filters.labels, () => filters.status, () => filters.keyword, pageSize], () => {
  page.value = 1
})

watch(() => currentDefinition.value.type, () => {
  if (!currentDefinition.value.pod) filters.nodeName = 'all-nodes'
})

watch(createForm, () => {
  if (editMode.value !== 'create' || !hasCreateSchema.value || createMode.value !== 'form' || syncingFromYaml.value) return
  syncActiveAppContainer()
  syncActiveInitContainer()
  syncYamlFromForm()
}, { deep: true })

watch(() => formState.yaml, scheduleYamlResize)

onMounted(() => {
  loadHiddenColumns()
  document.addEventListener('click', handleClickOutside)
  const clusterData = getDataExport<ClusterOption[]>('kubeClusters')
  if (Array.isArray(clusterData)) {
    clusters.value = clusterData
    if (!clusters.value.some((cluster) => cluster.id === filters.clusterId) && clusters.value[0]) {
      filters.clusterId = clusters.value[0].id
    }
  }
  if (!currentDefinition.value.namespaced) filters.namespace = 'cluster-scope'
  applyRouteFiltersFromQuery()
  refreshResources()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div class="space-y-6">
    <section class="card">
      <div class="card-header flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-base font-semibold text-gray-900 dark:text-white">{{ currentDefinition.title }}</h2>
            <span class="badge" :class="currentDefinition.namespaced ? 'badge-primary' : 'badge-gray'">
              {{ currentDefinition.namespaced ? '命名空间级' : '集群级' }}
            </span>
          </div>
          <p class="text-sm text-gray-500 dark:text-dark-400">{{ currentDefinition.description }}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button class="btn btn-secondary" type="button" :disabled="loading" @click="refreshResources">
            <Icon name="refresh" size="sm" :class="{ 'animate-spin': loading }" />
            刷新
          </button>
          <div ref="columnDropdownRef" class="relative">
            <button class="btn btn-secondary" type="button" title="列设置" @click.stop="showColumnDropdown = !showColumnDropdown">
              <Icon name="viewColumns" size="sm" />
              列设置
            </button>
            <div v-if="showColumnDropdown" class="absolute right-0 top-full z-50 mt-1 max-h-96 w-52 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-dark-600 dark:bg-dark-800">
              <button
                v-for="column in toggleableColumns"
                :key="column.key"
                type="button"
                class="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-dark-700"
                @click="toggleColumn(column.key)"
              >
                <span class="truncate">{{ column.label }}</span>
                <Icon v-if="isColumnVisible(column.key)" name="check" size="sm" class="shrink-0 text-primary-500" :stroke-width="2" />
              </button>
              <div class="mt-1 border-t border-gray-100 pt-1 dark:border-dark-700">
                <button class="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm text-gray-500 hover:bg-gray-100 dark:text-dark-300 dark:hover:bg-dark-700" type="button" @click="resetVisibleColumns">
                  <span>恢复默认列</span>
                  <Icon name="refresh" size="sm" />
                </button>
              </div>
            </div>
          </div>
          <button class="btn btn-primary" type="button" :disabled="currentDefinition.createDisabled" @click="openCreate">
            <Icon name="plus" size="sm" />
            创建
          </button>
        </div>
      </div>
      <div class="card-body space-y-4">
        <div :class="currentDefinition.pod ? 'grid gap-3 lg:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-7' : 'grid gap-3 lg:grid-cols-6'">
          <Select v-model="filters.clusterId" :options="clusterOptions" searchable @change="refreshResources" />
          <Select v-model="filters.namespace" :options="computedNamespaceOptions" :disabled="!currentDefinition.namespaced" searchable />
          <Select v-if="currentDefinition.pod" v-model="filters.nodeName" :options="computedNodeOptions" searchable />
          <input v-model="filters.name" class="input" placeholder="按名称筛选" />
          <input v-model="filters.labels" class="input" placeholder="标签 app=console" />
          <Select v-model="filters.status" :options="statusOptions.map((status) => ({ label: status === 'all' ? '全部状态' : status, value: status }))" />
          <input v-model="filters.keyword" class="input" type="search" placeholder="搜索" />
        </div>
        <div v-if="selectedResources.length && !currentDefinition.deleteDisabled" class="flex flex-col gap-3 rounded-xl border border-primary-200 bg-primary-50 px-4 py-3 dark:border-primary-900/40 dark:bg-primary-950/20 sm:flex-row sm:items-center sm:justify-between">
          <div class="text-sm text-primary-800 dark:text-primary-200">
            已选中 <span class="font-semibold">{{ selectedResources.length }}</span> 个{{ currentDefinition.title }}资源
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button class="btn btn-danger btn-sm" type="button" @click="openBulkDelete">
              <Icon name="trash" size="sm" />
              批量删除
            </button>
            <button class="btn btn-secondary btn-sm" type="button" @click="clearSelectedResources">清空选择</button>
          </div>
        </div>
        <div v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          {{ errorMessage }}
        </div>
        <div v-if="successMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300">
          {{ successMessage }}
        </div>
        <div v-if="currentDefinition.pod && !metricsAvailable" class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
          {{ metricsUnavailableMessage }}
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-body">
        <DataTable :columns="tableColumns" :data="pagedResources" :loading="loading" row-key="id" default-sort-key="name" :sort-storage-key="`kube-${currentDefinition.type}-sort`">
          <template #header-select>
            <input
              :checked="allVisibleSelected"
              :indeterminate.prop="someVisibleSelected && !allVisibleSelected"
              type="checkbox"
              class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              :disabled="!visibleSelectableResources.length"
              @change="toggleSelectAllVisible"
            >
          </template>
          <template #cell-select="{ row }">
            <input
              :checked="isRowSelected(row)"
              type="checkbox"
              class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
              :disabled="currentDefinition.deleteDisabled"
              @change="toggleResourceSelection(row)"
            >
          </template>
          <template #cell-name="{ row }">
            <button
              v-if="isPodResource(row) || isDeploymentResource(row)"
              class="text-left font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400"
              type="button"
              @click="openResourceDetail(row)"
            >
              {{ row.name }}
            </button>
            <span v-else class="text-left font-medium text-gray-900 dark:text-white">
              {{ row.name }}
            </span>
            <p class="mt-1 text-xs text-gray-400 dark:text-dark-500">{{ row.kind }}</p>
          </template>
          <template #cell-status="{ row }">
            <span class="badge" :class="statusClass(row.status)">{{ row.status }}</span>
          </template>
          <template #cell-ready="{ row }">
            <span class="font-mono text-xs">{{ row.ready || '-' }}</span>
          </template>
          <template #cell-restarts="{ row }">
            <span class="font-mono text-xs">{{ row.restarts ?? row.details.restartCount ?? 0 }}</span>
          </template>
          <template #cell-podIP="{ row }">
            <span class="font-mono text-xs">{{ row.podIP || row.details.podIP || '-' }}</span>
          </template>
          <template #cell-nodeName="{ row }">
            <div class="min-w-40 space-y-1">
              <button
                v-if="isPodResource(row) && nodeDisplayName(row) !== '-'"
                class="truncate text-xs font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400"
                type="button"
                @click="navigateToNodeDetail(row)"
              >
                {{ nodeDisplayName(row) }}
              </button>
              <p v-else class="truncate text-xs font-medium text-gray-700 dark:text-dark-200">{{ nodeDisplayName(row) }}</p>
              <div v-if="nodeInternalIP(row) || nodeExternalIP(row)" class="space-y-0.5 font-mono text-[11px] leading-4 text-gray-500 dark:text-dark-400">
                <p v-if="nodeInternalIP(row)" class="truncate">内网 {{ nodeInternalIP(row) }}</p>
                <p v-if="nodeExternalIP(row)" class="truncate">外网 {{ nodeExternalIP(row) }}</p>
              </div>
            </div>
          </template>
          <template #cell-cpu="{ row }">
            <div class="group relative inline-flex w-28 items-center gap-3">
              <div class="relative h-2 w-16 shrink-0 rounded-full bg-gray-100 dark:bg-dark-700">
                <div class="h-full rounded-full transition-all" :class="metricBarClass(metricPercent(row, 'cpu'))" :style="{ width: `${metricPercent(row, 'cpu')}%` }"></div>
                <span class="absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gray-500/70 dark:bg-dark-300" :style="{ left: `${metricRequestPercent(row, 'cpu')}%` }"></span>
              </div>
              <span class="min-w-0 truncate font-mono text-xs text-gray-600 dark:text-dark-300">{{ metricPercentText(row, 'cpu') }}</span>
              <div class="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-44 -translate-x-1/2 rounded-lg bg-primary-600 px-3 py-2 text-xs text-white shadow-lg shadow-primary-900/20 group-hover:block">
                <div v-for="item in metricTooltipRows(row, 'cpu')" :key="item.label" class="grid grid-cols-[64px_1fr] gap-2 font-mono leading-5">
                  <span>{{ item.label }}:</span>
                  <span class="text-right font-semibold">{{ item.value }}</span>
                </div>
                <span class="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-primary-600"></span>
              </div>
            </div>
          </template>
          <template #cell-memory="{ row }">
            <div class="group relative inline-flex w-32 items-center gap-3">
              <div class="relative h-2 w-16 shrink-0 rounded-full bg-gray-100 dark:bg-dark-700">
                <div class="h-full rounded-full transition-all" :class="metricBarClass(metricPercent(row, 'memory'))" :style="{ width: `${metricPercent(row, 'memory')}%` }"></div>
                <span class="absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gray-500/70 dark:bg-dark-300" :style="{ left: `${metricRequestPercent(row, 'memory')}%` }"></span>
              </div>
              <span class="min-w-0 truncate font-mono text-xs text-gray-600 dark:text-dark-300">{{ metricPercentText(row, 'memory') }}</span>
              <div class="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-44 -translate-x-1/2 rounded-lg bg-primary-600 px-3 py-2 text-xs text-white shadow-lg shadow-primary-900/20 group-hover:block">
                <div v-for="item in metricTooltipRows(row, 'memory')" :key="item.label" class="grid grid-cols-[64px_1fr] gap-2 font-mono leading-5">
                  <span>{{ item.label }}:</span>
                  <span class="text-right font-semibold">{{ item.value }}</span>
                </div>
                <span class="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-primary-600"></span>
              </div>
            </div>
          </template>
          <template #cell-labels="{ row }">
            <div class="flex max-w-md flex-nowrap items-center gap-1 overflow-hidden">
              <span v-for="label in visibleLabelPairs(row)" :key="label" class="badge badge-gray max-w-44 truncate">{{ label }}</span>
              <span v-if="hiddenLabelCount(row)" class="badge badge-gray shrink-0">+{{ hiddenLabelCount(row) }}</span>
            </div>
          </template>
          <template #cell-actions="{ row }">
            <div class="action-list">
              <button v-if="!isPodResource(row) && !isDeploymentResource(row)" class="action-item action-item-primary" type="button" @click="openResourceDetail(row)">
                <Icon name="eye" size="sm" />
                <span>详情</span>
              </button>
              <button v-if="!isPodResource(row) && !isDeploymentResource(row)" class="action-item action-item-primary" type="button" :disabled="currentDefinition.editDisabled" @click="openEdit(row)">
                <Icon name="edit" size="sm" />
                <span>编辑</span>
              </button>
              <button v-if="currentDefinition.workload && currentDefinition.supportsScale" class="action-item action-item-success" type="button" @click="openWorkloadAction(row, 'scale')">
                <Icon name="arrowsUpDown" size="sm" />
                <span>扩缩容</span>
              </button>
              <button v-if="currentDefinition.workload" class="action-item action-item-warning" type="button" @click="openWorkloadAction(row, 'restart')">
                <Icon name="refresh" size="sm" />
                <span>重启</span>
              </button>
              <button v-if="currentDefinition.workload && currentDefinition.supportsImageUpdate" class="action-item action-item-primary" type="button" @click="openWorkloadAction(row, 'update-image')">
                <Icon name="upload" size="sm" />
                <span>镜像</span>
              </button>
              <button v-if="currentDefinition.workload && currentDefinition.supportsRollback" class="action-item action-item-warning" type="button" @click="openWorkloadAction(row, 'rollback')">
                <Icon name="sync" size="sm" />
                <span>回滚</span>
              </button>
              <button v-if="currentDefinition.pod" class="action-item action-item-primary" type="button" @click="openLogs(row, true)">
                <Icon name="document" size="sm" />
                <span>日志</span>
              </button>
              <button v-if="currentDefinition.pod" class="action-item action-item-warning" type="button" @click="openTerminal(row)">
                <Icon name="terminal" size="sm" />
                <span>终端</span>
              </button>
              <button v-if="currentDefinition.node" class="action-item action-item-warning" type="button" @click="openNodeAction(row, 'drain')">
                <Icon name="download" size="sm" />
                <span>drain</span>
              </button>
              <button v-if="currentDefinition.node" class="action-item action-item-primary" type="button" @click="openNodeAction(row, 'cordon')">
                <Icon name="ban" size="sm" />
                <span>cordon</span>
              </button>
              <button v-if="currentDefinition.node" class="action-item action-item-success" type="button" @click="openNodeAction(row, 'uncordon')">
                <Icon name="checkCircle" size="sm" />
                <span>uncordon</span>
              </button>
              <button v-if="currentDefinition.secret" class="action-item action-item-warning" type="button" @click="openSecretReveal(row)">
                <Icon name="eye" size="sm" />
                <span>明文</span>
              </button>
              <button class="action-item action-item-danger" type="button" :disabled="currentDefinition.deleteDisabled" @click="openDelete(row)">
                <Icon name="trash" size="sm" />
                <span>删除</span>
              </button>
            </div>
          </template>
        </DataTable>

        <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p class="text-sm text-gray-500 dark:text-dark-400">共 {{ filteredResources.length }} 条，当前第 {{ page }} / {{ totalPages }} 页</p>
          <div class="flex items-center gap-2">
            <Select v-model="pageSize" :options="pageSizeOptions" />
            <button class="btn btn-secondary btn-sm" type="button" :disabled="page <= 1" @click="goPrevPage">上一页</button>
            <button class="btn btn-secondary btn-sm" type="button" :disabled="page >= totalPages" @click="goNextPage">下一页</button>
          </div>
        </div>
      </div>
    </section>

    <BaseDialog :show="detailPanelOpen && Boolean(selectedResource)" :title="resourceDetailTitle" width="extra-wide" @close="closeResourceDetail">
      <div v-if="selectedResource" class="flex flex-col gap-3 border-b border-gray-100 pb-4 dark:border-dark-700 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 class="text-base font-semibold text-gray-900 dark:text-white">{{ `${selectedResource.kind}/${selectedResource.name}` }}</h2>
          <p class="text-sm text-gray-500 dark:text-dark-400">
            {{ selectedResource.namespace ? `${selectedResource.namespace} · ${selectedResource.status}` : selectedResource.status }}
          </p>
        </div>
        <div class="tabs overflow-x-auto">
          <button
            v-for="tab in visibleDetailTabs"
            :key="tab.id"
            type="button"
            class="tab whitespace-nowrap"
            :class="{ 'tab-active': activeDetailTab === tab.id }"
            @click="activeDetailTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </div>
      </div>
      <div v-if="selectedResource" class="pt-4">
        <div v-if="activeDetailTab === 'overview' && isPodResource(selectedResource)" class="space-y-4">
          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <p class="text-xs text-gray-500 dark:text-dark-400">状态</p>
              <div class="mt-2 flex items-center gap-2">
                <span class="h-2.5 w-2.5 rounded-full" :class="selectedResource.status === 'Running' ? 'bg-emerald-500' : 'bg-amber-500'"></span>
                <span class="text-lg font-semibold text-gray-900 dark:text-white">{{ selectedResource.status }}</span>
              </div>
              <p class="mt-1 text-xs text-gray-500 dark:text-dark-400">{{ detailFieldValue(selectedResource.details.phase) }}</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <p class="text-xs text-gray-500 dark:text-dark-400">就绪</p>
              <p class="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{{ selectedResource.ready || '-' }}</p>
              <p class="mt-1 text-xs text-gray-500 dark:text-dark-400">容器</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <p class="text-xs text-gray-500 dark:text-dark-400">重启次数</p>
              <p class="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{{ selectedResource.restarts ?? selectedResource.details.restartCount ?? 0 }}</p>
              <p v-if="selectedResource.details.lastError" class="mt-1 truncate text-xs text-amber-600 dark:text-amber-300">{{ detailFieldValue(selectedResource.details.lastError) }}</p>
              <p v-else class="mt-1 text-xs text-gray-500 dark:text-dark-400">所有容器</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <p class="text-xs text-gray-500 dark:text-dark-400">节点</p>
              <button class="mt-2 text-left text-sm font-semibold text-primary-600 hover:text-primary-700 dark:text-primary-400" type="button" @click="navigateToNodeDetail(selectedResource)">
                {{ nodeDisplayName(selectedResource) }}
              </button>
              <p class="mt-1 font-mono text-xs text-gray-500 dark:text-dark-400">{{ nodeInternalIP(selectedResource) || '-' }}</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <p class="text-xs text-gray-500 dark:text-dark-400">Pod IP</p>
              <p class="mt-2 font-mono text-lg font-semibold text-gray-900 dark:text-white">{{ selectedResource.podIP || selectedResource.details.podIP || '-' }}</p>
              <p class="mt-1 text-xs text-gray-500 dark:text-dark-400">Pod IP</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <p class="text-xs text-gray-500 dark:text-dark-400">年龄</p>
              <p class="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{{ selectedResource.age }}</p>
              <p class="mt-1 font-mono text-xs text-gray-500 dark:text-dark-400">{{ selectedResource.details.createdAt || '-' }}</p>
            </div>
          </div>

          <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div class="space-y-4">
              <section class="rounded-xl border border-gray-100 dark:border-dark-700">
                <div class="border-b border-gray-100 px-4 py-3 dark:border-dark-700">
                  <h3 class="text-sm font-semibold text-gray-900 dark:text-white">容器（{{ podContainerRows(selectedResource).length }}）</h3>
                </div>
                <div class="overflow-x-auto">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>容器</th>
                        <th>状态</th>
                        <th>重启</th>
                        <th>CPU</th>
                        <th>内存</th>
                        <th>端口</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="container in podContainerRows(selectedResource)" :key="container.name">
                        <td>
                          <button class="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400" type="button" @click="openContainerDetail(container.name)">
                            {{ container.name }}
                          </button>
                          <div class="mt-1 max-w-md truncate text-xs text-gray-500 dark:text-dark-400">{{ container.image }}</div>
                        </td>
                        <td>
                          <span class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-dark-200">
                            <span class="h-2 w-2 rounded-full" :class="container.status === 'Running' ? 'bg-emerald-500' : 'bg-amber-500'"></span>
                            {{ container.status }}
                          </span>
                        </td>
                        <td class="font-mono text-xs">{{ container.restarts }}</td>
                        <td class="font-mono text-xs">{{ container.cpu }}</td>
                        <td class="font-mono text-xs">{{ container.memory }}</td>
                        <td class="font-mono text-xs">{{ container.port }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="mb-4 text-sm font-semibold text-gray-900 dark:text-white">信息</h3>
                <div class="grid gap-x-8 gap-y-3 md:grid-cols-2">
                  <div v-for="item in podInfoRows(selectedResource)" :key="item.label" class="grid grid-cols-[96px_minmax(0,1fr)] gap-3 text-sm">
                    <span class="text-gray-500 dark:text-dark-400">{{ item.label }}</span>
                    <span class="break-all font-medium text-gray-900 dark:text-white">{{ detailFieldValue(item.value) }}</span>
                  </div>
                </div>
              </section>

              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">卷与挂载（{{ podVolumeRows(selectedResource).length }}）</h3>
                <div class="mt-3 flex flex-wrap gap-2">
                  <span v-for="volume in podVolumeRows(selectedResource)" :key="volume" class="badge badge-gray">{{ volume }}</span>
                  <span v-if="!podVolumeRows(selectedResource).length" class="text-sm text-gray-500 dark:text-dark-400">未返回卷信息</span>
                </div>
              </section>
            </div>

            <aside class="space-y-3">
              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">事件（{{ selectedResource.events.length }}）</h3>
                <div v-if="selectedResource.events.length" class="mt-3 space-y-2">
                  <div v-for="event in selectedResource.events.slice(0, 3)" :key="event.id" class="rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-dark-900/60">
                    <div class="font-medium text-gray-900 dark:text-white">{{ event.reason }}</div>
                    <div class="mt-1 text-gray-500 dark:text-dark-400">{{ event.message }}</div>
                  </div>
                </div>
                <p v-else class="mt-3 text-sm text-gray-500 dark:text-dark-400">暂无最近事件</p>
              </section>

              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">关联资源（{{ podRelatedRows(selectedResource).length }}）</h3>
                <div class="mt-3 divide-y divide-gray-100 dark:divide-dark-700">
                  <button
                    v-for="item in podRelatedRows(selectedResource)"
                    :key="`${item.kind}-${item.name}`"
                    class="flex w-full items-center justify-between gap-3 py-2 text-left text-sm"
                    type="button"
                    @click="navigateToResource(item)"
                  >
                    <span class="text-gray-500 dark:text-dark-400">{{ item.kind }}</span>
                    <span class="truncate font-medium text-primary-600 dark:text-primary-400">{{ item.name }}</span>
                  </button>
                  <p v-if="!podRelatedRows(selectedResource).length" class="py-2 text-sm text-gray-500 dark:text-dark-400">暂无关联资源</p>
                </div>
              </section>

              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">端口（{{ podPortRows(selectedResource).length }}）</h3>
                <div class="mt-3 flex flex-wrap gap-2">
                  <span v-for="port in podPortRows(selectedResource)" :key="`${port.number}-${port.protocol}`" class="badge badge-gray font-mono">{{ port.number }} {{ port.protocol }}</span>
                  <span v-if="!podPortRows(selectedResource).length" class="text-sm text-gray-500 dark:text-dark-400">未暴露端口</span>
                </div>
              </section>

              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">标签（{{ labelPairs(selectedResource.labels).length }}）</h3>
                <div class="mt-3 flex flex-wrap gap-2">
                  <span v-for="label in labelPairs(selectedResource.labels)" :key="label" class="badge badge-gray">{{ label }}</span>
                </div>
              </section>

              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">注解（{{ Object.keys(selectedResource.annotations).length }}）</h3>
                <div class="mt-3 space-y-2">
                  <p v-for="[key, value] in Object.entries(selectedResource.annotations).slice(0, 3)" :key="key" class="break-all rounded-lg bg-gray-50 px-3 py-2 font-mono text-xs text-gray-600 dark:bg-dark-900/60 dark:text-dark-300">
                    {{ key }}={{ value }}
                  </p>
                  <p v-if="!Object.keys(selectedResource.annotations).length" class="text-sm text-gray-500 dark:text-dark-400">暂无注解</p>
                </div>
              </section>
            </aside>
          </div>
        </div>

        <div v-else-if="activeDetailTab === 'overview' && isDeploymentResource(selectedResource)" class="space-y-4">
          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <p class="text-xs text-gray-500 dark:text-dark-400">状态</p>
              <div class="mt-2 flex items-center gap-2">
                <span class="h-2.5 w-2.5 rounded-full" :class="selectedResource.status === 'Available' ? 'bg-emerald-500' : 'bg-amber-500'"></span>
                <span class="text-lg font-semibold text-gray-900 dark:text-white">{{ selectedResource.status }}</span>
              </div>
              <p class="mt-1 text-xs text-gray-500 dark:text-dark-400">Deployment</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <p class="text-xs text-gray-500 dark:text-dark-400">期望副本</p>
              <p class="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{{ deploymentReplicas(selectedResource).desired }}</p>
              <p class="mt-1 text-xs text-gray-500 dark:text-dark-400">spec.replicas</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <p class="text-xs text-gray-500 dark:text-dark-400">已更新</p>
              <p class="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{{ deploymentReplicas(selectedResource).updated }}</p>
              <p class="mt-1 text-xs text-gray-500 dark:text-dark-400">updatedReplicas</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <p class="text-xs text-gray-500 dark:text-dark-400">可用</p>
              <button class="mt-2 inline-flex items-center gap-2 text-lg font-semibold text-primary-600 hover:text-primary-700 dark:text-primary-400" type="button" @click="navigateToWorkloadPods(selectedResource)">
                {{ deploymentReplicas(selectedResource).available }}
                <Icon name="arrowRight" size="sm" />
              </button>
              <p class="mt-1 text-xs text-gray-500 dark:text-dark-400">availableReplicas</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <p class="text-xs text-gray-500 dark:text-dark-400">不可用</p>
              <p class="mt-2 text-lg font-semibold" :class="deploymentReplicas(selectedResource).unavailable > 0 ? 'text-amber-600 dark:text-amber-300' : 'text-gray-900 dark:text-white'">{{ deploymentReplicas(selectedResource).unavailable }}</p>
              <p class="mt-1 text-xs text-gray-500 dark:text-dark-400">unavailableReplicas</p>
            </div>
            <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <p class="text-xs text-gray-500 dark:text-dark-400">年龄</p>
              <p class="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{{ selectedResource.age }}</p>
              <p class="mt-1 text-xs text-gray-500 dark:text-dark-400">created</p>
            </div>
          </div>

          <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div class="space-y-4">
              <section class="rounded-xl border border-gray-100 dark:border-dark-700">
                <div class="border-b border-gray-100 px-4 py-3 dark:border-dark-700">
                  <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Pod 模板容器（{{ deploymentContainerRows(selectedResource).length }}）</h3>
                </div>
                <div class="overflow-x-auto">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>容器</th>
                        <th>镜像</th>
                        <th>拉取策略</th>
                        <th>端口</th>
                        <th>CPU req/limit</th>
                        <th>内存 req/limit</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="container in deploymentContainerRows(selectedResource)" :key="container.name">
                        <td>
                          <button class="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400" type="button" @click="openContainerDetail(container.name)">
                            {{ container.name }}
                          </button>
                        </td>
                        <td class="max-w-sm break-all font-mono text-xs">{{ container.image }}</td>
                        <td><span class="badge badge-gray">{{ container.policy }}</span></td>
                        <td class="font-mono text-xs">{{ container.ports }}</td>
                        <td class="font-mono text-xs">{{ container.cpu }}</td>
                        <td class="font-mono text-xs">{{ container.memory }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="mb-4 text-sm font-semibold text-gray-900 dark:text-white">发布策略与选择器</h3>
                <div class="grid gap-x-8 gap-y-3 md:grid-cols-2">
                  <div v-for="item in deploymentInfoRows(selectedResource)" :key="item.label" class="grid gap-1 text-sm sm:grid-cols-[190px_minmax(0,1fr)] sm:gap-4">
                    <span class="text-gray-500 dark:text-dark-400">{{ item.label }}</span>
                    <span class="break-all font-medium text-gray-900 dark:text-white">{{ detailFieldValue(item.value) }}</span>
                  </div>
                </div>
              </section>

              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Pod 模板卷（{{ workloadTemplateVolumeRows(selectedResource).length }}）</h3>
                <div class="mt-3 flex flex-wrap gap-2">
                  <span v-for="volume in workloadTemplateVolumeRows(selectedResource)" :key="volume" class="badge badge-gray">{{ volume }}</span>
                  <span v-if="!workloadTemplateVolumeRows(selectedResource).length" class="text-sm text-gray-500 dark:text-dark-400">未配置模板卷</span>
                </div>
              </section>
            </div>

            <aside class="space-y-3">
              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Conditions（{{ deploymentConditionRows(selectedResource).length }}）</h3>
                <div v-if="deploymentConditionRows(selectedResource).length" class="mt-3 space-y-2">
                  <div v-for="condition in deploymentConditionRows(selectedResource)" :key="condition.type" class="rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-dark-900/60">
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-medium text-gray-900 dark:text-white">{{ condition.type }}</span>
                      <span class="badge" :class="condition.status === 'True' ? 'badge-success' : 'badge-warning'">{{ condition.status }}</span>
                    </div>
                    <div class="mt-1 text-gray-500 dark:text-dark-400">{{ condition.reason }}</div>
                    <div v-if="condition.message" class="mt-1 text-gray-500 dark:text-dark-400">{{ condition.message }}</div>
                  </div>
                </div>
                <p v-else class="mt-3 text-sm text-gray-500 dark:text-dark-400">未返回 Conditions</p>
              </section>

              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">关联资源（{{ deploymentRelatedRows(selectedResource).length }}）</h3>
                <div class="mt-3 divide-y divide-gray-100 dark:divide-dark-700">
                  <button
                    v-for="item in deploymentRelatedRows(selectedResource)"
                    :key="`${item.kind}-${item.name}`"
                    class="flex w-full items-center justify-between gap-3 py-2 text-left text-sm"
                    type="button"
                    @click="navigateToResource(item)"
                  >
                    <span class="text-gray-500 dark:text-dark-400">{{ item.kind }}</span>
                    <span class="truncate font-medium text-primary-600 dark:text-primary-400">{{ item.name }}</span>
                  </button>
                  <p v-if="!deploymentRelatedRows(selectedResource).length" class="py-2 text-sm text-gray-500 dark:text-dark-400">暂无关联资源</p>
                </div>
              </section>

              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">标签（{{ labelPairs(selectedResource.labels).length }}）</h3>
                <div class="mt-3 flex flex-wrap gap-2">
                  <span v-for="label in labelPairs(selectedResource.labels)" :key="label" class="badge badge-gray">{{ label }}</span>
                  <span v-if="!labelPairs(selectedResource.labels).length" class="text-sm text-gray-500 dark:text-dark-400">暂无标签</span>
                </div>
              </section>

              <section class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <h3 class="text-sm font-semibold text-gray-900 dark:text-white">注解（{{ Object.keys(selectedResource.annotations).length }}）</h3>
                <div class="mt-3 space-y-2">
                  <p v-for="[key, value] in Object.entries(selectedResource.annotations).slice(0, 3)" :key="key" class="break-all rounded-lg bg-gray-50 px-3 py-2 font-mono text-xs text-gray-600 dark:bg-dark-900/60 dark:text-dark-300">
                    {{ key }}={{ value }}
                  </p>
                  <p v-if="!Object.keys(selectedResource.annotations).length" class="text-sm text-gray-500 dark:text-dark-400">暂无注解</p>
                </div>
              </section>
            </aside>
          </div>
        </div>

        <div v-else-if="activeDetailTab === 'overview'" class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div v-for="[key, value] in Object.entries(selectedResource.details)" :key="key" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
            <p class="text-xs text-gray-500 dark:text-dark-400">{{ detailFieldLabel(key) }}</p>
            <p class="mt-2 break-all text-sm font-medium text-gray-900 dark:text-white">{{ detailFieldValue(value) }}</p>
          </div>
        </div>

        <div v-else-if="activeDetailTab === 'status'" class="grid gap-4 md:grid-cols-3">
          <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
            <p class="text-xs text-gray-500 dark:text-dark-400">当前状态</p>
            <span class="badge mt-2" :class="statusClass(selectedResource.status)">{{ selectedResource.status }}</span>
          </div>
          <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
            <p class="text-xs text-gray-500 dark:text-dark-400">就绪</p>
            <button
              v-if="selectedResource.ready && currentDefinition.workload"
              class="mt-2 inline-flex items-center gap-2 text-lg font-semibold text-primary-600 hover:text-primary-700 dark:text-primary-400"
              type="button"
              @click="navigateToWorkloadPods(selectedResource)"
            >
              {{ selectedResource.ready }}
              <Icon name="arrowRight" size="sm" />
            </button>
            <p v-else class="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{{ selectedResource.ready || '-' }}</p>
            <p v-if="selectedResource.ready && currentDefinition.workload" class="mt-1 text-xs text-gray-500 dark:text-dark-400">查看由当前工作负载筛选出的 Pod</p>
          </div>
          <div v-if="currentDefinition.pod" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
            <p class="text-xs text-gray-500 dark:text-dark-400">重启次数</p>
            <p class="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{{ selectedResource.restarts ?? selectedResource.details.restartCount ?? 0 }}</p>
          </div>
          <div v-if="currentDefinition.pod" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
            <p class="text-xs text-gray-500 dark:text-dark-400">Pod IP</p>
            <p class="mt-2 font-mono text-sm font-semibold text-gray-900 dark:text-white">{{ selectedResource.podIP || selectedResource.details.podIP || '-' }}</p>
          </div>
          <div v-if="currentDefinition.pod" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
            <p class="text-xs text-gray-500 dark:text-dark-400">节点</p>
            <p class="mt-2 text-sm font-semibold text-gray-900 dark:text-white">{{ selectedResource.nodeName || selectedResource.details.nodeName || '-' }}</p>
          </div>
          <div v-if="currentDefinition.pod" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
            <p class="text-xs text-gray-500 dark:text-dark-400">最近错误</p>
            <p class="mt-2 text-sm font-semibold text-gray-900 dark:text-white">{{ detailFieldValue(selectedResource.details.lastError) }}</p>
          </div>
          <div v-if="currentDefinition.pod" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
            <p class="text-xs text-gray-500 dark:text-dark-400">CPU</p>
            <p class="mt-2 font-mono text-sm font-semibold text-gray-900 dark:text-white">{{ podMetricValue(selectedResource, 'cpuUsage', 'cpuRequest', 'cpuLimit') }}</p>
          </div>
          <div v-if="currentDefinition.pod" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
            <p class="text-xs text-gray-500 dark:text-dark-400">内存</p>
            <p class="mt-2 font-mono text-sm font-semibold text-gray-900 dark:text-white">{{ podMetricValue(selectedResource, 'memoryUsage', 'memoryRequest', 'memoryLimit') }}</p>
          </div>
          <div v-if="!currentDefinition.pod" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
            <p class="text-xs text-gray-500 dark:text-dark-400">副本</p>
            <p class="mt-2 text-lg font-semibold text-gray-900 dark:text-white">{{ selectedResource.replicas ?? '-' }} / {{ selectedResource.desiredReplicas ?? '-' }}</p>
          </div>
        </div>

        <div v-else-if="activeDetailTab === 'metadata'" class="grid gap-6 lg:grid-cols-2">
          <div>
            <h3 class="mb-3 text-sm font-semibold text-gray-900 dark:text-white">标签</h3>
            <div class="flex flex-wrap gap-2">
              <span v-for="label in labelPairs(selectedResource.labels)" :key="label" class="badge badge-gray">{{ label }}</span>
            </div>
          </div>
          <div>
            <h3 class="mb-3 text-sm font-semibold text-gray-900 dark:text-white">注解</h3>
            <div class="space-y-2">
              <p v-for="[key, value] in Object.entries(selectedResource.annotations)" :key="key" class="rounded-lg bg-gray-50 px-3 py-2 font-mono text-xs text-gray-600 dark:bg-dark-900/60 dark:text-dark-300">
                {{ key }}={{ value }}
              </p>
            </div>
          </div>
        </div>

        <div v-else-if="activeDetailTab === 'relations'" class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>类型</th>
                <th>名称</th>
                <th>Namespace</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in selectedResource.related" :key="`${item.kind}-${item.name}`">
                <td>
                  <div class="font-medium text-gray-900 dark:text-white">{{ item.kind }}</div>
                  <div v-if="item.relation" class="text-xs text-gray-400 dark:text-dark-500">{{ item.relation }}</div>
                </td>
                <td>
                  <button
                    v-if="relatedResourcePath(item)"
                    class="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400"
                    type="button"
                    @click="navigateToResource(item)"
                  >
                    {{ item.name }}
                  </button>
                  <span v-else>{{ item.name }}</span>
                </td>
                <td>{{ item.namespace || '-' }}</td>
                <td>
                  <span class="badge" :class="statusClass(item.status || 'Ready')">{{ item.status || 'Ready' }}</span>
                  <span v-if="item.ready" class="ml-2 font-mono text-xs text-gray-500 dark:text-dark-400">{{ item.ready }}</span>
                </td>
              </tr>
              <tr v-if="!selectedResource.related.length">
                <td colspan="4" class="text-center text-sm text-gray-500 dark:text-dark-400">暂无关联资源</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else-if="activeDetailTab === 'mounts' && isPodResource(selectedResource)" class="space-y-4">
          <section class="rounded-xl border border-gray-100 dark:border-dark-700">
            <div class="flex flex-col gap-2 border-b border-gray-100 px-4 py-3 dark:border-dark-700 sm:flex-row sm:items-center sm:justify-between">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">Pod Volumes（{{ podVolumeDetailRows(selectedResource).length }}）</h3>
              <span class="text-xs text-gray-500 dark:text-dark-400">Pod 级声明，容器通过 volumeMounts 使用</span>
            </div>
            <div v-if="podVolumeDetailRows(selectedResource).length" class="overflow-x-auto">
              <table class="table">
                <thead>
                  <tr>
                    <th>Volume</th>
                    <th>类型</th>
                    <th>来源</th>
                    <th>资源</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="volume in podVolumeDetailRows(selectedResource)" :key="volume.name">
                    <td class="font-mono text-xs font-semibold">{{ volume.name }}</td>
                    <td><span class="badge badge-gray">{{ volume.kind }}</span></td>
                    <td class="break-all text-sm text-gray-700 dark:text-dark-200">{{ volume.summary }}</td>
                    <td>
                      <button
                        v-if="volume.sourceResource"
                        class="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400"
                        type="button"
                        @click="navigateToResource(volume.sourceResource)"
                      >
                        {{ `${volume.sourceResource.kind}/${volume.sourceResource.name}` }}
                      </button>
                      <span v-else class="text-sm text-gray-500 dark:text-dark-400">Pod 内部卷</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="p-4 text-sm text-gray-500 dark:text-dark-400">未返回 Pod volumes</p>
          </section>

          <section class="rounded-xl border border-gray-100 dark:border-dark-700">
            <div class="border-b border-gray-100 px-4 py-3 dark:border-dark-700">
              <h3 class="text-sm font-semibold text-gray-900 dark:text-white">容器挂载（{{ podContainerMountMatrix(selectedResource).length }}）</h3>
            </div>
            <div v-if="podContainerMountMatrix(selectedResource).length" class="divide-y divide-gray-100 dark:divide-dark-700">
              <div v-for="container in podContainerMountMatrix(selectedResource)" :key="container.name" class="p-4">
                <div class="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <button class="font-semibold text-primary-600 hover:text-primary-700 dark:text-primary-400" type="button" @click="openContainerDetail(container.name)">
                    {{ container.name }}
                  </button>
                  <span class="text-xs text-gray-500 dark:text-dark-400">{{ container.mounts.length }} 个挂载</span>
                </div>
                <div v-if="container.mounts.length" class="overflow-x-auto rounded-xl border border-gray-100 dark:border-dark-700">
                  <table class="table">
                    <thead>
                      <tr>
                        <th>Volume</th>
                        <th>挂载路径</th>
                        <th>来源</th>
                        <th>权限</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="mount in container.mounts" :key="`${container.name}-${mount.name}-${mount.mountPath}`">
                        <td>
                          <div class="font-mono text-xs font-semibold text-gray-900 dark:text-white">{{ mount.name }}</div>
                          <div class="mt-1 text-xs text-gray-500 dark:text-dark-400">{{ mount.sourceKind }}</div>
                        </td>
                        <td>
                          <p class="break-all font-mono text-xs text-gray-900 dark:text-white">{{ mount.mountPath }}</p>
                          <p v-if="mount.subPath" class="mt-1 break-all font-mono text-xs text-gray-500 dark:text-dark-400">subPath: {{ mount.subPath }}</p>
                        </td>
                        <td>
                          <button
                            v-if="mount.sourceResource"
                            class="font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400"
                            type="button"
                            @click="navigateToResource(mount.sourceResource)"
                          >
                            {{ `${mount.sourceResource.kind}/${mount.sourceResource.name}` }}
                          </button>
                          <span v-else class="break-all text-sm text-gray-700 dark:text-dark-200">{{ mount.source }}</span>
                        </td>
                        <td><span class="badge badge-gray">{{ mount.readOnly ? 'RO' : 'RW' }}</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p v-else class="text-sm text-gray-500 dark:text-dark-400">当前容器未配置 volumeMounts</p>
              </div>
            </div>
            <p v-else class="p-4 text-sm text-gray-500 dark:text-dark-400">未返回容器挂载信息</p>
          </section>
        </div>

        <div v-else-if="activeDetailTab === 'monitoring' && (isPodResource(selectedResource) || isDeploymentResource(selectedResource))" class="space-y-4">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
            <select v-model="activeMonitoringRange" class="input sm:w-48">
              <option v-for="option in monitoringRangeOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <select v-model="activeMonitoringStep" class="input sm:w-48">
              <option v-for="option in monitoringStepOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <select v-model="activeMonitoringTarget" class="input sm:w-56">
              <option v-for="option in monitoringTargetOptions(selectedResource)" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
            <span class="text-xs text-gray-500 dark:text-dark-400 sm:ml-auto">
              {{ monitoringSampleSummary() }}
            </span>
          </div>

          <div
            v-if="!monitoringHasUsage(selectedResource)"
            class="rounded-3xl border border-amber-200 bg-amber-50 p-6 text-sm leading-6 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300"
          >
            <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div class="max-w-3xl">
                <h3 class="text-base font-semibold text-amber-900 dark:text-amber-200">{{ monitoringUnavailableTitle(selectedResource) }}</h3>
                <p class="mt-2">{{ metricsUnavailableMessage }}</p>
                <p class="mt-2 text-xs text-amber-700 dark:text-amber-300">
                  Kubernetes Metrics Server 提供的是 CPU / Memory 这类资源指标；Pod / Container 级网络 I/O、磁盘 I/O 通常需要 Prometheus 抓取 kubelet/cAdvisor 或等价容器指标采集链路。Node 级网络、磁盘、文件系统指标可由 node_exporter 提供。
                </p>
              </div>
              <div class="rounded-2xl border border-amber-200 bg-white/70 px-4 py-3 font-mono text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100">
                <p>kubectl get apiservice v1beta1.metrics.k8s.io</p>
                <p class="mt-1">kubectl top pod -n {{ selectedResource.namespace || 'default' }}</p>
              </div>
            </div>
          </div>

          <div v-else class="grid gap-4 lg:grid-cols-2">
            <KubeMonitoringChart
              v-for="chart in monitoringChartCards(selectedResource)"
              :key="`${monitoringChartKey}-${chart.kind}`"
              :title="chart.title"
              :labels="chart.labels"
              :datasets="chart.datasets"
              :right-axis="chart.rightAxis"
              :active-index="activeMonitoringIndex"
              :y-tick-formatter="(value: number) => monitoringTickLabel(value, chart.kind)"
              :tooltip-formatter="(value: number, label: string, unit?: string) => monitoringTooltipLabel(value, label, unit, chart.kind)"
              @hover-index="activeMonitoringIndex = $event"
            />
          </div>
        </div>

        <div v-else-if="activeDetailTab === 'events'" class="table-container">
          <table class="table">
            <thead>
              <tr>
                <th>类型</th>
                <th>原因</th>
                <th>消息</th>
                <th>最近出现</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="event in selectedResource.events" :key="event.id">
                <td><span class="badge" :class="event.type === 'Warning' ? 'badge-warning' : 'badge-success'">{{ event.type }}</span></td>
                <td class="font-mono text-xs">{{ event.reason }}</td>
                <td>{{ event.message }}</td>
                <td>{{ event.lastSeen }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else class="space-y-3">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span class="input-label mb-0">YAML</span>
            <div class="flex flex-wrap items-center gap-2 sm:ml-auto">
              <div class="inline-flex w-fit items-center gap-1 rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900">
                <span class="px-1.5 text-xs font-medium text-gray-500 dark:text-dark-400">字号</span>
                <button
                  v-for="size in [12, 13, 14, 16]"
                  :key="size"
                  type="button"
                  class="rounded-lg px-2 py-1 text-xs font-semibold transition-all"
                  :class="segmentButtonClass(yamlFontSize === size)"
                  @click="yamlFontSize = size"
                >
                  {{ size }}
                </button>
              </div>
              <button class="btn btn-primary btn-sm" type="button" @click="saveDetailYaml">保存 YAML</button>
            </div>
          </div>
          <textarea
            :value="detailYamlDraft"
            class="input min-h-[460px] font-mono leading-6"
            :style="{ fontSize: `${yamlFontSize}px` }"
            spellcheck="false"
            @input="onDetailYamlInput"
          ></textarea>
          <p v-if="detailYamlError" class="text-sm text-red-600 dark:text-red-300">{{ detailYamlError }}</p>
        </div>
      </div>
      <template #footer>
        <button class="btn btn-secondary" type="button" @click="closeResourceDetail">关闭</button>
      </template>
    </BaseDialog>

    <BaseDialog :show="containerDetailOpen && Boolean(selectedContainerRow())" :title="containerDetailTitle" width="wide" :z-index="60" @close="closeContainerDetail">
      <div v-if="selectedContainerRow()" class="space-y-4">
        <div class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p class="text-lg font-semibold text-gray-900 dark:text-white">{{ selectedContainerRow()?.name }}</p>
              <p class="mt-1 max-w-3xl break-all font-mono text-xs text-gray-500 dark:text-dark-400">{{ selectedContainerRow()?.image }}</p>
            </div>
            <span class="badge" :class="isTemplateContainerDetail ? 'badge-primary' : statusClass(selectedContainerRow()?.status || 'Running')">{{ selectedContainerRow()?.status }}</span>
          </div>
        </div>

        <div class="tabs w-full overflow-x-auto">
          <button
            v-for="tab in containerDetailTabs"
            :key="tab.id"
            type="button"
            class="tab flex-1 whitespace-nowrap text-center"
            :class="{ 'tab-active': activeContainerDetailTab === tab.id }"
            @click="activeContainerDetailTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </div>

        <div v-if="activeContainerDetailTab === 'details'" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
          <div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span class="badge badge-primary">{{ selectedContainerRow()?.name }}</span>
            <span class="badge" :class="isTemplateContainerDetail ? 'badge-primary' : selectedContainerRow()?.status === 'Running' ? 'badge-success' : 'badge-warning'">{{ isTemplateContainerDetail ? 'Pod Template' : selectedContainerStatusObject()?.ready === false ? 'Not Ready' : 'Ready' }}</span>
          </div>
          <div class="grid gap-x-8 gap-y-5 md:grid-cols-2">
            <div v-for="item in selectedContainerDetailRows()" :key="item.label" class="min-w-0">
              <p class="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-dark-400">{{ item.label }}</p>
              <p class="mt-2 break-all font-mono text-sm font-medium text-gray-900 dark:text-white">{{ detailFieldValue(item.value) }}</p>
            </div>
            <div class="min-w-0">
              <p class="text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">Requests</p>
              <p v-for="line in containerResourceRows(selectedContainerYamlObject() ?? {}).requests" :key="line" class="mt-1 font-mono text-sm text-gray-900 dark:text-white">{{ line }}</p>
            </div>
            <div class="min-w-0">
              <p class="text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">Limits</p>
              <p v-for="line in containerResourceRows(selectedContainerYamlObject() ?? {}).limits" :key="line" class="mt-1 font-mono text-sm text-gray-900 dark:text-white">{{ line }}</p>
            </div>
          </div>
        </div>

        <div v-else-if="activeContainerDetailTab === 'env'" class="rounded-xl border border-gray-100 dark:border-dark-700">
          <div class="border-b border-gray-100 px-4 py-3 dark:border-dark-700">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">环境变量（{{ selectedContainerEnvRows().length }}）</h3>
          </div>
          <div v-if="selectedContainerEnvRows().length" class="overflow-x-auto">
            <table class="table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>来源</th>
                  <th>值</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="env in selectedContainerEnvRows()" :key="env.name">
                  <td class="font-mono text-xs">{{ env.name }}</td>
                  <td><span class="badge badge-gray">{{ env.source }}</span></td>
                  <td class="break-all font-mono text-xs">{{ env.value }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="p-4 text-sm text-gray-500 dark:text-dark-400">未配置环境变量</p>
        </div>

        <div v-else class="rounded-xl border border-gray-100 dark:border-dark-700">
          <div class="border-b border-gray-100 px-4 py-3 dark:border-dark-700">
            <h3 class="text-sm font-semibold text-gray-900 dark:text-white">卷挂载（{{ selectedContainerMountRows().length }}）</h3>
          </div>
          <div v-if="selectedContainerMountRows().length" class="divide-y divide-gray-100 dark:divide-dark-700">
            <div v-for="mount in selectedContainerMountRows()" :key="`${mount.name}-${mount.mountPath}`" class="grid gap-3 px-4 py-3 text-sm md:grid-cols-[180px_minmax(0,1fr)_80px] md:items-center">
              <span class="badge badge-gray w-fit font-mono">{{ mount.name }}</span>
              <div class="min-w-0">
                <p class="break-all font-mono font-medium text-gray-900 dark:text-white">{{ mount.mountPath }}</p>
                <p class="mt-1 break-all text-xs text-gray-500 dark:text-dark-400">{{ mount.source }}</p>
                <p v-if="mount.subPath" class="mt-1 break-all font-mono text-xs text-gray-500 dark:text-dark-400">subPath: {{ mount.subPath }}</p>
              </div>
              <span class="justify-self-start text-xs font-semibold text-gray-500 dark:text-dark-400 md:justify-self-end">{{ mount.readOnly ? 'RO' : 'RW' }}</span>
            </div>
          </div>
          <p v-else class="p-4 text-sm text-gray-500 dark:text-dark-400">未配置卷挂载</p>
        </div>
      </div>
      <template #footer>
        <button class="btn btn-secondary" type="button" @click="closeContainerDetail">关闭</button>
      </template>
    </BaseDialog>

    <BaseDialog :show="editDialogOpen" :title="editMode === 'create' ? `创建 ${createDefinition.title}` : `编辑 ${currentDefinition.title}`" :width="createDialogWidth" @close="closeEditDialog">
      <form class="space-y-4" @submit.prevent="submitForm">
        <div v-if="editMode === 'create' && hasCreateSchema" class="space-y-4">
          <div class="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-dark-700 dark:bg-dark-800 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p class="text-sm font-semibold text-gray-900 dark:text-white">{{ currentCreateSchema?.title }}</p>
              <p class="text-xs leading-5 text-gray-500 dark:text-dark-400">{{ currentCreateSchema?.summary }}</p>
            </div>
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit" aria-label="弹窗尺寸">
                <button
                  type="button"
                  class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                  :class="segmentButtonClass(createDialogSize === 'regular')"
                  @click="setCreateDialogSize('regular')"
                >
                  常规
                </button>
                <button
                  type="button"
                  class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                  :class="segmentButtonClass(createDialogSize === 'wide')"
                  @click="setCreateDialogSize('wide')"
                >
                  超宽
                </button>
              </div>
              <div class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit" aria-label="创建方式">
                <button
                  type="button"
                  class="flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition-all sm:flex-none"
                  :class="createMode === 'form' ? 'bg-primary-600 text-white shadow-sm shadow-primary-600/25' : 'text-gray-600 hover:bg-white hover:text-gray-900 dark:text-dark-300 dark:hover:bg-dark-800 dark:hover:text-white'"
                  @click="setCreateMode('form')"
                >
                  表单创建
                </button>
                <button
                  type="button"
                  class="flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition-all sm:flex-none"
                  :class="createMode === 'yaml' ? 'bg-primary-600 text-white shadow-sm shadow-primary-600/25' : 'text-gray-600 hover:bg-white hover:text-gray-900 dark:text-dark-300 dark:hover:bg-dark-800 dark:hover:text-white'"
                  @click="setCreateMode('yaml')"
                >
                  YAML 编辑
                </button>
              </div>
            </div>
          </div>

          <div v-if="yamlDocumentSummaries.length" class="space-y-2 rounded-xl border border-blue-100 bg-blue-50/70 p-3 dark:border-blue-900/40 dark:bg-blue-950/20">
            <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p class="text-sm font-semibold text-blue-900 dark:text-blue-200">多资源 YAML</p>
                <p class="text-xs leading-5 text-blue-700 dark:text-blue-300">表单正在编辑选中的资源；切换资源后，表单会同步对应 YAML 文档，提交时仍会保留完整多文档 YAML。</p>
              </div>
              <span class="w-fit rounded-full border border-blue-200 bg-white px-3 py-1 text-xs font-medium text-blue-700 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
                共 {{ yamlDocumentSummaries.length }} 个资源
              </span>
            </div>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="item in yamlDocumentSummaries"
                :key="item.index"
                type="button"
                class="rounded-lg border px-3 py-2 text-left text-xs font-semibold transition"
                :class="activeYamlDocumentIndex === item.index ? 'border-primary-500 bg-primary-600 text-white shadow-sm shadow-primary-600/20' : 'border-blue-200 bg-white text-blue-800 hover:border-primary-300 hover:text-primary-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200'"
                :title="item.description"
                @click="setActiveYamlDocument(item.index)"
              >
                {{ item.label }}
              </button>
            </div>
          </div>

          <div v-if="formErrors.length" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
            <p v-for="error in formErrors" :key="error">{{ error }}</p>
          </div>

          <div class="grid min-w-0 gap-4" :class="createDialogSplitClass">
            <div class="min-w-0 space-y-4">
              <div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
                当前表单覆盖常用创建字段；YAML 中的复杂字段会作为高级配置保留，未表单化字段请继续在 YAML 中维护。
              </div>

              <section v-if="createDefinition.type === 'deployments'" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <div class="mb-4 space-y-3">
                  <button type="button" class="flex w-full items-start justify-between gap-3 text-left" @click="toggleSection('deployment')">
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold text-gray-900 dark:text-white">Deployment</span>
                      <span class="block text-xs leading-5 text-gray-500 dark:text-dark-400">配置 Deployment 自身的基本信息与元数据。</span>
                    </span>
                    <Icon :name="isSectionCollapsed('deployment') ? 'chevronDown' : 'chevronUp'" size="sm" class="mt-1 shrink-0 text-gray-400" />
                  </button>
                  <div v-if="!isSectionCollapsed('deployment')" class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                    <button
                      v-for="panel in deploymentPanels"
                      :key="panel.id"
                      type="button"
                      class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                      :class="segmentButtonClass(activeDeploymentPanel === panel.id)"
                      @click="activeDeploymentPanel = panel.id"
                    >
                      {{ panel.label }}
                    </button>
                  </div>
                </div>

                <div v-if="!isSectionCollapsed('deployment')" class="space-y-3">
                  <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                    {{ deploymentPanels.find((panel) => panel.id === activeDeploymentPanel)?.help }}
                  </div>
                  <div v-if="activeDeploymentPanel === 'basic'" class="grid gap-3 md:grid-cols-3">
                    <label class="block">
                      <span class="input-label">名称 <span class="text-red-500">*</span></span>
                      <input class="input" :value="createForm.name" placeholder="deployment-name" @input="updateTextField('name', $event)" />
                    </label>
                    <label class="block">
                      <span class="input-label">Namespace <span class="text-red-500">*</span></span>
                      <input class="input" :value="createForm.namespace" placeholder="default" @input="updateTextField('namespace', $event)" />
                    </label>
                    <label class="block">
                      <span class="input-label">副本数 <span class="text-red-500">*</span></span>
                      <input class="input" min="0" type="number" :value="createForm.replicas" @input="updateNumberField('replicas', $event)" />
                    </label>
                  </div>
                  <div v-else class="space-y-4">
                    <div class="space-y-2">
                      <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                        <span class="input-label">标签</span>
                        <span class="text-xs text-gray-400 dark:text-dark-500">默认标签 key 为 app，value 跟随名称，可继续增加其他标签。</span>
                      </div>
                      <div v-for="pair in createForm.labels" :key="pair.id" class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto]">
                        <input v-model="pair.key" class="input" placeholder="key" @focus="markFormSource" />
                        <input v-model="pair.value" class="input" placeholder="value" @focus="markFormSource" />
                        <button class="btn btn-secondary btn-sm" type="button" :disabled="pair.key === 'app' && createForm.labels.length <= 1" @click="removePair('labels', pair.id)">
                          <Icon name="trash" size="sm" />
                        </button>
                      </div>
                      <button class="btn btn-secondary btn-sm" type="button" @click="addPair('labels')">
                        <Icon name="plus" size="sm" />
                        添加标签
                      </button>
                    </div>
                    <div class="space-y-2">
                      <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                        <span class="input-label">注解</span>
                        <span class="text-xs text-gray-400 dark:text-dark-500">默认空；需要时再写入 metadata.annotations。</span>
                      </div>
                      <div v-if="createForm.annotations.length" class="space-y-2">
                        <div v-for="pair in createForm.annotations" :key="pair.id" class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto]">
                          <input v-model="pair.key" class="input" placeholder="key" @focus="markFormSource" />
                          <input v-model="pair.value" class="input" placeholder="value" @focus="markFormSource" />
                          <button class="btn btn-secondary btn-sm" type="button" @click="removePair('annotations', pair.id)">
                            <Icon name="trash" size="sm" />
                          </button>
                        </div>
                      </div>
                      <div v-else class="rounded-xl border border-gray-100 px-4 py-5 text-center text-sm text-gray-500 dark:border-dark-700 dark:text-dark-400">当前未配置注解。</div>
                      <button class="btn btn-secondary btn-sm" type="button" @click="addPair('annotations')">
                        <Icon name="plus" size="sm" />
                        添加注解
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <section v-if="createDefinition.type === 'deployments'" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <div class="mb-4 space-y-3">
                  <button type="button" class="flex w-full items-start justify-between gap-3 text-left" @click="toggleSection('deployment-strategy')">
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold text-gray-900 dark:text-white">Deployment 更新策略</span>
                      <span class="block text-xs leading-5 text-gray-500 dark:text-dark-400">默认不写入，使用 Kubernetes 默认 RollingUpdate；需要显式控制滚动更新、历史版本和进度期限时再配置。</span>
                    </span>
                    <Icon :name="isSectionCollapsed('deployment-strategy') ? 'chevronDown' : 'chevronUp'" size="sm" class="mt-1 shrink-0 text-gray-400" />
                  </button>
                  <div v-if="!isSectionCollapsed('deployment-strategy')" class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                    <button
                      v-for="panel in strategyPanels"
                      :key="panel.id"
                      type="button"
                      class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                      :class="segmentButtonClass(activeStrategyPanel === panel.id)"
                      @click="setStrategyPanel(panel.id)"
                    >
                      {{ panel.label }}
                    </button>
                  </div>
                </div>
                <div v-if="!isSectionCollapsed('deployment-strategy')" class="space-y-3">
                  <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                    {{ strategyPanels.find((panel) => panel.id === activeStrategyPanel)?.help }}
                  </div>
                  <div v-if="activeStrategyPanel === 'strategy'" class="grid gap-3 md:grid-cols-3">
                    <label class="block">
                      <span class="input-label">策略类型</span>
                      <Select
                        :model-value="createForm.strategyType"
                        :options="[{ label: '默认', value: '' }, { label: 'RollingUpdate', value: 'RollingUpdate' }, { label: 'Recreate', value: 'Recreate' }]"
                        @update:model-value="updateScalarField('strategyType', $event)"
                      />
                    </label>
                    <label class="block">
                      <span class="input-label">maxSurge</span>
                      <input class="input" :value="createForm.maxSurge" placeholder="25%" :disabled="createForm.strategyType !== 'RollingUpdate'" @input="updateTextField('maxSurge', $event)" />
                    </label>
                    <label class="block">
                      <span class="input-label">maxUnavailable</span>
                      <input class="input" :value="createForm.maxUnavailable" placeholder="25%" :disabled="createForm.strategyType !== 'RollingUpdate'" @input="updateTextField('maxUnavailable', $event)" />
                    </label>
                  </div>
                  <div v-else class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <label class="block">
                      <span class="input-label">minReadySeconds</span>
                      <input class="input" min="0" type="number" :value="createForm.minReadySeconds ?? ''" placeholder="默认" @input="updateNullableNumberField('minReadySeconds', $event)" />
                    </label>
                    <label class="block">
                      <span class="input-label">revisionHistoryLimit</span>
                      <input class="input" min="0" type="number" :value="createForm.revisionHistoryLimit ?? ''" placeholder="默认" @input="updateNullableNumberField('revisionHistoryLimit', $event)" />
                    </label>
                    <label class="block">
                      <span class="input-label">progressDeadlineSeconds</span>
                      <input class="input" min="1" type="number" :value="createForm.progressDeadlineSeconds ?? ''" placeholder="默认" @input="updateNullableNumberField('progressDeadlineSeconds', $event)" />
                    </label>
                    <label class="flex min-h-[42px] items-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-700 dark:border-dark-600 dark:text-dark-300">
                      <input v-model="createForm.paused" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" @focus="markFormSource" />
                      暂停 rollout
                    </label>
                  </div>
                </div>
              </section>

              <section
                v-for="section in visibleCreateSections"
                :key="section.title"
                class="rounded-xl border border-gray-100 p-4 dark:border-dark-700"
              >
                <button
                  type="button"
                  class="mb-4 flex w-full items-start justify-between gap-3 text-left"
                  @click="toggleSection(sectionKey(section.title))"
                >
                  <span class="min-w-0">
                    <span class="block text-sm font-semibold text-gray-900 dark:text-white">{{ ['Pod 模板', 'Pod 配置'].includes(section.title) ? createPodSpecTitle : section.title }}</span>
                    <span v-if="section.description" class="block text-xs text-gray-500 dark:text-dark-400">{{ section.description }}</span>
                  </span>
                  <Icon :name="isSectionCollapsed(sectionKey(section.title)) ? 'chevronDown' : 'chevronUp'" size="sm" class="mt-1 shrink-0 text-gray-400" />
                </button>

                <div v-if="!isSectionCollapsed(sectionKey(section.title))" class="space-y-4">
                  <div v-if="['Pod 模板', 'Pod 配置'].includes(section.title)" class="space-y-4">
                    <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                      {{ createPodSpecDescription }} 普通容器配置基础信息、端口、环境变量、资源、安全、探针、生命周期和容器挂载；Init 容器支持 command / args、env、resources 和 volumeMounts，但不配置 readiness、liveness、startup probe 或 lifecycle。Pod 安全、存储卷和调度在下方以 Pod 级配置统一生效。
                    </div>
                    <div class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                      <button
                        v-for="panel in podTemplatePanels"
                        :key="panel.id"
                        type="button"
                        class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                        :class="segmentButtonClass(activePodTemplatePanel === panel.id)"
                        @click="setPodTemplatePanel(panel.id)"
                      >
                        {{ panel.label }}
                      </button>
                    </div>
                    <p class="text-xs leading-5 text-gray-500 dark:text-dark-400">
                      {{ podTemplatePanels.find((panel) => panel.id === activePodTemplatePanel)?.help }}
                    </p>
                  </div>

                  <template v-if="!['Pod 模板', 'Pod 配置'].includes(section.title)">
                  <div v-for="field in section.fields" :key="field.key" class="space-y-2">
                    <template v-if="section.title !== '基本信息' || createDefinition.type === 'pods' || field.key === 'name' || field.key === 'namespace'">
                    <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                      <span class="input-label">
                        {{ field.label }}
                        <span v-if="field.required" class="text-red-500">*</span>
                      </span>
                      <span v-if="field.help" class="text-xs text-gray-400 dark:text-dark-500">{{ field.help }}</span>
                    </div>

                    <input
                      v-if="field.type === 'text'"
                      class="input"
                      :placeholder="field.placeholder"
                      :value="scalarValue(field.key)"
                      @input="updateTextField(field.key, $event)"
                    />

                    <input
                      v-else-if="field.type === 'number'"
                      class="input"
                      :min="field.min"
                      type="number"
                      :value="numberValue(field.key)"
                      @input="updateNumberField(field.key, $event)"
                    />

                    <Select
                      v-else-if="field.type === 'select'"
                      :model-value="scalarValue(field.key)"
                      :options="fieldOptions(field)"
                      @update:model-value="updateScalarField(field.key, $event)"
                    />

                    <div v-else-if="field.type === 'keyValue' || field.type === 'configData' || field.type === 'secretData'" class="space-y-2">
                      <div v-for="pair in pairList(field.key)" :key="pair.id" class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto]">
                        <input v-model="pair.key" class="input" placeholder="key" @focus="markFormSource" />
                        <input
                          v-model="pair.value"
                          class="input"
                          :type="field.type === 'secretData' ? 'password' : 'text'"
                          :placeholder="field.type === 'secretData' ? 'value' : 'value'"
                          @focus="markFormSource"
                        />
                        <button class="btn btn-secondary btn-sm" type="button" @click="removePair(field.key, pair.id)">
                          <Icon name="trash" size="sm" />
                        </button>
                      </div>
                      <button class="btn btn-secondary btn-sm" type="button" @click="addPair(field.key)">
                        <Icon name="plus" size="sm" />
                        添加
                      </button>
                    </div>

                    <div v-else-if="field.type === 'ports'" class="space-y-2">
                      <div v-for="port in createForm.ports" :key="port.id" class="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_100px_100px_112px_auto]">
                        <input v-model="port.name" class="input" placeholder="名称" @focus="markFormSource" />
                        <input v-model.number="port.port" class="input" min="1" type="number" placeholder="Port" @focus="markFormSource" />
                        <input v-model.number="port.targetPort" class="input" min="1" type="number" placeholder="Target" @focus="markFormSource" />
                        <Select v-model="port.protocol" :options="[{ label: 'TCP', value: 'TCP' }, { label: 'UDP', value: 'UDP' }]" />
                        <button class="btn btn-secondary btn-sm" type="button" @click="removePort(port.id)">
                          <Icon name="trash" size="sm" />
                        </button>
                      </div>
                      <button class="btn btn-secondary btn-sm" type="button" @click="addPort">
                        <Icon name="plus" size="sm" />
                        添加端口
                      </button>
                    </div>

                    <div v-else-if="field.type === 'env'" class="space-y-2">
                      <div v-for="env in createForm.env" :key="env.id" class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto]">
                        <input v-model="env.name" class="input" placeholder="NAME" @focus="markFormSource" />
                        <input v-model="env.value" class="input" placeholder="value" @focus="markFormSource" />
                        <button class="btn btn-secondary btn-sm" type="button" @click="removeEnv(env.id)">
                          <Icon name="trash" size="sm" />
                        </button>
                      </div>
                      <button class="btn btn-secondary btn-sm" type="button" @click="addEnv">
                        <Icon name="plus" size="sm" />
                        添加变量
                      </button>
                    </div>
                    </template>
                  </div>
                  </template>

                  <div v-else-if="activePodTemplatePanel === 'app'" class="space-y-4">
                    <div class="inline-flex w-full flex-wrap rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                      <button
                        v-for="panel in appContainerPanels"
                        :key="panel.id"
                        type="button"
                        class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                        :class="segmentButtonClass(activeAppContainerPanel === panel.id)"
                        @click="setAppContainerPanel(panel.id)"
                      >
                        {{ panel.label }}
                      </button>
                    </div>
                    <p class="text-xs leading-5 text-gray-500 dark:text-dark-400">
                      {{ appContainerPanels.find((panel) => panel.id === activeAppContainerPanel)?.help }}
                    </p>

                    <div v-if="createForm.appContainers.length" class="space-y-3">
                      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div class="flex min-w-0 flex-wrap gap-2">
                          <button
                            v-for="container in createForm.appContainers"
                            :key="container.id"
                            type="button"
                            class="rounded-lg border px-3 py-2 text-sm font-semibold transition-all"
                            :class="activeAppContainerId === container.id ? 'border-primary-500 bg-primary-50 text-primary-700 dark:border-primary-500 dark:bg-primary-950/30 dark:text-primary-300' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-dark-700 dark:text-dark-300 dark:hover:bg-dark-800'"
                            @click="activeAppContainerId = container.id; syncLegacyFieldsFromActiveAppContainer()"
                          >
                            {{ container.name || '未命名普通容器' }}
                          </button>
                        </div>
                        <button class="btn btn-danger btn-sm shrink-0 sm:ml-auto" type="button" @click="addAppContainer">
                          <Icon name="plus" size="sm" />
                          添加普通容器
                        </button>
                      </div>

                      <div v-if="activeAppContainer" class="rounded-xl border border-gray-100 p-3 dark:border-dark-700">
                        <div v-if="activeAppContainerPanel === 'basic'" class="space-y-3">
                          <div class="grid gap-3 md:grid-cols-2">
                            <label class="block">
                              <span class="input-label">容器名称</span>
                              <input class="input" :value="activeAppContainer.name" placeholder="app" @input="updateAppTextField(activeAppContainer, 'name', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">镜像</span>
                              <input class="input" :value="activeAppContainer.image" placeholder="registry.example/app:v1.0.0" @input="updateAppTextField(activeAppContainer, 'image', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">镜像拉取策略</span>
                              <Select
                                :model-value="activeAppContainer.imagePullPolicy"
                                :options="imagePullPolicyOptions"
                                @update:model-value="updateAppScalarField(activeAppContainer, 'imagePullPolicy', $event)"
                              />
                            </label>
                          </div>
                          <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                            私有仓库认证使用 Pod 级 imagePullSecrets，在下方“Pod 安全 / 身份”里统一配置，普通容器和 Init 容器共享。
                          </div>
                          <div class="space-y-2">
                            <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                              <span class="input-label">端口</span>
                              <span class="text-xs text-gray-400 dark:text-dark-500">为空时不写入 ports；hostPort 需显式勾选后才写入。</span>
                            </div>
                            <div v-if="!activeAppContainer.ports.length" class="rounded-xl border border-gray-100 px-4 py-3 text-sm text-gray-500 dark:border-dark-700 dark:text-dark-400">
                              当前普通容器未配置端口。
                            </div>
                            <div v-for="port in activeAppContainer.ports" :key="port.id" class="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_110px_120px_112px_150px_120px_auto]">
                              <input v-model="port.name" class="input" placeholder="名称" @focus="markFormSource" />
                              <input class="input" min="1" type="number" :value="port.targetPort ?? ''" placeholder="containerPort" @input="updatePortNumberField(port, 'targetPort', $event)" />
                              <label class="flex h-11 items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-600 dark:border-dark-600 dark:bg-dark-800 dark:text-dark-300">
                                <input v-model="port.hostPortEnabled" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" @change="markFormSource(); syncLegacyFieldsFromActiveAppContainer()" />
                                hostPort
                              </label>
                              <input class="input" min="1" type="number" :disabled="!port.hostPortEnabled" :value="port.hostPort ?? ''" placeholder="hostPort" @input="updatePortNumberField(port, 'hostPort', $event)" />
                              <Select v-model="port.protocol" :options="[{ label: 'TCP', value: 'TCP' }, { label: 'UDP', value: 'UDP' }]" />
                              <input v-model="port.hostIP" class="input" :disabled="!port.hostPortEnabled" placeholder="hostIP" @focus="markFormSource" />
                              <button class="btn btn-secondary btn-sm" type="button" @click="removeAppPort(activeAppContainer, port.id)">
                                <Icon name="trash" size="sm" />
                              </button>
                            </div>
                            <button class="btn btn-secondary btn-sm" type="button" @click="addAppPort(activeAppContainer)">
                              <Icon name="plus" size="sm" />
                              添加端口
                            </button>
                          </div>
                          <button class="btn btn-danger btn-sm" type="button" :disabled="createForm.appContainers.length <= 1" @click="removeAppContainer(activeAppContainer.id)">
                            <Icon name="trash" size="sm" />
                            移除当前普通容器
                          </button>
                        </div>

                        <div v-else-if="activeAppContainerPanel === 'env'" class="space-y-2">
                          <div v-for="env in activeAppContainer.env" :key="env.id" class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto]">
                            <input v-model="env.name" class="input" placeholder="NAME" @focus="markFormSource" />
                            <input v-model="env.value" class="input" placeholder="value" @focus="markFormSource" />
                            <button class="btn btn-secondary btn-sm" type="button" @click="removeAppEnv(activeAppContainer, env.id)">
                              <Icon name="trash" size="sm" />
                            </button>
                          </div>
                          <button class="btn btn-secondary btn-sm" type="button" @click="addAppEnv(activeAppContainer)">
                            <Icon name="plus" size="sm" />
                            添加变量
                          </button>
                        </div>

                        <div v-else-if="activeAppContainerPanel === 'resources'" class="space-y-3">
                          <div class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                            <button
                              v-for="panel in resourcePanels"
                              :key="panel.id"
                              type="button"
                              class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                              :class="segmentButtonClass(activeResourcePanel === panel.id)"
                              @click="setResourcePanel(panel.id)"
                            >
                              {{ panel.label }}
                            </button>
                          </div>
                          <div class="grid gap-3 md:grid-cols-2">
                            <label v-for="field in resourceFieldGroups[activeResourcePanel]" :key="field.key" class="block">
                              <span class="input-label">{{ field.label }}</span>
                              <input
                                class="input"
                                :placeholder="field.placeholder"
                                :value="appScalarValue(activeAppContainer, field.key as keyof AppContainerEntry)"
                                @input="updateAppTextField(activeAppContainer, field.key as keyof AppContainerEntry, $event)"
                              />
                              <span class="input-hint">{{ field.help }}</span>
                            </label>
                          </div>
                        </div>

                        <div v-else-if="activeAppContainerPanel === 'security'" class="space-y-3">
                          <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                            只影响当前选中的普通容器，生成到该容器的 securityContext；Pod 级安全身份仍在下方“Pod 安全”中配置。
                          </div>
                          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                            <label class="block">
                              <span class="input-label">runAsUser</span>
                              <input class="input" min="0" type="number" :value="activeAppContainer.containerRunAsUser ?? ''" placeholder="默认" @input="updateAppNullableNumberField(activeAppContainer, 'containerRunAsUser', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">runAsGroup</span>
                              <input class="input" min="0" type="number" :value="activeAppContainer.containerRunAsGroup ?? ''" placeholder="默认" @input="updateAppNullableNumberField(activeAppContainer, 'containerRunAsGroup', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">runAsNonRoot</span>
                              <Select :model-value="activeAppContainer.containerRunAsNonRoot" :options="[{ label: '默认', value: '' }, { label: '开启', value: 'true' }, { label: '关闭', value: 'false' }]" @update:model-value="updateAppScalarField(activeAppContainer, 'containerRunAsNonRoot', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">privileged</span>
                              <Select :model-value="activeAppContainer.privileged" :options="[{ label: '默认', value: '' }, { label: '开启', value: 'true' }, { label: '关闭', value: 'false' }]" @update:model-value="updateAppScalarField(activeAppContainer, 'privileged', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">allowPrivilegeEscalation</span>
                              <Select :model-value="activeAppContainer.allowPrivilegeEscalation" :options="[{ label: '默认', value: '' }, { label: '开启', value: 'true' }, { label: '关闭', value: 'false' }]" @update:model-value="updateAppScalarField(activeAppContainer, 'allowPrivilegeEscalation', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">readOnlyRootFilesystem</span>
                              <Select :model-value="activeAppContainer.readOnlyRootFilesystem" :options="[{ label: '默认', value: '' }, { label: '开启', value: 'true' }, { label: '关闭', value: 'false' }]" @update:model-value="updateAppScalarField(activeAppContainer, 'readOnlyRootFilesystem', $event)" />
                            </label>
                          </div>
                        </div>

                        <div v-else-if="activeAppContainerPanel === 'probes'" class="space-y-3">
                          <div class="inline-flex w-full flex-wrap rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                            <button
                              v-for="panel in probePanels"
                              :key="panel.id"
                              type="button"
                              class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                              :class="segmentButtonClass(activeProbePanel === panel.id)"
                              @click="setProbePanel(panel.id)"
                            >
                              {{ panel.label }}
                            </button>
                          </div>
                          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                            <label v-for="field in probeFieldGroups[activeProbePanel]" :key="field.key" class="block">
                              <span class="input-label">{{ field.label }}</span>
                              <input
                                v-if="field.type === 'text'"
                                class="input"
                                :placeholder="field.placeholder"
                                :value="appScalarValue(activeAppContainer, field.key as keyof AppContainerEntry)"
                                @input="updateAppTextField(activeAppContainer, field.key as keyof AppContainerEntry, $event)"
                              />
                              <input
                                v-else
                                class="input"
                                :min="field.min"
                                type="number"
                                :value="Number(appScalarValue(activeAppContainer, field.key as keyof AppContainerEntry)) || 0"
                                @input="updateAppNumberField(activeAppContainer, field.key as keyof AppContainerEntry, $event)"
                              />
                              <span class="input-hint">{{ field.help }}</span>
                            </label>
                          </div>
                        </div>

                        <div v-else-if="activeAppContainerPanel === 'mounts'" class="space-y-3">
                          <div class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                            <button
                              v-for="panel in mountPanels"
                              :key="panel.id"
                              type="button"
                              class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                              :class="segmentButtonClass(activeMountPanel === panel.id)"
                              @click="setMountPanel(panel.id)"
                            >
                              {{ panel.label }}
                            </button>
                          </div>
                          <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                            {{ mountPanels.find((panel) => panel.id === activeMountPanel)?.help }}。未添加条目时不会写入 volumeMounts；Pod volumes 请在“Pod 存储卷”中维护。
                          </div>
                          <div v-if="mountListByType(activeMountPanel).length" class="space-y-3">
                            <div v-for="mount in mountListByType(activeMountPanel)" :key="mount.id" class="rounded-xl border border-gray-100 p-3 dark:border-dark-700">
                              <div class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
                                <div class="block space-y-2">
                                  <span class="input-label">Pod Volume</span>
                                  <Select
                                    :model-value="podVolumeOptions(mount.type, mount.name).some((option) => option.value === mount.name) ? mount.name : null"
                                    :options="podVolumeOptions(mount.type, mount.name)"
                                    :placeholder="mount.name || '请选择 Pod 存储卷'"
                                    searchable
                                    @update:model-value="onVolumeMountSelect(mount, $event)"
                                  />
                                  <p v-if="!podVolumeListByType(mount.type).length" class="text-xs leading-5 text-amber-600 dark:text-amber-400">
                                    请先在 Pod 存储卷中添加 {{ mountPanels.find((panel) => panel.id === mount.type)?.label }} 卷。
                                  </p>
                                </div>
                                <label class="block">
                                  <span class="input-label">挂载路径</span>
                                  <input v-model="mount.mountPath" class="input" placeholder="/etc/config" @focus="markFormSource" />
                                </label>
                                <label class="block">
                                  <span class="input-label">SubPath</span>
                                  <input v-model="mount.subPath" class="input" placeholder="可选" @focus="markFormSource" />
                                </label>
                                <label class="flex min-h-[42px] items-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-700 dark:border-dark-600 dark:text-dark-300">
                                  <input :checked="mount.readOnly" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" @change="updateVolumeMountReadOnly(mount, $event)" />
                                  只读挂载
                                </label>
                                <div class="flex items-end gap-2">
                                  <button class="btn btn-secondary btn-sm w-full" type="button" @click="removeVolumeMount(mount.id)">
                                    <Icon name="trash" size="sm" />
                                    移除
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div v-else class="rounded-xl border border-gray-100 px-4 py-6 text-center text-sm text-gray-500 dark:border-dark-700 dark:text-dark-400">
                            当前分类还没有挂载项。
                          </div>
                          <button class="btn btn-danger btn-sm" type="button" @click="addVolumeMount()">
                            <Icon name="plus" size="sm" />
                            添加 {{ mountPanels.find((panel) => panel.id === activeMountPanel)?.label }} 挂载
                          </button>
                          <button v-if="activeMountPanel !== 'emptyDir'" class="btn btn-danger btn-sm" type="button" @click="openRelatedConfigResource(activeMountPanel, undefined, 'app-mount')">
                            <Icon name="plus" size="sm" />
                            新建 {{ mountCreateLabel(activeMountPanel) }} 并挂载
                          </button>
                        </div>

                        <div v-else class="space-y-3">
                          <div class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                            <button
                              v-for="panel in lifecyclePanels"
                              :key="panel.id"
                              type="button"
                              class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                              :class="segmentButtonClass(activeLifecyclePanel === panel.id)"
                              @click="setLifecyclePanel(panel.id)"
                            >
                              {{ panel.label }}
                            </button>
                          </div>
                          <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                            {{ lifecyclePanels.find((panel) => panel.id === activeLifecyclePanel)?.help }} 多命令用逗号分隔，例如 `/bin/sh, -c, echo started`。
                          </div>
                          <div v-if="lifecycleList(activeLifecyclePanel, activeAppContainer).length" class="space-y-3">
                            <div v-for="hook in lifecycleList(activeLifecyclePanel, activeAppContainer)" :key="hook.id" class="rounded-xl border border-gray-100 p-3 dark:border-dark-700">
                              <div class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-[160px_minmax(0,1fr)_120px_auto]">
                                <label class="block">
                                  <span class="input-label">处理方式</span>
                                  <Select v-model="hook.handlerType" :options="[{ label: 'Exec', value: 'exec' }, { label: 'HTTP GET', value: 'httpGet' }]" />
                                </label>
                                <label v-if="hook.handlerType === 'exec'" class="block xl:col-span-2">
                                  <span class="input-label">命令</span>
                                  <input v-model="hook.command" class="input" placeholder="/bin/sh, -c, echo started" @focus="markFormSource" />
                                </label>
                                <label v-if="hook.handlerType === 'httpGet'" class="block">
                                  <span class="input-label">路径</span>
                                  <input v-model="hook.path" class="input" placeholder="/hook" @focus="markFormSource" />
                                </label>
                                <label v-if="hook.handlerType === 'httpGet'" class="block">
                                  <span class="input-label">端口</span>
                                  <input v-model.number="hook.port" class="input" min="1" type="number" @focus="markFormSource" />
                                </label>
                                <div class="flex items-end">
                                  <button class="btn btn-secondary btn-sm w-full" type="button" @click="removeLifecycleHook(hook.id, activeAppContainer)">
                                    <Icon name="trash" size="sm" />
                                    移除
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div v-else class="rounded-xl border border-gray-100 px-4 py-6 text-center text-sm text-gray-500 dark:border-dark-700 dark:text-dark-400">
                            当前钩子未启用。
                          </div>
                          <button class="btn btn-secondary btn-sm" type="button" @click="addLifecycleHook(activeLifecyclePanel, activeAppContainer)">
                            <Icon name="plus" size="sm" />
                            添加 {{ lifecyclePanels.find((panel) => panel.id === activeLifecyclePanel)?.label }}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div v-else class="space-y-4">
                    <div>
                      <div class="inline-flex w-full flex-wrap rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                        <button
                          v-for="panel in initContainerPanels"
                          :key="panel.id"
                          type="button"
                          class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                          :class="segmentButtonClass(activeInitContainerPanel === panel.id)"
                          @click="setInitContainerPanel(panel.id)"
                        >
                          {{ panel.label }}
                        </button>
                      </div>
                    </div>
                    <p class="text-xs leading-5 text-gray-500 dark:text-dark-400">
                      {{ initContainerPanels.find((panel) => panel.id === activeInitContainerPanel)?.help }}
                    </p>

                    <div v-if="createForm.initContainers.length" class="space-y-3">
                      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div class="flex min-w-0 flex-wrap gap-2">
                          <button
                            v-for="container in createForm.initContainers"
                            :key="container.id"
                            type="button"
                            class="rounded-lg border px-3 py-2 text-sm font-semibold transition-all"
                            :class="activeInitContainerId === container.id ? 'border-primary-500 bg-primary-50 text-primary-700 dark:border-primary-500 dark:bg-primary-950/30 dark:text-primary-300' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-dark-700 dark:text-dark-300 dark:hover:bg-dark-800'"
                            @click="activeInitContainerId = container.id"
                          >
                            {{ container.name || '未命名 Init 容器' }}
                          </button>
                        </div>
                        <button class="btn btn-danger btn-sm shrink-0 sm:ml-auto" type="button" @click="addInitContainer">
                          <Icon name="plus" size="sm" />
                          添加 Init 容器
                        </button>
                      </div>

                      <div v-if="activeInitContainer" class="rounded-xl border border-gray-100 p-3 dark:border-dark-700">
                        <div v-if="activeInitContainerPanel === 'basic'" class="space-y-3">
                          <div class="grid gap-3 md:grid-cols-2">
                            <label class="block">
                              <span class="input-label">Init 容器名称</span>
                              <input class="input" :value="activeInitContainer.name" placeholder="init-db" @input="updateInitTextField(activeInitContainer, 'name', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">镜像</span>
                              <input class="input" :value="activeInitContainer.image" placeholder="busybox:1.36" @input="updateInitTextField(activeInitContainer, 'image', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">镜像拉取策略</span>
                              <Select
                                :model-value="activeInitContainer.imagePullPolicy"
                                :options="imagePullPolicyOptions"
                                @update:model-value="updateInitScalarField(activeInitContainer, 'imagePullPolicy', $event)"
                              />
                            </label>
                          </div>
                          <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                            私有仓库认证使用 Pod 级 imagePullSecrets，在下方“Pod 安全 / 身份”里统一配置，普通容器和 Init 容器共享。
                          </div>
                          <button class="btn btn-danger btn-sm" type="button" @click="removeInitContainer(activeInitContainer.id)">
                            <Icon name="trash" size="sm" />
                            移除当前 Init 容器
                          </button>
                        </div>

                        <div v-else-if="activeInitContainerPanel === 'command'" class="grid gap-3 md:grid-cols-2">
                          <label class="block">
                            <span class="input-label">Command</span>
                            <input class="input" :value="activeInitContainer.command" placeholder="/bin/sh, -c" @input="updateInitTextField(activeInitContainer, 'command', $event)" />
                            <span class="input-hint">逗号分隔，写入 command 数组。</span>
                          </label>
                          <label class="block">
                            <span class="input-label">Args</span>
                            <input class="input" :value="activeInitContainer.args" placeholder="echo init" @input="updateInitTextField(activeInitContainer, 'args', $event)" />
                            <span class="input-hint">逗号分隔，写入 args 数组。</span>
                          </label>
                        </div>

                        <div v-else-if="activeInitContainerPanel === 'env'" class="space-y-2">
                          <div v-for="env in activeInitContainer.env" :key="env.id" class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto]">
                            <input v-model="env.name" class="input" placeholder="NAME" @focus="markFormSource" />
                            <input v-model="env.value" class="input" placeholder="value" @focus="markFormSource" />
                            <button class="btn btn-secondary btn-sm" type="button" @click="removeInitEnv(activeInitContainer, env.id)">
                              <Icon name="trash" size="sm" />
                            </button>
                          </div>
                          <button class="btn btn-secondary btn-sm" type="button" @click="addInitEnv(activeInitContainer)">
                            <Icon name="plus" size="sm" />
                            添加 Init 环境变量
                          </button>
                        </div>

                        <div v-else-if="activeInitContainerPanel === 'resources'" class="grid gap-3 md:grid-cols-2">
                          <label class="block">
                            <span class="input-label">CPU Request</span>
                            <input class="input" :value="initScalarValue(activeInitContainer, 'cpuRequest')" placeholder="100m" @input="updateInitTextField(activeInitContainer, 'cpuRequest', $event)" />
                          </label>
                          <label class="block">
                            <span class="input-label">CPU Limit</span>
                            <input class="input" :value="initScalarValue(activeInitContainer, 'cpuLimit')" placeholder="500m" @input="updateInitTextField(activeInitContainer, 'cpuLimit', $event)" />
                          </label>
                          <label class="block">
                            <span class="input-label">Memory Request</span>
                            <input class="input" :value="initScalarValue(activeInitContainer, 'memoryRequest')" placeholder="128Mi" @input="updateInitTextField(activeInitContainer, 'memoryRequest', $event)" />
                          </label>
                          <label class="block">
                            <span class="input-label">Memory Limit</span>
                            <input class="input" :value="initScalarValue(activeInitContainer, 'memoryLimit')" placeholder="512Mi" @input="updateInitTextField(activeInitContainer, 'memoryLimit', $event)" />
                          </label>
                        </div>

                        <div v-else-if="activeInitContainerPanel === 'security'" class="space-y-3">
                          <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                            写入当前 Init 容器 securityContext。常规 Init 容器不支持 lifecycle、readinessProbe、livenessProbe 或 startupProbe，因此这里不提供探针和生命周期配置。
                          </div>
                          <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                            <label class="block">
                              <span class="input-label">runAsUser</span>
                              <input class="input" min="0" type="number" :value="activeInitContainer.containerRunAsUser ?? ''" placeholder="默认" @input="updateInitNullableNumberField(activeInitContainer, 'containerRunAsUser', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">runAsGroup</span>
                              <input class="input" min="0" type="number" :value="activeInitContainer.containerRunAsGroup ?? ''" placeholder="默认" @input="updateInitNullableNumberField(activeInitContainer, 'containerRunAsGroup', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">runAsNonRoot</span>
                              <Select :model-value="activeInitContainer.containerRunAsNonRoot" :options="[{ label: '默认', value: '' }, { label: '开启', value: 'true' }, { label: '关闭', value: 'false' }]" @update:model-value="updateInitScalarField(activeInitContainer, 'containerRunAsNonRoot', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">privileged</span>
                              <Select :model-value="activeInitContainer.privileged" :options="[{ label: '默认', value: '' }, { label: '开启', value: 'true' }, { label: '关闭', value: 'false' }]" @update:model-value="updateInitScalarField(activeInitContainer, 'privileged', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">allowPrivilegeEscalation</span>
                              <Select :model-value="activeInitContainer.allowPrivilegeEscalation" :options="[{ label: '默认', value: '' }, { label: '开启', value: 'true' }, { label: '关闭', value: 'false' }]" @update:model-value="updateInitScalarField(activeInitContainer, 'allowPrivilegeEscalation', $event)" />
                            </label>
                            <label class="block">
                              <span class="input-label">readOnlyRootFilesystem</span>
                              <Select :model-value="activeInitContainer.readOnlyRootFilesystem" :options="[{ label: '默认', value: '' }, { label: '开启', value: 'true' }, { label: '关闭', value: 'false' }]" @update:model-value="updateInitScalarField(activeInitContainer, 'readOnlyRootFilesystem', $event)" />
                            </label>
                          </div>
                        </div>

                        <div v-else class="space-y-3">
                          <div class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                            <button
                              v-for="panel in mountPanels"
                              :key="panel.id"
                              type="button"
                              class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                              :class="segmentButtonClass(activeMountPanel === panel.id)"
                              @click="setMountPanel(panel.id)"
                            >
                              {{ panel.label }}
                            </button>
                          </div>

                          <div v-if="initMountListByType(activeInitContainer, activeMountPanel).length" class="space-y-3">
                            <div
                              v-for="mount in initMountListByType(activeInitContainer, activeMountPanel)"
                              :key="mount.id"
                              class="rounded-xl border border-gray-100 p-3 dark:border-dark-700"
                            >
                              <div class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
                                <div class="block space-y-2">
                                  <span class="input-label">Pod Volume</span>
                                  <Select
                                    :model-value="podVolumeOptions(mount.type, mount.name).some((option) => option.value === mount.name) ? mount.name : null"
                                    :options="podVolumeOptions(mount.type, mount.name)"
                                    :placeholder="mount.name || '请选择 Pod 存储卷'"
                                    searchable
                                    @update:model-value="onVolumeMountSelect(mount, $event)"
                                  />
                                  <p v-if="!podVolumeListByType(mount.type).length" class="text-xs leading-5 text-amber-600 dark:text-amber-400">
                                    请先在 Pod 存储卷中添加 {{ mountPanels.find((panel) => panel.id === mount.type)?.label }} 卷。
                                  </p>
                                </div>
                                <label class="block">
                                  <span class="input-label">挂载路径</span>
                                  <input v-model="mount.mountPath" class="input" placeholder="/etc/init" @focus="markFormSource" />
                                </label>
                                <label class="block">
                                  <span class="input-label">SubPath</span>
                                  <input v-model="mount.subPath" class="input" placeholder="可选" @focus="markFormSource" />
                                </label>
                                <label class="flex min-h-[42px] items-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-700 dark:border-dark-600 dark:text-dark-300">
                                  <input :checked="mount.readOnly" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" @change="updateVolumeMountReadOnly(mount, $event)" />
                                  只读挂载
                                </label>
                                <div class="flex items-end">
                                  <button class="btn btn-secondary btn-sm w-full" type="button" @click="removeInitVolumeMount(activeInitContainer, mount.id)">
                                    <Icon name="trash" size="sm" />
                                    移除
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                          <div v-else class="rounded-xl border border-gray-100 px-4 py-6 text-center text-sm text-gray-500 dark:border-dark-700 dark:text-dark-400">
                            当前 Init 容器还没有此类挂载。
                          </div>
                          <button class="btn btn-danger btn-sm" type="button" @click="addInitVolumeMount(activeInitContainer)">
                            <Icon name="plus" size="sm" />
                            添加 {{ mountPanels.find((panel) => panel.id === activeMountPanel)?.label }} 挂载
                          </button>
                        </div>
                      </div>
                    </div>

                    <div v-else class="flex flex-col gap-3 rounded-xl border border-dashed border-gray-200 bg-gray-50 p-3 dark:border-dark-700 dark:bg-dark-900/40 sm:flex-row sm:items-center sm:justify-between">
                      <span class="text-sm text-gray-500 dark:text-dark-400">当前未配置 Init 容器；需要初始化数据库、拉取配置或等待依赖时再添加。</span>
                      <button class="btn btn-danger btn-sm shrink-0 sm:ml-auto" type="button" @click="addInitContainer">
                        <Icon name="plus" size="sm" />
                        添加 Init 容器
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <section v-if="createDefinition.type === 'deployments' && activePodTemplatePanel === 'app' && showLegacyAppSections" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <div class="mb-4 space-y-3">
                  <button type="button" class="flex w-full items-start justify-between gap-3 text-left" @click="toggleSection('resources')">
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold text-gray-900 dark:text-white">资源限制</span>
                      <span class="block text-xs leading-5 text-gray-500 dark:text-dark-400">按 CPU 与内存分别配置 requests / limits，未填写的值不会写入 YAML。</span>
                    </span>
                    <Icon :name="isSectionCollapsed('resources') ? 'chevronDown' : 'chevronUp'" size="sm" class="mt-1 shrink-0 text-gray-400" />
                  </button>
                  <div v-if="!isSectionCollapsed('resources')" class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                    <button
                      v-for="panel in resourcePanels"
                      :key="panel.id"
                      type="button"
                      class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                      :class="segmentButtonClass(activeResourcePanel === panel.id)"
                      @click="setResourcePanel(panel.id)"
                    >
                      {{ panel.label }}
                    </button>
                  </div>
                </div>

                <div v-if="!isSectionCollapsed('resources')" class="grid gap-3 md:grid-cols-2">
                  <label v-for="field in resourceFieldGroups[activeResourcePanel]" :key="field.key" class="block">
                    <span class="input-label">{{ field.label }}</span>
                    <input
                      class="input"
                      :placeholder="field.placeholder"
                      :value="scalarValue(field.key)"
                      @input="updateTextField(field.key, $event)"
                    />
                    <span class="input-hint">{{ field.help }}</span>
                  </label>
                </div>
              </section>

              <section v-if="createDefinition.type === 'deployments' && activePodTemplatePanel === 'app' && showLegacyAppSections" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <div class="mb-4 space-y-3">
                  <button type="button" class="flex w-full items-start justify-between gap-3 text-left" @click="toggleSection('probes')">
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold text-gray-900 dark:text-white">健康检查</span>
                      <span class="block text-xs leading-5 text-gray-500 dark:text-dark-400">Readiness 控制是否接收流量，Liveness 控制容器是否需要重启，Startup 适合慢启动容器。</span>
                    </span>
                    <Icon :name="isSectionCollapsed('probes') ? 'chevronDown' : 'chevronUp'" size="sm" class="mt-1 shrink-0 text-gray-400" />
                  </button>
                  <div v-if="!isSectionCollapsed('probes')" class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                    <button
                      v-for="panel in probePanels"
                      :key="panel.id"
                      type="button"
                      class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                      :class="segmentButtonClass(activeProbePanel === panel.id)"
                      @click="setProbePanel(panel.id)"
                    >
                      {{ panel.label }}
                    </button>
                  </div>
                </div>

                <div v-if="!isSectionCollapsed('probes')" class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <label v-for="field in probeFieldGroups[activeProbePanel]" :key="field.key" class="block">
                    <span class="input-label">{{ field.label }}</span>
                    <input
                      v-if="field.type === 'text'"
                      class="input"
                      :placeholder="field.placeholder"
                      :value="scalarValue(field.key)"
                      @input="updateTextField(field.key, $event)"
                    />
                    <input
                      v-else
                      class="input"
                      :min="field.min"
                      type="number"
                      :value="numberValue(field.key)"
                      @input="updateNumberField(field.key, $event)"
                    />
                    <span class="input-hint">{{ field.help }}</span>
                  </label>
                </div>
              </section>

              <section v-if="createDefinition.type === 'deployments' && activePodTemplatePanel === 'app' && showLegacyAppSections" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <div class="mb-4 space-y-3">
                  <button type="button" class="flex w-full items-start justify-between gap-3 text-left" @click="toggleSection('mounts')">
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold text-gray-900 dark:text-white">挂载与配置</span>
                      <span class="block text-xs leading-5 text-gray-500 dark:text-dark-400">ConfigMap、Secret 和 emptyDir 均为可选项；挂载项只选择当前 Namespace 资源，需要新资源时从下方创建入口进入。</span>
                    </span>
                    <Icon :name="isSectionCollapsed('mounts') ? 'chevronDown' : 'chevronUp'" size="sm" class="mt-1 shrink-0 text-gray-400" />
                  </button>
                  <div v-if="!isSectionCollapsed('mounts')" class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                    <button
                      v-for="panel in mountPanels"
                      :key="panel.id"
                      type="button"
                      class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                      :class="segmentButtonClass(activeMountPanel === panel.id)"
                      @click="setMountPanel(panel.id)"
                    >
                      {{ panel.label }}
                    </button>
                  </div>
                </div>

                <div v-if="!isSectionCollapsed('mounts')" class="space-y-3">
                  <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                    {{ mountPanels.find((panel) => panel.id === activeMountPanel)?.help }}。未添加条目时不会写入 volumes / volumeMounts；从 YAML 回填的复杂挂载字段会尽量保留在原始结构中。
                  </div>

                  <div v-if="mountListByType(activeMountPanel).length" class="space-y-3">
                    <div
                      v-for="mount in mountListByType(activeMountPanel)"
                      :key="mount.id"
                      class="rounded-xl border border-gray-100 p-3 dark:border-dark-700"
                    >
                      <div class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)]">
                        <label class="block">
                          <span class="input-label">Volume 名称</span>
                          <input v-model="mount.name" class="input" placeholder="app-config" @focus="markFormSource" />
                        </label>
                        <div v-if="mount.type !== 'emptyDir'" class="block space-y-2">
                          <span class="input-label">{{ mountSourceLabel(mount.type) }}</span>
                          <Select
                            :model-value="sourceOptions(mount.type).some((option) => option.value === mount.sourceName) ? mount.sourceName : null"
                            :options="sourceOptions(mount.type)"
                            :placeholder="mount.sourceName || '请选择已有资源'"
                            searchable
                            @update:model-value="onMountSourceSelect(mount, $event)"
                          />
                          <p v-if="mount.sourceName && !sourceOptions(mount.type).some((option) => option.value === mount.sourceName)" class="text-xs leading-5 text-amber-600 dark:text-amber-400">
                            当前 YAML 引用了 {{ mount.sourceName }}，但示例资源列表中暂未返回该名称；请确认后端资源列表同步后再选择。
                          </p>
                        </div>
                        <label class="block">
                          <span class="input-label">挂载路径</span>
                          <input v-model="mount.mountPath" class="input" placeholder="/etc/config" @focus="markFormSource" />
                        </label>
                        <label class="block">
                          <span class="input-label">SubPath</span>
                          <input v-model="mount.subPath" class="input" placeholder="可选" @focus="markFormSource" />
                        </label>
                        <label class="flex min-h-[42px] items-center gap-2 rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-gray-700 dark:border-dark-600 dark:text-dark-300">
                          <input :checked="mount.readOnly" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500" @change="updateVolumeMountReadOnly(mount, $event)" />
                          只读挂载
                        </label>
                        <div class="flex items-end">
                          <button class="btn btn-secondary btn-sm w-full" type="button" @click="removeVolumeMount(mount.id)">
                            <Icon name="trash" size="sm" />
                            移除
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div v-else class="rounded-xl border border-gray-100 px-4 py-6 text-center text-sm text-gray-500 dark:border-dark-700 dark:text-dark-400">
                    当前分类还没有挂载项。
                  </div>

                  <button class="btn btn-danger btn-sm" type="button" @click="addVolumeMount()">
                    <Icon name="plus" size="sm" />
                    添加 {{ mountPanels.find((panel) => panel.id === activeMountPanel)?.label }} 挂载
                  </button>
                  <button v-if="activeMountPanel !== 'emptyDir'" class="btn btn-danger btn-sm" type="button" @click="openRelatedConfigResource(activeMountPanel)">
                    <Icon name="plus" size="sm" />
                    创建 {{ mountCreateLabel(activeMountPanel) }}
                  </button>
                </div>
              </section>

              <section v-if="createDefinition.type === 'deployments' && activePodTemplatePanel === 'app' && showLegacyAppSections" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <div class="mb-4 space-y-3">
                  <button type="button" class="flex w-full items-start justify-between gap-3 text-left" @click="toggleSection('lifecycle')">
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold text-gray-900 dark:text-white">生命周期钩子</span>
                      <span class="block text-xs leading-5 text-gray-500 dark:text-dark-400">配置容器 PostStart / PreStop 钩子；支持 exec 命令或 HTTP GET，默认不生成。</span>
                    </span>
                    <Icon :name="isSectionCollapsed('lifecycle') ? 'chevronDown' : 'chevronUp'" size="sm" class="mt-1 shrink-0 text-gray-400" />
                  </button>
                  <div v-if="!isSectionCollapsed('lifecycle')" class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                    <button
                      v-for="panel in lifecyclePanels"
                      :key="panel.id"
                      type="button"
                      class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                      :class="segmentButtonClass(activeLifecyclePanel === panel.id)"
                      @click="setLifecyclePanel(panel.id)"
                    >
                      {{ panel.label }}
                    </button>
                  </div>
                </div>

                <div v-if="!isSectionCollapsed('lifecycle')" class="space-y-3">
                  <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                    {{ lifecyclePanels.find((panel) => panel.id === activeLifecyclePanel)?.help }} 多命令用逗号分隔，例如 `/bin/sh, -c, echo started`。
                  </div>
                  <div v-if="lifecycleList(activeLifecyclePanel).length" class="space-y-3">
                    <div v-for="hook in lifecycleList(activeLifecyclePanel)" :key="hook.id" class="rounded-xl border border-gray-100 p-3 dark:border-dark-700">
                      <div class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-[160px_minmax(0,1fr)_120px_auto]">
                        <label class="block">
                          <span class="input-label">处理方式</span>
                          <Select v-model="hook.handlerType" :options="[{ label: 'Exec', value: 'exec' }, { label: 'HTTP GET', value: 'httpGet' }]" />
                        </label>
                        <label v-if="hook.handlerType === 'exec'" class="block xl:col-span-2">
                          <span class="input-label">命令</span>
                          <input v-model="hook.command" class="input" placeholder="/bin/sh, -c, echo started" @focus="markFormSource" />
                        </label>
                        <label v-if="hook.handlerType === 'httpGet'" class="block">
                          <span class="input-label">路径</span>
                          <input v-model="hook.path" class="input" placeholder="/hook" @focus="markFormSource" />
                        </label>
                        <label v-if="hook.handlerType === 'httpGet'" class="block">
                          <span class="input-label">端口</span>
                          <input v-model.number="hook.port" class="input" min="1" type="number" @focus="markFormSource" />
                        </label>
                        <div class="flex items-end">
                          <button class="btn btn-secondary btn-sm w-full" type="button" @click="removeLifecycleHook(hook.id)">
                            <Icon name="trash" size="sm" />
                            移除
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-else class="rounded-xl border border-gray-100 px-4 py-6 text-center text-sm text-gray-500 dark:border-dark-700 dark:text-dark-400">
                    当前钩子未启用。
                  </div>
                  <button class="btn btn-secondary btn-sm" type="button" @click="ensureLifecycleHook(activeLifecyclePanel)">
                    <Icon name="plus" size="sm" />
                    添加 {{ lifecyclePanels.find((panel) => panel.id === activeLifecyclePanel)?.label }}
                  </button>
                </div>
              </section>

              <section v-if="usesPodSpecCreateForm" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <div class="mb-4 space-y-3">
                  <button type="button" class="flex w-full items-start justify-between gap-3 text-left" @click="toggleSection('pod-security')">
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold text-gray-900 dark:text-white">Pod 安全</span>
                      <span class="block text-xs leading-5 text-gray-500 dark:text-dark-400">ServiceAccount、imagePullSecrets 与 Pod securityContext 按 Kubernetes Pod spec 归属配置。</span>
                    </span>
                    <Icon :name="isSectionCollapsed('pod-security') ? 'chevronDown' : 'chevronUp'" size="sm" class="mt-1 shrink-0 text-gray-400" />
                  </button>
                  <div v-if="!isSectionCollapsed('pod-security')" class="inline-flex w-full flex-wrap rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 lg:w-fit">
                    <button
                      v-for="panel in podSecurityPanels"
                      :key="panel.id"
                      type="button"
                      class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all lg:flex-none"
                      :class="segmentButtonClass(activePodSecurityPanel === panel.id)"
                      @click="setPodSecurityPanel(panel.id)"
                    >
                      {{ panel.label }}
                    </button>
                  </div>
                </div>

                <div v-if="!isSectionCollapsed('pod-security')" class="space-y-3">
                  <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                    {{ podSecurityPanels.find((panel) => panel.id === activePodSecurityPanel)?.help }}
                  </div>
                  <div v-if="activePodSecurityPanel === 'identity'" class="grid gap-3 md:grid-cols-2">
                    <label class="block">
                      <span class="input-label">ServiceAccount</span>
                      <input class="input" :value="createForm.serviceAccountName" placeholder="default" @input="updateTextField('serviceAccountName', $event)" />
                    </label>
                    <label class="block">
                      <span class="input-label">自动挂载 Token</span>
                      <Select
                        :model-value="createForm.automountServiceAccountToken"
                        :options="[{ label: '默认', value: '' }, { label: '开启', value: 'true' }, { label: '关闭', value: 'false' }]"
                        @update:model-value="updateScalarField('automountServiceAccountToken', $event)"
                      />
                      <span class="input-hint">默认不写入 YAML，由集群和 ServiceAccount 默认值决定。</span>
                    </label>
                    <div class="block md:col-span-2">
                      <span class="input-label">镜像拉取密钥</span>
                      <div class="space-y-2">
                        <div class="relative">
                          <button
                            type="button"
                            class="flex w-full items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-left text-sm text-gray-900 transition hover:border-gray-300 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/30 dark:border-dark-600 dark:bg-dark-800 dark:text-gray-100 dark:hover:border-dark-500"
                            :aria-expanded="imagePullSecretDropdownOpen"
                            @click="imagePullSecretDropdownOpen = !imagePullSecretDropdownOpen"
                          >
                            <span class="min-w-0 flex-1 truncate">{{ imagePullSecretTriggerText }}</span>
                            <Icon name="chevronDown" size="md" :class="['shrink-0 text-gray-400 transition-transform duration-200', imagePullSecretDropdownOpen && 'rotate-180']" />
                          </button>
                          <div
                            v-if="imagePullSecretDropdownOpen"
                            class="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-gray-200 bg-white py-1 shadow-lg shadow-black/10 dark:border-dark-700 dark:bg-dark-800 dark:shadow-black/30"
                          >
                            <button
                              v-for="option in imagePullSecretOptions"
                              :key="option.value"
                              type="button"
                              class="flex w-full min-w-0 items-center gap-3 px-4 py-2.5 text-left text-sm text-gray-700 transition hover:bg-gray-50 dark:text-dark-200 dark:hover:bg-dark-700"
                              @click="toggleImagePullSecret(option.value)"
                            >
                              <span
                                :class="[
                                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                                  isImagePullSecretSelected(option.value)
                                    ? 'border-primary-500 bg-primary-500 text-white'
                                    : 'border-gray-300 bg-white dark:border-dark-500 dark:bg-dark-800'
                                ]"
                              >
                                <Icon v-if="isImagePullSecretSelected(option.value)" name="check" size="xs" />
                              </span>
                              <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
                              <span
                                v-if="option.secretType"
                                class="shrink-0 rounded-lg bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-dark-700 dark:text-dark-300"
                              >
                                {{ option.secretType }}
                              </span>
                            </button>
                            <div v-if="!imagePullSecretOptions.length" class="px-4 py-6 text-center text-sm text-gray-500 dark:text-dark-400">
                              当前 Namespace 暂无镜像仓库认证 Secret。
                            </div>
                          </div>
                        </div>
                        <div class="flex flex-wrap items-center gap-2">
                          <button class="btn btn-danger btn-sm" type="button" @click="openRelatedConfigResource('secret', undefined, 'image-pull-secret')">
                            <Icon name="plus" size="sm" />
                            新建 Secret 并选中
                          </button>
                          <button v-if="imagePullSecretNames().length" class="btn btn-secondary btn-sm" type="button" @click="clearImagePullSecrets">
                            <Icon name="xCircle" size="sm" />
                            清空
                          </button>
                          <span v-if="imagePullSecretNames().length" class="text-xs text-gray-500 dark:text-dark-400">
                            已选择：{{ imagePullSecretNames().join(', ') }}
                          </span>
                          <span v-else class="text-xs text-gray-500 dark:text-dark-400">
                            未选择时不写入 imagePullSecrets。
                          </span>
                        </div>
                      </div>
                      <span class="input-hint">从当前 Namespace 的镜像仓库认证 Secret 中选择；普通容器和 Init 容器共享，多选后自动写入 imagePullSecrets。</span>
                    </div>
                  </div>
                  <div v-else-if="activePodSecurityPanel === 'pod'" class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <label class="block">
                      <span class="input-label">runAsUser</span>
                      <input class="input" min="0" type="number" :value="createForm.runAsUser ?? ''" placeholder="默认" @input="updateNullableNumberFormField('runAsUser', $event)" />
                    </label>
                    <label class="block">
                      <span class="input-label">runAsGroup</span>
                      <input class="input" min="0" type="number" :value="createForm.runAsGroup ?? ''" placeholder="默认" @input="updateNullableNumberFormField('runAsGroup', $event)" />
                    </label>
                    <label class="block">
                      <span class="input-label">fsGroup</span>
                      <input class="input" min="0" type="number" :value="createForm.fsGroup ?? ''" placeholder="默认" @input="updateNullableNumberFormField('fsGroup', $event)" />
                    </label>
                    <label class="block">
                      <span class="input-label">runAsNonRoot</span>
                      <Select :model-value="createForm.runAsNonRoot" :options="[{ label: '默认', value: '' }, { label: '开启', value: 'true' }, { label: '关闭', value: 'false' }]" @update:model-value="updateScalarField('runAsNonRoot', $event)" />
                    </label>
                    <label class="block">
                      <span class="input-label">seccompProfile</span>
                      <Select :model-value="createForm.seccompProfileType" :options="[{ label: '默认', value: '' }, { label: 'RuntimeDefault', value: 'RuntimeDefault' }, { label: 'Localhost', value: 'Localhost' }, { label: 'Unconfined', value: 'Unconfined' }]" @update:model-value="updateScalarField('seccompProfileType', $event)" />
                    </label>
                    <label class="block">
                      <span class="input-label">localhostProfile</span>
                      <input class="input" :value="createForm.seccompLocalhostProfile" placeholder="profiles/audit.json" :disabled="createForm.seccompProfileType !== 'Localhost'" @input="updateTextField('seccompLocalhostProfile', $event)" />
                    </label>
                  </div>
                </div>
              </section>

              <section v-if="usesPodSpecCreateForm" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <div class="mb-4 space-y-3">
                  <button type="button" class="flex w-full items-start justify-between gap-3 text-left" @click="toggleSection('pod-network')">
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold text-gray-900 dark:text-white">Pod 网络</span>
                      <span class="block text-xs leading-5 text-gray-500 dark:text-dark-400">hostNetwork、dnsPolicy 和 dnsConfig 都属于 Pod 级网络配置，普通容器和 Init 容器共享。</span>
                    </span>
                    <Icon :name="isSectionCollapsed('pod-network') ? 'chevronDown' : 'chevronUp'" size="sm" class="mt-1 shrink-0 text-gray-400" />
                  </button>
                </div>

                <div v-if="!isSectionCollapsed('pod-network')" class="space-y-4">
                  <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                    默认不写入网络字段，沿用集群默认 DNS 策略；启用宿主机网络时通常配合 ClusterFirstWithHostNet，自定义 DNS 时通常选择 None 并填写 dnsConfig。
                  </div>
                  <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <label class="block">
                      <span class="input-label">宿主机网络 hostNetwork</span>
                      <Select
                        :model-value="createForm.hostNetwork"
                        :options="[{ label: '默认', value: '' }, { label: '开启', value: 'true' }, { label: '关闭', value: 'false' }]"
                        @update:model-value="updateScalarField('hostNetwork', $event)"
                      />
                      <span class="input-hint">开启后 Pod 使用节点网络命名空间；需要谨慎处理端口冲突和 DNS 策略。</span>
                    </label>
                    <label class="block">
                      <span class="input-label">DNS 策略 dnsPolicy</span>
                      <Select
                        :model-value="createForm.dnsPolicy"
                        :options="[
                          { label: '默认', value: '' },
                          { label: 'ClusterFirst', value: 'ClusterFirst' },
                          { label: 'Default', value: 'Default' },
                          { label: 'ClusterFirstWithHostNet', value: 'ClusterFirstWithHostNet' },
                          { label: 'None', value: 'None' }
                        ]"
                        @update:model-value="updateScalarField('dnsPolicy', $event)"
                      />
                      <span class="input-hint">ClusterFirst 是集群内服务默认策略；hostNetwork 场景常用 ClusterFirstWithHostNet。</span>
                    </label>
                    <label class="block">
                      <span class="input-label">DNS 服务器 nameservers</span>
                      <input class="input" :value="createForm.dnsNameservers" placeholder="10.96.0.10, 8.8.8.8" @input="updateTextField('dnsNameservers', $event)" />
                      <span class="input-hint">逗号分隔，写入 dnsConfig.nameservers。</span>
                    </label>
                    <label class="block md:col-span-2">
                      <span class="input-label">DNS 搜索域 searches</span>
                      <input class="input" :value="createForm.dnsSearches" placeholder="svc.cluster.local, cluster.local" @input="updateTextField('dnsSearches', $event)" />
                      <span class="input-hint">逗号分隔，写入 dnsConfig.searches。</span>
                    </label>
                  </div>
                  <div class="space-y-2">
                    <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                      <span class="input-label">DNS 选项 options</span>
                      <span class="text-xs text-gray-400 dark:text-dark-500">例如 ndots=5，写入 dnsConfig.options。</span>
                    </div>
                    <div v-for="option in createForm.dnsOptions" :key="option.id" class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto]">
                      <input v-model="option.key" class="input" placeholder="选项名称，例如 ndots" @focus="markFormSource" />
                      <input v-model="option.value" class="input" placeholder="选项值，例如 5" @focus="markFormSource" />
                      <button class="btn btn-secondary btn-sm" type="button" @click="removePair('dnsOptions', option.id)">
                        <Icon name="trash" size="sm" />
                      </button>
                    </div>
                    <button class="btn btn-danger btn-sm" type="button" @click="addPair('dnsOptions')">
                      <Icon name="plus" size="sm" />
                      添加 DNS 选项
                    </button>
                  </div>
                </div>
              </section>

              <section v-if="usesPodSpecCreateForm" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <div class="mb-4 space-y-3">
                  <button type="button" class="flex w-full items-start justify-between gap-3 text-left" @click="toggleSection('pod-storage')">
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold text-gray-900 dark:text-white">Pod 存储卷</span>
                      <span class="block text-xs leading-5 text-gray-500 dark:text-dark-400">只定义 {{ createDefinition.type === 'pods' ? 'Pod' : 'Pod 模板' }} volumes；挂载路径在普通容器 / Init 容器的“挂载”页签中配置。</span>
                    </span>
                    <Icon :name="isSectionCollapsed('pod-storage') ? 'chevronDown' : 'chevronUp'" size="sm" class="mt-1 shrink-0 text-gray-400" />
                  </button>
                  <div v-if="!isSectionCollapsed('pod-storage')" class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
                    <button
                      v-for="panel in mountPanels"
                      :key="panel.id"
                      type="button"
                      class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all sm:flex-none"
                      :class="segmentButtonClass(activeMountPanel === panel.id)"
                      @click="setMountPanel(panel.id)"
                    >
                      {{ panel.label }}
                    </button>
                  </div>
                </div>

                <div v-if="!isSectionCollapsed('pod-storage')" class="space-y-3">
                  <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                    {{ mountPanels.find((panel) => panel.id === activeMountPanel)?.help }}。未添加条目时不会写入 volumes；同一个 volume 可被多个普通容器或 Init 容器分别挂载到不同路径。
                  </div>

                  <div v-if="podVolumeListByType(activeMountPanel).length" class="space-y-3">
                    <div v-for="volume in podVolumeListByType(activeMountPanel)" :key="volume.id" class="rounded-xl border border-gray-100 p-3 dark:border-dark-700">
                      <div class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)_minmax(0,1fr)]">
                        <label class="block">
                          <span class="input-label">Volume 名称</span>
                          <input v-model="volume.name" class="input" placeholder="app-data" @focus="markFormSource" />
                        </label>
                        <div v-if="volume.type !== 'emptyDir'" class="block space-y-2">
                          <span class="input-label">{{ mountSourceLabel(volume.type) }}</span>
                          <Select
                            :model-value="sourceOptions(volume.type).some((option) => option.value === volume.sourceName) ? volume.sourceName : null"
                            :options="sourceOptions(volume.type)"
                            :placeholder="volume.sourceName || '请选择已有资源'"
                            searchable
                            @update:model-value="onPodVolumeSourceSelect(volume, $event)"
                          />
                        </div>
                        <div v-else class="rounded-xl border border-gray-100 px-4 py-2.5 text-sm text-gray-500 dark:border-dark-700 dark:text-dark-400">
                          emptyDir 不需要选择外部资源。
                        </div>
                        <div class="rounded-xl border border-gray-100 px-4 py-2.5 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:text-dark-400">
                          <span class="font-semibold text-gray-700 dark:text-dark-200">使用情况：</span>
                          <template v-if="podVolumeUsage(volume).length">
                            <span v-for="usage in podVolumeUsage(volume)" :key="usage.id" class="mr-2 inline-flex rounded-lg bg-gray-100 px-2 py-1 dark:bg-dark-800">
                              {{ usage.label }} -> {{ usage.path }}
                            </span>
                          </template>
                          <span v-else>尚未挂载到容器。</span>
                        </div>
                        <div class="flex items-end gap-2">
                          <button class="btn btn-secondary btn-sm w-full" type="button" @click="removePodVolume(volume.id)">
                            <Icon name="trash" size="sm" />
                            移除
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div v-else class="rounded-xl border border-gray-100 px-4 py-6 text-center text-sm text-gray-500 dark:border-dark-700 dark:text-dark-400">
                    当前分类还没有 Pod 存储卷。
                  </div>

                  <button class="btn btn-danger btn-sm" type="button" @click="addPodVolume()">
                    <Icon name="plus" size="sm" />
                    添加 {{ mountPanels.find((panel) => panel.id === activeMountPanel)?.label }} 卷
                  </button>
                  <button v-if="activeMountPanel !== 'emptyDir'" class="btn btn-danger btn-sm" type="button" @click="openRelatedConfigResource(activeMountPanel, undefined, 'pod-volume')">
                    <Icon name="plus" size="sm" />
                    新建 {{ mountCreateLabel(activeMountPanel) }} 并选中
                  </button>
                </div>
              </section>

              <section v-if="usesPodSpecCreateForm" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <div class="mb-4 space-y-3">
                  <button type="button" class="flex w-full items-start justify-between gap-3 text-left" @click="toggleSection('pod-scheduling')">
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold text-gray-900 dark:text-white">Pod 调度</span>
                      <span class="block text-xs leading-5 text-gray-500 dark:text-dark-400">按 Pod 亲和与反亲和控制当前 Pod 与其他 Pod 在节点、可用区等拓扑域内的分布关系。</span>
                    </span>
                    <Icon :name="isSectionCollapsed('pod-scheduling') ? 'chevronDown' : 'chevronUp'" size="sm" class="mt-1 shrink-0 text-gray-400" />
                  </button>
                  <div v-if="!isSectionCollapsed('pod-scheduling')" class="inline-flex w-full flex-wrap rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 lg:w-fit">
                    <button
                      v-for="panel in podSchedulePanels"
                      :key="panel.id"
                      type="button"
                      class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all lg:flex-none"
                      :class="segmentButtonClass(activePodSchedulePanel === panel.id)"
                      @click="setPodSchedulePanel(panel.id)"
                    >
                      {{ panel.label }}
                    </button>
                  </div>
                </div>

                <div v-if="!isSectionCollapsed('pod-scheduling')" class="space-y-3">
                  <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                    {{ podSchedulePanels.find((panel) => panel.id === activePodSchedulePanel)?.help }} 当前表单生成 requiredDuringSchedulingIgnoredDuringExecution 规则。
                  </div>

                  <div v-if="activePodSchedulePanel === 'affinity'" class="space-y-3">
                    <div class="grid min-w-0 gap-2 rounded-xl bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-500 dark:bg-dark-900/50 dark:text-dark-400 sm:grid-cols-2">
                      <span>拓扑域键</span>
                      <span>目标 Pod 标签键</span>
                      <span>匹配方式</span>
                      <span>标签值</span>
                    </div>
                    <div v-for="item in affinityList('podAffinity')" :key="item.id" class="space-y-2 rounded-xl border border-gray-100 p-2 dark:border-dark-700">
                      <div class="grid min-w-0 gap-2 sm:grid-cols-2">
                        <input v-model="item.topologyKey" class="input" placeholder="例如 kubernetes.io/hostname" @focus="markFormSource" />
                        <input v-model="item.labelKey" class="input" placeholder="例如 app.kubernetes.io/name" @focus="markFormSource" />
                        <Select v-model="item.operator" :options="[{ label: '属于 In', value: 'In' }, { label: '不属于 NotIn', value: 'NotIn' }, { label: '存在 Exists', value: 'Exists' }, { label: '不存在 DoesNotExist', value: 'DoesNotExist' }]" />
                        <input v-model="item.values" class="input" placeholder="多个值用逗号分隔" :disabled="['Exists', 'DoesNotExist'].includes(item.operator)" @focus="markFormSource" />
                      </div>
                      <div class="flex justify-end">
                        <button class="btn btn-secondary btn-sm" type="button" @click="removePodAffinity('podAffinity', item.id)">
                          <Icon name="trash" size="sm" />
                        </button>
                      </div>
                    </div>
                    <button class="btn btn-danger btn-sm w-fit" type="button" @click="addPodAffinity('podAffinity')">
                      <Icon name="plus" size="sm" />
                      添加 Pod 亲和规则
                    </button>
                  </div>

                  <div v-else class="space-y-3">
                    <div class="grid min-w-0 gap-2 rounded-xl bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-500 dark:bg-dark-900/50 dark:text-dark-400 sm:grid-cols-2">
                      <span>拓扑域键</span>
                      <span>避开的 Pod 标签键</span>
                      <span>匹配方式</span>
                      <span>标签值</span>
                    </div>
                    <div v-for="item in affinityList('podAntiAffinity')" :key="item.id" class="space-y-2 rounded-xl border border-gray-100 p-2 dark:border-dark-700">
                      <div class="grid min-w-0 gap-2 sm:grid-cols-2">
                        <input v-model="item.topologyKey" class="input" placeholder="例如 kubernetes.io/hostname" @focus="markFormSource" />
                        <input v-model="item.labelKey" class="input" placeholder="例如 app.kubernetes.io/name" @focus="markFormSource" />
                        <Select v-model="item.operator" :options="[{ label: '属于 In', value: 'In' }, { label: '不属于 NotIn', value: 'NotIn' }, { label: '存在 Exists', value: 'Exists' }, { label: '不存在 DoesNotExist', value: 'DoesNotExist' }]" />
                        <input v-model="item.values" class="input" placeholder="多个值用逗号分隔" :disabled="['Exists', 'DoesNotExist'].includes(item.operator)" @focus="markFormSource" />
                      </div>
                      <div class="flex justify-end">
                        <button class="btn btn-secondary btn-sm" type="button" @click="removePodAffinity('podAntiAffinity', item.id)">
                          <Icon name="trash" size="sm" />
                        </button>
                      </div>
                    </div>
                    <button class="btn btn-danger btn-sm w-fit" type="button" @click="addPodAffinity('podAntiAffinity')">
                      <Icon name="plus" size="sm" />
                      添加 Pod 反亲和规则
                    </button>
                  </div>
                </div>
              </section>

              <section v-if="usesPodSpecCreateForm" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
                <div class="mb-4 space-y-3">
                  <button type="button" class="flex w-full items-start justify-between gap-3 text-left" @click="toggleSection('node-scheduling')">
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold text-gray-900 dark:text-white">节点调度</span>
                      <span class="block text-xs leading-5 text-gray-500 dark:text-dark-400">按节点标签选择、节点亲和和污点容忍控制 Pod 可调度到哪些 Node。</span>
                    </span>
                    <Icon :name="isSectionCollapsed('node-scheduling') ? 'chevronDown' : 'chevronUp'" size="sm" class="mt-1 shrink-0 text-gray-400" />
                  </button>
                  <div v-if="!isSectionCollapsed('node-scheduling')" class="inline-flex w-full flex-wrap rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 lg:w-fit">
                    <button
                      v-for="panel in nodeSchedulePanels"
                      :key="panel.id"
                      type="button"
                      class="flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold transition-all lg:flex-none"
                      :class="segmentButtonClass(activeNodeSchedulePanel === panel.id)"
                      @click="setNodeSchedulePanel(panel.id)"
                    >
                      {{ panel.label }}
                    </button>
                  </div>
                </div>

                <div v-if="!isSectionCollapsed('node-scheduling')" class="space-y-3">
                  <div class="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-500 dark:border-dark-700 dark:bg-dark-900/40 dark:text-dark-400">
                    {{ nodeSchedulePanels.find((panel) => panel.id === activeNodeSchedulePanel)?.help }}
                  </div>

                  <div v-if="activeNodeSchedulePanel === 'selector'" class="space-y-3">
                    <div class="grid min-w-0 gap-2 rounded-xl bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-500 dark:bg-dark-900/50 dark:text-dark-400 sm:grid-cols-2">
                      <span>节点标签键</span>
                      <span>节点标签值</span>
                    </div>
                    <div v-for="pair in createForm.nodeSelector" :key="pair.id" class="space-y-2 rounded-xl border border-gray-100 p-2 dark:border-dark-700">
                      <div class="grid min-w-0 gap-2 sm:grid-cols-2">
                        <input v-model="pair.key" class="input" placeholder="例如 topology.kubernetes.io/zone" @focus="markFormSource" />
                        <input v-model="pair.value" class="input" placeholder="例如 cn-hangzhou-a" @focus="markFormSource" />
                      </div>
                      <div class="flex justify-end">
                        <button class="btn btn-secondary btn-sm" type="button" @click="removePair('nodeSelector', pair.id)">
                          <Icon name="trash" size="sm" />
                        </button>
                      </div>
                    </div>
                    <div v-if="!createForm.nodeSelector.length" class="rounded-xl border border-gray-100 px-4 py-5 text-center text-sm text-gray-500 dark:border-dark-700 dark:text-dark-400">
                      未配置节点标签选择；为空时不写入 nodeSelector。
                    </div>
                    <button class="btn btn-danger btn-sm w-fit" type="button" @click="addPair('nodeSelector')">
                      <Icon name="plus" size="sm" />
                      添加节点标签条件
                    </button>
                  </div>

                  <div v-else-if="activeNodeSchedulePanel === 'affinity'" class="space-y-3">
                    <div class="grid min-w-0 gap-2 rounded-xl bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-500 dark:bg-dark-900/50 dark:text-dark-400 sm:grid-cols-2">
                      <span>节点标签键</span>
                      <span>匹配方式</span>
                      <span>标签值</span>
                    </div>
                    <div v-for="item in createForm.nodeAffinity" :key="item.id" class="space-y-2 rounded-xl border border-gray-100 p-2 dark:border-dark-700">
                      <div class="grid min-w-0 gap-2 sm:grid-cols-2">
                        <input v-model="item.key" class="input" placeholder="例如 kubernetes.io/os" @focus="markFormSource" />
                        <Select v-model="item.operator" :options="[{ label: '属于 In', value: 'In' }, { label: '不属于 NotIn', value: 'NotIn' }, { label: '存在 Exists', value: 'Exists' }, { label: '不存在 DoesNotExist', value: 'DoesNotExist' }]" />
                        <input v-model="item.values" class="input" placeholder="多个值用逗号分隔，例如 linux, windows" :disabled="['Exists', 'DoesNotExist'].includes(item.operator)" @focus="markFormSource" />
                      </div>
                      <div class="flex justify-end">
                        <button class="btn btn-secondary btn-sm" type="button" @click="removeNodeAffinity(item.id)">
                          <Icon name="trash" size="sm" />
                        </button>
                      </div>
                    </div>
                    <div v-if="!createForm.nodeAffinity.length" class="rounded-xl border border-gray-100 px-4 py-5 text-center text-sm text-gray-500 dark:border-dark-700 dark:text-dark-400">
                      未配置节点亲和；为空时不写入 nodeAffinity。
                    </div>
                    <button class="btn btn-danger btn-sm w-fit" type="button" @click="addNodeAffinity">
                      <Icon name="plus" size="sm" />
                      添加节点亲和条件
                    </button>
                  </div>

                  <div v-else class="space-y-3">
                    <div class="grid min-w-0 gap-2 rounded-xl bg-gray-50 px-3 py-2 text-xs font-semibold text-gray-500 dark:bg-dark-900/50 dark:text-dark-400 sm:grid-cols-2">
                      <span>污点键</span>
                      <span>匹配方式</span>
                      <span>污点值</span>
                      <span>污点效果</span>
                      <span>容忍秒数</span>
                    </div>
                    <div v-for="item in createForm.tolerations" :key="item.id" class="space-y-2 rounded-xl border border-gray-100 p-2 dark:border-dark-700">
                      <div class="grid min-w-0 gap-2 sm:grid-cols-2">
                        <input v-model="item.key" class="input" placeholder="例如 node.kubernetes.io/not-ready" @focus="markFormSource" />
                        <Select v-model="item.operator" :options="[{ label: '等于 Equal', value: 'Equal' }, { label: '存在 Exists', value: 'Exists' }]" />
                        <input v-model="item.value" class="input" placeholder="污点值" :disabled="item.operator === 'Exists'" @focus="markFormSource" />
                        <Select v-model="item.effect" :options="[{ label: '不限制', value: '' }, { label: 'NoSchedule', value: 'NoSchedule' }, { label: 'PreferNoSchedule', value: 'PreferNoSchedule' }, { label: 'NoExecute', value: 'NoExecute' }]" />
                        <input v-model.number="item.tolerationSeconds" class="input" min="0" type="number" placeholder="秒" :disabled="item.effect !== 'NoExecute'" @focus="markFormSource" />
                      </div>
                      <div class="flex justify-end">
                        <button class="btn btn-secondary btn-sm" type="button" @click="removeToleration(item.id)">
                          <Icon name="trash" size="sm" />
                        </button>
                      </div>
                    </div>
                    <div v-if="!createForm.tolerations.length" class="rounded-xl border border-gray-100 px-4 py-5 text-center text-sm text-gray-500 dark:border-dark-700 dark:text-dark-400">
                      未配置污点容忍；为空时不写入 tolerations。
                    </div>
                    <button class="btn btn-danger btn-sm w-fit" type="button" @click="addToleration">
                      <Icon name="plus" size="sm" />
                      添加污点容忍
                    </button>
                  </div>
                </div>
              </section>
            </div>

            <div class="min-w-0 space-y-3">
              <div v-if="createDefinition.type === 'deployments'" class="space-y-3 rounded-xl border border-gray-100 p-3 dark:border-dark-700">
                <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <span class="input-label">YAML 模板</span>
                    <p class="text-xs text-gray-500 dark:text-dark-400">选择常用模板后会回填表单并重新生成 YAML。</p>
                  </div>
                  <Select
                    :model-value="activeYamlTemplate"
                    :options="yamlTemplates.map((template) => ({ label: template.label, value: template.id }))"
                    @update:model-value="applyYamlTemplate"
                  />
                </div>
                <p class="text-xs leading-5 text-gray-500 dark:text-dark-400">
                  模板用于快速填充最小起始字段，不会锁定名称；切换模板会同步替换对应镜像。
                </p>
              </div>

              <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="input-label mb-0">YAML</span>
                  <span class="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-300">
                    当前：{{ createMode === 'form' ? '表单模式' : 'YAML 模式' }}
                  </span>
                  <span class="rounded-full border px-3 py-1 text-xs font-medium" :class="validationStatusClass(yamlSyntaxStatus().status)">
                    {{ yamlSyntaxStatus().text }}
                  </span>
                </div>
                <div class="inline-flex w-fit items-center gap-1 rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:ml-auto">
                  <span class="px-1.5 text-xs font-medium text-gray-500 dark:text-dark-400">字号</span>
                  <button
                    v-for="size in [12, 13, 14, 16]"
                    :key="size"
                    type="button"
                    class="rounded-lg px-2 py-1 text-xs font-semibold transition-all"
                    :class="segmentButtonClass(yamlFontSize === size)"
                    @click="yamlFontSize = size"
                  >
                    {{ size }}
                  </button>
                </div>
              </div>
              <div v-if="yamlValidationItems.some((item) => item.status === 'warning' || item.status === 'error')" class="flex flex-wrap gap-2">
                <span
                  v-for="item in yamlValidationItems.filter((item) => item.status === 'warning' || item.status === 'error')"
                  :key="item.text"
                  class="rounded-full border px-3 py-1 text-xs font-medium"
                  :class="validationStatusClass(item.status)"
                >
                  {{ item.text }}
                </span>
              </div>
              <div class="yaml-editor-shell">
                <pre
                  class="yaml-highlight-layer"
                  :style="{ fontSize: `${yamlFontSize}px` }"
                  v-html="highlightedYaml"
                ></pre>
                <textarea
                  ref="yamlTextareaRef"
                  class="yaml-editor-input"
                  :style="{ fontSize: `${yamlFontSize}px` }"
                  :value="formState.yaml"
                  spellcheck="false"
                  @input="onYamlInput"
                ></textarea>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="space-y-4">
          <div v-if="editMode === 'create' && !hasCreateSchema" class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
            当前资源暂未配置表单 schema，先使用 YAML 创建；后续可以按同一机制扩展到此资源。
          </div>
          <div v-if="formErrors.length" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
            <p v-for="error in formErrors" :key="error">{{ error }}</p>
          </div>
          <label class="block">
            <span class="input-label">名称</span>
            <input v-model="formState.name" class="input" :disabled="editMode === 'edit'" placeholder="resource-name" />
          </label>
          <label v-if="createDefinition.namespaced" class="block">
            <span class="input-label">Namespace</span>
            <input v-model="formState.namespace" class="input" placeholder="default" />
          </label>
          <div class="space-y-2">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span class="input-label mb-0">YAML</span>
              <div class="inline-flex w-fit items-center gap-1 rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:ml-auto">
                <span class="px-1.5 text-xs font-medium text-gray-500 dark:text-dark-400">字号</span>
                <button
                  v-for="size in [12, 13, 14, 16]"
                  :key="size"
                  type="button"
                  class="rounded-lg px-2 py-1 text-xs font-semibold transition-all"
                  :class="segmentButtonClass(yamlFontSize === size)"
                  @click="yamlFontSize = size"
                >
                  {{ size }}
                </button>
              </div>
            </div>
            <textarea
              :value="formState.yaml"
              class="input min-h-80 font-mono leading-6"
              :style="{ fontSize: `${yamlFontSize}px` }"
              spellcheck="false"
              @input="onRawYamlInput"
            ></textarea>
          </div>
          <p v-if="yamlParseError" class="text-sm text-red-600 dark:text-red-300">{{ yamlParseError }}</p>
        </div>

        <div class="flex justify-end gap-2">
          <button class="btn btn-secondary" type="button" @click="closeEditDialog">取消</button>
          <button class="btn btn-primary" type="submit">提交</button>
        </div>
      </form>
    </BaseDialog>

    <BaseDialog
      :show="relatedDialogOpen"
      :title="`创建 ${relatedDefinition.title}`"
      width="wide"
      :z-index="60"
      @close="closeRelatedDialog"
    >
      <form class="space-y-4" @submit.prevent="submitRelatedForm">
        <div class="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-700 dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-300">
          在当前 {{ createDefinition.title }} 表单上叠加创建 {{ relatedDefinition.title }}；取消会回到原表单，创建成功后会自动选中到{{ relatedFillTargetText }}。
        </div>

        <div class="flex flex-col gap-3 rounded-xl border border-gray-200 p-3 dark:border-dark-700 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p class="text-sm font-semibold text-gray-900 dark:text-white">{{ relatedCreateSchema?.title }}</p>
            <p class="text-xs leading-5 text-gray-500 dark:text-dark-400">{{ relatedCreateSchema?.summary }}</p>
          </div>
          <div class="inline-flex w-full rounded-xl border border-gray-200 bg-gray-100 p-1 dark:border-dark-700 dark:bg-dark-900 sm:w-fit">
            <button
              type="button"
              class="flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition-all sm:flex-none"
              :class="segmentButtonClass(relatedCreateMode === 'form')"
              @click="setRelatedCreateMode('form')"
            >
              表单创建
            </button>
            <button
              type="button"
              class="flex-1 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-semibold transition-all sm:flex-none"
              :class="segmentButtonClass(relatedCreateMode === 'yaml')"
              @click="setRelatedCreateMode('yaml')"
            >
              YAML 编辑
            </button>
          </div>
        </div>

        <div v-if="relatedFormErrors.length" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          <p v-for="error in relatedFormErrors" :key="error">{{ error }}</p>
        </div>

        <div class="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(360px,1.05fr)]">
          <div class="space-y-4">
            <section v-for="section in relatedCreateSchema?.sections" :key="section.title" class="rounded-xl border border-gray-100 p-4 dark:border-dark-700">
              <h3 class="mb-4 text-sm font-semibold text-gray-900 dark:text-white">{{ section.title }}</h3>
              <div class="space-y-4">
                <div v-for="field in section.fields" :key="field.key" class="space-y-2">
                  <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <span class="input-label">
                      {{ field.label }}
                      <span v-if="field.required" class="text-red-500">*</span>
                    </span>
                    <span v-if="field.help" class="text-xs text-gray-400 dark:text-dark-500">{{ field.help }}</span>
                  </div>

                  <input
                    v-if="field.type === 'text'"
                    class="input"
                    :placeholder="field.placeholder"
                    :value="relatedScalarValue(field.key)"
                    @input="updateRelatedTextField(field.key, $event)"
                  />

                  <Select
                    v-else-if="field.type === 'select'"
                    :model-value="relatedScalarValue(field.key)"
                    :options="fieldOptions(field)"
                    @update:model-value="updateRelatedScalarField(field.key, $event)"
                  />

                  <div v-else-if="field.type === 'keyValue' || field.type === 'configData' || field.type === 'secretData'" class="space-y-2">
                    <div v-for="pair in relatedPairList(field.key)" :key="pair.id" class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto]">
                      <input v-model="pair.key" class="input" placeholder="key" />
                      <input
                        v-model="pair.value"
                        class="input"
                        :type="field.type === 'secretData' ? 'password' : 'text'"
                        placeholder="value"
                      />
                      <button class="btn btn-secondary btn-sm" type="button" @click="removeRelatedPair(field.key, pair.id)">
                        <Icon name="trash" size="sm" />
                      </button>
                    </div>
                    <button class="btn btn-secondary btn-sm" type="button" @click="addRelatedPair(field.key)">
                      <Icon name="plus" size="sm" />
                      添加
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <div class="space-y-3">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <span class="input-label">YAML</span>
                <span class="text-xs" :class="relatedYamlParseError ? 'text-red-500' : 'text-gray-400 dark:text-dark-500'">
                  {{ relatedYamlParseError || (relatedCreateMode === 'form' ? '随表单实时生成' : 'YAML 变更会尝试回填表单') }}
                </span>
              </div>
            </div>
            <textarea
              class="input min-h-[420px] resize-y font-mono leading-6"
              :style="{ fontSize: `${yamlFontSize}px` }"
              :value="relatedFormState.yaml"
              spellcheck="false"
              @input="onRelatedYamlInput"
            ></textarea>
          </div>
        </div>

        <div class="flex justify-end gap-2">
          <button class="btn btn-secondary" type="button" @click="closeRelatedDialog">取消</button>
          <button class="btn btn-primary" type="submit">创建并选中</button>
        </div>
      </form>
    </BaseDialog>

    <BaseDialog :show="actionDialogOpen" :title="workloadActionDialogTitle" width="normal" @close="actionDialogOpen = false">
      <div class="space-y-4">
        <label v-if="actionForm.action === 'scale'" class="block">
          <span class="input-label">目标副本数</span>
          <input v-model.number="actionForm.replicas" class="input" min="0" type="number" />
        </label>
        <label v-if="actionForm.action === 'update-image'" class="block">
          <span class="input-label">目标镜像</span>
          <input v-model="actionForm.image" class="input" placeholder="registry.example/app:v1.2.3" />
        </label>
        <label v-if="actionForm.action === 'rollback'" class="block">
          <span class="input-label">回滚目标</span>
          <input v-model="actionForm.rollbackRevision" class="input" placeholder="previous 或 revision id" />
        </label>
        <p class="text-sm leading-6 text-gray-600 dark:text-dark-300">{{ workloadActionConfirmText }}</p>
      </div>
      <template #footer>
        <button class="btn btn-secondary" type="button" @click="actionDialogOpen = false">取消</button>
        <button class="btn btn-danger" type="button" @click="confirmWorkloadAction">确认执行</button>
      </template>
    </BaseDialog>

    <BaseDialog :show="Boolean(pendingConfirm)" :title="pendingConfirm?.title || '确认操作'" width="normal" @close="pendingConfirm = null">
      <p class="text-sm leading-6 text-gray-600 dark:text-dark-300">{{ pendingConfirm?.message }}</p>
      <template #footer>
        <button class="btn btn-secondary" type="button" @click="pendingConfirm = null">取消</button>
        <button class="btn btn-danger" type="button" @click="confirmHighRisk">确认执行</button>
      </template>
    </BaseDialog>

    <BaseDialog :show="logsDialogOpen" title="Pod 日志" width="wide" @close="logsDialogOpen = false">
      <pre class="console-block max-h-[560px] whitespace-pre-wrap">{{ logsText }}</pre>
    </BaseDialog>

    <BaseDialog :show="terminalDialogOpen" title="Pod 终端" width="wide" @close="terminalDialogOpen = false">
      <div class="space-y-4">
        <div class="grid gap-3 md:grid-cols-2">
          <label class="block">
            <span class="input-label">容器</span>
            <select v-model="terminalContainerName" class="input">
              <option v-for="option in podTerminalContainerOptions(selectedResource)" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
          <label class="block">
            <span class="input-label">进入命令</span>
            <select v-model="terminalCommandPreset" class="input">
              <option v-for="option in terminalCommandOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
        </div>
        <label v-if="terminalCommandPreset === 'custom'" class="block">
          <span class="input-label">自定义命令</span>
          <input v-model="terminalCustomCommand" class="input font-mono" placeholder="/bin/sh" />
        </label>
        <pre class="console-block whitespace-pre-wrap">$ kubectl exec -it {{ selectedResource?.name }} -n {{ selectedResource?.namespace || 'default' }} -c {{ terminalContainerName || '-' }} -- {{ terminalCommand }}</pre>
        <p v-if="terminalSessionMessage" class="text-sm text-gray-600 dark:text-dark-300">{{ terminalSessionMessage }}</p>
      </div>
      <template #footer>
        <button class="btn btn-secondary" type="button" @click="terminalDialogOpen = false">关闭</button>
        <button class="btn btn-primary" type="button" :disabled="!terminalContainerName" @click="connectTerminal">连接终端</button>
      </template>
    </BaseDialog>

    <BaseDialog :show="secretDialogOpen" title="Secret 明文" width="normal" @close="closeSecretDialog">
      <div class="space-y-3">
        <p class="text-sm text-amber-600 dark:text-amber-400">关闭弹窗后会清空当前明文状态，页面不会长期保存 Secret 内容。</p>
        <div v-for="[key, value] in Object.entries(secretPlaintext)" :key="key" class="rounded-xl border border-gray-100 p-3 dark:border-dark-700">
          <p class="text-xs text-gray-500 dark:text-dark-400">{{ key }}</p>
          <p class="mt-1 break-all font-mono text-sm text-gray-900 dark:text-white">{{ value }}</p>
        </div>
      </div>
    </BaseDialog>
  </div>
</template>

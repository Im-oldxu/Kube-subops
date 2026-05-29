import { parse, parseAllDocuments, stringify } from 'yaml'
import type { ParsedYamlResult } from './types'

export function stringifyKubeObject(value: Record<string, unknown>) {
  return stringify(value, {
    indent: 2,
    lineWidth: 120,
    singleQuote: false
  }).trimEnd()
}

export function stringifyKubeObjects(values: Record<string, unknown>[]) {
  return values.map((value) => stringifyKubeObject(value)).join('\n---\n')
}

export function parseKubeYaml(value: string): ParsedYamlResult {
  try {
    const parsed = parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'YAML 必须是一个 Kubernetes 对象。' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'YAML 解析失败。'
    }
  }
}

export function parseKubeYamlDocuments(value: string): ParsedYamlResult {
  try {
    const documents = parseAllDocuments(value)
    const errors = documents.flatMap((document) => document.errors)
    if (errors.length) {
      return { ok: false, error: errors[0]?.message || 'YAML 解析失败。' }
    }

    const values = documents
      .map((document) => document.toJSON())
      .filter((document): document is Record<string, unknown> => Boolean(document))

    if (!values.length) {
      return { ok: false, error: 'YAML 必须至少包含一个 Kubernetes 对象。' }
    }

    const invalidDocumentIndex = values.findIndex((document) => !document || typeof document !== 'object' || Array.isArray(document))
    if (invalidDocumentIndex >= 0) {
      return { ok: false, error: `第 ${invalidDocumentIndex + 1} 个 YAML 文档必须是一个 Kubernetes 对象。` }
    }

    return { ok: true, value: values[0], values }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'YAML 解析失败。'
    }
  }
}

export function readPath(value: unknown, path: Array<string | number>) {
  return path.reduce<unknown>((current, key) => {
    if (current === null || current === undefined) return undefined
    if (typeof key === 'number') return Array.isArray(current) ? current[key] : undefined
    if (typeof current === 'object' && key in current) return (current as Record<string, unknown>)[key]
    return undefined
  }, value)
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function stringRecordToPairs(record: Record<string, unknown>) {
  return Object.entries(record).map(([key, value], index) => ({
    id: `${key}-${index}`,
    key,
    value: value === undefined || value === null ? '' : String(value)
  }))
}

export function pairsToRecord(pairs: Array<{ key: string; value: string }>) {
  return Object.fromEntries(
    pairs
      .map((pair) => [pair.key.trim(), pair.value] as const)
      .filter(([key]) => key)
  )
}

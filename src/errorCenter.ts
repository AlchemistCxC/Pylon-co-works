/**
 * errorCenter — 运行错误聚合存储（模块级 + useSyncExternalStore）。
 *
 * reportRuntimeError 产生的错误统一收口为可回溯列表（带时间戳、可单个关闭/全部清除），
 * 替代"只显示最新一条"的单 banner。容量上限 50，超出丢弃最旧。
 */

import { useSyncExternalStore } from 'react'
import type { RuntimeErrorDetail } from './runtimeError'

export interface ErrorEntry extends RuntimeErrorDetail {
  id: number
  at: number
  /** 报告 8.3：同指纹（action+message）出现次数/首次/最后时间——去重聚合 */
  count: number
  firstAt: number
  lastAt: number
}

const MAX_ERRORS = 50
let nextId = 1
let errors: ErrorEntry[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function fingerprint(detail: { action: string; message: string }): string {
  return `${detail.action}:${detail.message}`
}

export function addError(detail: RuntimeErrorDetail): void {
  const now = Date.now()
  const existing = errors.find(entry => fingerprint(entry) === fingerprint(detail))
  if (existing) {
    errors = errors.map(entry => entry === existing
      ? { ...entry, count: entry.count + 1, lastAt: now, at: now }
      : entry)
    emit()
    return
  }
  errors = [{ id: nextId++, at: now, count: 1, firstAt: now, lastAt: now, ...detail }, ...errors].slice(0, MAX_ERRORS)
  emit()
}

export function clearErrors(): void {
  errors = []
  emit()
}

export function dismissError(id: number): void {
  errors = errors.filter(entry => entry.id !== id)
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getErrors(): readonly ErrorEntry[] {
  return errors
}

export function useErrors(): readonly ErrorEntry[] {
  return useSyncExternalStore(subscribe, getErrors)
}

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
}

const MAX_ERRORS = 50
let nextId = 1
let errors: ErrorEntry[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function addError(detail: RuntimeErrorDetail): void {
  errors = [{ id: nextId++, at: Date.now(), ...detail }, ...errors].slice(0, MAX_ERRORS)
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

function getErrors(): readonly ErrorEntry[] {
  return errors
}

export function useErrors(): readonly ErrorEntry[] {
  return useSyncExternalStore(subscribe, getErrors)
}

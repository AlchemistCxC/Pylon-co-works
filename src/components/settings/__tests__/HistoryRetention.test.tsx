// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import HistoryRetention from '../HistoryRetention'
import { RETENTION_STORAGE_KEY, readRetentionPolicy } from '../historyRetentionPolicy'

function choose(label: string, option: string) {
  fireEvent.click(screen.getByRole('combobox', { name: label }))
  fireEvent.mouseDown(screen.getByRole('option', { name: option }))
}

describe('HistoryRetention 设置组件', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('默认显示永久保存且无影响提示', () => {
    render(<HistoryRetention />)
    expect(screen.getByRole('combobox', { name: '保留策略' })).toHaveTextContent('永久保存')
    expect(screen.queryByText(/预计影响/)).toBeNull()
  })

  it('切换按时间保留显示天数档位与影响提示（D-15 必须显示预计影响）', () => {
    render(<HistoryRetention />)
    choose('保留策略', '按时间保留')
    expect(screen.getByLabelText('保留天数')).toBeTruthy()
    const impact = screen.getByText(/预计影响/).textContent ?? ''
    expect(impact).toContain('30 天')
    expect(impact).toContain('立即删除')
  })

  it('切换按数量保留显示条数档位与影响提示', () => {
    render(<HistoryRetention />)
    choose('保留策略', '按每个 Session 事件数量保留')
    expect(screen.getByLabelText('每会话保留事件数')).toBeTruthy()
    expect(screen.getByText(/预计影响/).textContent).toContain('1000 条')
  })

  it('切回永久保存隐藏档位与影响提示', () => {
    render(<HistoryRetention />)
    choose('保留策略', '按时间保留')
    expect(screen.getByText(/预计影响/)).toBeTruthy()
    choose('保留策略', '永久保存')
    expect(screen.queryByText(/预计影响/)).toBeNull()
    expect(screen.queryByLabelText('保留天数')).toBeNull()
  })

  it('选择策略只写入保留策略 key，不触发任何删除路径（D-03 只写策略）', () => {
    render(<HistoryRetention />)
    choose('保留策略', '按时间保留')
    const raw = localStorage.getItem(RETENTION_STORAGE_KEY)
    expect(raw).not.toBeNull()
    // 持久化的是策略本身（含模式与档位），且回读为合法策略
    expect(readRetentionPolicy(localStorage)).toEqual({ mode: 'by_time', days: 30 })
    // 无任何删除类 key/副作用写入：本次交互唯一的持久化副作用是策略 key
    const storedKeys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
    expect(storedKeys).toEqual([RETENTION_STORAGE_KEY])
  })

  it('修改天数档位后影响提示同步更新并持久化', () => {
    render(<HistoryRetention />)
    choose('保留策略', '按时间保留')
    choose('保留天数', '90 天')
    expect(screen.getByText(/预计影响/).textContent).toContain('90 天')
    expect(readRetentionPolicy(localStorage)).toEqual({ mode: 'by_time', days: 90 })
  })

  it('修改条数档位后影响提示同步更新并持久化', () => {
    render(<HistoryRetention />)
    choose('保留策略', '按每个 Session 事件数量保留')
    choose('每会话保留事件数', '5000 条')
    expect(screen.getByText(/预计影响/).textContent).toContain('5000 条')
    expect(readRetentionPolicy(localStorage)).toEqual({ mode: 'by_count', count: 5000 })
  })
})

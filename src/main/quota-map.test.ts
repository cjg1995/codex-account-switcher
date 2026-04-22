import { describe, expect, it } from 'vitest'
import { mapRateLimitsToSnapshot, mapTokenCountRateLimitsToSnapshot, mapUsagePayloadToSnapshot } from './quota-map'

describe('mapRateLimitsToSnapshot', () => {
  it('优先 rateLimitsByLimitId.codex', () => {
    const snap = mapRateLimitsToSnapshot(
      {
        rateLimits: { limitId: 'legacy', primary: { usedPercent: 1, resetsAt: 100 } },
        rateLimitsByLimitId: {
          codex: { limitId: 'codex', primary: { usedPercent: 50, resetsAt: 200 }, secondary: null }
        }
      },
      'plus',
      null
    )
    expect(snap?.limitId).toBe('codex')
    expect(snap?.primary?.usedPercent).toBe(50)
    expect(snap?.planType).toBe('plus')
    expect(snap?.buckets?.length).toBe(1)
  })

  it('无 codex 键时回退 rateLimits', () => {
    const snap = mapRateLimitsToSnapshot(
      {
        rateLimits: { limitId: 'x', primary: { usedPercent: 3, resetsAt: 9 } }
      },
      null,
      { hasCredits: true, balance: 10 }
    )
    expect(snap?.limitId).toBe('x')
    expect(snap?.credits?.balance).toBe(10)
    expect(snap?.buckets?.length).toBe(1)
  })

  it('多 limitId 合并为 buckets 并按窗口时长排序，主展示优先短窗口', () => {
    const snap = mapRateLimitsToSnapshot(
      {
        rateLimitsByLimitId: {
          week: {
            limitId: 'week',
            primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 3000 },
            secondary: null
          },
          fiveh: {
            limitId: 'fiveh',
            primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2000 },
            secondary: null
          }
        }
      },
      'free',
      null
    )
    expect(snap?.buckets?.length).toBe(2)
    expect(snap?.buckets?.[0].displayLabel).toBe('5 小时')
    expect(snap?.buckets?.[1].displayLabel).toBe('1 周')
    expect(snap?.limitId).toBe('fiveh')
  })

  it('从 credits._codexmanager_extra_rate_limits 合并额外窗口', () => {
    const snap = mapRateLimitsToSnapshot(
      {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 2000 },
          credits: {
            _codexmanager_extra_rate_limits: [
              {
                source_key: 'code_review_rate_limit',
                limit_id: 'code_review_rate_limit',
                limit_name: 'Code Review',
                primary_window: {
                  used_percent: 30,
                  limit_window_seconds: 86400,
                  reset_at: 3000
                }
              }
            ]
          }
        }
      },
      'plus',
      null
    )
    expect(snap?.buckets?.length).toBe(2)
    const extra = snap?.buckets?.find((b) => b.limitId === 'code_review_rate_limit')
    expect(extra?.displayLabel).toContain('24 小时')
    expect(extra?.primary?.windowDurationMins).toBe(1440)
  })

  it('支持从 wham/usage 原始响应构建快照', () => {
    const snap = mapUsagePayloadToSnapshot(
      {
        plan_type: 'plus',
        rate_limit: {
          primary_window: {
            used_percent: 32,
            limit_window_seconds: 18000,
            reset_at: 1000
          },
          secondary_window: {
            used_percent: 53,
            limit_window_seconds: 604800,
            reset_at: 2000
          }
        },
        code_review_rate_limit: {
          limit_id: 'code_review_rate_limit',
          limit_name: 'Code Review',
          primary_window: {
            used_percent: 0,
            limit_window_seconds: 604800,
            reset_at: 3000
          }
        },
        credits: {
          has_credits: false,
          unlimited: false,
          balance: '0'
        }
      },
      null,
      null
    )

    expect(snap?.planType).toBe('plus')
    expect(snap?.primary?.windowDurationMins).toBe(300)
    expect(snap?.secondary?.windowDurationMins).toBe(10080)
    expect(snap?.buckets?.some((b) => b.limitId === 'code_review_rate_limit')).toBe(true)
  })

  it('支持 usedPercent 为 0~1 小数的场景', () => {
    const snap = mapRateLimitsToSnapshot(
      {
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 0.72, windowDurationMins: 300, resetsAt: 1000 }
        }
      },
      'plus',
      null
    )
    expect(snap?.primary?.usedPercent).toBe(72)
  })

  it('usedPercent 等于 1 时按 1% 处理，不按 100% 处理', () => {
    const snap = mapTokenCountRateLimitsToSnapshot(
      {
        limit_id: 'codex',
        primary: {
          used_percent: 1,
          window_minutes: 10080,
          resets_at: 1000
        },
        plan_type: 'free'
      },
      null,
      null
    )
    expect(snap?.primary?.usedPercent).toBe(1)
  })

  it('支持从 token_count.rate_limits 构建快照', () => {
    const snap = mapTokenCountRateLimitsToSnapshot(
      {
        limit_id: 'codex',
        limit_name: null,
        primary: {
          used_percent: 5,
          window_minutes: 300,
          resets_at: 1000
        },
        secondary: {
          used_percent: 60,
          window_minutes: 10080,
          resets_at: 2000
        },
        plan_type: 'plus',
        credits: {
          has_credits: false,
          unlimited: false,
          balance: 0
        }
      },
      null,
      null
    )

    expect(snap?.planType).toBe('plus')
    expect(snap?.primary?.windowDurationMins).toBe(300)
    expect(snap?.secondary?.windowDurationMins).toBe(10080)
    expect(snap?.primary?.usedPercent).toBe(5)
    expect(snap?.credits?.balance).toBe(0)
  })
})

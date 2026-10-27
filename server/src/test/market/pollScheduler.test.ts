/**
 * 온디맨드 시세 폴링 스케줄러 검증
 *
 *   실행: cd server && npx ts-node src/test/market/pollScheduler.test.ts
 *
 * 왜 검증하는가 — 이전 구현은 구독 종목마다 setInterval(1초)을 걸었다. 상세 페이지처럼
 * 1종목일 때는 문제가 없었지만, 목록 화면이 30종목을 구독하면 그대로 30 req/s 가 되어
 * KIS 한도 20 req/s 를 넘는다. 같은 앱키를 SmartPoller(지정가 체결)와 실거래 주문이
 * 함께 쓰므로 이 초과는 주문 실패로 이어진다. 그래서 '종목당 주기'가 아니라 '전체 호출
 * 속도'를 상한으로 두었고, 그 상한이 실제로 지켜지는지를 여기서 확인한다.
 */

import { decidePollTick, type PollTickDecision } from '../../services/market/KisRealtime'

const RATE_PER_SEC = 10
const TICK_MS = 1000 / RATE_PER_SEC   // 100ms
const MIN_CODE_INTERVAL_MS = 1000

let pass = 0
let fail = 0

const check = (label: string, ok: boolean, detail = ''): void => {
    if (ok) { pass++; console.log(`  ✔ ${label}${detail ? `  (${detail})` : ''}`) }
    else { fail++; console.log(`  ✘ ${label}${detail ? `  (${detail})` : ''}`) }
}

/** 틱 루프를 시뮬레이션한다. 실제 타이머·네트워크 없이 결정만 돌린다. */
interface SimResult {
    polls: { code: string; at: number }[]
    stopped: string | null
    ticks: number
}

const simulate = (opts: {
    codes: string[]
    durationMs: number
    open?: boolean
    pending?: string[]
    closedAt?: number | null
    startAt?: number
}): SimResult => {
    const { codes, durationMs } = opts
    const open = opts.open ?? true
    const pending = [...(opts.pending ?? codes)]   // 기본: 전부 첫 조회 대기
    const lastPolled = new Map<string, number>()
    const polls: SimResult['polls'] = []
    let stopped: string | null = null
    let ticks = 0

    const start = opts.startAt ?? 1_000_000
    for (let now = start; now < start + durationMs; now += TICK_MS) {
        ticks++
        const d: PollTickDecision = decidePollTick({
            codes, lastPolled, pending, now, open,
            closedAt: opts.closedAt ?? (open ? null : start),
            minCodeIntervalMs: MIN_CODE_INTERVAL_MS,
        })
        if (d.action === 'stop') { stopped = d.reason; break }
        if (d.action === 'idle') continue
        if (d.pendingIndex !== null) pending.splice(d.pendingIndex, 1)
        lastPolled.set(d.code, now)
        polls.push({ code: d.code, at: now })
    }
    return { polls, stopped, ticks }
}

const codesOf = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => String(100000 + i))

console.log('\n[검증] 온디맨드 시세 폴링 스케줄러')

// ─── 1) 호출 속도 상한 ────────────────────────────────────────
console.log('\n- 전체 호출 속도 상한 (KIS 한도 20 req/s 의 절반)')
for (const n of [1, 5, 30, 100, 300]) {
    const dur = 10_000
    const r = simulate({ codes: codesOf(n), durationMs: dur })
    const rate = r.polls.length / (dur / 1000)
    check(`구독 ${String(n).padStart(3)}종목 → ${rate.toFixed(1)} req/s`, rate <= RATE_PER_SEC + 0.01,
        `상한 ${RATE_PER_SEC}`)
}
{
    // 틱당 최대 1건이므로 어떤 1초 구간을 잘라도 RATE_PER_SEC 를 넘을 수 없다
    const r = simulate({ codes: codesOf(50), durationMs: 20_000 })
    let worst = 0
    for (const p of r.polls) {
        const inWindow = r.polls.filter((q) => q.at >= p.at && q.at < p.at + 1000).length
        if (inWindow > worst) worst = inWindow
    }
    check('슬라이딩 1초 창 최대 호출 수', worst <= RATE_PER_SEC, `${worst}건`)
}

// ─── 2) 종목별 최소 간격 ──────────────────────────────────────
console.log('\n- 종목별 최소 조회 간격')
for (const n of [1, 3, 30]) {
    const r = simulate({ codes: codesOf(n), durationMs: 10_000 })
    const byCode = new Map<string, number[]>()
    for (const p of r.polls) {
        const arr = byCode.get(p.code) ?? []
        arr.push(p.at)
        byCode.set(p.code, arr)
    }
    let minGap = Infinity
    for (const times of byCode.values()) {
        for (let i = 1; i < times.length; i++) minGap = Math.min(minGap, times[i] - times[i - 1])
    }
    check(`구독 ${n}종목 → 같은 종목 재조회 최소 간격 ${minGap === Infinity ? '-' : minGap + 'ms'}`,
        minGap === Infinity || minGap >= MIN_CODE_INTERVAL_MS, `하한 ${MIN_CODE_INTERVAL_MS}ms`)
}

// ─── 3) 공평성 (굶는 종목 없음) ───────────────────────────────
console.log('\n- 공평성')
{
    const n = 30
    const dur = 30_000
    const r = simulate({ codes: codesOf(n), durationMs: dur })
    const counts = codesOf(n).map((c) => r.polls.filter((p) => p.code === c).length)
    const min = Math.min(...counts)
    const max = Math.max(...counts)
    check('모든 구독 종목이 조회됨 (굶는 종목 0)', min > 0, `최소 ${min}회 / 최대 ${max}회`)
    check('종목 간 조회 횟수 편차 1회 이내', max - min <= 1, `편차 ${max - min}`)
    const cycle = dur / min
    check('30종목의 갱신 주기', cycle <= 3500, `약 ${(cycle / 1000).toFixed(1)}초`)
}
{
    const r = simulate({ codes: codesOf(1), durationMs: 10_000 })
    const cycle = 10_000 / r.polls.length
    check('1종목(상세 페이지) 갱신 주기', cycle <= 1100, `약 ${(cycle / 1000).toFixed(1)}초`)
}

// ─── 4) 첫 조회 우선 처리 ─────────────────────────────────────
console.log('\n- 신규 구독의 첫 조회')
{
    // 이미 돌고 있던 20종목 + 새로 구독한 1종목
    const codes = [...codesOf(20), '999999']
    const lastPolled = new Map<string, number>(codesOf(20).map((c) => [c, 1_000_000]))
    const d = decidePollTick({
        codes, lastPolled, pending: ['999999'], now: 1_000_050,
        open: true, closedAt: null, minCodeIntervalMs: MIN_CODE_INTERVAL_MS,
    })
    check('대기 중 다른 종목보다 신규 구독을 먼저 조회',
        d.action === 'poll' && d.code === '999999' && d.pendingIndex === 0,
        d.action === 'poll' ? d.code : d.action)

    // 구독이 해제된 코드가 큐에 남아 있으면 건너뛴다
    const d2 = decidePollTick({
        codes: codesOf(2), lastPolled: new Map(), pending: ['해제된코드', '100001'],
        now: 1_000_000, open: true, closedAt: null, minCodeIntervalMs: MIN_CODE_INTERVAL_MS,
    })
    check('해제된 코드는 큐에서 건너뜀',
        d2.action === 'poll' && d2.code === '100001' && d2.pendingIndex === 1,
        d2.action === 'poll' ? `${d2.code}/${d2.pendingIndex}` : d2.action)
}

// ─── 5) 구독 0건 / 장 외 ──────────────────────────────────────
console.log('\n- 종료 조건')
{
    const d = decidePollTick({
        codes: [], lastPolled: new Map(), pending: [], now: 1, open: true,
        closedAt: null, minCodeIntervalMs: MIN_CODE_INTERVAL_MS,
    })
    check('구독 0건 → 타이머 중지', d.action === 'stop' && d.reason === 'no-subscribers')

    // 장 외: 구독 종목마다 '마지막 종가' 1회만 받고 중지
    const codes = codesOf(5)
    const r = simulate({ codes, durationMs: 10_000, open: false, pending: [] })
    const once = codes.every((c) => r.polls.filter((p) => p.code === c).length === 1)
    check('장 외 전환 → 종목당 정확히 1회 수집', once && r.polls.length === 5, `${r.polls.length}건`)
    check('수집이 끝나면 타이머 중지', r.stopped === 'closed-sweep-done', String(r.stopped))
    check('장 외 수집도 한 틱에 1건씩 (속도 상한 준수)',
        r.polls.every((p, i) => i === 0 || p.at - r.polls[i - 1].at >= TICK_MS))

    // 장 외 전환 전에 이미 조회된 종목은 다시 받지 않는다
    const lastPolled = new Map<string, number>([['100000', 2_000_500]])
    const d3 = decidePollTick({
        codes: ['100000'], lastPolled, pending: [], now: 2_000_600,
        open: false, closedAt: 2_000_000, minCodeIntervalMs: MIN_CODE_INTERVAL_MS,
    })
    check('장 외 전환 이후 조회된 종목은 재수집 안 함',
        d3.action === 'stop' && d3.reason === 'closed-sweep-done', d3.action)
}

// ─── 6) 대조군: 수정 전 방식 ──────────────────────────────────
console.log('\n- [대조군] 수정 전 방식 (종목당 setInterval 1초)')
for (const n of [30, 100]) {
    const oldRate = n / (MIN_CODE_INTERVAL_MS / 1000)   // 종목당 1초 → n req/s
    check(`구독 ${n}종목이면 ${oldRate} req/s — KIS 한도 20 초과`, oldRate > 20,
        `수정 후 ${RATE_PER_SEC} req/s`)
}

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)

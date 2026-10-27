import cron from 'node-cron'
import fs from 'fs'
import path from 'path'
import {
    fetchForeignAndInstitutional,
    upsertForeignAndInstitutional,
    getActiveStocks,
    getAllLastDates,
    getTradingDays,
    KisApiError,
    dayAfter,
    getToday,
} from '../../services/market/ForeignAndInstitutional'
import { dataPath } from '../../utils/dataDir'
import { runInitialCollect } from '../../utils/initialCollect'

// ─────────────────────────────────────────────────────────────
// 투자자별 매매동향 수집 (기관·외국인·개인·금융투자·연기금 순매수)
//
// KIS FHPTJ04160001 은 기준일로부터 과거 "30거래일"을 한 묶음으로 준다. 그래서
// 30거래일보다 긴 구간을 메우려면 기준일을 뒤로 옮겨가며 여러 번 호출해야 한다.
// (예전 구현은 기준일을 항상 오늘로 고정하고 응답을 startDate 로 걸러내기만 해서,
//  2026-05-15~07-07 처럼 창 밖으로 밀려난 구간이 영구히 비어 있었다.)
//
// 또 이 TR 은 당일치를 장 마감(15:40) 이후에만 준다. 그 전에 오늘을 기준일로 주면
// rt_cd=2 "TIME LIMIT 00:00 ~ 15:40" 이 오고 한 건도 안 내려온다. 예전에는 이걸
// 빈 배열로 삼켜서, 오전에 서버를 재시작하면 3,590종목을 93분 돌고도 아무것도
// 적재되지 않았다. 지금은 오류로 올려 즉시 중단한다.
//
// 실행
//   일일 수집 : 서버 기동 시 등록(평일 16:30 KST)
//   과거 백필 : npx ts-node src/schedulers/market/ForeignAndInstitutional.ts --from=20260512
// ─────────────────────────────────────────────────────────────

// 볼륨에 둔다 — 4.8시간짜리 백필이라 재시작으로 진행상황이 날아가면 처음부터 다시다
const PROGRESS_PATH = dataPath('cache', 'foreignBackfillProgress.json')

/** 종목당 호출 간격(ms). 1,200ms 에서 EGW00201(초당 거래건수 초과)이 확인돼 여유를 뒀다. */
const DEFAULT_DELAY_MS = 1600
const MAX_RETRY = 4

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 유량 초과(EGW00201)만 지수 백오프로 재시도한다.
 * TIME LIMIT 은 기다려도 안 풀리므로 그대로 올린다.
 */
async function fetchWithRetry(code: string, baseDate: string, minDate?: string): Promise<any[]> {
    let wait = 2000
    for (let attempt = 1; ; attempt++) {
        try {
            return await fetchForeignAndInstitutional(code, baseDate, minDate)
        } catch (err) {
            const isRate = err instanceof KisApiError && err.isRateLimit
            if (!isRate || attempt > MAX_RETRY) throw err
            console.warn(`[ForeignAndInstitutional] ${code} 유량 초과 — ${wait}ms 후 재시도(${attempt}/${MAX_RETRY})`)
            await sleep(wait)
            wait *= 2
        }
    }
}

/**
 * 기준일 목록 — 한 번에 30거래일이 오고, 이는 달력으로 42~44일에 해당한다(실측).
 * 창 크기를 40일로 보수적으로 잡고 38일씩 뒤로 물러 2~6일씩 겹치게 한다.
 *
 * 종료 조건은 "기준일이 시작점 이전"이 아니라 "기준일의 창이 시작점을 덮음"이다.
 * 전자로 하면 창이 이미 시작점을 지난 뒤에도 기준일을 하나 더 만들어, 그 호출은
 * 전부 minDate 에 걸러져 버려진다(종목당 1회 = 3,590회 낭비).
 */
const WINDOW_DAYS = 40
const STEP_DAYS = 38

export function buildBaseDates(from: string, to: string): string[] {
    const toDate = (s: string) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`)
    const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '')
    const DAY = 24 * 60 * 60 * 1000

    const start = toDate(from)
    const dates: string[] = []
    let cur = toDate(to)
    for (;;) {
        dates.push(fmt(cur))
        if (cur.getTime() - WINDOW_DAYS * DAY <= start.getTime()) break
        cur = new Date(cur.getTime() - STEP_DAYS * DAY)
    }
    return dates.reverse()
}

interface Progress {
    from: string
    to: string
    done: number[]
}

function loadProgress(from: string, to: string): Set<number> {
    try {
        const p: Progress = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'))
        if (p.from === from && p.to === to) return new Set(p.done)
    } catch {}
    return new Set()
}

function saveProgress(from: string, to: string, done: Set<number>): void {
    try {
        fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true })
        fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ from, to, done: [...done] }), 'utf-8')
    } catch {}
}

// ─── 일일 수집 ────────────────────────────────────────────────

export const collectForeignAndInstitutional = async (): Promise<void> => {
    console.log('[ForeignAndInstitutional] 수집 시작')

    const [stocks, lastDates] = await Promise.all([getActiveStocks(), getAllLastDates()])
    const today = getToday()

    let updated = 0
    let skipped = 0

    for (const stock of stocks) {
        try {
            const lastDate = lastDates.get(stock.id)
            const startDate = lastDate ? dayAfter(lastDate) : undefined
            if (startDate && startDate > today) {
                skipped++
                continue
            }

            const rows = await fetchWithRetry(stock.code, today, startDate)
            if (rows.length > 0) {
                await upsertForeignAndInstitutional(stock.id, rows)
                updated++
            }

            await sleep(DEFAULT_DELAY_MS)
        } catch (err) {
            // 장 마감 전이면 전 종목이 같은 결과다 — 93분을 헛돌지 않고 즉시 멈춘다
            if (err instanceof KisApiError && err.isTimeLimit) {
                console.error('[ForeignAndInstitutional] 장 마감(15:40) 전이라 당일 데이터를 받을 수 없습니다 — 수집 중단')
                return
            }
            console.error(`[ForeignAndInstitutional] 오류 - ${stock.code}:`, (err as any)?.message ?? err)
        }
    }

    console.log(`[ForeignAndInstitutional] 수집 완료 — 갱신 ${updated}건 / 스킵 ${skipped}건`)
}

// ─── 과거 백필 ────────────────────────────────────────────────

export const backfillForeignAndInstitutional = async (
    from: string,
    to: string,
    delayMs = DEFAULT_DELAY_MS,
    limit = 0,
): Promise<void> => {
    const baseDates = buildBaseDates(from, to)
    const all = await getActiveStocks()
    // limit 은 스모크 테스트용 — 몇 종목만 돌려 동작을 확인한 뒤 전체를 건다
    const stocks = limit > 0 ? all.slice(0, limit) : all
    const done = limit > 0 ? new Set<number>() : loadProgress(from, to)

    const totalCalls = (stocks.length - done.size) * baseDates.length
    console.log(`[백필] 구간 ${from} ~ ${to}`)
    console.log(`[백필] 기준일 ${baseDates.length}개: ${baseDates.join(', ')}`)
    console.log(`[백필] 종목 ${stocks.length}개 (완료 ${done.size}개 건너뜀)`)
    console.log(`[백필] 예상 호출 ${totalCalls.toLocaleString()}회 · 약 ${((totalCalls * delayMs) / 3600000).toFixed(1)}시간\n`)

    let processed = 0
    let rowsTotal = 0
    const startedAt = Date.now()

    for (const stock of stocks) {
        if (done.has(stock.id)) continue

        try {
            for (const baseDate of baseDates) {
                const rows = await fetchWithRetry(stock.code, baseDate, from)
                if (rows.length > 0) {
                    await upsertForeignAndInstitutional(stock.id, rows)
                    rowsTotal += rows.length
                }
                await sleep(delayMs)
            }
            done.add(stock.id)
        } catch (err) {
            if (err instanceof KisApiError && err.isTimeLimit) {
                console.error('[백필] TIME LIMIT — 기준일에 오늘이 포함됐습니다. --to 를 전 거래일로 낮추세요.')
                break
            }
            // 이 종목만 미완료로 남기고 계속 — 다음 실행에서 재시도된다
            console.error(`[백필] 오류 - ${stock.code}:`, (err as any)?.message ?? err)
        }

        processed++
        if (processed % 25 === 0) {
            saveProgress(from, to, done)
            const elapsedSec = (Date.now() - startedAt) / 1000
            const remainMin = (((stocks.length - done.size) * elapsedSec) / Math.max(processed, 1)) / 60
            console.log(
                `[백필] ${done.size}/${stocks.length}종목 · ${rowsTotal.toLocaleString()}행 · 남은 시간 약 ${remainMin.toFixed(0)}분`,
            )
        }
    }

    saveProgress(from, to, done)
    console.log(`\n[백필] 종료 — ${done.size}/${stocks.length}종목 완료, ${rowsTotal.toLocaleString()}행 적재`)
    if (done.size < stocks.length) {
        console.log('[백필] 미완료 종목이 있습니다. 같은 명령을 다시 실행하면 이어서 진행합니다.')
    }
}

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startForeignAndInstitutionalScheduler = (): void => {
    // 17:50 — 공매도(16:20~17:32) 종료 후. 활성 3,951종목 × 1,600ms 라 약 106분 걸려
    // 19:36 경 끝난다. 이 TR 은 당일치를 15:40 이후에만 주므로 그 제약도 만족한다.
    //
    // 17:35 에서 옮긴 이유 — 종목 마스터 동기화(2026-10-27)로 활성 종목이 3,590→3,951 이
    // 되면서 공매도 종료가 17:25→17:32 로 밀려 여유가 10분에서 3.5분으로 줄었다. KIS
    // 유량은 앱키 단위로 공유되므로 두 수집기가 겹치면 양쪽 다 유량 초과로 실패한다.
    cron.schedule(
        '50 17 * * 1-5',
        () => {
            collectForeignAndInstitutional().catch((err) =>
                console.error('[ForeignAndInstitutional] 스케줄러 오류:', err)
            )
        },
        { timezone: 'Asia/Seoul' }
    )

    console.log('[ForeignAndInstitutional] 스케줄러 등록 완료 (평일 17:50 KST)')

    runInitialCollect('ForeignAndInstitutional', collectForeignAndInstitutional)
}

// ─── CLI (서버와 분리해 단독 실행) ────────────────────────────
// 6시간짜리 작업이라 서버 라이프사이클에 묶지 않는다. 25종목마다 진행 상황을
// 파일에 남기므로, 중단되면 같은 명령으로 이어서 진행할 수 있다.
if (require.main === module) {
    const args = process.argv.slice(2)
    const arg = (name: string, fallback = '') => {
        const hit = args.find((a) => a.startsWith(`--${name}=`))
        return hit ? hit.slice(name.length + 3) : fallback
    }

    const main = async () => {
        // 기본 --to 는 캘린더상 마지막 거래일. 오늘을 넣으면 15:40 전에 TIME LIMIT 이 난다.
        const from = arg('from', '20260512')
        const days = await getTradingDays(from, getToday())
        const today = getToday()
        const lastClosed = [...days].reverse().find((d) => d < today) ?? from
        const to = arg('to', lastClosed)
        const delay = Number(arg('delay', String(DEFAULT_DELAY_MS)))
        const limit = Number(arg('limit', '0'))   // 스모크 테스트: --limit=3

        await backfillForeignAndInstitutional(from, to, delay, limit)

        const sequelize = (await import('../../config/database')).default
        await sequelize.close()
        process.exit(0)
    }

    main().catch((err) => {
        console.error('[백필] 실행 실패:', err?.message ?? err)
        process.exit(1)
    })
}

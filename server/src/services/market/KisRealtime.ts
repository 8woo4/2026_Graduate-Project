import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { Server, Socket } from 'socket.io'
import { QueryTypes } from 'sequelize'
import sequelize from '../../config/database'
import { getKisAccessToken } from './KisAuth'
import { dataPath } from '../../utils/dataDir'

const BASE_URL      = 'https://openapi.koreainvestment.com:9443'
const APP_KEY       = process.env.KIS_REAL_APP_KEY!
const APP_SECRET    = process.env.KIS_REAL_APP_SECRET!

const CRAWL_BATCH_SIZE      = 20   // 병렬 배치 크기 (KIS rate limit 20 req/s 기준)
const CRAWL_BATCH_INTERVAL  = 1200 // 배치 간 최소 간격 ms — 20건/1,200ms = 16.7 req/s.
                                   // 600ms(=33 req/s)는 KIS 한도 20 req/s 를 넘겨 rate limit
                                   // 대기가 상시 발생했다. 전종목 크롤링은 기본 비활성이지만
                                   // 켰을 때 한도를 넘지 않도록 값 자체를 바로잡는다.
const OVERTIME_BATCH_INTERVAL = 2000 // 시간외 배치 간격 ms

// 시간외 단일가(16:00~18:00)는 10분 단위로 체결된다 — 가격이 10분에 한 번만 바뀐다.
// 전종목 한 사이클이 6분쯤 걸리는데 쉬지 않고 반복하면 같은 값을 두세 번씩 다시
// 받아오면서 KIS 유량만 먹는다. 같은 시간대에 공매도·수급 배치가 돌아야 하므로
// 사이클 주기를 체결 주기에 맞추고 남는 시간은 양보한다(신선도 손실 없음).
const OVERTIME_CYCLE_MS = 10 * 60_000
const POLL_INTERVAL_MS  = 1000  // 종목별 최소 조회 간격 (구독이 적을 때의 상한선)

// 기본값 false — 전종목 크롤링은 ENABLE_FULL_CRAWL=true 로 명시 활성화
const FULL_CRAWL_ENABLED = process.env.ENABLE_FULL_CRAWL === 'true'

// ─── 서버 가격 스냅샷 ────────────────────────────────────────
export const priceMap      = new Map<string, number>()
export const changeMap     = new Map<string, number>()
export const changeRateMap = new Map<string, number>()
export const volumeMap     = new Map<string, number>()

// ─── priceMap 영속화 (재시작 시 복원) ────────────────────────
const CACHE_PATH = dataPath('cache', 'priceCache.json')

const loadPriceCache = () => {
    try {
        if (!fs.existsSync(CACHE_PATH)) return
        const raw = fs.readFileSync(CACHE_PATH, 'utf-8')
        const obj: Record<string, number> = JSON.parse(raw)
        for (const [code, price] of Object.entries(obj)) {
            priceMap.set(code, price)
        }
        console.log(`[PriceCache] 복원 완료 — ${priceMap.size}개 종목`)
    } catch (err) {
        console.warn('[PriceCache] 캐시 로드 실패 (무시):', (err as Error).message)
    }
}

const savePriceCache = () => {
    try {
        const dir = path.dirname(CACHE_PATH)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        const obj = Object.fromEntries(priceMap)
        fs.writeFileSync(CACHE_PATH, JSON.stringify(obj), 'utf-8')
    } catch (err) {
        console.warn('[PriceCache] 캐시 저장 실패:', (err as Error).message)
    }
}

// ─── 시간대 판별 (KST) ────────────────────────────────────────

const getNowKst = () => new Date(Date.now() + 9 * 3600 * 1000)

const isWeekday = (): boolean => {
    const day = getNowKst().getUTCDay()
    return day !== 0 && day !== 6
}

// 정규장: 09:00 ~ 15:30
const isMarketOpen = (): boolean => {
    if (!isWeekday()) return false
    const now = getNowKst()
    const min = now.getUTCHours() * 60 + now.getUTCMinutes()
    return min >= 9 * 60 && min < 15 * 60 + 30
}

// 시간외 단일가: 16:00 ~ 18:00
const isOvertimeOpen = (): boolean => {
    if (!isWeekday()) return false
    const now = getNowKst()
    const min = now.getUTCHours() * 60 + now.getUTCMinutes()
    return min >= 16 * 60 && min < 18 * 60
}

const getTimeZoneLabel = (): string => {
    if (isMarketOpen())    return '장 중'
    if (isOvertimeOpen())  return '시간외 단일가'
    return '장 외'
}

// ─── KIS REST API: 정규장 현재가 (FHKST01010100) ─────────────
// 장 중: 실시간 현재가 / 장 외: 마지막 종가 반환
type FetchResult = {
    code: string; price: number; change: number; changeRate: number
    volume: number; open?: number; high?: number; low?: number
} | null | 'RATE_LIMIT'

const fetchCurrentPrice = async (code: string): Promise<FetchResult> => {
    try {
        const token = await getKisAccessToken()
        const res = await axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price`,
            {
                headers: {
                    authorization: `Bearer ${token}`,
                    appkey:    APP_KEY,
                    appsecret: APP_SECRET,
                    tr_id:     'FHKST01010100',
                    'content-type': 'application/json',
                },
                params: {
                    FID_COND_MRKT_DIV_CODE: 'J',
                    FID_INPUT_ISCD: code,
                },
            }
        )
        if (res.data?.msg_cd === 'EGW00201') return 'RATE_LIMIT'
        const o = res.data?.output
        if (!o || res.data?.rt_cd !== '0') return null
        return {
            code,
            price:      Number(o.stck_prpr),
            change:     Number(o.prdy_vrss),
            changeRate: Number(o.prdy_ctrt),
            volume:     Number(o.acml_vol),
            open:       Number(o.stck_oprc),
            high:       Number(o.stck_hgpr),
            low:        Number(o.stck_lwpr),
        }
    } catch (err: any) {
        if (err.response?.data?.msg_cd === 'EGW00201') return 'RATE_LIMIT'
        return null
    }
}

// ─── KIS REST API: 시간외 단일가 현재가 (FHPST02300000) ───────
// 사용 시간대: 16:00 ~ 18:00
// 시간외 거래가 없는 종목은 ovtm_untp_prpr = 0 → null 반환
const fetchOvertimePrice = async (code: string): Promise<FetchResult> => {
    try {
        const token = await getKisAccessToken()
        const res = await axios.get(
            `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-overtime-price`,
            {
                headers: {
                    authorization: `Bearer ${token}`,
                    appkey:    APP_KEY,
                    appsecret: APP_SECRET,
                    tr_id:     'FHPST02300000',
                    'content-type': 'application/json',
                },
                params: {
                    FID_COND_MRKT_DIV_CODE: 'J',
                    FID_INPUT_ISCD: code,
                },
            }
        )
        if (res.data?.msg_cd === 'EGW00201') return 'RATE_LIMIT'
        const o = res.data?.output
        if (!o || res.data?.rt_cd !== '0') return null

        const price = Number(o.ovtm_untp_prpr)
        if (!price) return null  // 시간외 거래 없는 종목 → caller가 종가 fallback

        return {
            code,
            price,
            change:     Number(o.ovtm_untp_prdy_vrss),
            changeRate: Number(o.ovtm_untp_prdy_ctrt),
            volume:     Number(o.ovtm_untp_vol),
        }
    } catch (err: any) {
        if (err.response?.data?.msg_cd === 'EGW00201') return 'RATE_LIMIT'
        return null
    }
}

// ─── 시간대별 fetch 선택 ──────────────────────────────────────
// 시간외(16~18): ovtm price 시도 → 0이면 정규 종가 fallback
// 장 외(18~): inquire-price가 마지막 종가 반환하므로 그대로 사용
const fetchPrice = async (code: string): Promise<FetchResult> => {
    if (isMarketOpen()) return fetchCurrentPrice(code)

    if (isOvertimeOpen()) {
        const result = await fetchOvertimePrice(code)
        if (result === 'RATE_LIMIT') return 'RATE_LIMIT'
        if (result !== null) return result
        // 시간외 거래 없는 종목: 정규 종가(15:30 기준) fallback
        return fetchCurrentPrice(code)
    }

    // 장 외 (18:00 이후 / 장전): inquire-price → 전 거래일 종가
    return fetchCurrentPrice(code)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ─── 전종목 크롤러 ───────────────────────────────────────────
let crawlerRunning = false

const startFullCrawler = async (io: Server): Promise<void> => {
    if (crawlerRunning) return
    crawlerRunning = true
    console.log('[KisCrawler] 전종목 크롤링 모드 시작')

    let lastClosedLog = 0

    while (true) {
        const market   = isMarketOpen()
        const overtime = isOvertimeOpen()

        // 장 외 대기
        if (!market && !overtime) {
            const now = Date.now()
            if (now - lastClosedLog > 5 * 60_000) {
                const t = getNowKst().toISOString().slice(11, 16)
                console.log(`[KisCrawler] 장 외 대기 중... (${t} KST) — 개장/시간외 시 자동 재개`)
                lastClosedLog = now
            }
            await sleep(30_000)
            continue
        }

        let stocks: { id: number; code: string }[]
        try {
            stocks = await sequelize.query<{ id: number; code: string }>(
                `SELECT id, code FROM stocks WHERE is_active = 1 AND market IN ('KOSPI','KOSDAQ')`,
                { type: QueryTypes.SELECT }
            )
        } catch {
            await sleep(10_000)
            continue
        }

        const label       = getTimeZoneLabel()
        const batchInterval = market ? CRAWL_BATCH_INTERVAL : OVERTIME_BATCH_INTERVAL
        const cycleStart  = Date.now()
        const totalBatches = Math.ceil(stocks.length / CRAWL_BATCH_SIZE)
        console.log(`\n[KisCrawler] ━━━ 사이클 시작 (${label}) ━━━ ${stocks.length}개 / ${totalBatches}배치 / ${new Date().toLocaleTimeString('ko-KR')}`)

        let updated = 0, changed = 0, rateLimitHits = 0

        for (let i = 0; i < stocks.length; i += CRAWL_BATCH_SIZE) {
            // 시간대 전환 감지 → 사이클 중단
            const stillValid = market ? isMarketOpen() : isOvertimeOpen()
            if (!stillValid) {
                console.log(`[KisCrawler] 시간대 전환 감지 (${label} 종료) — ${i}번째에서 중단`)
                break
            }

            const batch      = stocks.slice(i, i + CRAWL_BATCH_SIZE)
            const batchStart = Date.now()

            // 배치 병렬 요청
            const results = await Promise.all(batch.map(s => fetchPrice(s.code)))

            for (let j = 0; j < batch.length; j++) {
                const result = results[j]
                const stock  = batch[j]

                if (result === 'RATE_LIMIT') {
                    rateLimitHits++
                    if (rateLimitHits <= 3) console.warn(`[KisCrawler] ⚠ Rate limit — ${stock.code} — 3초 대기`)
                    await sleep(3000)
                    break
                }

                if (result) {
                    if (priceMap.get(stock.code) !== result.price) changed++
                    priceMap.set(result.code, result.price)
                    changeMap.set(result.code, result.change)
                    changeRateMap.set(result.code, result.changeRate)
                    volumeMap.set(result.code, result.volume)
                    io.emit('stock:price', result)
                    updated++
                }
            }

            // 첫 배치 로그
            if (i === 0) {
                const sample = results.filter(r => r && r !== 'RATE_LIMIT').slice(0, 3)
                    .map(r => r && r !== 'RATE_LIMIT' ? `${r.code}=${r.price}` : '').join(' ')
                console.log(`[KisCrawler] 첫 배치 샘플: ${sample}`)
            }

            // 500개마다 진행 로그
            const processed = i + batch.length
            if (processed % 500 < CRAWL_BATCH_SIZE) {
                const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(0)
                console.log(`[KisCrawler] 진행 ${processed}/${stocks.length} (${elapsed}s) | 업데이트 ${updated}개`)
            }

            // 배치 간 최소 간격 보장
            const batchElapsed = Date.now() - batchStart
            const wait = Math.max(0, batchInterval - batchElapsed)
            if (wait > 0 && i + CRAWL_BATCH_SIZE < stocks.length) await sleep(wait)
        }

        const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1)
        const sample  = [...priceMap.entries()].slice(0, 5).map(([c, p]) => `${c}=${p}`).join(' | ')
        console.log(`\n========================================`)
        console.log(`✅ [KisCrawler] 사이클 완료 (${label})`)
        console.log(`   소요시간: ${elapsed}s | 업데이트: ${updated}개 | 가격변동: ${changed}개 | RateLimit: ${rateLimitHits}회`)
        console.log(`   샘플: ${sample || '없음'}`)
        console.log(`========================================\n`)

        // 시간외에는 다음 10분 경계까지 쉰다 — 그 시간을 배치 수집기가 쓴다.
        // 장 중에는 체결이 계속 나므로 쉬지 않고 이어서 돈다.
        if (overtime) {
            const rest = OVERTIME_CYCLE_MS - (Date.now() - cycleStart)
            if (rest > 0) {
                console.log(`[KisCrawler] 시간외 — 다음 사이클까지 ${Math.round(rest / 1000)}s 대기 (단일가 10분 주기)`)
                await sleep(rest)
            }
        }
    }
}

// ─── 온디맨드 폴링 (상세 페이지용) ──────────────────────────
const refCount = new Map<string, number>()

/**
 * 구독 종목을 타이머 하나로 돌려가며 조회한다(라운드로빈).
 *
 * 이전 구현은 종목마다 setInterval(1초)을 걸었다. 상세 페이지처럼 1종목일 때는 문제가
 * 없었지만(주석도 "종목 1개라 부담 없음"), 목록 화면이 30종목을 구독하면 그대로 30 req/s 가
 * 되어 KIS 한도 20 req/s 를 넘는다. 그래서 '종목당 주기'가 아니라 '전체 호출 속도'를
 * 상한으로 잡는다 — 구독이 몇 개든 합계가 ONDEMAND_RATE_PER_SEC 를 넘지 않고,
 * 종목 하나의 갱신 주기는 구독 수에 비례해 늘어난다(30종목 → 약 3초).
 *
 * 한도의 절반만 쓰는 이유: 같은 앱키를 SmartPoller(지정가 체결·포트폴리오)와 실거래
 * 주문이 함께 쓴다. 시세 갱신이 주문 경로의 유량을 잠식해선 안 된다.
 */
const ONDEMAND_RATE_PER_SEC = 10
const ONDEMAND_TICK_MS = Math.round(1000 / ONDEMAND_RATE_PER_SEC)
// 구독이 적을 때 같은 종목을 초당 10회 때리지 않도록 종목별 하한을 둔다.
const MIN_CODE_INTERVAL_MS = POLL_INTERVAL_MS

const lastPolled = new Map<string, number>()
const pending: string[] = []          // 새로 구독된 코드 — 라운드로빈보다 먼저 1회 조회
let rrTimer: ReturnType<typeof setInterval> | null = null
let closedAt: number | null = null    // 장 외 전환을 감지한 시각(마지막 종가 1회 수집용)

const doFetch = async (code: string, io: Server) => {
    const result = await fetchPrice(code)
    if (result && typeof result !== 'string') {
        priceMap.set(result.code, result.price)
        changeMap.set(result.code, result.change)
        changeRateMap.set(result.code, result.changeRate)
        volumeMap.set(result.code, result.volume)
        io.emit('stock:price', result)
    }
}

const poll = (code: string, io: Server, now: number): void => {
    lastPolled.set(code, now)
    void doFetch(code, io)
}

/**
 * 한 틱에 무엇을 할지 결정하는 순수 함수. 타이머·네트워크·모듈 상태에서 떼어내
 * 호출 속도 상한과 공평성을 단위 검증할 수 있게 한다(테스트: test/market/pollScheduler.test.ts).
 * pending 은 소비된 코드를 호출자가 제거하도록 인덱스를 돌려준다.
 */
export interface PollTickInput {
    codes: string[]                    // 구독 중인 코드
    lastPolled: Map<string, number>    // code → 마지막 조회 시각
    pending: readonly string[]         // 첫 조회 대기 큐
    now: number
    open: boolean                      // 정규장 또는 시간외 단일가
    closedAt: number | null            // 장 외 전환을 감지한 시각
    minCodeIntervalMs: number
}

export type PollTickDecision =
    | { action: 'poll'; code: string; pendingIndex: number | null }
    | { action: 'stop'; reason: 'no-subscribers' | 'closed-sweep-done' }
    | { action: 'idle' }

export const decidePollTick = (input: PollTickInput): PollTickDecision => {
    const { codes, lastPolled, pending, now, open, closedAt, minCodeIntervalMs } = input

    if (codes.length === 0) return { action: 'stop', reason: 'no-subscribers' }

    if (!open) {
        // 장 외 전환 — 구독 종목의 마지막 종가를 한 종목씩 1회만 받고 멈춘다.
        // 한 번에 전부 쏘지 않는 이유는 그 순간 호출 속도 상한이 깨지기 때문이다.
        const since = closedAt ?? now
        const stale = codes.find((c) => (lastPolled.get(c) ?? 0) < since)
        return stale !== undefined
            ? { action: 'poll', code: stale, pendingIndex: null }
            : { action: 'stop', reason: 'closed-sweep-done' }
    }

    // 첫 조회 대기 중인 구독을 먼저 — 상세 페이지는 구독 직후 한 틱 안에 값을 받는다
    for (let i = 0; i < pending.length; i++) {
        if (codes.includes(pending[i])) return { action: 'poll', code: pending[i], pendingIndex: i }
    }

    // 가장 오래된 종목부터 — 구독 수가 많아도 모든 종목이 고르게 돌아온다
    let target: string | null = null
    let oldest = Infinity
    for (const code of codes) {
        const at = lastPolled.get(code) ?? 0
        if (at < oldest) {
            oldest = at
            target = code
        }
    }
    if (target !== null && now - oldest >= minCodeIntervalMs) {
        return { action: 'poll', code: target, pendingIndex: null }
    }
    return { action: 'idle' }
}

const tick = (io: Server): void => {
    const now = Date.now()
    const open = isMarketOpen() || isOvertimeOpen()
    if (!open && closedAt === null) closedAt = now
    if (open) closedAt = null

    const decision = decidePollTick({
        codes: [...refCount.keys()],
        lastPolled,
        pending,
        now,
        open,
        closedAt,
        minCodeIntervalMs: MIN_CODE_INTERVAL_MS,
    })

    if (decision.action === 'stop') {
        if (decision.reason === 'closed-sweep-done') {
            console.log(`[KisRealtime] 장 외 — 종가 수집 완료, 폴링 중지 (구독 ${refCount.size}종목)`)
        }
        stopRoundRobin()
        return
    }
    if (decision.action === 'idle') return

    if (decision.pendingIndex !== null) pending.splice(decision.pendingIndex, 1)
    poll(decision.code, io, now)
}

const startRoundRobin = (io: Server): void => {
    if (rrTimer !== null) return
    rrTimer = setInterval(() => tick(io), ONDEMAND_TICK_MS)
    console.log(`[KisRealtime] 온디맨드 폴링 시작 (${getTimeZoneLabel()}, 상한 ${ONDEMAND_RATE_PER_SEC} req/s)`)
}

const stopRoundRobin = (): void => {
    if (rrTimer === null) return
    clearInterval(rrTimer)
    rrTimer = null
}

const startPolling = (code: string, io: Server): void => {
    pending.push(code)
    startRoundRobin(io)
}

const decrement = (code: string) => {
    const count = refCount.get(code) ?? 0
    if (count <= 1) {
        refCount.delete(code)
        lastPolled.delete(code)
        if (refCount.size === 0) stopRoundRobin()
    } else {
        refCount.set(code, count - 1)
    }
}

// ─── 상태 진단 ───────────────────────────────────────────────
export const getRealtimeStatus = () => ({
    mode:            FULL_CRAWL_ENABLED ? 'full-crawl' : 'on-demand',
    crawlerRunning,
    timeZone:        getTimeZoneLabel(),
    isMarketOpen:    isMarketOpen(),
    isOvertimeOpen:  isOvertimeOpen(),
    priceMapSize:    priceMap.size,
    onDemandPolling: [...refCount.keys()],
    onDemandRateCap: `${ONDEMAND_RATE_PER_SEC} req/s`,
    onDemandCycleMs: Math.max(MIN_CODE_INTERVAL_MS, refCount.size * ONDEMAND_TICK_MS),
    samplePrices:    [...priceMap.entries()].slice(0, 10).map(([code, price]) => ({ code, price })),
})

// ─── 진입점 ──────────────────────────────────────────────────
export const startKisRealtime = async (io: Server): Promise<void> => {
    // 재시작 시 이전 가격 복원
    loadPriceCache()

    // 60초마다 priceMap → 파일 저장
    setInterval(savePriceCache, 60_000)

    if (FULL_CRAWL_ENABLED) {
        console.log('[KisRealtime] 전종목 크롤링 모드 (ENABLE_FULL_CRAWL=true)')
        startFullCrawler(io).catch(err =>
            console.error('[KisCrawler] 크롤러 오류:', err.message)
        )
    } else {
        console.log('[KisRealtime] 온디맨드 폴링 모드 (ENABLE_FULL_CRAWL=false)')
    }

    // 상세 페이지 온디맨드 폴링 — 항상 활성
    io.on('connection', (socket: Socket) => {
        const socketSubs = new Set<string>()

        socket.on('subscribe:stock', (code: string) => {
            if (socketSubs.has(code)) return
            socketSubs.add(code)
            const count = refCount.get(code) ?? 0
            refCount.set(code, count + 1)
            if (count === 0) startPolling(code, io)
        })

        socket.on('unsubscribe:stock', (code: string) => {
            if (!socketSubs.has(code)) return
            socketSubs.delete(code)
            decrement(code)
        })

        socket.on('disconnect', () => {
            socketSubs.forEach(code => decrement(code))
        })
    })
}

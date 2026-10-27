/**
 * StockMaster — 종목 마스터 동기화 (신규 상장 추가 / 상장폐지 비활성 / 종목명·시장 정정)
 *
 * stocks 테이블은 2026-03-24 덤프로 한 번 적재된 뒤 행이 갱신되지 않았다. 매주 도는
 * ListedShares 는 기존 행의 상장주식수 컬럼만 바꾸므로, 그 이후의 신규 상장은 들어오지
 * 않고 상장폐지 종목은 is_active=1 로 남는다(가격 수집에서 매일 빠지는 78종목이 그것이다).
 *
 * 출처는 KIS 가 공개하는 정적 마스터 파일이다. 앱키·유량 제한과 무관하고 시장당 1회
 * 다운로드로 전 종목을 받으므로, 종목별 API 호출(KisRealtime 의 20건 배치 병렬)이 필요 없다.
 */

import axios from 'axios'
import AdmZip from 'adm-zip'
import { QueryTypes, Transaction } from 'sequelize'
import sequelize from '../../config/database'

export type Market = 'KOSPI' | 'KOSDAQ'

export interface MasterRecord {
    code: string
    isin: string
    name: string
    group: string
    market: Market
}

export interface DbRow {
    code: string
    name: string
    market: string
    isin_code: string | null
    security_group: string | null
    is_active: number
}

/**
 * 꼬리 길이가 227/221 인 이유 — KIS 공식 샘플은 파일을 줄 단위로 읽어 끝의 개행문자가
 * 남은 상태에서 len-228(KOSPI) 로 자른다. 여기서는 개행을 떼고 split 하므로 1을 뺀다.
 * 이름은 길이가 가변이므로 꼬리를 뺀 나머지 전체를 이름으로 본다. 고정폭(예: 40자)으로
 * 자르면 패딩과 꼬리의 증권그룹구분까지 이름에 들어온다 — 최초 적재가 이 방식이어서
 * stocks.name 이 '동화약품 + 공백 32 + ST30'(정확히 40자) 꼴로 저장돼 있다.
 */
const SOURCES: { market: Market; url: string; tail: number }[] = [
    { market: 'KOSPI', url: 'https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip', tail: 227 },
    { market: 'KOSDAQ', url: 'https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip', tail: 221 },
]

/**
 * 적재 대상 증권그룹구분. 기존 3,590건의 구성을 역산한 집합이다 —
 * 수익증권(BC)·ETN(EN)·신주인수권(SW/SR)·PF 는 최초 적재에서 제외됐고 그 기준을 유지한다.
 * 범위를 바꿀 때 코드를 고치지 않도록 STOCK_MASTER_GROUPS 로 덮어쓸 수 있다.
 */
const DEFAULT_GROUPS = 'ST,EF,RT,FS,DR,IF,MF'

export const includedGroups = (): Set<string> =>
    new Set(
        (process.env.STOCK_MASTER_GROUPS ?? DEFAULT_GROUPS)
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter((s) => s.length > 0),
    )

// 마스터 파일이 깨진 채로 내려오면 전 종목을 비활성으로 돌릴 수 있다. 두 가드로 막는다.
const MIN_RECORDS_PER_MARKET = 500

export const deactivateLimitRatio = (): number => {
    const v = Number(process.env.STOCK_MASTER_DEACTIVATE_LIMIT)
    return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.05
}

const CODE_RE = /^[A-Z0-9]{6,9}$/
const GROUP_RE = /^[A-Z]{2}$/

/** 외부 파일에서 온 값이라 제어문자를 걷어내고 컬럼 폭(100)에 맞춘다. */
const sanitizeName = (raw: string): string =>
    raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100)

export const parseMaster = (buf: Buffer, market: Market, tail: number): MasterRecord[] => {
    const text = new TextDecoder('euc-kr').decode(buf)
    const out: MasterRecord[] = []

    for (const line of text.split(/\r?\n/)) {
        if (line.length <= tail + 21) continue

        const head = line.slice(0, line.length - tail)
        const code = head.slice(0, 9).trim().toUpperCase()
        const isin = head.slice(9, 21).trim().toUpperCase().slice(0, 20)
        const name = sanitizeName(head.slice(21))
        const group = line.slice(line.length - tail, line.length - tail + 2).trim().toUpperCase()

        if (!CODE_RE.test(code) || !GROUP_RE.test(group) || name.length === 0) continue

        out.push({ code, isin, name, group, market })
    }

    return out
}

export const fetchMaster = async (): Promise<{ records: MasterRecord[]; perMarket: Record<string, number> }> => {
    const records: MasterRecord[] = []
    const perMarket: Record<string, number> = {}

    for (const src of SOURCES) {
        const res = await axios.get<ArrayBuffer>(src.url, { responseType: 'arraybuffer', timeout: 60_000 })
        const entry = new AdmZip(Buffer.from(res.data)).getEntries()[0]
        if (!entry) throw new Error(`${src.market} 마스터 zip 이 비어 있습니다`)

        const parsed = parseMaster(entry.getData(), src.market, src.tail)
        if (parsed.length < MIN_RECORDS_PER_MARKET) {
            throw new Error(
                `${src.market} 마스터 파싱 ${parsed.length}건 — 최소 ${MIN_RECORDS_PER_MARKET}건 미달, 형식 변경 의심`,
            )
        }

        perMarket[src.market] = parsed.length
        records.push(...parsed)
    }

    return { records, perMarket }
}

export interface SyncPlan {
    upserts: MasterRecord[] // 신규 + 변경 + 재상장 복구 (한 문장으로 처리)
    inserts: MasterRecord[]
    updates: { code: string; fields: string[] }[]
    reactivates: string[]
    deactivates: DbRow[]
    skippedGroups: Record<string, number>
    duplicatedCodes: string[]
    masterTotal: number
    dbTotal: number
}

export const buildPlan = (records: MasterRecord[], rows: DbRow[]): SyncPlan => {
    const groups = includedGroups()
    const skippedGroups: Record<string, number> = {}
    const duplicatedCodes: string[] = []

    const master = new Map<string, MasterRecord>()
    for (const r of records) {
        if (!groups.has(r.group)) {
            skippedGroups[r.group] = (skippedGroups[r.group] ?? 0) + 1
            continue
        }
        if (master.has(r.code)) {
            duplicatedCodes.push(r.code)
            continue
        }
        master.set(r.code, r)
    }

    const db = new Map(rows.map((r) => [r.code, r]))
    const inserts: MasterRecord[] = []
    const updates: { code: string; fields: string[] }[] = []
    const reactivates: string[] = []
    const upserts: MasterRecord[] = []

    for (const [code, m] of master) {
        const cur = db.get(code)
        if (!cur) {
            inserts.push(m)
            upserts.push(m)
            continue
        }

        const fields: string[] = []
        if (cur.name !== m.name) fields.push('name')
        if (cur.market !== m.market) fields.push('market')
        if ((cur.isin_code ?? '') !== m.isin) fields.push('isin_code')
        if ((cur.security_group ?? '') !== m.group) fields.push('security_group')
        if (Number(cur.is_active) !== 1) {
            fields.push('is_active')
            reactivates.push(code)
        }

        if (fields.length > 0) {
            updates.push({ code, fields })
            upserts.push(m)
        }
    }

    // 마스터에 없는 '활성' 종목만 비활성 대상이다. 이미 꺼진 행은 건드리지 않는다.
    const deactivates = rows.filter((r) => Number(r.is_active) === 1 && !master.has(r.code))

    return {
        upserts,
        inserts,
        updates,
        reactivates,
        deactivates,
        skippedGroups,
        duplicatedCodes,
        masterTotal: master.size,
        dbTotal: rows.length,
    }
}

export const loadDbRows = (): Promise<DbRow[]> =>
    sequelize.query<DbRow>(
        'SELECT code, name, market, isin_code, security_group, is_active FROM stocks',
        { type: QueryTypes.SELECT },
    )

const BATCH = 400

/**
 * AI 예측 대상 여부의 기본값. 모델은 개별 기업의 재무·수급·감성으로 학습되므로
 * ETF·리츠·펀드·예탁증서에 종목 단위 상승 예측을 붙이는 것은 범주 오류다. 주권만 대상으로 둔다.
 * 신규 행에만 적용한다 — 기존 행의 값은 아래 ON DUPLICATE 에서 건드리지 않는다.
 */
export const defaultMlTarget = (group: string): number => (group === 'ST' ? 1 : 0)

/**
 * 신규·변경·재상장을 한 문장으로 처리한다. code 가 UNIQUE 라 중복 키에서 갱신으로 떨어진다.
 * is_ml_target 은 갱신 목록에 넣지 않는다 — 운영 중 바뀐 값을 동기화가 되돌리면 안 된다
 * (AI 담당이 특정 ETF 를 대상으로 지정했다면 주간 동기화가 그것을 되돌려선 안 된다).
 */
const applyUpserts = async (list: MasterRecord[], t: Transaction): Promise<void> => {
    for (let i = 0; i < list.length; i += BATCH) {
        const chunk = list.slice(i, i + BATCH)
        const values = chunk.map(() => '(?, ?, ?, ?, ?, 1, ?)').join(', ')
        const bind: (string | number)[] = []
        for (const r of chunk) bind.push(r.code, r.name, r.market, r.isin, r.group, defaultMlTarget(r.group))

        await sequelize.query(
            `INSERT INTO stocks (code, name, market, isin_code, security_group, is_active, is_ml_target)
             VALUES ${values} AS src
             ON DUPLICATE KEY UPDATE
                 name = src.name,
                 market = src.market,
                 isin_code = src.isin_code,
                 security_group = src.security_group,
                 is_active = 1`,
            { replacements: bind, transaction: t },
        )
    }
}

const applyDeactivations = async (codes: string[], t: Transaction): Promise<void> => {
    for (let i = 0; i < codes.length; i += BATCH) {
        const chunk = codes.slice(i, i + BATCH)
        await sequelize.query(
            `UPDATE stocks SET is_active = 0
              WHERE is_active = 1 AND code IN (${chunk.map(() => '?').join(', ')})`,
            { replacements: chunk, transaction: t },
        )
    }
}

export interface SyncResult extends SyncPlan {
    dryRun: boolean
    applied: boolean
    perMarket: Record<string, number>
    blockedReason?: string
}

export const syncStockMaster = async (
    opts: { dryRun?: boolean; force?: boolean } = {},
): Promise<SyncResult> => {
    const dryRun = opts.dryRun === true
    const { records, perMarket } = await fetchMaster()
    const rows = await loadDbRows()
    const plan = buildPlan(records, rows)

    const limit = deactivateLimitRatio()
    const ratio = plan.dbTotal > 0 ? plan.deactivates.length / plan.dbTotal : 0

    // 마스터가 부분적으로만 내려온 경우를 전 종목 폐지로 오인하지 않게 한다.
    if (!opts.force && ratio > limit) {
        return {
            ...plan,
            dryRun,
            applied: false,
            perMarket,
            blockedReason:
                `비활성 대상 ${plan.deactivates.length}건이 전체 ${plan.dbTotal}건의 ` +
                `${(ratio * 100).toFixed(1)}% 로 임계 ${(limit * 100).toFixed(1)}% 를 넘어 적용을 중단했다. ` +
                `의도한 변경이면 force 로 실행한다.`,
        }
    }

    if (dryRun) return { ...plan, dryRun, applied: false, perMarket }

    if (plan.upserts.length === 0 && plan.deactivates.length === 0) {
        return { ...plan, dryRun, applied: true, perMarket }
    }

    const t = await sequelize.transaction()
    try {
        await applyUpserts(plan.upserts, t)
        await applyDeactivations(plan.deactivates.map((d) => d.code), t)
        await t.commit()
    } catch (err) {
        await t.rollback()
        throw err
    }

    return { ...plan, dryRun, applied: true, perMarket }
}

export const formatReport = (r: SyncResult): string => {
    const skipped = Object.entries(r.skippedGroups)
        .sort((a, b) => b[1] - a[1])
        .map(([g, n]) => `${g}:${n}`)
        .join(' ')

    const lines = [
        `[StockMaster] ${r.dryRun ? '모의 실행(dry-run)' : r.applied ? '적용 완료' : '적용 중단'}`,
        `  마스터 ${Object.entries(r.perMarket).map(([m, n]) => `${m} ${n}`).join(' / ')} → 대상 ${r.masterTotal}건 (DB ${r.dbTotal}건)`,
        `  신규 ${r.inserts.length} · 변경 ${r.updates.length} · 재상장 복구 ${r.reactivates.length} · 비활성(상장폐지) ${r.deactivates.length}`,
        `  적재 제외 그룹 ${skipped || '없음'}`,
    ]
    if (r.duplicatedCodes.length > 0) {
        lines.push(`  ⚠️ 중복 코드 ${r.duplicatedCodes.length}건: ${r.duplicatedCodes.slice(0, 5).join(', ')}`)
    }
    if (r.blockedReason) lines.push(`  ⚠️ ${r.blockedReason}`)
    return lines.join('\n')
}

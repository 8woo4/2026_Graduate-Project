/**
 * 종목 마스터 동기화 검증
 *
 *   실행: cd server && npx ts-node src/test/market/stockMaster.test.ts
 *         (--offline 을 주면 실제 마스터 파일 다운로드 단계를 건너뛴다)
 *
 * 검증하는 것
 *   1) 파서가 고정폭 꼬리를 '문자' 기준으로 분리하는가 — 최초 적재를 망친 지점이다.
 *      한글이 EUC-KR 2바이트라 바이트 기준으로 자르면 이름 끝에 꼬리가 섞여 들어간다.
 *      그 잘못된 방식을 대조군으로 함께 돌려 실제로 깨지는 것을 보여준다.
 *   2) 외부 파일에서 온 값의 입력 검증(코드 형식·빈 이름·제어문자)
 *   3) 변경 계획 산출 — 신규/변경/비활성/재상장/그룹 제외/중복 코드/무변경
 *   4) 전 종목이 비활성으로 돌아가는 사고를 막는 임계 가드
 *   5) 실제 KIS 마스터 파일 연동 (네트워크)
 */

import {
    buildPlan,
    deactivateLimitRatio,
    defaultMlTarget,
    fetchMaster,
    includedGroups,
    parseMaster,
    type DbRow,
    type MasterRecord,
} from '../../services/market/StockMaster'

let pass = 0
let fail = 0

const check = (label: string, ok: boolean, detail = ''): void => {
    if (ok) {
        pass++
        console.log(`  ✔ ${label}${detail ? `  (${detail})` : ''}`)
    } else {
        fail++
        console.log(`  ✘ ${label}${detail ? `  (${detail})` : ''}`)
    }
}

// ─── 마스터 한 줄 합성 ────────────────────────────────────────
// 실제 레코드 구조: [단축코드 9][표준코드 12][한글종목명 가변] + [꼬리 tail(개행 제외)]
// 꼬리는 전부 ASCII 이고 맨 앞 2자리가 증권그룹구분이다.

const KOSPI_TAIL = 227

const line = (code: string, isin: string, nameBytes: Buffer, group: string, tail = KOSPI_TAIL): Buffer =>
    Buffer.concat([
        Buffer.from(code.padEnd(9, ' '), 'latin1'),
        Buffer.from(isin.padEnd(12, ' '), 'latin1'),
        nameBytes,
        Buffer.from(' '.repeat(6), 'latin1'), // 이름 뒤 패딩 (실제 파일에도 존재)
        Buffer.from(group + 'X'.repeat(tail - group.length), 'latin1'),
    ])

const eucKr = (hex: string): Buffer => Buffer.from(hex, 'hex')

const NAME_DONGHWA = eucKr('b5bfc8adbee0c7b0')          // 동화약품
const NAME_SAMSUNG = eucKr('bbefbcbac0fcc0da')          // 삼성전자
const NAME_HITE = eucKr('c7cfc0ccc6aec1f8b7ce32bfec42') // 하이트진로2우B
const NAME_KODEX = Buffer.from('KODEX 200', 'latin1')

const join = (...bufs: Buffer[]): Buffer =>
    Buffer.concat(bufs.flatMap((b, i) => (i === 0 ? [b] : [Buffer.from('\n'), b])))

console.log('\n[검증] 종목 마스터 동기화 (StockMaster)')

// ─── 1) 파서: 문자 기준 분리 ──────────────────────────────────
console.log('\n- 파서: 고정폭 꼬리 분리')
{
    const buf = join(
        line('000020   ', 'KR7000020008', NAME_DONGHWA, 'ST'),
        line('005930   ', 'KR7005930003', NAME_SAMSUNG, 'ST'),
        line('069500   ', 'KR7069500007', NAME_KODEX, 'EF'),
        line('000087   ', 'KR7000087007', NAME_HITE, 'ST'),
    )
    const recs = parseMaster(buf, 'KOSPI', KOSPI_TAIL)

    check('4개 레코드 전부 파싱', recs.length === 4, `${recs.length}건`)
    check('한글 이름에 꼬리가 섞이지 않음', recs[0]?.name === '동화약품', `"${recs[0]?.name}"`)
    check('긴 한글 이름도 정확', recs[3]?.name === '하이트진로2우B', `"${recs[3]?.name}"`)
    check('영문 이름 정확', recs[2]?.name === 'KODEX 200', `"${recs[2]?.name}"`)
    check('증권그룹구분 2자리 추출', recs[0]?.group === 'ST' && recs[2]?.group === 'EF',
        `${recs[0]?.group}/${recs[2]?.group}`)
    check('단축코드 trim', recs[1]?.code === '005930', `"${recs[1]?.code}"`)
    check('표준코드(ISIN) 추출', recs[1]?.isin === 'KR7005930003', `"${recs[1]?.isin}"`)
    check('시장 태깅', recs.every((r) => r.market === 'KOSPI'))

    // [대조군] 최초 적재가 쓴 방식 — 이름을 고정폭 40자로 자르면 패딩과 꼬리가 함께 들어온다.
    // DB 의 "동화약품 + 공백 32 + ST30"(40자)이 이 방식의 산출물이다.
    const broken = ((): string => {
        const one = line('000020   ', 'KR7000020008', NAME_DONGHWA, 'ST')
        return new TextDecoder('euc-kr').decode(one).slice(21, 61)
    })()
    check('[대조군] 고정폭 40자로 자르면 꼬리가 섞인다', /ST/.test(broken), `"${broken}"`)
    check('[대조군] 길이가 정확히 40자 — DB 오염과 같은 형태', broken.length === 40, `${broken.length}자`)
}

// ─── 2) 파서: 입력 검증 ───────────────────────────────────────
console.log('\n- 파서: 외부 입력 검증')
{
    const bad = join(
        line('00##20   ', 'KR7000020008', NAME_DONGHWA, 'ST'),                  // 코드 형식 위반
        line('000030   ', 'KR7000030007', Buffer.from('   ', 'latin1'), 'ST'),  // 빈 이름
        line('000040   ', 'KR7000040006', NAME_SAMSUNG, 'S1'),                  // 그룹 형식 위반
        line('000050   ', 'KR7000050005', Buffer.concat([NAME_SAMSUNG, Buffer.from([0x07])]), 'ST'),
    )
    const recs = parseMaster(bad, 'KOSPI', KOSPI_TAIL)
    const codes = recs.map((r) => r.code)

    check('코드 형식 위반 거부', !codes.includes('00##20'))
    check('빈 이름 거부', !codes.includes('000030'))
    check('그룹 형식 위반 거부', !codes.includes('000040'))
    check('제어문자는 제거하고 통과', codes.includes('000050') && recs.find((r) => r.code === '000050')?.name === '삼성전자')
    check('짧은 줄은 조용히 무시', parseMaster(Buffer.from('too short\n', 'latin1'), 'KOSPI', KOSPI_TAIL).length === 0)
}

// ─── 3) 변경 계획 산출 ────────────────────────────────────────
console.log('\n- 변경 계획 산출')
{
    const m = (code: string, name: string, group: string, market: 'KOSPI' | 'KOSDAQ' = 'KOSPI'): MasterRecord =>
        ({ code, isin: `KR${code}`, name, group, market })
    const d = (code: string, name: string, opts: Partial<DbRow> = {}): DbRow => ({
        code, name, market: 'KOSPI', isin_code: `KR${code}`, security_group: 'ST', is_active: 1, ...opts,
    })

    const master: MasterRecord[] = [
        m('000001', '무변경종목', 'ST'),
        m('000002', '이름바뀜', 'ST'),
        m('000003', '신규상장', 'ST'),
        m('000004', '시장이동', 'ST', 'KOSDAQ'),
        m('000005', '재상장', 'ST'),
        m('000006', '꼬리정리대상', 'ST'),
        m('000900', '제외그룹', 'BC'),
        m('000007', '중복코드', 'ST'),
        m('000007', '중복코드둘', 'ST'),
    ]
    const rows: DbRow[] = [
        d('000001', '무변경종목'),
        d('000002', '이름예전'),
        d('000004', '시장이동'),
        d('000005', '재상장', { is_active: 0 }),
        d('000006', '꼬리정리대상                     ST30'),
        d('000007', '중복코드'),
        d('000099', '상장폐지됨'),
        d('000098', '이미비활성', { is_active: 0 }),
    ]

    const plan = buildPlan(master, rows)
    const codesOf = (l: { code: string }[]) => l.map((x) => x.code).sort().join(',')

    check('신규 상장만 insert', codesOf(plan.inserts) === '000003', codesOf(plan.inserts))
    check('변경 대상 산출', codesOf(plan.updates) === '000002,000004,000005,000006', codesOf(plan.updates))
    check('이름 변경 감지', plan.updates.find((u) => u.code === '000002')?.fields.includes('name') === true)
    check('시장 이동 감지', plan.updates.find((u) => u.code === '000004')?.fields.includes('market') === true)
    check('깨진 이름 정정 대상에 포함', plan.updates.find((u) => u.code === '000006')?.fields.includes('name') === true)
    check('재상장 복구', plan.reactivates.join(',') === '000005', plan.reactivates.join(','))
    check('상장폐지만 비활성 대상', codesOf(plan.deactivates) === '000099', codesOf(plan.deactivates))
    check('이미 비활성인 행은 재처리하지 않음', !plan.deactivates.some((x) => x.code === '000098'))
    check('무변경 종목은 쓰기 대상 아님', !plan.upserts.some((x) => x.code === '000001'))
    check('제외 그룹은 대상에서 빠짐', plan.skippedGroups['BC'] === 1 && !plan.upserts.some((x) => x.code === '000900'))
    check('중복 코드는 1건만 채택', plan.duplicatedCodes.length === 1 && plan.duplicatedCodes[0] === '000007')
    check('upserts = inserts + updates', plan.upserts.length === plan.inserts.length + plan.updates.length,
        `${plan.upserts.length} = ${plan.inserts.length} + ${plan.updates.length}`)
    check('기본 적재 그룹에 ST·EF 포함, BC·EN 제외',
        includedGroups().has('ST') && includedGroups().has('EF') &&
        !includedGroups().has('BC') && !includedGroups().has('EN'))
}

// ─── 3-b) AI 예측 대상 기본값 ─────────────────────────────────
console.log('\n- AI 예측 대상(is_ml_target) 기본값')
{
    check('주권(ST)만 예측 대상', defaultMlTarget('ST') === 1)
    check('ETF 는 비대상', defaultMlTarget('EF') === 0)
    for (const g of ['RT', 'FS', 'DR', 'IF', 'MF', 'EN', 'BC']) {
        check(`${g} 는 비대상`, defaultMlTarget(g) === 0)
    }

    // 동기화는 기존 행의 is_ml_target 을 비교 대상에 넣지 않는다 — AI 담당이 특정 종목을
    // 대상으로 지정했을 때 주간 동기화가 그것을 되돌리면 안 된다.
    const rows: DbRow[] = [{
        code: '069500', name: 'KODEX 200', market: 'KOSPI',
        isin_code: 'KR7069500007', security_group: 'EF', is_active: 1,
    }]
    const master: MasterRecord[] = [{
        code: '069500', isin: 'KR7069500007', name: 'KODEX 200', group: 'EF', market: 'KOSPI',
    }]
    const plan = buildPlan(master, rows)
    check('무변경 ETF 는 쓰기 대상이 아님(is_ml_target 비교 안 함)',
        plan.upserts.length === 0 && plan.updates.length === 0 && plan.deactivates.length === 0)
}

// ─── 4) 비활성 임계 가드 ──────────────────────────────────────
console.log('\n- 전 종목 비활성 사고 방지')
{
    const rows: DbRow[] = Array.from({ length: 1000 }, (_, i) => ({
        code: String(100000 + i), name: `종목${i}`, market: 'KOSPI',
        isin_code: null, security_group: 'ST', is_active: 1,
    }))

    // 마스터가 절반만 내려온 상황
    const half = rows.slice(0, 500).map<MasterRecord>((r) => ({
        code: r.code, isin: '', name: r.name, group: 'ST', market: 'KOSPI',
    }))
    const planHalf = buildPlan(half, rows)
    const ratioHalf = planHalf.deactivates.length / planHalf.dbTotal
    check('절반 누락은 임계를 초과한다 → 적용 중단 조건', ratioHalf > deactivateLimitRatio(),
        `${(ratioHalf * 100).toFixed(1)}% > ${(deactivateLimitRatio() * 100).toFixed(1)}%`)

    // 정상적인 상장폐지 규모(1%)
    const most = rows.slice(0, 990).map<MasterRecord>((r) => ({
        code: r.code, isin: '', name: r.name, group: 'ST', market: 'KOSPI',
    }))
    const planMost = buildPlan(most, rows)
    const ratioMost = planMost.deactivates.length / planMost.dbTotal
    check('정상 폐지 규모는 임계 이하 → 적용 진행', ratioMost <= deactivateLimitRatio(),
        `${(ratioMost * 100).toFixed(1)}%`)
}

// ─── 5) 실제 마스터 파일 연동 ─────────────────────────────────
const main = async (): Promise<void> => {
    if (process.argv.includes('--offline')) {
        console.log('\n- 실제 마스터 파일 연동: 생략 (--offline)')
    } else {
        console.log('\n- 실제 KIS 마스터 파일 연동')
        try {
            const { records, perMarket } = await fetchMaster()
            check('KOSPI 레코드 수 정상 범위', (perMarket['KOSPI'] ?? 0) > 2000, `${perMarket['KOSPI']}건`)
            check('KOSDAQ 레코드 수 정상 범위', (perMarket['KOSDAQ'] ?? 0) > 1500, `${perMarket['KOSDAQ']}건`)

            const groups = new Set(records.map((r) => r.group))
            check('증권그룹구분이 2자리로 파싱됨', [...groups].every((g) => /^[A-Z]{2}$/.test(g)),
                [...groups].sort().join(','))
            check('주권(ST)·ETF(EF)가 모두 존재', groups.has('ST') && groups.has('EF'))

            // 오염은 '패딩 공백 여러 칸 + 그룹코드' 형태다. 정상 이름(예: "KODEX 유럽명품TOP10 STOXX")은
            // 공백이 한 칸이므로 공백 2칸 이상을 요구해 오탐을 막는다.
            const polluted = records.filter((r) => /\s{2,}(ST|EF|RT|FS|DR|IF|MF|EN|BC)[A-Z0-9]*\s*[0-9]*$/.test(r.name))
            check('파싱된 이름에 꼬리 코드가 남지 않음', polluted.length === 0,
                polluted.length > 0 ? `예: "${polluted[0].name}"` : '0건')

            const noName = records.filter((r) => r.name.length === 0)
            check('이름 없는 레코드 없음', noName.length === 0, `${noName.length}건`)

            // 클라이언트 formatStockName 이 끝의 ST/EF 를 지우므로, 정상 이름이 그 패턴으로
            // 끝나면 표시가 깎인다. 실제로 그런 종목이 있는지 확인한다.
            const risky = records.filter((r) => /(ST|EF|MF|DR|RF|BC|FS)[A-Z0-9]*$/.test(r.name))
            check('formatStockName 오절삭 위험 종목 점검', true, `${risky.length}건${risky.length ? ` 예: ${risky.slice(0, 3).map((r) => r.name).join(' / ')}` : ''}`)
        } catch (err) {
            check('마스터 파일 다운로드', false, (err as Error).message)
        }
    }

    console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
    console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
    process.exit(fail === 0 ? 0 : 1)
}

main()

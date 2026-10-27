import path from 'path'
import { pathToFileURL } from 'url'

// ─────────────────────────────────────────────────────────────
// 실시간 구독 종목 선택 검증
//
//   실행: cd server && npx ts-node src/test/market/subscribeCodes.test.ts  (Node 22.18+)
//
// 서버가 전체 호출 속도를 10 req/s 로 묶으므로(pollScheduler.test.ts), 구독 종목이
// 많아질수록 종목 하나의 갱신 주기가 비례해 느려진다. 그래서 '무엇을 구독하는가'가
// 체감 실시간성을 좌우한다. 여기서 확인하는 것:
//   1) 보이는 종목만 고르는가 (스크롤로 지나간 종목은 빠지는가)
//   2) 상한을 넘기지 않고, 상한이 걸릴 때 화면 위쪽이 잘려 나가지 않는가
//   3) 가시 정보가 없을 때 폴백이 동작하는가
//   4) 관심종목은 보이지 않아도 포함되는가 / 중복이 제거되는가
//
// 검증 대상은 사본이 아니라 클라이언트가 실제로 번들하는 client/src/utils/subscribeCodes.ts 다.
// 클라이언트 패키지는 ESM 이라 ts-node(CJS) require 로는 못 읽고 서버 tsconfig rootDir 밖이라
// 정적 import 도 안 되므로 Node 기본 import() 로 불러온다(TS 가 require 로 바꾸지 않게 Function 으로 감싼다).
// ─────────────────────────────────────────────────────────────

interface CodeHolder { code: string }
interface SubscribeModule {
  pickSubscribeCodes: (
    ordered: readonly CodeHolder[],
    visible: readonly string[],
    favorites: readonly CodeHolder[],
    cap?: number,
    fallbackTopN?: number,
  ) => string[]
  VISIBLE_SUBSCRIBE_CAP: number
  FALLBACK_TOP_N: number
}

const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<SubscribeModule>
const MODULE_PATH = path.resolve(__dirname, '../../../../client/src/utils/subscribeCodes.ts')

const main = async (): Promise<void> => {
    const { pickSubscribeCodes, VISIBLE_SUBSCRIBE_CAP, FALLBACK_TOP_N } =
        await nativeImport(pathToFileURL(MODULE_PATH).href)

    let pass = 0
    let fail = 0
    const check = (label: string, ok: boolean, detail = ''): void => {
        if (ok) { pass++; console.log(`  ✔ ${label}${detail ? `  (${detail})` : ''}`) }
        else { fail++; console.log(`  ✘ ${label}${detail ? `  (${detail})` : ''}`) }
    }

    const rows = (n: number, offset = 0): CodeHolder[] =>
        Array.from({ length: n }, (_, i) => ({ code: String(100000 + offset + i) }))

    console.log('\n[검증] 실시간 구독 종목 선택')

    // ─── 1) 보이는 종목만 ─────────────────────────────────────
    console.log('\n- 보이는 종목만 구독')
    {
        const ordered = rows(100)
        // 스크롤로 40~59번째가 화면에 들어온 상태
        const visible = ordered.slice(40, 60).map((r) => r.code)
        const got = pickSubscribeCodes(ordered, visible, [])
        check('보이는 20종목만 선택', got.length === 20, `${got.length}종목`)
        check('화면 밖(위쪽) 종목은 제외', !got.includes(ordered[0].code))
        check('화면 밖(아래쪽) 종목은 제외', !got.includes(ordered[99].code))
        check('보이는 구간은 전부 포함', visible.every((c) => got.includes(c)))

        // 스크롤이 더 내려가 다른 구간이 보이면 교체된다
        const next = pickSubscribeCodes(ordered, ordered.slice(70, 80).map((r) => r.code), [])
        check('스크롤하면 구독 집합이 교체됨',
            next.every((c) => !visible.includes(c)) && next.length === 10, `${next.length}종목`)
    }

    // ─── 2) 상한 ──────────────────────────────────────────────
    console.log('\n- 구독 상한')
    {
        const ordered = rows(400)
        const visible = ordered.map((r) => r.code)           // 전부 보인다고 주장하는 비정상 입력
        const got = pickSubscribeCodes(ordered, visible, [])
        check(`상한 ${VISIBLE_SUBSCRIBE_CAP} 를 넘지 않음`, got.length === VISIBLE_SUBSCRIBE_CAP, `${got.length}종목`)
        check('상한이 걸리면 화면 위쪽(거래량 상위)부터 남긴다',
            got[0] === ordered[0].code && got[got.length - 1] === ordered[VISIBLE_SUBSCRIBE_CAP - 1].code,
            `${got[0]} … ${got[got.length - 1]}`)

        // 교차 이벤트가 들어온 순서는 화면 순서와 다르다 — 그래도 위쪽이 남아야 한다
        const shuffled = [...visible].reverse()
        const got2 = pickSubscribeCodes(ordered, shuffled, [])
        check('교차 이벤트 순서가 뒤바뀌어도 결과가 같다',
            got2.join(',') === got.join(','))

        const got3 = pickSubscribeCodes(ordered, visible, [], 5)
        check('상한을 낮추면 그만큼만', got3.length === 5, `${got3.length}종목`)
    }

    // ─── 3) 폴백 ──────────────────────────────────────────────
    console.log('\n- 가시 정보가 없을 때의 폴백')
    {
        const ordered = rows(100)
        const got = pickSubscribeCodes(ordered, [], [])
        check(`가시 정보 0건 → 상위 ${FALLBACK_TOP_N}개`, got.length === FALLBACK_TOP_N, `${got.length}종목`)
        check('폴백도 거래량 상위부터', got[0] === ordered[0].code)

        const few = pickSubscribeCodes(rows(3), [], [])
        check('목록이 폴백 개수보다 적으면 있는 만큼', few.length === 3, `${few.length}종목`)
        check('목록이 비면 빈 결과', pickSubscribeCodes([], [], []).length === 0)
    }

    // ─── 4) 관심종목 / 중복 ───────────────────────────────────
    console.log('\n- 관심종목과 중복 제거')
    {
        const ordered = rows(100)
        const visible = ordered.slice(0, 10).map((r) => r.code)
        const favs = [{ code: '900001' }, { code: '900002' }]
        const got = pickSubscribeCodes(ordered, visible, favs)
        check('관심종목은 보이지 않아도 포함', got.includes('900001') && got.includes('900002'))
        check('보이는 종목 + 관심종목', got.length === 12, `${got.length}종목`)

        // 관심종목이 화면에도 보이는 경우
        const overlap = pickSubscribeCodes(ordered, visible, [{ code: ordered[0].code }])
        check('중복은 한 번만', overlap.length === 10 && new Set(overlap).size === 10, `${overlap.length}종목`)

        // 상한을 넘겨도 관심종목은 보장한다
        const capped = pickSubscribeCodes(ordered, ordered.map((r) => r.code), favs, 5)
        check('상한 적용 후에도 관심종목은 포함', capped.includes('900001') && capped.length === 7,
            `${capped.length}종목`)
    }

    // ─── 5) 검색 시나리오 ────────────────────────────────────
    console.log('\n- 검색 결과 구독')
    {
        // 검색으로 3종목만 남은 경우 — 전부 화면에 보인다
        const found = rows(3, 500)
        const got = pickSubscribeCodes(found, found.map((r) => r.code), [])
        check('검색 결과 3종목 전부 구독', got.length === 3, `${got.length}종목`)
        // 서버 상한 10 req/s, 종목별 하한 1초 → 3종목이면 1초 주기
        check('3종목이면 종목당 1초 주기(하한)', Math.max(1000, got.length * 100) === 1000)
    }

    console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
    console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
    process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error('실행 실패:', err?.message ?? err)
    process.exit(1)
})

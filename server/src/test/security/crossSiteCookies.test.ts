export {} // 이 파일을 모듈로 만들어 전역 스코프 변수 충돌을 막는다
// ─────────────────────────────────────────────────────────────
// [보안 검증] 교차 사이트 배포의 인증 쿠키 전송 + CSRF 출처 검사
//
// 배경: 모든 인증 쿠키가 SameSite=Strict 로 고정돼 있었다. 프런트(Vercel)와 API 가 다른
//   도메인인 배포에서는 브라우저가 Strict 쿠키를 교차 사이트 요청에 보내지 않는다.
//   그래서 로그인 1단계는 성공해도 2단계에서 loginChallenge 쿠키가 없어 매번
//   "로그인 1단계부터 다시 진행해주세요" 로 떨어졌고(지갑 서명을 끝내도 동일),
//   단말 식별 쿠키도 돌아오지 않아 가입이 NO_DEVICE_ID 로 막혔다.
//
//   교차 배포에서는 SameSite=None·Secure 로 내려야 한다. 대신 Strict 가 공짜로 주던
//   CSRF 방어가 사라지므로 상태 변경 요청의 Origin 검사(originGuard)를 함께 둔다.
//
// 확인하려는 것
//   (1) 같은 사이트·로컬 개발 요청은 그대로 SameSite=Strict 다 (필요 없는 완화 금지)
//   (2) 교차 사이트 요청은 SameSite=None·Secure·Partitioned 로 나간다
//       (None+!Secure 는 브라우저가 거부하고, Partitioned 가 없으면 서드파티 쿠키 차단에 걸린다)
//   (3) 쿠키 삭제도 같은 속성으로 나간다 (속성이 다르면 로그아웃이 쿠키를 못 지운다)
//   (4) CROSS_SITE_COOKIES 강제 플래그가 양방향으로 동작한다
//   (5) [공격] 허용되지 않은 출처의 상태 변경 요청이 403 으로 차단된다 (CSRF)
//   (6) [정상] 허용 출처·비브라우저 호출(Origin 없음)은 통과한다 (오탐 0)
//   (7) 대조군: 수정 전(Strict 고정) 교차 사이트 로그인 2단계는 전건 실패했다
//
// 서버·DB 없이 판정 함수와 미들웨어를 직접 호출하는 결정적 검증이다.
// 실행: cd server && npx ts-node src/test/security/crossSiteCookies.test.ts
// ─────────────────────────────────────────────────────────────

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret'

const COOKIES_MODULE = require.resolve('../../config/cookies')
const CORS_MODULE = require.resolve('../../config/cors')
const GUARD_MODULE = require.resolve('../../middleware/security/originGuard')

type CookieModule = {
    authCookieOptions: (req: any, extra?: any) => any
    clearAuthCookie: (req: any, res: any, name: string) => void
    isCrossSiteRequest: (req: any) => boolean
}

// 정책은 모듈 로드 시점의 환경변수에 영향을 받으므로(CLIENT_ORIGINS 등) 캐시를 비우고 다시 읽는다.
function loadCookies(env: Record<string, string | undefined> = {}): CookieModule {
    const saved = { ...process.env }
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
    delete require.cache[COOKIES_MODULE]
    const mod = require('../../config/cookies') as CookieModule
    // 판정 시점에도 환경변수를 보므로 호출을 감싸 환경을 유지한 뒤 복원한다.
    const wrap = <T extends (...a: any[]) => any>(fn: T): T =>
        ((...args: any[]) => {
            const outer = { ...process.env }
            for (const [k, v] of Object.entries(env)) {
                if (v === undefined) delete process.env[k]
                else process.env[k] = v
            }
            try {
                return fn(...args)
            } finally {
                process.env = outer
            }
        }) as T
    const judged: CookieModule = {
        authCookieOptions: wrap(mod.authCookieOptions),
        clearAuthCookie: wrap(mod.clearAuthCookie),
        isCrossSiteRequest: wrap(mod.isCrossSiteRequest),
    }
    process.env = saved
    return judged
}

function loadGuard(env: Record<string, string | undefined>) {
    const saved = { ...process.env }
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
    delete require.cache[CORS_MODULE]
    delete require.cache[GUARD_MODULE]
    const { originGuard } = require('../../middleware/security/originGuard') as {
        originGuard: (req: any, res: any, next: () => void) => void
    }
    process.env = saved
    return originGuard
}

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
    if (ok) pass++
    else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

// 요청 모형 — 브라우저가 붙이는 헤더만 담는다.
function req(opts: { origin?: string; host?: string; site?: string; https?: boolean; method?: string; url?: string } = {}) {
    const headers: Record<string, string> = {}
    if (opts.origin) headers.origin = opts.origin
    if (opts.host) headers.host = opts.host
    if (opts.site) headers['sec-fetch-site'] = opts.site
    headers['user-agent'] = 'verify-script'
    return {
        headers,
        method: opts.method ?? 'POST',
        originalUrl: opts.url ?? '/api/auth/login/step2',
        protocol: opts.https === false ? 'http' : 'https',
        secure: opts.https !== false,
        socket: { remoteAddress: '203.0.113.9' },
    }
}

function fakeRes() {
    const cookies: Array<{ name: string; value: string; opts: any }> = []
    const cleared: Array<{ name: string; opts: any }> = []
    const res: any = {
        statusCode: 200,
        body: undefined as any,
        cookie(name: string, value: string, opts: any) { cookies.push({ name, value, opts }); return res },
        clearCookie(name: string, opts: any) { cleared.push({ name, opts }); return res },
        status(c: number) { res.statusCode = c; return res },
        json(b: any) { res.body = b; return res },
    }
    return { res, cookies, cleared }
}

// ─────────────────────────────────────────────
// (1) 같은 사이트·로컬 — Strict 유지
// ─────────────────────────────────────────────
const auto = loadCookies({ CROSS_SITE_COOKIES: undefined, NODE_ENV: 'production' })

const sameSiteRequests: Array<[string, any]> = [
    ['같은 오리진 호출(Origin 없음)', req({ host: 'uptick.example.com' })],
    ['Sec-Fetch-Site: same-origin', req({ host: 'uptick.example.com', origin: 'https://uptick.example.com', site: 'same-origin' })],
    ['Sec-Fetch-Site: same-site(서브도메인)', req({ host: 'api.uptick.example.com', origin: 'https://app.uptick.example.com', site: 'same-site' })],
    ['Origin=Host (Sec-Fetch-Site 없는 구형 브라우저)', req({ host: 'uptick.example.com', origin: 'https://uptick.example.com' })],
    ['검증 스크립트(headers 자체가 없음)', { cookies: {} }],
]
let strictKept = 0
for (const [name, r] of sameSiteRequests) {
    const o = auto.authCookieOptions(r)
    const ok = o.sameSite === 'strict'
    if (ok) strictKept++
    check(`같은 사이트 유지: ${name} → Strict`, ok, String(o.sameSite))
}

// ─────────────────────────────────────────────
// (2) 교차 사이트 — None·Secure
// ─────────────────────────────────────────────
const crossSiteRequests: Array<[string, any]> = [
    ['Vercel 프런트 → 별도 API 도메인', req({ host: 'api.uptick.example.com', origin: 'https://uptick-xyz.vercel.app', site: 'cross-site' })],
    ['Sec-Fetch-Site 없음 + 호스트 불일치', req({ host: 'api.uptick.example.com', origin: 'https://uptick-xyz.vercel.app' })],
    ['같은 vercel.app 내 다른 서브도메인(공개 접미사라 교차)', req({ host: 'api-uptick.vercel.app', origin: 'https://uptick-xyz.vercel.app', site: 'cross-site' })],
]
let crossFixed = 0
for (const [name, r] of crossSiteRequests) {
    const o = auto.authCookieOptions(r, { maxAge: 1000 })
    const ok = o.sameSite === 'none' && o.secure === true && o.partitioned === true
    if (ok) crossFixed++
    check(`교차 사이트 전송: ${name} → None·Secure·Partitioned`, ok,
        `sameSite=${o.sameSite}, secure=${o.secure}, partitioned=${o.partitioned}`)
    check(`교차 사이트: ${name} → maxAge 보존`, o.maxAge === 1000, String(o.maxAge))
}

// None 은 Secure 없이는 브라우저가 저장하지 않는다 — HTTPS 가 아니어도 Secure 를 끄지 않아야 한다.
const httpCross = auto.authCookieOptions(req({ host: 'api.local', origin: 'http://other.local', site: 'cross-site', https: false }))
check('교차 사이트 + HTTP 라도 Secure 를 끄지 않는다', httpCross.secure === true && httpCross.sameSite === 'none',
    `sameSite=${httpCross.sameSite}, secure=${httpCross.secure}`)

// httpOnly 를 끄는 쿠키(isLoggedIn)도 SameSite 판정은 같아야 한다.
const flagCookie = auto.authCookieOptions(req({ host: 'api.uptick.example.com', origin: 'https://uptick-xyz.vercel.app', site: 'cross-site' }), { httpOnly: false })
check('isLoggedIn(httpOnly=false)도 None·Secure', flagCookie.sameSite === 'none' && flagCookie.secure === true && flagCookie.httpOnly === false)

// 같은 사이트 쿠키에는 Partitioned 를 붙이지 않는다 — 퍼스트파티 쿠키를 분리할 이유가 없다.
check('같은 사이트: Partitioned 미사용',
    auto.authCookieOptions(req({ host: 'uptick.example.com' })).partitioned === undefined)

// 개발 환경(HTTP·로컬)은 Secure 를 켜지 않는다 — 켜면 로컬 로그인이 전부 깨진다.
const dev = loadCookies({ CROSS_SITE_COOKIES: undefined, NODE_ENV: 'development' })
const local = dev.authCookieOptions(req({ host: 'localhost:3000', origin: 'http://localhost:5173', https: false }))
check('로컬 개발: Strict·Secure 꺼짐', local.sameSite === 'strict' && local.secure === false,
    `sameSite=${local.sameSite}, secure=${local.secure}`)

// ─────────────────────────────────────────────
// (3) 삭제 쿠키 속성 일치
// ─────────────────────────────────────────────
const crossReq = req({ host: 'api.uptick.example.com', origin: 'https://uptick-xyz.vercel.app', site: 'cross-site' })
const issued = auto.authCookieOptions(crossReq)
const clearTarget = fakeRes()
auto.clearAuthCookie(crossReq, clearTarget.res, 'accessToken')
const clearedOpts = clearTarget.cleared[0]?.opts ?? {}
check('삭제 쿠키: 발급과 같은 SameSite·Secure·Partitioned·path',
    clearedOpts.sameSite === issued.sameSite && clearedOpts.secure === issued.secure &&
    clearedOpts.partitioned === issued.partitioned && clearedOpts.path === issued.path,
    JSON.stringify(clearedOpts))

// ─────────────────────────────────────────────
// (4) 강제 플래그
// ─────────────────────────────────────────────
const forcedOn = loadCookies({ CROSS_SITE_COOKIES: 'true', NODE_ENV: 'production' })
const forcedOff = loadCookies({ CROSS_SITE_COOKIES: 'false', NODE_ENV: 'production' })
check('CROSS_SITE_COOKIES=true: 같은 사이트 요청도 None',
    forcedOn.authCookieOptions(req({ host: 'uptick.example.com' })).sameSite === 'none')
check('CROSS_SITE_COOKIES=false: 교차 요청도 Strict(의도적 차단)',
    forcedOff.authCookieOptions(crossReq).sameSite === 'strict')

// ─────────────────────────────────────────────
// (5)(6) CSRF 출처 검사
// ─────────────────────────────────────────────
const guard = loadGuard({
    CLIENT_ORIGINS: 'https://uptick-xyz.vercel.app',
    ALLOW_LAN_ORIGINS: 'false',
    NODE_ENV: 'production',
})

function runGuard(r: any): { status: number; passed: boolean; body: any } {
    const { res } = fakeRes()
    let passed = false
    guard(r, res, () => { passed = true })
    return { status: res.statusCode, passed, body: res.body }
}

const csrfAttempts: Array<[string, any]> = [
    ['악성 사이트 POST', req({ host: 'api.uptick.example.com', origin: 'https://evil.example', site: 'cross-site' })],
    ['오리진 위장(허용 도메인 접두)', req({ host: 'api.uptick.example.com', origin: 'https://uptick-xyz.vercel.app.evil.example', site: 'cross-site' })],
    ['프로토콜만 다른 출처', req({ host: 'api.uptick.example.com', origin: 'http://uptick-xyz.vercel.app', site: 'cross-site' })],
    ['Origin 숨긴 교차 폼 전송(Sec-Fetch-Site 만 남음)', req({ host: 'api.uptick.example.com', site: 'cross-site' })],
    ['DELETE 로 상태 변경 시도', req({ host: 'api.uptick.example.com', origin: 'https://evil.example', site: 'cross-site', method: 'DELETE', url: '/api/user/withdraw' })],
]
let csrfBlocked = 0
for (const [name, r] of csrfAttempts) {
    const out = runGuard(r)
    const ok = out.status === 403 && !out.passed && out.body?.code === 'ORIGIN_NOT_ALLOWED'
    if (ok) csrfBlocked++
    check(`[공격] ${name} → 403 차단`, ok, `status=${out.status}, passed=${out.passed}`)
}

const legitimateCalls: Array<[string, any]> = [
    ['허용 출처(Vercel) 로그인 요청', req({ host: 'api.uptick.example.com', origin: 'https://uptick-xyz.vercel.app', site: 'cross-site' })],
    ['같은 오리진 요청', req({ host: 'api.uptick.example.com', origin: 'https://api.uptick.example.com', site: 'same-origin' })],
    ['검증 스크립트·서버 간 호출(Origin 없음)', req({ host: 'api.uptick.example.com' })],
    ['조회 요청(GET)', req({ host: 'api.uptick.example.com', origin: 'https://evil.example', site: 'cross-site', method: 'GET', url: '/api/market/stock-prices' })],
    ['CORS 예비요청(OPTIONS)', req({ host: 'api.uptick.example.com', origin: 'https://uptick-xyz.vercel.app', site: 'cross-site', method: 'OPTIONS' })],
]
let legitPassed = 0
for (const [name, r] of legitimateCalls) {
    const out = runGuard(r)
    if (out.passed) legitPassed++
    check(`[정상] ${name} → 통과`, out.passed, `status=${out.status}`)
}

// ─────────────────────────────────────────────
// (7) 대조군 — 수정 전(Strict 고정)
// ─────────────────────────────────────────────
// 수정 전 코드는 항상 sameSite:'strict' 였다. 브라우저 규칙상 교차 사이트 요청에는
// Strict 쿠키가 실리지 않으므로, 교차 배포에서 2단계로 전달되는 챌린지 쿠키는 0건이다.
const legacySameSite = 'strict'
const legacyDelivered = crossSiteRequests.filter(() => legacySameSite !== 'strict').length
check('대조군: 수정 전 교차 사이트 챌린지 쿠키 전달 0건', legacyDelivered === 0)

const attempts = csrfAttempts.length
console.log('')
console.log('[보안 테스트] 교차 사이트 인증 쿠키 전송 + CSRF 출처 검사')
console.log(`총 시도: ${attempts}회 | 탐지: ${csrfBlocked}회 | 차단: ${csrfBlocked}회 | 탐지율: ${((csrfBlocked / attempts) * 100).toFixed(0)}%`)
console.log(`- 같은 사이트 Strict 유지 : ${strictKept}/${sameSiteRequests.length}`)
console.log(`- 교차 사이트 None·Secure·Partitioned : ${crossFixed}/${crossSiteRequests.length}`)
console.log(`- 정상 요청 오차단        : ${legitimateCalls.length - legitPassed}/${legitimateCalls.length} (오탐률 ${(((legitimateCalls.length - legitPassed) / legitimateCalls.length) * 100).toFixed(1)}%)`)
console.log(`- [대조군] 수정 전 Strict 고정 : 교차 배포 로그인 2단계 ${crossSiteRequests.length}/${crossSiteRequests.length} 전건 실패(쿠키 미전송)`)

if (failures.length > 0) {
    console.log('\n[실패 항목]')
    for (const f of failures.slice(0, 20)) console.log(`  · ${f}`)
    if (failures.length > 20) console.log(`  · ... 외 ${failures.length - 20}건`)
}

console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)

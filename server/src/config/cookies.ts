import type { CookieOptions, Request, Response } from 'express'

// ─────────────────────────────────────────────────────────────
// 인증 쿠키 속성 결정
//
// 모든 인증 쿠키(로그인 챌린지·액세스·리프레시·신뢰 기기·단말 식별자)는 SameSite=Strict
// 로 고정돼 있었다. 프런트와 API 가 같은 호스트일 때는 맞는 선택이지만, 프런트를 Vercel 에
// 올리고 API 를 다른 도메인에서 서비스하면 **브라우저가 그 쿠키를 아예 보내지 않는다.**
// 그 결과 1단계는 성공하는데 2단계에서 loginChallenge 쿠키가 없어 매번
// "로그인 1단계부터 다시 진행해주세요" 로 떨어졌고(지갑 서명을 끝내도 동일),
// 같은 이유로 단말 식별 쿠키도 돌아오지 않아 가입이 NO_DEVICE_ID 로 막혔다.
//
// 그래서 교차 사이트 배포에서는 SameSite=None + Secure 로 내려야 한다. 대신 Strict 가
// 제공했던 CSRF 방어가 빠지므로, 상태 변경 요청의 Origin 검사(originGuard)를 함께 둔다.
// 교차 여부는 요청마다 판정한다 — 같은 도메인 배포·로컬 개발은 그대로 Strict 를 유지해
// 필요 없는 완화를 하지 않는다.
//
//   CROSS_SITE_COOKIES=true|false  자동 판정을 쓰지 않고 강제할 때만 지정한다.
//                                  (프록시가 Origin·Sec-Fetch-Site 를 지우는 환경 대비)
// ─────────────────────────────────────────────────────────────

const COOKIE_PATH = '/'

let warnedInsecureCrossSite = false

function envFlag(name: string): boolean | undefined {
    const raw = process.env[name]?.trim().toLowerCase()
    if (raw === 'true') return true
    if (raw === 'false') return false
    return undefined
}

function hostnameOf(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) return ''
    try {
        return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase()
    } catch {
        return ''
    }
}

// 이 요청이 교차 사이트(프런트 도메인 ≠ API 도메인)인가.
export function isCrossSiteRequest(req: Request): boolean {
    const forced = envFlag('CROSS_SITE_COOKIES')
    if (forced !== undefined) return forced

    // 검증 스크립트의 가짜 req 처럼 headers 가 없을 수도 있다 — 없으면 같은 사이트로 본다.
    const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>

    // Sec-Fetch-Site 는 브라우저가 직접 붙이므로 Host 비교보다 정확하다.
    // 같은 사이트의 다른 서브도메인('same-site')은 Strict 쿠키가 그대로 전송되니 교차가 아니다.
    const site = headers['sec-fetch-site']
    if (typeof site === 'string' && site.length > 0) return site === 'cross-site'

    // Origin 이 없는 요청은 브라우저가 아니다(서버 간 호출·검증 스크립트·curl).
    const originHost = hostnameOf(headers.origin)
    if (!originHost) return false
    const serverHost = hostnameOf(headers.host)
    if (!serverHost) return false
    return originHost !== serverHost
}

// trust proxy 가 켜져 있어 req.protocol 이 x-forwarded-proto 를 반영한다.
function isSecureRequest(req: Request): boolean {
    return req.secure || req.protocol === 'https'
}

export function authCookieOptions(req: Request, extra: CookieOptions = {}): CookieOptions {
    const crossSite = isCrossSiteRequest(req)

    if (crossSite && !isSecureRequest(req) && !warnedInsecureCrossSite) {
        warnedInsecureCrossSite = true
        console.warn(
            '[cookies] 교차 사이트 요청이지만 HTTPS 가 아니다 — 브라우저는 SameSite=None 쿠키를 ' +
            'Secure 없이 저장하지 않는다. API 를 HTTPS 로 서비스하거나 프런트와 같은 도메인에 두어야 한다.',
        )
    }

    return {
        path: COOKIE_PATH,
        httpOnly: true,
        // SameSite=None 은 Secure 가 없으면 브라우저가 거부한다 — 교차 배포에서는 항상 켠다.
        secure: crossSite ? true : process.env.NODE_ENV === 'production',
        sameSite: crossSite ? 'none' : 'strict',
        // CHIPS — 교차 사이트 쿠키는 서드파티 쿠키로 취급돼 차단될 수 있다(크롬 단계적 폐지,
        // 사파리 ITP). Partitioned 는 "이 상위 사이트 안에서만 쓰는 쿠키" 로 분리 저장시켜
        // 그 차단에서 빠지게 한다. 우리 쿠키의 소비자는 프런트 한 곳뿐이라 분리로 잃는 것이 없고,
        // 속성을 모르는 구형 브라우저는 무시하므로 기존 동작으로 되돌아간다.
        ...(crossSite ? { partitioned: true } : {}),
        ...extra,
    }
}

// 쿠키 삭제도 Set-Cookie 다 — 발급 때와 속성(path·SameSite·Secure)이 같아야 브라우저가 받아들인다.
export function clearAuthCookie(req: Request, res: Response, name: string): void {
    const { path, httpOnly, secure, sameSite, partitioned } = authCookieOptions(req)
    res.clearCookie(name, { path, httpOnly, secure, sameSite, partitioned })
}

export function describeCookiePolicy(): string {
    const forced = envFlag('CROSS_SITE_COOKIES')
    if (forced === true) return '인증 쿠키: SameSite=None·Secure 강제 (CROSS_SITE_COOKIES=true)'
    if (forced === false) return '인증 쿠키: SameSite=Strict 강제 (CROSS_SITE_COOKIES=false)'
    return '인증 쿠키: 요청별 자동 판정 (같은 사이트 → Strict / 교차 사이트 → None·Secure)'
}

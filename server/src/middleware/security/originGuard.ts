import { Request, Response, NextFunction } from 'express'
import { isAllowedOrigin } from '../../config/cors'
import { logAnomaly } from '../../services/auth/anomalyService'

// ─────────────────────────────────────────────────────────────
// 상태 변경 요청의 출처 검사 (CSRF 방어)
//
// 교차 사이트 배포에서는 인증 쿠키를 SameSite=None 으로 내려야 브라우저가 전송한다
// (config/cookies.ts 참고). Strict 가 자동으로 막아주던 "다른 사이트가 사용자의 쿠키로
// 우리 API 를 호출하는 요청"을 여기서 명시적으로 막는다.
//
// 판정 규칙
//   · GET·HEAD·OPTIONS 는 통과 — 상태를 바꾸지 않고, OPTIONS 는 CORS 예비요청이다.
//   · 같은 오리진·같은 사이트 요청은 통과 — CSRF 가 성립하지 않는다. API 도메인에서
//     직접 호출하는 경로가 CLIENT_ORIGINS 에 없다는 이유로 막히면 안 된다.
//   · 교차 출처면 CORS 허용목록과 같은 기준으로 검사한다. 브라우저는 교차 사이트
//     POST(폼 전송 포함)에 항상 Origin 을 붙이므로 이 검사로 충분하다.
//   · Origin 이 없으면 브라우저 교차 요청이 아니다(서버 간 호출·검증 스크립트·curl).
//     단 Sec-Fetch-Site 가 cross-site 라고 말하면 그 신호를 믿고 막는다.
//
// cors 미들웨어도 허용되지 않은 Origin 을 걷어내지만, 그 경로는 500 으로 떨어지고
// anomaly_logs 에 아무 기록이 남지 않는다. 여기서 403 으로 정규화하고 탐지로 기록한다.
// ─────────────────────────────────────────────────────────────

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function hostnameOf(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0) return ''
    try {
        return new URL(value.includes('://') ? value : `https://${value}`).hostname.toLowerCase()
    } catch {
        return ''
    }
}

export function originGuard(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) return next()

    const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>
    const origin = typeof headers.origin === 'string' ? headers.origin : ''
    const site = headers['sec-fetch-site']

    // 브라우저가 스스로 같은 오리진·같은 사이트라고 표시한 요청은 CSRF 가 아니다.
    if (site === 'same-origin' || site === 'same-site' || site === 'none') return next()
    const originHost = hostnameOf(origin)
    if (originHost && originHost === hostnameOf(headers.host)) return next()

    const allowed = origin ? isAllowedOrigin(origin) : site !== 'cross-site'
    if (allowed) return next()

    const ip =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
        req.socket.remoteAddress ||
        'unknown'

    // 요청 본문 위·변조와 같은 계열(허용되지 않은 출처가 사용자 쿠키로 보낸 요청)이라
    // 기존 유형을 쓴다. 새 ENUM 값은 마이그레이션·대시보드 동기화가 필요해 과하다.
    void logAnomaly({
        email: '',
        ip,
        userAgent: req.headers['user-agent'] || 'unknown',
        type: 'REQUEST_TAMPERING',
        action: 'BLOCK',
        detail: `[CSRF] 허용되지 않은 출처의 상태 변경 요청 — ${req.method} ${req.originalUrl} (origin: ${origin || '없음'}, sec-fetch-site: ${site ?? '없음'})`,
    }).catch((err) => console.error('[originGuard] 탐지 기록 실패:', err))

    res.status(403).json({ code: 'ORIGIN_NOT_ALLOWED', message: '허용되지 않은 출처의 요청입니다.' })
}

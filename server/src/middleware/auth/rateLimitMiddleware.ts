import { Request, Response, NextFunction } from 'express'
import { logAnomaly } from '../../services/auth/anomalyService'

interface RateLimitEntry {
  count: number
  firstAttempt: number
  blockedUntil?: number
}

// IP 기반 인메모리 저장소
const loginStore = new Map<string, RateLimitEntry>()
const emailStore = new Map<string, RateLimitEntry>()
const smsStore = new Map<string, RateLimitEntry>()
const communityStore = new Map<string, RateLimitEntry>()

const getIp = (req: Request): string =>
  (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
  req.socket.remoteAddress ||
  'unknown'

const createLimiter = (
  store: Map<string, RateLimitEntry>,
  options: {
    maxAttempts: number
    windowMs: number
    blockMs: number
    message: string
    /**
     * 한도 초과로 요청을 막을 때 호출된다. 리미터가 막은 요청은 이상탐지 계층에
     * 도달하지 못하므로, 여기서 기록하지 않으면 대량 시도가 감사 로그에 전혀
     * 남지 않는 관측 공백이 생긴다.
     */
    onBlock?: (ip: string, req: Request) => void
  },
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = getIp(req)
    const now = Date.now()
    const entry = store.get(ip)

    // 차단 상태 확인
    if (entry?.blockedUntil && now < entry.blockedUntil) {
      const remaining = Math.ceil((entry.blockedUntil - now) / 1000 / 60)
      options.onBlock?.(ip, req)
      return res.status(429).json({
        message: `${options.message} (${remaining}분 후 재시도 가능)`,
      })
    }

    // 윈도우 초과 시 초기화
    if (!entry || now - entry.firstAttempt > options.windowMs) {
      store.set(ip, { count: 1, firstAttempt: now })
      return next()
    }

    // 시도 횟수 초과 시 차단
    if (entry.count >= options.maxAttempts) {
      store.set(ip, {
        ...entry,
        blockedUntil: now + options.blockMs,
      })
      options.onBlock?.(ip, req)
      return res.status(429).json({ message: options.message })
    }

    entry.count++
    store.set(ip, entry)
    next()
  }
}

// 로그인 Rate Limiter: 5회 실패 시 15분 차단
export const loginRateLimiter = createLimiter(loginStore, {
  maxAttempts: 15,
  windowMs: 15 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
  message: '로그인 시도 횟수를 초과했습니다. 15분 후 다시 시도해주세요',
  // 한도 초과 사실 자체를 남긴다. 응답을 지연시키지 않도록 대기하지 않는다.
  onBlock: (ip, req) => {
    void logAnomaly({
      email: typeof req.body?.email === 'string' ? req.body.email : '',
      ip,
      userAgent: req.headers['user-agent'],
      type: 'BRUTE_FORCE',
      action: 'BLOCK',
      detail: `로그인 요청 한도 초과(IP당 15회/15분) → 레이트 리미터 차단`,
    }).catch(() => undefined)
  },
})

// 이메일 인증 Rate Limiter: 분당 3회 제한
export const emailCodeRateLimiter = createLimiter(emailStore, {
  maxAttempts: 3,
  windowMs: 60 * 1000,
  blockMs: 60 * 1000,
  message: '이메일 인증 요청이 너무 많습니다. 잠시 후 다시 시도해주세요',
})

// 커뮤니티 쓰기 Rate Limiter: 분당 20회 초과 시 5분 차단 (글·댓글·추천·삭제 — 도배 방지)
export const communityWriteRateLimiter = createLimiter(communityStore, {
  maxAttempts: 20,
  windowMs: 60 * 1000,
  blockMs: 5 * 60 * 1000,
  message: '커뮤니티 요청이 너무 많습니다. 잠시 후 다시 시도해주세요',
})

// SMS 인증 Rate Limiter: 분당 3회 제한
export const smsCodeRateLimiter = createLimiter(smsStore, {
  maxAttempts: 3,
  windowMs: 60 * 1000,
  blockMs: 60 * 1000,
  message: 'SMS 인증 요청이 너무 많습니다. 잠시 후 다시 시도해주세요',
})
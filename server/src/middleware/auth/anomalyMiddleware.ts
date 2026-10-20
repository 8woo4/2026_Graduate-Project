import { Request, Response, NextFunction } from 'express'
import { analyzeLoginAttempt, isAccountLocked, recordBotBehavior, recordBiometricMismatch } from '../../services/auth/anomalyService'
import { processLoginBehavior } from '../../services/auth/behaviorProfileService'
import { checkIPAbuse } from '../../services/auth/abuseIPDBService'
import { blockIP } from '../security/ipBlockMiddleware'
import AnomalyLog from '../../models/auth/AnomalyLog'
import { getClientIp } from '../../utils/getClientIp'
import { LOGIN_CHALLENGE_COOKIE, LOGIN_CHALLENGE_TTL_MS } from '../../services/auth/loginChallengeService'
import { authCookieOptions } from '../../config/cookies'
import {
  assessRisk,
  collectRiskSignals,
  decideAuthRequirement,
  detectBotBehavior,
  parseBehaviorData,
} from '../../services/auth/riskEngine'

// ─────────────────────────────────────────────
// 0. AbuseIPDB — 알려진 악성 IP 차단
// login/step1 및 register 앞에 배치
// ─────────────────────────────────────────────
export async function checkAbuseIP(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = getClientIp(req)

  try {
    const { isAbusive, score } = await checkIPAbuse(ip)
    // 차단 임계 미만이라도 점수는 위험 신호다(회색 지대). 여기서 이미 외부 API 를
    // 호출했으므로 점수를 넘겨 적응형 인증이 재조회 없이 재사용하게 한다.
    res.locals.abuseScore = score
    if (!isAbusive) {
      next()
      return
    }

    blockIP(ip)

    await AnomalyLog.create({
      user_id: null,
      email: req.body.email ?? null,
      ip,
      user_agent: req.headers['user-agent'] ?? null,
      anomaly_type: 'ABUSE_IP',
      action: 'BLOCK',
      detail: `AbuseIPDB 악성 IP 탐지: 점수 ${score}/100`,
      country: null,
    })

    res.status(403).json({
      message: '비정상적인 접근으로 차단되었습니다.',
      code: 'IP_BLOCKED',
    })
  } catch {
    next() // fail-open: AbuseIPDB 장애 시 정상 처리
  }
}

// ─────────────────────────────────────────────
// 1. 로그인 전 — 계정 잠금 확인
// authRouter의 /login/step1 앞에 배치
//
// 잠금 여부를 여기서 응답으로 알려주면, 비밀번호를 모르는 공격자도 문구만 보고
// 그 이메일의 가입 여부를 알 수 있다(계정 열거). 그래서 이 미들웨어는 잠금 상태를
// res.locals 에 실어 넘기기만 하고 차단하지 않는다. 실제 거부는 비밀번호 검증을
// 통과한 뒤 authService.loginStep1 이 수행한다.
// ─────────────────────────────────────────────
export async function checkAccountLock(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // 로그인 아이디가 이메일일 때만 미리 조회한다(휴대폰은 1단계에서 계정을 해석한다). 이 값은 안내용이며
  // 실제 거부는 비밀번호 검증 이후 authService.loginStep1 이 한다.
  const email = typeof req.body.loginId === 'string' && req.body.loginId.includes('@')
    ? req.body.loginId
    : req.body.email

  if (!email || typeof email !== 'string') {
    next()
    return
  }

  try {
    const { locked } = await isAccountLocked(email)
    res.locals.accountLocked = locked
    next()
  } catch (err) {
    console.error('[anomalyMiddleware] checkAccountLock error:', err)
    next()
  }
}

// 1단계 성공 응답에만 2단계 챌린지 쿠키를 싣는다. 차단 응답(403)에는 절대 싣지 않는다.
function attachLoginChallenge(req: Request, res: Response): void {
  const token = res.locals.loginChallenge
  if (!res.locals.loginSuccess || typeof token !== 'string') return
  res.cookie(LOGIN_CHALLENGE_COOKIE, token, authCookieOptions(req, {
    maxAge: LOGIN_CHALLENGE_TTL_MS,
  }))
}

// ─────────────────────────────────────────────
// 2. 로그인 후 — 이상탐지 분석
// authRouter의 /login/step1,2 핸들러 뒤에 배치
// authController에서 res.locals 설정 필요:
//   res.locals.loginSuccess   = true/false
//   res.locals.loginEmail     = email
//   res.locals.loginUserId    = userId (성공 시)
//   res.locals.responseData   = 응답 JSON 객체
//   res.locals.responseStatus = HTTP 상태코드
// ─────────────────────────────────────────────
export async function analyzeAfterLogin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { loginSuccess, loginEmail, loginUserId, responseData, responseStatus } = res.locals

  // 로그인 아이디가 없으면 이상탐지 대상 아님 — 그대로 응답
  if (!loginEmail && !res.locals.loginKey) {
    res.status(responseStatus ?? 400).json(responseData)
    return
  }

  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'

  try {
    const anomalyResult = await analyzeLoginAttempt({
      userId: loginUserId,
      email: loginEmail,
      ip,
      userAgent: req.headers['user-agent'],
      success: loginSuccess ?? false,
      isStep2: res.locals.isStep2 ?? false,
      deviceHash: res.locals.deviceHash,
      loginKey: res.locals.loginKey,
      accountId: res.locals.loginAccountId,
    })

    // 임계 초과 차단 — 계정 잠금과 IP 차단을 같은 응답으로 돌려준다.
    //
    // 이전에는 잠금이면 423/ACCOUNT_LOCKED, 그 외 차단이면 403/IP_BLOCKED 로 갈렸다.
    // 그런데 잠금은 "그 이메일이 실제로 존재할 때만" 발생하므로, 공격자는 임의 이메일에
    // 실패를 5회 쌓아 보고 응답이 423 인지 403 인지만 보면 가입 여부를 알 수 있었다
    // (비용이 조금 더 드는 계정 열거). 응답을 통일해 이 채널을 없앤다.
    // 잠금 사실과 대응 방법은 소유자에게 이메일로 안내되며, 상세 사유는 anomaly_logs 에 남는다.
    if (anomalyResult.locked || anomalyResult.blocked) {
      res.status(403).json({
        message: '반복된 인증 실패가 감지되어 접근이 차단되었습니다. 잠시 후 다시 시도해주세요.',
        code: 'AUTH_THROTTLED',
      })
      return
    }

    // 이상 감지됐지만 차단 수준 아님 → 경고 헤더 추가
    if (anomalyResult.anomalies.length > 0) {
      res.setHeader('X-Security-Warning', anomalyResult.anomalies.join(','))
    }

    // ── 적응형 인증(H) — 요구 인증 강도 산출 ──────────────────
    //
    // 여기서 계산하는 이유: 위험 점수는 이번 로그인의 탐지 결과(anomalyResult)를
    // 입력으로 쓰는데, 그 값이 확정되는 시점이 컨트롤러가 아니라 이 미들웨어다.
    //
    // 응답에 requiredAuth 를 **추가**하되 기존 requireWalletSign 은 그대로 둔다 —
    // 구버전 클라이언트가 깨지지 않게 하기 위함이다. 그리고 이 값은 어디까지나
    // 안내용이며, 실제 강제는 step2 가 서버에서 재계산해 수행한다(클라이언트 신뢰 금지).
    if (loginSuccess && loginUserId != null && responseData && typeof responseData === 'object') {
      try {
        const collected = await collectRiskSignals({
          userId: loginUserId,
          ip,
          loginAnomalies: anomalyResult.anomalies,
          abuseScore: res.locals.abuseScore,
          behaviorData: res.locals.behaviorData
        })
        const behavior = parseBehaviorData(res.locals.behaviorData)
        const botSignals = behavior ? detectBotBehavior(behavior) : []
        if (behavior && botSignals.length > 0) {
          await recordBotBehavior({
            userId: loginUserId,
            email: loginEmail ?? '',
            ip,
            userAgent: req.headers['user-agent'],
            signals: botSignals,
            metrics: behavior,
          })
        }

        // ── 행동 생체인식 — 사용자별 프로필 대비 유사도 판정 ──────────
        //
        // 봇 신호(세션 단위 즉시판단)를 넘어, 로그인마다 누적한 "이 사람의 리듬"과 비교한다.
        // 불일치면 신호를 기록(2단계 재독해 경로)하고 이번 판정에도 반영한다. 봇 신호와 같은
        // 이유로 반드시 await — 기록이 없으면 2단계(강제 지점)가 이 신호를 못 본다.
        if (behavior) {
          try {
            const bio = await processLoginBehavior(loginUserId, behavior)
            if (bio.outcome === 'mismatch') {
              await recordBiometricMismatch({
                userId: loginUserId,
                email: loginEmail ?? '',
                ip,
                userAgent: req.headers['user-agent'],
                detail: bio.detail,
              })
              collected.signals.push('BEHAVIOR_BIOMETRIC_MISMATCH')
            }
          } catch (bioErr) {
            // 생체인식 실패가 로그인을 막지 않는다(fail-open).
            console.error('[Biometric] 로그인 행동 판정 실패:', bioErr)
          }
        }

        const risk = assessRisk(collected.signals)
        const decision = decideAuthRequirement({
          isTrustedDevice: res.locals.isTrustedDevice === true,
          risk,
          // step2 와 같은 입력으로 판정해야 안내값과 실제 요구가 어긋나지 않는다.
          degraded: collected.degraded,
        })
        responseData.requiredAuth = decision.requirement
        responseData.riskScore = risk.score
        responseData.riskBand = risk.bandLabel
        if (collected.degraded) {
          // 신호 수집이 부분 실패했다 — 점수가 과소평가됐을 수 있음을 남긴다.
          console.warn('[AdaptiveAuth] 신호 수집 degraded — 점수 과소평가 가능:', risk.detail)
        }
      } catch (err) {
        // 점수 산출 실패가 로그인을 막지는 않는다. 다만 등급을 낮추지도 않는다 —
        // requiredAuth 를 비워두면 step2 가 서버에서 다시 계산해 강제한다.
        console.error('[AdaptiveAuth] 위험 점수 산출 실패:', err)
      }
    }

    // 정상 응답
    attachLoginChallenge(req, res)
    res.status(responseStatus ?? 200).json(responseData)

  } catch (err) {
    console.error('[anomalyMiddleware] analyzeAfterLogin error:', err)
    // fail-open — 이상탐지 실패해도 원래 응답은 정상 전송
    attachLoginChallenge(req, res)
    res.status(responseStatus ?? 200).json(responseData)
  }
}
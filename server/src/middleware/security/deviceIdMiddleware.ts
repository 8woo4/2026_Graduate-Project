import { Request, Response, NextFunction } from 'express'
import {
  DEVICE_ID_COOKIE,
  DEVICE_ID_MAX_AGE_MS,
  hashDeviceId,
  isValidDeviceId,
  newDeviceId,
} from '../../services/auth/deviceIdentityService'
import { authCookieOptions } from '../../config/cookies'

// 모든 API 요청에 붙인다. 쿠키가 없거나 형식이 틀리면 새로 발급한다.
//   res.locals.deviceHash  : 이 요청 단말의 HMAC
//   res.locals.deviceFresh : 이번 요청에서 처음 발급했는가
// 정상 브라우저는 가입·로그인 전에 이미 다른 API(이메일 인증 등)를 호출하므로 식별자를 갖고 온다.
// 가입 요청에서 deviceFresh 가 참이면 쿠키를 받지 않는 클라이언트(스크립트, 쿠키 차단)다.
export function deviceIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  try {
    let raw = req.cookies?.[DEVICE_ID_COOKIE]
    let fresh = false
    if (!isValidDeviceId(raw)) {
      raw = newDeviceId()
      fresh = true
      res.cookie(DEVICE_ID_COOKIE, raw, authCookieOptions(req, {
        maxAge: DEVICE_ID_MAX_AGE_MS,
      }))
    }
    res.locals.deviceHash = hashDeviceId(raw)
    res.locals.deviceFresh = fresh
  } catch (err) {
    // 식별자 발급 실패가 서비스 전체를 막지 않게 한다. 다계정 탐지만 이 요청에서 빠진다.
    console.error('[deviceIdentity] 단말 식별자 처리 실패:', err)
  }
  next()
}

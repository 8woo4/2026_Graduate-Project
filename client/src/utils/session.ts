// ─────────────────────────────────────────────────────────────
// 클라이언트 로그인 표시 — 화면 가드(UX) 전용
//
// 기존에는 세 파일(App·Navbar·OrderPanel)이 각자 `document.cookie` 에서
// `isLoggedIn=true` 를 찾아 로그인 여부를 판단했다. 프런트와 API 가 같은 도메인일 때는
// 동작하지만, 교차 사이트 배포(프런트 Vercel · API 다른 도메인)에서는 그 쿠키의 소유자가
// API 도메인이라 프런트 JS 의 document.cookie 에 **절대 나타나지 않는다**. 쿠키는 오리진
// 경계를 넘지 않으므로 SameSite·Partitioned 같은 속성으로 풀리는 문제가 아니다.
// 그 결과 로그인에 성공해도 모든 보호 라우트가 "로그인 후 이용 가능한 서비스입니다" 로 떨어졌다.
//
// 그래서 판단 근거를 localStorage 의 loginTime 으로 옮긴다. 이 값은 세션 잔여 시간 계산에
// 이미 쓰던 것이라 만료 의미도 그대로 따라온다(토큰 수명 600초, 연장 시 갱신).
// 같은 도메인 배포에서 내려오는 isLoggedIn 쿠키는 보조 신호로만 인정한다.
//
// 보안: 이것은 화면 노출을 막는 1차 방어일 뿐이고 실제 인증은 서버가 쿠키 JWT 로 검증한다.
// 이전의 isLoggedIn 쿠키도 httpOnly 가 아니어서 사용자가 직접 써넣을 수 있었으므로
// 방어력 차이는 없다(관리자 화면 가드가 localStorage 를 쓰는 것과 같은 전제).
// ─────────────────────────────────────────────────────────────

// 액세스 토큰 수명과 같아야 한다 — 서버 authService.ACCESS_TOKEN_TTL_SEC
export const SESSION_TTL_SEC = 600

const hasLoginCookie = (): boolean =>
  document.cookie.split(';').some((c) => c.trim().startsWith('isLoggedIn=true'))

/** 남은 세션 시간(초). loginTime 이 없거나 손상됐으면 0 */
export const sessionRemaining = (): number => {
  const raw = localStorage.getItem('loginTime')
  if (!raw) return 0
  const started = Number(raw)
  if (!Number.isFinite(started) || started <= 0) return 0
  return Math.max(0, SESSION_TTL_SEC - Math.floor((Date.now() - started) / 1000))
}

export const isLoggedIn = (): boolean => sessionRemaining() > 0 || hasLoginCookie()

/** 로그아웃·만료·탈퇴 공통 정리. 교차 사이트 배포에서는 API 도메인 쿠키를 JS 가 지울 수
 *  없으므로(서버 /logout 이 지운다) 로컬 표시를 지우는 것이 실제 의미를 갖는다. */
export const clearSession = (): void => {
  localStorage.removeItem('loginTime')
  localStorage.removeItem('upTick_user')
  for (const name of ['accessToken', 'refreshToken', 'isLoggedIn']) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`
  }
}

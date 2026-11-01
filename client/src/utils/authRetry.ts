import axios from 'axios'
import { API_BASE } from './api'

// ─────────────────────────────────────────────────────────────
// 액세스 토큰 만료 자동 복구
//
// 액세스 토큰 수명은 10분인데, 만료된 뒤 화면에서 무언가를 누르면 서버가 401 을 주고
// 그대로 끝났다. 갱신은 Navbar 의 "세션 연장"(만료 1분 전 경고 팝업)을 사용자가 직접
// 눌러야만 일어나므로, 10분 넘게 열어 둔 화면에서는 멀쩡한 동작이 실패로 보인다.
//
// 그래서 401 을 받으면 리프레시 토큰으로 한 번만 갱신하고 원래 요청을 재시도한다.
// 재시도는 반드시 1회로 제한한다 — 갱신 자체가 401 인 상황(리프레시 만료·로그아웃)에서
// 무한히 돌면 서버에 401 폭풍을 치게 된다.
//
// 보안: 갱신 가능 여부는 서버가 httpOnly 리프레시 쿠키로 판정한다. 이 코드가 하는 일은
// "한 번 더 물어본다" 뿐이고, 권한을 스스로 늘리지 않는다.
// ─────────────────────────────────────────────────────────────

const REFRESH_PATH = '/api/auth/refresh'

// 갱신을 건드리면 안 되는 경로 — 여기서 나온 401 은 "자격 증명이 틀렸다"는 뜻이라
// 재시도해도 결과가 같고, 로그인 실패 횟수만 부풀린다.
const NO_RETRY = [REFRESH_PATH, '/api/auth/login', '/api/auth/logout', '/api/auth/register']

const isApiUrl = (url: string): boolean => url.startsWith(API_BASE)
const isNoRetryPath = (url: string): boolean => NO_RETRY.some((p) => url.includes(p))

// 동시에 여러 요청이 401 을 받으면 갱신도 그 수만큼 나간다. 하나로 합쳐
// 같은 결과를 공유한다 — 리프레시 토큰 회전을 쓰게 되면 중복 호출이 곧 실패가 된다.
let inFlight: Promise<boolean> | null = null

export function refreshSession(): Promise<boolean> {
  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
      const res = await originalFetch(`${API_BASE}${REFRESH_PATH}`, {
        method: 'POST',
        credentials: 'include',
      })
      if (!res.ok) return false
      // 남은 세션 표시(Navbar 카운트다운)도 같이 맞춘다.
      localStorage.setItem('loginTime', Date.now().toString())
      return true
    } catch {
      return false
    } finally {
      // 다음 만료 때 다시 갱신할 수 있도록 즉시 비운다.
      setTimeout(() => {
        inFlight = null
      }, 0)
    }
  })()

  return inFlight
}

// 패치 전의 원본 fetch — 갱신 요청 자신은 패치를 거치지 않아야 한다(재귀 방지).
const originalFetch: typeof fetch = globalThis.fetch.bind(globalThis)

let installed = false

export function installAuthRetry(): void {
  if (installed) return
  installed = true

  // ── axios ──────────────────────────────────────────────────
  // 재시도는 요청 인터셉터(tradeSigning)를 다시 타므로 HMAC 서명도 새 timestamp·nonce 로
  // 다시 만들어진다. 이미 문자열로 굳힌 본문은 그대로 쓰이므로 서명 대상이 달라지지 않는다.
  axios.interceptors.response.use(
    (res) => res,
    async (error) => {
      const config = error?.config
      const url: string = config?.url ?? ''
      if (
        error?.response?.status !== 401 ||
        !config ||
        config.__authRetried ||
        !isApiUrl(url) ||
        isNoRetryPath(url)
      ) {
        return Promise.reject(error)
      }

      config.__authRetried = true
      const ok = await refreshSession()
      if (!ok) return Promise.reject(error)
      return axios(config)
    },
  )

  // ── fetch ──────────────────────────────────────────────────
  // 화면 대부분이 fetch 를 직접 쓰기 때문에(41곳) 호출부를 하나씩 고치는 대신 한 겹을
  // 씌운다. 우리 API 로 가는 요청에만 관여하고 나머지는 원본 그대로 통과시킨다.
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await originalFetch(input as any, init)
    if (res.status !== 401) return res

    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!isApiUrl(url) || isNoRetryPath(url)) return res

    // 서명된 거래 요청은 여기서 재시도하면 안 된다 — 헤더에 이미 굳은 timestamp·nonce 를
    // 그대로 다시 보내는 꼴이라 서버가 재전송(REPLAY)으로 차단한다. 그쪽은 서명을 다시
    // 만들 수 있는 signedFetch 가 직접 처리한다.
    const headers = new Headers(init?.headers)
    if (headers.has('X-Signature')) return res

    // Request 객체로 들어온 호출은 본문을 이미 소비했을 수 있어 그대로 재전송할 수 없다.
    if (typeof input !== 'string' && !(input instanceof URL)) return res

    const ok = await refreshSession()
    if (!ok) return res
    return originalFetch(input as any, init)
  }
}

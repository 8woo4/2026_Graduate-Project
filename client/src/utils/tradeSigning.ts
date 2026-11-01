import axios from 'axios'

// ─────────────────────────────────────────────────────────────
// 거래 요청 HMAC 서명 (서버 hmacMiddleware 와 짝)
// 로그인 시 발급받은 세션 서명키로 /api/trade/* 상태변경 요청에 자동 서명한다.
//
// 서명 경로가 둘(axios 인터셉터 / fetch 래퍼)이지만 서명 생성은 buildSignature 하나만
// 쓴다. 알고리즘이 갈라지면 한쪽만 서버 검증을 통과하는 사고가 나기 때문이다.
// ─────────────────────────────────────────────────────────────

const SECRET_KEY = 'uptick_signing_secret'

export function setSigningSecret(secret: string): void {
  sessionStorage.setItem(SECRET_KEY, secret)
}

export function clearSigningSecret(): void {
  sessionStorage.removeItem(SECRET_KEY)
}

function getSigningSecret(): string | null {
  return sessionStorage.getItem(SECRET_KEY)
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// 서버가 수신할 정확한 본문 문자열에 대해 서명한다. 본문이 한 글자라도 달라지면
// 서명이 불일치하므로, 호출부는 여기서 반환한 body 를 그대로 전송해야 한다.
async function buildSignature(rawBody: string): Promise<Record<string, string> | null> {
  const secret = getSigningSecret()
  if (!secret) return null // 미로그인/구세션 — 서버가 401 로 재로그인 유도

  const timestamp = Date.now().toString()
  const nonce = crypto.randomUUID()
  const signature = await hmacSha256Hex(secret, `${timestamp}.${nonce}.${rawBody}`)

  return {
    'Content-Type': 'application/json',
    'X-Signature': signature,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
  }
}

// 서명 대상 판정 — 서버 hmacMiddleware 의 적용 범위와 반드시 일치시킨다.
function requiresSignature(url: string, method: string): boolean {
  const m = method.toUpperCase()
  return url.includes('/api/trade/') && m !== 'GET' && m !== 'HEAD'
}

let installed = false

// 앱 진입 시 1회 호출 — 기본 axios 인스턴스에 요청 인터셉터를 등록한다.
export function installTradeSigning(): void {
  if (installed) return
  installed = true

  axios.interceptors.request.use(async (config) => {
    if (!requiresSignature(config.url ?? '', config.method ?? 'get')) return config

    let body = ''
    if (config.data != null) {
      body = typeof config.data === 'string' ? config.data : JSON.stringify(config.data)
      config.data = body
    }

    const headers = await buildSignature(body)
    if (!headers) return config

    config.headers = config.headers ?? {}
    for (const [k, v] of Object.entries(headers)) (config.headers as any)[k] = v
    return config
  })
}

// fetch 로 보내는 거래 요청용 래퍼.
// axios 인터셉터는 fetch 를 가로채지 못하므로, fetch 를 쓰는 호출부는 반드시 이 함수를
// 써야 한다. 그냥 fetch 로 보내면 서버 hmacMiddleware 가 403 으로 거절한다.
export async function signedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  if (!requiresSignature(url, method)) return fetch(url, init)

  // 본문은 문자열로 고정한 뒤 그 문자열에 서명하고, 같은 문자열을 전송한다.
  const body = init.body == null ? '' : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)

  const send = async (): Promise<Response | null> => {
    const signed = await buildSignature(body)
    if (!signed) return null
    return fetch(url, {
      ...init,
      // 본문이 없는 요청(예: DELETE, 파라미터 없는 POST)도 빈 문자열에 서명하므로
      // body 를 생략하지 않고 그대로 맞춰 보낸다 — 서버 rawBody 와 일치시키기 위함.
      body: body === '' ? undefined : body,
      headers: { ...(init.headers as Record<string, string> | undefined), ...signed },
    })
  }

  const first = await send()
  if (!first) return fetch(url, init)
  if (first.status !== 401) return first

  // 액세스 토큰 만료로 막힌 것이면 갱신 후 한 번만 다시 보낸다. 재시도는 send() 를 다시
  // 타므로 timestamp·nonce 가 새로 만들어진다 — 같은 서명을 재사용하면 서버가 재전송으로
  // 차단하기 때문에, 헤더를 돌려쓰지 않는 이 경로로만 재시도해야 한다.
  const { refreshSession } = await import('./authRetry')
  if (!(await refreshSession())) return first
  return (await send()) ?? first
}

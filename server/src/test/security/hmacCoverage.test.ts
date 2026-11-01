import express from 'express'

// ─────────────────────────────────────────────────────────────
// [보안 검증] HMAC 서명 검증 적용 범위 (routing coverage)
//
// 배경: 서명 검증이 매수·매도 2개 라우트에만 걸려 있었다. 클라이언트 인터셉터는
// /api/trade/* 의 모든 상태변경 요청에 서명을 붙이고 있었으므로, PIN 변경·계좌 리셋·
// 주문 취소·실계좌 등록은 "클라이언트는 서명해 보내는데 서버는 검증하지 않는" 상태였다.
// 특히 실계좌 등록은 KIS 앱키·시크릿을 본문에 실어 보내므로 변조·재전송 방어가 필요하다.
//
// 이 스크립트는 알고리즘이 아니라 "배선"을 검증한다.
//   (0) 검증 목록의 경로가 실제 라우터에 존재하는가 — 없는 경로는 미들웨어 때문에 403 이 나와
//       "보호됨"으로 잘못 집계된다(실제로 PIN 경로가 분리된 뒤 그 상태로 방치돼 있었다)
//   (1) 모든 상태변경(POST/PUT/PATCH/DELETE) 라우트가 서명 없이는 통과하지 못하는가
//   (2) 조회(GET) 라우트는 서명 없이도 통과하는가 — 과잉 적용으로 화면이 깨지지 않아야 함
//   (3) 서버 적용 범위와 클라이언트 서명 범위 판정이 동일한가
//
// 실제 라우터를 그대로 마운트하되, 인증·컨트롤러는 스텁으로 대체해 DB 없이 돌린다.
// 실행: cd server && npx ts-node src/test/security/hmacCoverage.test.ts
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

// 인증·컨트롤러를 스텁으로 갈아끼운다 — 검증 대상은 hmacMiddleware 배선뿐이다.
// 인증 등급 미들웨어(verificationTierMiddleware)는 실제 코드를 그대로 통과시키도록 두 인증을 모두 갖춘 사용자로 둔다
const TEST_USER = { id: 999_999_100, email: 'coverage@test.local', is_email_verified: true, is_phone_verified: true }

require.cache[require.resolve('../../middleware/auth/authMiddleware')] = {
  id: require.resolve('../../middleware/auth/authMiddleware'),
  filename: require.resolve('../../middleware/auth/authMiddleware'),
  loaded: true,
  exports: {
    isAuthenticated: (req: any, _res: any, next: any) => { req.user = TEST_USER; next() },
  },
} as any


function stubController(modulePath: string): void {
  const resolved = require.resolve(modulePath)
  const handler = (_req: any, res: any) => res.json({ ok: true })
  // 컨트롤러가 내보내는 이름을 알 수 없으므로, 접근되는 모든 export 를 핸들러로 돌려준다.
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: new Proxy({}, { get: () => handler }),
  } as any
}

stubController('../../controllers/trade/virtualTradeController')
stubController('../../controllers/trade/realTradeController')
stubController('../../controllers/trade/tradePinController')

const virtualRouter = require('../../routes/trade/virtualTradeRouter').default
const realRouter = require('../../routes/trade/realTradeRouter').default
// 거래 PIN 은 모의·실거래 공용이라 별도 라우터(/api/trade/pin)로 분리돼 있다. 이걸 마운트하지
// 않으면 PIN 라우트 3개가 검증 범위에서 빠지고, 아래 존재 확인이 그 사실을 드러낸다.
const pinRouter = require('../../routes/trade/tradePinRouter').default

const app = express()
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString('utf8') } }))
app.use('/api/trade/pin', pinRouter)
app.use('/api/trade/virtual', virtualRouter)
app.use('/api/trade/real', realRouter)

// 서명 세션이 없는 상태에서는 hmacMiddleware 가 401 을 낸다. 세션이 있는 상태를 만들어
// "서명 누락 → 403" 까지 확인하기 위해 실제 서명키를 발급한다.
const { issueSessionSecret, computeSignature } = require('../../services/auth/hmacService')
const SESSION_SECRET: string = issueSessionSecret(TEST_USER.id)
let nonceSeq = 0

type Route = { method: 'post' | 'delete' | 'get'; path: string; label: string }

// 아래 목록은 라우터 파일의 실제 경로와 1:1 로 맞춰야 한다. 예전 목록은 PIN 이 분리된 뒤에도
// '/api/trade/virtual/pin' 을 그대로 두고 있었는데, hmacMiddleware 가 router.use 로 경로 매칭보다
// 먼저 걸리기 때문에 없는 경로도 403 을 돌려준다 — 즉 통과로 집계되는 거짓 양성이었다.
// 그래서 아래 "존재 확인"에서 서명을 갖춘 요청이 404 가 아닌지를 함께 본다.
const stateChanging: Route[] = [
  { method: 'post',   path: '/api/trade/pin',                    label: 'PIN 설정' },
  { method: 'post',   path: '/api/trade/pin/verify',             label: 'PIN 검증' },
  { method: 'post',   path: '/api/trade/pin/change',             label: 'PIN 변경' },
  { method: 'post',   path: '/api/trade/virtual/account/open',   label: '모의계좌 개설' },
  { method: 'post',   path: '/api/trade/virtual/account/reset',  label: '모의계좌 리셋' },
  { method: 'post',   path: '/api/trade/virtual/buy',            label: '모의 매수' },
  { method: 'post',   path: '/api/trade/virtual/sell',           label: '모의 매도' },
  { method: 'delete', path: '/api/trade/virtual/orders/1',       label: '미체결 취소' },
  { method: 'post',   path: '/api/trade/real/account',           label: '실계좌 등록(앱키·시크릿)' },
  { method: 'delete', path: '/api/trade/real/account',           label: '실계좌 해제' },
  { method: 'post',   path: '/api/trade/real/buy',               label: '실거래 매수' },
  { method: 'post',   path: '/api/trade/real/sell',              label: '실거래 매도' },
]

const readOnly: Route[] = [
  { method: 'get', path: '/api/trade/pin/status',             label: 'PIN 설정 여부 조회' },
  { method: 'get', path: '/api/trade/virtual/portfolio',      label: '포트폴리오 조회' },
  { method: 'get', path: '/api/trade/virtual/market-status',  label: '장 운영 상태 조회' },
  { method: 'get', path: '/api/trade/virtual/orders',         label: '거래내역 조회' },
  { method: 'get', path: '/api/trade/virtual/orders/pending', label: '미체결 조회' },
  { method: 'get', path: '/api/trade/virtual/orders/1/proof', label: '체결 장부 포함 증명 조회' },
  { method: 'get', path: '/api/trade/real/account',           label: '실계좌 상태 조회' },
  { method: 'get', path: '/api/trade/real/balance',           label: 'KIS 잔고 조회' },
  { method: 'get', path: '/api/trade/real/orders',            label: '실거래 내역 조회' },
]

async function main(): Promise<void> {
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`

  // 서명을 올바르게 붙여 보낸다 — 경로가 실제로 존재하는지(404 가 아닌지) 확인하는 용도다.
  // 서명 검증을 통과하면 스텁 컨트롤러가 200 을 주고, 경로가 없으면 404 가 온다.
  const callWithSignature = async (r: Route): Promise<number> => {
    const body = r.method === 'get' ? '' : JSON.stringify({ probe: 1 })
    const timestamp = String(Date.now())
    const nonce = `cov-${nonceSeq++}-${Math.random().toString(16).slice(2)}`
    const signature = computeSignature(SESSION_SECRET, timestamp, nonce, body)
    const init: RequestInit = {
      method: r.method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
      },
    }
    if (r.method !== 'get') init.body = body
    const res = await fetch(`${base}${r.path}`, init)
    return res.status
  }

  // 서명 헤더를 붙이지 않고 보낸다 — 이것이 "서명 없는 요청"의 정의다.
  const callWithoutSignature = async (r: Route): Promise<number> => {
    const init: RequestInit = { method: r.method.toUpperCase() }
    if (r.method !== 'get') {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = JSON.stringify({ probe: 1 })
    }
    const res = await fetch(`${base}${r.path}`, init)
    return res.status
  }

  try {
  // ─────────────────────────────────────────────
  // 0) 경로 존재 확인 — 목록이 실제 라우터와 어긋나지 않는가
  //
  // hmacMiddleware 는 router.use 로 걸려 있어 경로 매칭보다 먼저 실행된다. 그래서 없는 경로에
  // 서명 없이 요청하면 404 가 아니라 403 이 나오고, "보호되고 있다"로 잘못 집계된다.
  // 올바른 서명을 붙여 404 가 아닌지 확인하면 이 거짓 양성을 걸러낼 수 있다.
  // ─────────────────────────────────────────────
  let exists = 0
  for (const r of [...stateChanging, ...readOnly]) {
    const status = await callWithSignature(r)
    const found = status !== 404
    if (found) exists++
    check(`경로 존재: ${r.method.toUpperCase()} ${r.path}`, found, `status=${status}`)
  }

  // ─────────────────────────────────────────────
  // 1) 상태변경 라우트 — 서명 없이는 전부 거절돼야 한다
  // ─────────────────────────────────────────────
  let blocked = 0
  for (const r of stateChanging) {
    const status = await callWithoutSignature(r)
    const denied = status === 403
    if (denied) blocked++
    check(`서명 없는 ${r.label} 거절 (${r.method.toUpperCase()} ${r.path})`, denied, `status=${status}`)
  }

  // ─────────────────────────────────────────────
  // 2) 조회 라우트 — 서명 없이도 통과해야 한다(과잉 적용 방지)
  // ─────────────────────────────────────────────
  let allowed = 0
  for (const r of readOnly) {
    const status = await callWithoutSignature(r)
    const ok = status === 200
    if (ok) allowed++
    check(`서명 없는 ${r.label} 허용 (GET ${r.path})`, ok, `status=${status}`)
  }

  // ─────────────────────────────────────────────
  // 3) 클라이언트 서명 범위와 서버 검증 범위의 일치
  //   클라이언트(tradeSigning.requiresSignature)와 동일한 판정을 재현해 대조한다.
  //   한쪽만 바뀌면 정상 요청이 403 이 되거나(가용성) 서명 없는 요청이 통과한다(보안).
  // ─────────────────────────────────────────────
  const clientWouldSign = (url: string, method: string): boolean => {
    const m = method.toUpperCase()
    return url.includes('/api/trade/') && m !== 'GET' && m !== 'HEAD'
  }

  let matched = 0
  const allRoutes = [...stateChanging, ...readOnly]
  for (const r of allRoutes) {
    const status = await callWithoutSignature(r)
    const serverEnforces = status === 403
    const clientSigns = clientWouldSign(r.path, r.method)
    const agree = serverEnforces === clientSigns
    if (agree) matched++
    check(
      `범위 일치: ${r.method.toUpperCase()} ${r.path}`,
      agree,
      `클라 서명=${clientSigns} / 서버 강제=${serverEnforces}`,
    )
  }

  // ─────────────────────────────────────────────
  // 결과 출력
  // ─────────────────────────────────────────────
  console.log('')
  console.log('[보안 테스트] HMAC 서명 검증 적용 범위')
  console.log(`총 시도: ${stateChanging.length}회 | 탐지: ${blocked}회 | 차단: ${blocked}회 | 탐지율: ${((blocked / stateChanging.length) * 100).toFixed(0)}%`)
  console.log(`- 상태변경 라우트 보호 : ${blocked}/${stateChanging.length} (서명 누락 시 403)`)
  console.log(`- 조회 라우트 오차단   : ${readOnly.length - allowed}/${readOnly.length} (오탐률 ${(((readOnly.length - allowed) / readOnly.length) * 100).toFixed(1)}%)`)
  console.log(`- 클라·서버 범위 일치  : ${matched}/${allRoutes.length}`)
  console.log(`- 경로 존재 확인       : ${exists}/${allRoutes.length} (404 면 목록이 라우터와 어긋난 것)`)
  console.log(`- [대조군] 이전 배선(buy·sell 만) : 상태변경 ${stateChanging.length}개 중 4개만 보호 = ${((4 / stateChanging.length) * 100).toFixed(0)}%`)

  if (failures.length > 0) {
    console.log('\n[실패 항목]')
    for (const f of failures.slice(0, 20)) console.log(`  · ${f}`)
  }

  console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
  console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('검증 실행 오류:', err)
  process.exit(1)
})

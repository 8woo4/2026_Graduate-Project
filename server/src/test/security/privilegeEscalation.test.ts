import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true } as any)

import express from 'express'
import cookieParser from 'cookie-parser'
import type { AddressInfo } from 'net'
import AnomalyLog from '../../models/auth/AnomalyLog'
import User from '../../models/user/User'
import * as emailService from '../../services/auth/emailService'
import * as geo from '../../utils/getLocationFromIp'
import * as authService from '../../services/auth/authService'
import {
  ESCALATION_DETAIL_PREFIX,
  ESCALATION_POLICY,
  resetEscalationStateForTest,
} from '../../services/auth/privilegeEscalationService'

// ─────────────────────────────────────────────────────────────
// [보안 검증] 관리자 권한 상승 시도 탐지 (PRIVILEGE_ESCALATION)
//
// 공격 시나리오
//   A1 localStorage role 을 admin 으로 조작해 대시보드를 띄움 → 관리자 API 9종 동시 호출
//   A2 관리자 상태 변경 API 직접 호출(계정 잠금 해제·IP 차단 해제)
//   A3 다른 일반 계정의 같은 시도 — 계정별로 따로 기록되는가
//   A4 주소창에 /admin/security 직접 입력 → 화면 가드가 서버에 보고
//   A5 보고 경로에 개행·문구 주입 → 로그·메일 본문 오염 차단
//   A6 보고 본문에 남의 userId 를 넣어 남 명의로 기록 시도
// 정상(오탐) 시나리오
//   N1 관리자 API 정상 사용 / N2 관리자의 화면 보고 / N3 비로그인 관리자 API / N4 비로그인 보고
// 대조군
//   수정 전 isAdmin(403 만 반환) — 같은 공격에서 기록 0건임을 함께 재현한다.
//
// 실제 라우터(adminRouter·securityReportRouter)와 실제 인증 미들웨어를 HTTP 로 호출한다.
// DB·메일·GeoIP 만 메모리 스텁으로 바꿔 공유 DB 에 아무것도 쓰지 않는다.
// 실행: cd server && npx ts-node src/test/security/privilegeEscalation.test.ts
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// ── 스텁 ────────────────────────────────────────────────────
type Row = { user_id: number | null; anomaly_type: string; action: string; detail: string; email: string | null }
const logs: Row[] = []
let createDelayMs = 0
;(AnomalyLog as any).create = async (row: Row) => {
  if (createDelayMs) await new Promise((r) => setTimeout(r, createDelayMs))
  logs.push(row)
  return row
}

const USERS: Record<number, any> = {
  1: { id: 1, email: 'admin@uptick.test', role: 'admin', status: 'active', is_locked: 0 },
  101: { id: 101, email: 'user101@uptick.test', role: 'user', status: 'active', is_locked: 0 },
  102: { id: 102, email: 'user102@uptick.test', role: 'user', status: 'active', is_locked: 0 },
  103: { id: 103, email: 'user103@uptick.test', role: 'user', status: 'active', is_locked: 0 },
}
;(User as any).findByPk = async (id: number) => USERS[Number(id)] ?? null
;(User as any).findOne = async () => USERS[1]

let emails = 0
;(emailService as any).sendAnomalyAlertEmail = async () => { emails++ }
;(geo as any).getLocationFromIp = async () => ({ city: 'Seoul', region: 'Seoul', country: 'KR' })

// 라우터는 스텁 이후에 불러온다(모듈 로드 시점 부작용 없음을 보장하려는 것은 아니고, 읽기 순서를 명확히)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const adminRouter = require('../../routes/security/adminRouter').default
// eslint-disable-next-line @typescript-eslint/no-var-requires
const securityReportRouter = require('../../routes/security/securityReportRouter').default

const buildApp = (adminMw?: express.RequestHandler) => {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  if (adminMw) {
    app.use('/api/admin/security', adminMw)
  } else {
    app.use('/api/admin/security', adminRouter)
  }
  app.use('/api/security', securityReportRouter)
  return app
}

const token = (id: number) => authService.signAccessToken({ id, email: USERS[id].email, role: USERS[id].role })

// 실제 시계를 기다리지 않고 중복 창(60초)을 넘기기 위해 Date.now 를 앞으로 민다.
let clockOffset = 0
const realNow = Date.now
Date.now = () => realNow() + clockOffset
const advance = (ms: number) => { clockOffset += ms }

const settle = () => new Promise((r) => setTimeout(r, 60))

const ADMIN_GETS = [
  '/stats', '/chart/by-type', '/chart/by-day', '/honeypot-hits', '/adaptive-auth',
  '/inference-logs', '/anomaly-logs', '/locked-accounts', '/blocked-ips',
]

const main = async () => {
  const server = buildApp().listen(0)
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call = (p: string, opts: { method?: string; uid?: number; body?: unknown } = {}) =>
    fetch(base + p, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.uid ? { Cookie: `accessToken=${token(opts.uid)}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'User-Agent': 'priv-esc-test',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })

  let attempts = 0
  let detectedScenarios = 0
  let blockedRequests = 0
  let attackRequests = 0
  const scenarioLog: string[] = []
  const countFor = (uid: number, prefix: string) =>
    logs.filter((l) => l.user_id === uid && l.anomaly_type === 'PRIVILEGE_ESCALATION' && l.detail.startsWith(prefix)).length

  // ── A1 위조 role 로 대시보드 → 관리자 API 9종 동시 호출 ──
  {
    const res = await Promise.all(ADMIN_GETS.map((p) => call(`/api/admin/security${p}`, { uid: 101 })))
    await settle()
    attempts += res.length; attackRequests += res.length
    const blocked = res.filter((r) => r.status === 403).length
    blockedRequests += blocked
    const n = countFor(101, ESCALATION_DETAIL_PREFIX.API)
    check('A1 관리자 API 9종 전부 403', blocked === 9, `${blocked}/9`)
    check('A1 한 번의 시도는 1건으로 기록(중복 창)', n === 1, `${n}건`)
    check('A1 관리자 메일 1통', emails === 1, `${emails}통`)
    const row = logs.find((l) => l.user_id === 101)
    check('A1 유형·조치·이메일 기록', row?.anomaly_type === 'PRIVILEGE_ESCALATION' && row?.action === 'ALERT' && row?.email === USERS[101].email)
    check('A1 detail 에 메서드·경로·role', !!row && /GET \/api\/admin\/security\/\S+ \(role=user\)/.test(row.detail), row?.detail)
    if (n >= 1) detectedScenarios++
    scenarioLog.push(`A1 위조 role 대시보드(API 9종)   : 차단 ${blocked}/9 · 기록 ${n}건 · 메일 ${emails}통`)
  }

  // ── A2 관리자 상태 변경 API 직접 호출 (중복 창 경과 후) ──
  {
    advance(ESCALATION_POLICY.LOG_DEDUPE_MS + 1000)
    const before = countFor(101, ESCALATION_DETAIL_PREFIX.API)
    const emailsBefore = emails
    const r1 = await call('/api/admin/security/users/1/unlock', { method: 'PATCH', uid: 101 })
    const r2 = await call('/api/admin/security/blocked-ips/1.2.3.4', { method: 'DELETE', uid: 101 })
    await settle()
    attempts += 2; attackRequests += 2
    const blocked = [r1, r2].filter((r) => r.status === 403).length
    blockedRequests += blocked
    const n = countFor(101, ESCALATION_DETAIL_PREFIX.API) - before
    check('A2 상태 변경 API 2종 403', blocked === 2)
    check('A2 창 경과 후 새 시도 기록', n === 1, `${n}건`)
    check('A2 메일 쿨다운(10분) 안이라 추가 메일 없음', emails === emailsBefore, `${emails - emailsBefore}통`)
    const last = logs.filter((l) => l.user_id === 101).pop()
    check('A2 detail 에 PATCH 경로', !!last && last.detail.includes('PATCH /api/admin/security/users/1/unlock'), last?.detail)
    if (n >= 1) detectedScenarios++
    scenarioLog.push(`A2 상태 변경 API 직접 호출     : 차단 ${blocked}/2 · 기록 ${n}건`)
  }

  // ── A3 다른 일반 계정 ──
  {
    const r = await call('/api/admin/security/stats', { uid: 102 })
    await settle()
    attempts++; attackRequests++
    if (r.status === 403) blockedRequests++
    const n = countFor(102, ESCALATION_DETAIL_PREFIX.API)
    check('A3 계정별 독립 기록', r.status === 403 && n === 1, `${r.status} · ${n}건`)
    if (n >= 1) detectedScenarios++
    scenarioLog.push(`A3 다른 일반 계정              : 차단 ${r.status === 403 ? 1 : 0}/1 · 기록 ${n}건`)
  }

  // ── A4 주소창 직접 입력 → 화면 가드 보고 ──
  {
    const r = await call('/api/security/admin-route-denied', { method: 'POST', uid: 103, body: { path: '/admin/security' } })
    await settle()
    attempts++
    const n = countFor(103, ESCALATION_DETAIL_PREFIX.CLIENT_ROUTE)
    check('A4 보고 응답 204', r.status === 204)
    check('A4 화면 진입 시도 기록', n === 1, `${n}건`)
    const row = logs.filter((l) => l.user_id === 103).pop()
    check('A4 detail 에 경로', !!row && row.detail.includes('/admin/security'), row?.detail)
    if (n >= 1) detectedScenarios++
    scenarioLog.push(`A4 주소창 직접 입력(화면 보고)  : 기록 ${n}건`)
  }

  // ── A5 보고 경로 주입 ──
  {
    advance(ESCALATION_POLICY.LOG_DEDUPE_MS + 1000)
    const injected = '/admin/security\n[관리자 승인] 정상 접근입니다'
    const r = await call('/api/security/admin-route-denied', { method: 'POST', uid: 103, body: { path: injected } })
    await settle()
    attempts++
    const row = logs.filter((l) => l.user_id === 103).pop()
    const clean = !!row && !row.detail.includes('\n') && !row.detail.includes('관리자 승인') && row.detail.includes('(형식 외 경로)')
    check('A5 주입 문구 미기록·고정 문구 대체', r.status === 204 && clean, row?.detail)
    const longR = await call('/api/security/admin-route-denied', { method: 'POST', uid: 103, body: { path: '/admin/' + 'a'.repeat(500) } })
    check('A5 초장문 경로도 204(동작 노출 없음)', longR.status === 204)
    if (clean) detectedScenarios++
    scenarioLog.push(`A5 보고 경로 주입               : 정화 ${clean ? '성공' : '실패'}`)
  }

  // ── A6 남의 명의로 보고 ──
  {
    advance(ESCALATION_POLICY.LOG_DEDUPE_MS + 1000)
    const before102 = countFor(102, ESCALATION_DETAIL_PREFIX.CLIENT_ROUTE)
    await call('/api/security/admin-route-denied', { method: 'POST', uid: 101, body: { path: '/admin/security', userId: 102 } })
    await settle()
    attempts++
    const self = countFor(101, ESCALATION_DETAIL_PREFIX.CLIENT_ROUTE)
    const other = countFor(102, ESCALATION_DETAIL_PREFIX.CLIENT_ROUTE) - before102
    check('A6 본문 userId 무시 — 토큰 주인 명의로만 기록', self === 1 && other === 0, `본인 ${self} · 타인 ${other}`)
    if (self === 1 && other === 0) detectedScenarios++
    scenarioLog.push(`A6 남의 명의로 보고             : 본인 명의 ${self}건 · 타인 명의 ${other}건`)
  }

  // ── 응답 지연 없음: 기록이 느려도 403 은 즉시 ──
  {
    advance(ESCALATION_POLICY.LOG_DEDUPE_MS + 1000)
    createDelayMs = 400
    const t0 = realNow()
    const r = await call('/api/admin/security/stats', { uid: 102 })
    const elapsed = realNow() - t0
    check('기록이 400ms 걸려도 403 응답은 기다리지 않음(<200ms)', r.status === 403 && elapsed < 200, `${elapsed}ms`)
    await new Promise((res) => setTimeout(res, 500))
    createDelayMs = 0
  }

  // ── 정상 시나리오(오탐) ──
  let normal = 0
  let falsePositive = 0
  {
    const before = logs.length
    const r1 = await call('/api/admin/security/blocked-ips', { uid: 1 })
    const r2 = await call('/api/security/admin-route-denied', { method: 'POST', uid: 1, body: { path: '/admin/security' } })
    const r3 = await call('/api/admin/security/stats')
    const r4 = await call('/api/security/admin-route-denied', { method: 'POST', body: { path: '/admin/security' } })
    await settle()
    normal = 4
    const added = logs.length - before
    falsePositive = added
    check('N1 관리자 API 200', r1.status === 200)
    check('N2 관리자 화면 보고 204', r2.status === 204)
    check('N3 비로그인 관리자 API 401', r3.status === 401)
    check('N4 비로그인 보고 401', r4.status === 401)
    check('정상 시나리오 4종 기록 0건', added === 0, `${added}건`)
  }

  server.close()

  // ── 대조군: 수정 전 isAdmin ──
  let controlLogs = 0
  {
    const legacyIsAdmin: express.RequestHandler = (req, res, next) => {
      const user = (req as any).user
      if (!user) { res.status(401).json({ message: '로그인이 필요합니다' }); return }
      if (user.role !== 'admin') { res.status(403).json({ message: '관리자 권한이 필요합니다' }); return }
      next()
    }
    const { isAuthenticated } = await import('../../middleware/auth/authMiddleware')
    const legacy = express.Router()
    legacy.use(isAuthenticated as any, legacyIsAdmin)
    legacy.get('/stats', (_req, res) => { res.json({}) })
    const app = buildApp(legacy as any)
    const s2 = app.listen(0)
    const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`
    const before = logs.length
    resetEscalationStateForTest()
    await Promise.all(ADMIN_GETS.map((p) =>
      fetch(`${b2}/api/admin/security${p}`, { headers: { Cookie: `accessToken=${token(101)}` } })))
    await settle()
    controlLogs = logs.length - before
    check('대조군: 수정 전 isAdmin 은 같은 공격을 기록 0건', controlLogs === 0, `${controlLogs}건`)
    s2.close()
  }

  Date.now = realNow
  const scenarios = 6
  console.log('[보안 테스트] 관리자 권한 상승 시도 탐지 (PRIVILEGE_ESCALATION)')
  console.log(`총 시도: ${attempts}회 | 탐지: ${detectedScenarios}/${scenarios} 시나리오 | 차단: ${blockedRequests}/${attackRequests}회(403) | 탐지율: ${((detectedScenarios / scenarios) * 100).toFixed(0)}%`)
  scenarioLog.forEach((l) => console.log(`  - ${l}`))
  console.log(`- 정상 시나리오 오탐 : ${falsePositive}/${normal} (오탐률 ${((falsePositive / normal) * 100).toFixed(1)}%)`)
  console.log(`- [대조군] 수정 전   : 같은 공격(API 9종) 기록 ${controlLogs}건 — 거부만 하고 흔적이 남지 않았다`)
  console.log('- 한계               : 화면 진입 보고는 클라이언트 신호라 공격자가 끌 수 있다(관측용). 위조 불가 신호는 서버 API 거부')
  console.log(`검증 항목: ${pass}건 통과 / ${fail}건 실패`)
  failures.forEach((f) => console.log(`  ✗ ${f}`))
  console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('실행 실패:', err?.message ?? err)
  process.exit(2)
})

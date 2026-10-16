import AnomalyLog from '../../models/auth/AnomalyLog'
import User from '../../models/user/User'
import { sendAnomalyAlertEmail } from './emailService'
import { getLocationFromIp } from '../../utils/getLocationFromIp'

/**
 * 관리자 권한 상승 시도 탐지.
 *
 * 관리자 화면 가드(AdminRoute)는 localStorage 의 role 만 보는 표시용 1차 방어이고, 실제 권한은
 * 서버 isAdmin 이 검증한다. 그런데 두 지점 모두 거부만 하고 기록을 남기지 않아, 일반 계정이
 * 관리자 기능을 노린 정황이 대시보드·메일 어디에도 드러나지 않았다.
 *
 * 출처를 둘로 나눠 기록한다. 신뢰도가 다르기 때문이다.
 *   API          서버 isAdmin 이 직접 거부한 요청 — 위조 불가. role 을 조작해 대시보드를 띄운
 *                공격자는 반드시 여기서 잡힌다.
 *   CLIENT_ROUTE 화면 가드가 돌려보내며 보낸 보고 — 클라이언트가 보내므로 공격자가 끌 수 있다.
 *                주소창 직접 입력 같은 정찰 정황을 보는 관측 신호로만 쓴다.
 *
 * 차단은 하지 않는다(action=ALERT). 요청 자체는 이미 403·리다이렉트로 거부됐고, 주소를 잘못
 * 입력한 정상 사용자의 IP 를 막을 이유가 없다. 기록 → 관리자 메일 순서는 다른 탐지와 같다.
 */

export type EscalationSource = 'API' | 'CLIENT_ROUTE'

// adminController 가 출처별 건수를 detail 접두어로 센다 — 문구를 바꾸면 집계도 함께 바뀐다.
export const ESCALATION_DETAIL_PREFIX: Record<EscalationSource, string> = {
  API: '관리자 API 거부:',
  CLIENT_ROUTE: '관리자 화면 진입 시도(클라이언트 보고):',
}

export const ESCALATION_POLICY = {
  // 위조 role 로 대시보드가 뜨면 API 가 한 번에 9개 호출된다. 한 번의 시도를 9건으로 세지 않도록
  // 같은 사용자·출처는 이 시간 안에 1건만 기록한다.
  LOG_DEDUPE_MS: 60 * 1000,
  EMAIL_COOLDOWN_MS: 10 * 60 * 1000,
  // 사용자 수만큼만 쌓이지만, 장기 기동 시 메모리가 계속 늘지 않게 오래된 항목을 정리한다.
  MAX_TRACKED: 10_000,
} as const

export interface EscalationEvent {
  userId: number
  email: string | null
  role: string
  ip: string
  userAgent: string | null
  source: EscalationSource
  method: string
  path: string
}

const lastLoggedAt = new Map<string, number>()
const lastEmailAt = new Map<number, number>()

const prune = (map: Map<string | number, number>, now: number, ttl: number): void => {
  if (map.size < ESCALATION_POLICY.MAX_TRACKED) return
  for (const [k, t] of map) if (now - t >= ttl) map.delete(k)
}

/** 같은 사용자·출처가 중복 창 안이면 false. 창 밖이면 시각을 갱신하고 true. */
export function shouldRecord(userId: number, source: EscalationSource, now: number): boolean {
  const key = `${userId}:${source}`
  const prev = lastLoggedAt.get(key)
  if (prev !== undefined && now - prev < ESCALATION_POLICY.LOG_DEDUPE_MS) return false
  prune(lastLoggedAt as Map<string | number, number>, now, ESCALATION_POLICY.LOG_DEDUPE_MS)
  lastLoggedAt.set(key, now)
  return true
}

function shouldEmail(userId: number, now: number): boolean {
  const prev = lastEmailAt.get(userId)
  if (prev !== undefined && now - prev < ESCALATION_POLICY.EMAIL_COOLDOWN_MS) return false
  prune(lastEmailAt as Map<string | number, number>, now, ESCALATION_POLICY.EMAIL_COOLDOWN_MS)
  lastEmailAt.set(userId, now)
  return true
}

// 클라이언트 보고의 경로는 사용자가 마음대로 보낼 수 있는 값이라 detail 에 그대로 넣지 않는다.
// 관리자 화면 경로 형식만 받아들이고, 나머지는 고정 문구로 바꾼다(로그·메일 본문 주입 방지).
const ADMIN_PATH_PATTERN = /^\/admin(\/[A-Za-z0-9_-]{1,40}){0,3}\/?$/

export function sanitizeReportedPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 160) return '(형식 외 경로)'
  return ADMIN_PATH_PATTERN.test(raw) ? raw : '(형식 외 경로)'
}

export function buildDetail(ev: Pick<EscalationEvent, 'source' | 'method' | 'path' | 'role'>): string {
  const prefix = ESCALATION_DETAIL_PREFIX[ev.source]
  return ev.source === 'API'
    ? `${prefix} ${ev.method} ${ev.path} (role=${ev.role})`
    : `${prefix} ${ev.path} (role=${ev.role})`
}

/**
 * 기록·알림. 호출부(미들웨어)의 응답을 늦추지 않도록 await 하지 않고 부르며, 실패는 삼킨다 —
 * 거부 자체는 이미 끝났으므로 기록 실패가 요청 흐름을 바꾸면 안 된다.
 * @returns 실제로 기록했으면 true (중복 창 안이면 false)
 */
export async function recordPrivilegeEscalation(ev: EscalationEvent, now = Date.now()): Promise<boolean> {
  // 관리자는 대상이 아니다. 미들웨어가 이미 걸렀어도 호출부 실수에 대비해 한 번 더 막는다.
  if (ev.role === 'admin') return false
  if (!shouldRecord(ev.userId, ev.source, now)) return false

  const detail = buildDetail(ev)
  console.warn(`[SECURITY] 권한 상승 시도 — user ${ev.userId} · ${detail} · IP ${ev.ip}`)

  const geo = await getLocationFromIp(ev.ip).catch(() => ({ city: undefined, region: undefined, country: undefined }))
  const location = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || '알 수 없음'

  await Promise.allSettled([
    AnomalyLog.create({
      user_id: ev.userId,
      email: ev.email,
      ip: ev.ip,
      user_agent: ev.userAgent,
      anomaly_type: 'PRIVILEGE_ESCALATION',
      action: 'ALERT',
      detail,
      country: geo.country ?? null,
    }),
    (async () => {
      if (!shouldEmail(ev.userId, now)) return
      const admin = await User.findOne({ where: { role: 'admin' } })
      if (!admin?.email) return
      const what = ev.source === 'API' ? '관리자 API 를 호출' : '관리자 화면에 진입하려'
      return sendAnomalyAlertEmail(admin.email, {
        reasons: [`관리자 권한이 없는 계정(ID ${ev.userId})이 ${what} 했습니다. 요청은 거부되었습니다.`],
        ip: ev.ip,
        location,
        userAgent: ev.userAgent ?? '알 수 없음',
      })
    })(),
  ])
  return true
}

/** 검증 스크립트 전용 — 중복·쿨다운 상태 초기화 */
export function resetEscalationStateForTest(): void {
  lastLoggedAt.clear()
  lastEmailAt.clear()
}

import AnomalyLog from '../../models/auth/AnomalyLog'
import User from '../../models/user/User'
import { sendAnomalyAlertEmail } from '../auth/emailService'
import { getLocationFromIp } from '../../utils/getLocationFromIp'

// ─────────────────────────────────────────────────────────────
// 커뮤니티 남용 탐지 기록
//
// 커뮤니티는 거부만 하고 기록을 남기지 않아, 막아낸 시도가 대시보드·메일 어디에도 드러나지
// 않았다(검증 스크립트는 100% 차단을 보이는데 운영 중 실제 시도는 집계가 0 인 관측 공백).
// 거부는 이미 끝난 뒤이므로 기록 실패가 요청 흐름을 바꾸지 않게 호출부는 await 하지 않는다.
//
// 세 종류를 하나의 유형(COMMUNITY_ABUSE)에 담고 detail 접두어로 구분한다. 신뢰도가 다르다.
//   IDOR          서버가 user_id 로 소유자를 판정해 거부한 삭제 시도 — 위조 불가. 가장 강한 신호.
//   IMAGE_FORGERY 이미지로 위장한 첨부(SVG·MIME 불일치·크기 초과) — 저장 전에 거부됨.
//   SPAM          레이트 리미터가 막은 쓰기 요청 — 도배·자동화 정황.
//
// 차단은 리미터가 이미 한다(SPAM=BLOCK). 나머지는 요청만 거부하고 IP 를 막지 않으므로 ALERT 다.
// ─────────────────────────────────────────────────────────────

export type CommunityThreat = 'IDOR' | 'IMAGE_FORGERY' | 'SPAM'

// adminController 가 종류별 건수를 detail 접두어로 센다 — 문구를 바꾸면 집계도 함께 바뀐다.
export const COMMUNITY_DETAIL_PREFIX: Record<CommunityThreat, string> = {
  IDOR: '커뮤니티 소유자 불일치 거부:',
  IMAGE_FORGERY: '커뮤니티 이미지 위장 거부:',
  SPAM: '커뮤니티 도배 차단:',
}

const THREAT_ACTION: Record<CommunityThreat, 'ALERT' | 'BLOCK'> = {
  IDOR: 'ALERT',
  IMAGE_FORGERY: 'ALERT',
  SPAM: 'BLOCK',
}

export const COMMUNITY_ABUSE_POLICY = {
  // 한 번의 시도가 여러 요청으로 번지는 경우(목록 자동 재조회, 연속 클릭)를 여러 건으로 세지
  // 않도록 같은 주체·종류는 이 시간 안에 1건만 기록한다.
  LOG_DEDUPE_MS: 60 * 1000,
  // IDOR 만 메일로 알린다. 이미지 위장·도배는 양이 많아 메일을 보내면 경보 피로만 남는다.
  EMAIL_COOLDOWN_MS: 10 * 60 * 1000,
  MAX_TRACKED: 10_000,
} as const

export interface CommunityAbuseEvent {
  userId: number | null
  email: string | null
  ip: string
  userAgent: string | null
  threat: CommunityThreat
  method: string
  path: string
  /** 종류별 부가 정보. 사용자 입력 원문을 넣지 않는다(로그·메일 본문 주입 방지). */
  info?: string
}

const lastLoggedAt = new Map<string, number>()
const lastEmailAt = new Map<string, number>()

const prune = (map: Map<string, number>, now: number, ttl: number): void => {
  if (map.size < COMMUNITY_ABUSE_POLICY.MAX_TRACKED) return
  for (const [k, t] of map) if (now - t >= ttl) map.delete(k)
}

/** 같은 주체(계정 또는 IP)·종류가 중복 창 안이면 false. 창 밖이면 시각을 갱신하고 true. */
export function shouldRecord(subject: string, threat: CommunityThreat, now: number): boolean {
  const key = `${subject}:${threat}`
  const prev = lastLoggedAt.get(key)
  if (prev !== undefined && now - prev < COMMUNITY_ABUSE_POLICY.LOG_DEDUPE_MS) return false
  prune(lastLoggedAt, now, COMMUNITY_ABUSE_POLICY.LOG_DEDUPE_MS)
  lastLoggedAt.set(key, now)
  return true
}

function shouldEmail(subject: string, now: number): boolean {
  const prev = lastEmailAt.get(subject)
  if (prev !== undefined && now - prev < COMMUNITY_ABUSE_POLICY.EMAIL_COOLDOWN_MS) return false
  prune(lastEmailAt, now, COMMUNITY_ABUSE_POLICY.EMAIL_COOLDOWN_MS)
  lastEmailAt.set(subject, now)
  return true
}

// 경로는 라우터가 만든 값이지만 길이는 잘라서 넣는다(detail 비대 방지)
const SAFE_PATH = /^[A-Za-z0-9/_.:-]{1,120}$/

export function buildDetail(ev: Pick<CommunityAbuseEvent, 'threat' | 'method' | 'path' | 'info'>): string {
  const prefix = COMMUNITY_DETAIL_PREFIX[ev.threat]
  const path = SAFE_PATH.test(ev.path) ? ev.path : '(형식 외 경로)'
  return ev.info ? `${prefix} ${ev.method} ${path} — ${ev.info}` : `${prefix} ${ev.method} ${path}`
}

/**
 * 기록·알림. 호출부의 응답을 늦추지 않도록 await 하지 않고 부르며, 실패는 삼킨다.
 * @returns 실제로 기록했으면 true (중복 창 안이면 false)
 */
export async function recordCommunityAbuse(ev: CommunityAbuseEvent, now = Date.now()): Promise<boolean> {
  const subject = ev.userId !== null ? `u${ev.userId}` : `ip${ev.ip}`
  if (!shouldRecord(subject, ev.threat, now)) return false

  const detail = buildDetail(ev)
  console.warn(`[SECURITY] 커뮤니티 남용 — ${subject} · ${detail} · IP ${ev.ip}`)

  const geo = await getLocationFromIp(ev.ip).catch(() => ({ city: undefined, region: undefined, country: undefined }))
  const location = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || '알 수 없음'

  await Promise.allSettled([
    AnomalyLog.create({
      user_id: ev.userId,
      email: ev.email,
      ip: ev.ip,
      user_agent: ev.userAgent,
      anomaly_type: 'COMMUNITY_ABUSE',
      action: THREAT_ACTION[ev.threat],
      detail,
      country: geo.country ?? null,
    }),
    (async () => {
      if (ev.threat !== 'IDOR') return
      if (!shouldEmail(subject, now)) return
      const admin = await User.findOne({ where: { role: 'admin' } })
      if (!admin?.email) return
      return sendAnomalyAlertEmail(admin.email, {
        reasons: [
          `계정(ID ${ev.userId ?? '미확인'})이 다른 사용자의 커뮤니티 글·댓글을 삭제하려 했습니다. 요청은 거부되었습니다.`,
        ],
        ip: ev.ip,
        location,
        userAgent: ev.userAgent ?? '알 수 없음',
      })
    })(),
  ])
  return true
}

/** 검증 스크립트 전용 — 중복·쿨다운 상태 초기화 */
export function resetCommunityAbuseStateForTest(): void {
  lastLoggedAt.clear()
  lastEmailAt.clear()
}

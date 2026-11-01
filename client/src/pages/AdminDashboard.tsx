import { useState, useEffect, useCallback } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  LineChart, Line, Legend, PieChart, Pie, Cell,
} from 'recharts'

import { API_BASE } from '../utils/api'

const API = `${API_BASE}/api/admin/security`

const TYPE_META: Record<string, { label: string; color: string }> = {
  BRUTE_FORCE:        { label: '브루트포스',     color: '#e53935' },
  ABNORMAL_TIME:      { label: '비정상 시간대', color: '#fb8c00' },
  CONCURRENT_SESSION: { label: '동시 세션',     color: '#8e24aa' },
  ABNORMAL_COUNTRY:   { label: '비정상 국가',   color: '#1e88e5' },
  HONEYPOT:           { label: '허니팟',       color: '#b71c1c' },
  ABUSE_IP:           { label: '악성 IP',       color: '#d84315' },
  REQUEST_TAMPERING:  { label: '요청 위·변조',  color: '#00897b' },
  REPLAY_ATTACK:      { label: '요청 재전송',   color: '#5e35b1' },
  ABNORMAL_TRADE_AMOUNT: { label: '거래 이상',   color: '#c62828' },
  ADVERSARIAL_INPUT:  { label: '적대적 입력',   color: '#00acc1' },
  MODEL_EXTRACTION:   { label: '모델 추출(구)', color: '#6d4c41' },
  INFERENCE_ABUSE:    { label: 'AI 조회 남용',  color: '#6d4c41' },
  IMPOSSIBLE_TRAVEL:  { label: '불가능한 이동', color: '#0277bd' },
  CREDENTIAL_STUFFING:{ label: '반복실패 후 성공', color: '#ad1457' },
  POST_CHANGE_TRADE:  { label: '계정변경 직후 거래', color: '#ef6c00' },
  DORMANT_ACCOUNT_ACTIVITY: { label: '휴면계정 활동', color: '#4527a0' },
  TRADE_FREQUENCY_SPIKE: { label: '거래 빈도 급증(관측)', color: '#546e7a' },
  ROUND_AMOUNT_PATTERN:  { label: '반올림 금액 반복(관측)', color: '#78909c' },
  MULTI_ACCOUNT_SAME_IP: { label: '동일IP 다계정(관측)', color: '#607d8b' },
  ADAPTIVE_STEPUP:    { label: '적응형 재인증',   color: '#00695c' },
  CANARY_ACCESS:      { label: '카나리 계좌',     color: '#880e4f' },
  BOT_BEHAVIOR_MOUSE:  { label: '봇 행동-마우스(관측)', color: '#455a64' },
  BOT_BEHAVIOR_TYPING: { label: '봇 행동-타자(관측)',   color: '#37474f' },
  MULTI_ACCOUNT_DEVICE: { label: '단말 다계정',        color: '#6a1b9a' },
  LEDGER_TAMPERING:    { label: '체결 장부 위·변조',   color: '#bf360c' },
  SPOOFING_ORDER:      { label: '허수주문(관측)',       color: '#b71c6b' },
  WASH_TRADE:          { label: '자전거래(관측)',       color: '#7b1fa2' },
  BOT_TRADE_BEHAVIOR:  { label: '거래 자동화(관측)',    color: '#283593' },
  BEHAVIOR_BIOMETRIC_MISMATCH: { label: '행동 생체인식 불일치(관측)', color: '#4a148c' },
  DEVICE_FINGERPRINT_MISMATCH: { label: '디바이스 지문 변화(관측)', color: '#311b92' },
  PRIVILEGE_ESCALATION: { label: '권한 상승 시도', color: '#d50000' },
  COMMUNITY_ABUSE:      { label: '커뮤니티 남용',   color: '#00838f' },
}

const ACTION_META: Record<string, { label: string; color: string }> = {
  ALERT: { label: '경고', color: '#fb8c00' },
  BLOCK: { label: '차단', color: '#e53935' },
  LOCK:  { label: '잠금', color: '#8e24aa' },
}

type Stats = {
  total: number; today: number; locked: number; blockedIPs: number
  honeypotHits: number; integrityViolations: number
  tradeAnomalies: number; tradeBlocked: number
  multiAccountDevices: number; multiAccountAlerts: number; multiAccountBlocked: number
  ledgerAnchored: number; ledgerTampering: number; ledgerOnChain: boolean
  escalationApi: number; escalationRoute: number
  communityIdor: number; communityImage: number; communitySpam: number
}
// 서버(getAnomalyLogs)는 AnomalyLog 행을 통째로 내려준다 — user_id·user_agent 도 온다.
// 타입에만 빠져 있어 허니팟 표에서 `(h as any).user_agent` 로 우회하고 있었다.
type AnomalyLog = {
  id: number; user_id: number | null; email: string | null; ip: string; anomaly_type: string
  action: string; detail: string; country: string | null; resolved: boolean; created_at: string
  user_agent: string | null
}
type LockedUser = { id: number; email: string; name: string; created_at: string }
type ChartRow = { anomaly_type?: string; date?: string; count: number; label?: string }
type InferenceLog = {
  id: number; user_id: number | null; ip: string; stock_code: string | null; horizon: string | null
  decision: 'ALLOW' | 'DENY'; deny_reason: string | null; label: number | null
  latency_ms: number | null; adapter: string | null; created_at: string
}
type InferenceSummary = {
  allowed24h: number; denied24h: number
  allowedTotal: number; deniedTotal: number
  denyByReason: { deny_reason: string | null; count: number }[]
}
type AdaptiveAuthStats = {
  windowDays: number; total: number; note: string
  byRequirement: Record<string, number>
  byMode: Record<string, number>
  averageScore: number | null
}

const g = fetch

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [chartType, setChartType] = useState<ChartRow[]>([])
  const [chartDay, setChartDay] = useState<ChartRow[]>([])
  const [honeypots, setHoneypots] = useState<AnomalyLog[]>([])
  const [logs, setLogs] = useState<AnomalyLog[]>([])
  const [logTotal, setLogTotal] = useState(0)
  const [logPage, setLogPage] = useState(1)
  const [logTypeFilter, setLogTypeFilter] = useState('')
  const [lockedUsers, setLockedUsers] = useState<LockedUser[]>([])
  const [blockedIPs, setBlockedIPs] = useState<string[]>([])
  const [inferenceLogs, setInferenceLogs] = useState<InferenceLog[]>([])
  const [inferenceSummary, setInferenceSummary] = useState<InferenceSummary | null>(null)
  const [adaptive, setAdaptive] = useState<AdaptiveAuthStats | null>(null)
  const [selectedLog, setSelectedLog] = useState<AnomalyLog | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const opt = { credentials: 'include' as const }
      const [s, ct, cd, hp, la, bi, inf, ad] = await Promise.all([
        g(`${API}/stats`, opt).then(r => r.json()),
        g(`${API}/chart/by-type`, opt).then(r => r.json()),
        g(`${API}/chart/by-day`, opt).then(r => r.json()),
        g(`${API}/honeypot-hits`, opt).then(r => r.json()),
        g(`${API}/locked-accounts`, opt).then(r => r.json()),
        g(`${API}/blocked-ips`, opt).then(r => r.json()),
        g(`${API}/inference-logs`, opt).then(r => r.json()),
        g(`${API}/adaptive-auth?days=7`, opt).then(r => r.json()),
      ])
      setStats(s)
      setChartType(ct.map((r: ChartRow) => ({ ...r, label: TYPE_META[r.anomaly_type!]?.label ?? r.anomaly_type, count: Number(r.count) })))
      setChartDay(cd.map((r: ChartRow) => ({ ...r, count: Number(r.count) })))
      setHoneypots(Array.isArray(hp) ? hp : [])
      setLockedUsers(la.users ?? [])
      setBlockedIPs(bi.ips ?? [])
      setInferenceLogs(Array.isArray(inf?.logs) ? inf.logs : [])
      setInferenceSummary(inf?.summary ?? null)
      setAdaptive(ad && typeof ad.total === 'number' ? ad : null)
      setLastUpdated(new Date())
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [])

  const fetchLogs = useCallback(async () => {
    const params = new URLSearchParams({ page: String(logPage), limit: '20' })
    if (logTypeFilter) params.set('type', logTypeFilter)
    const res = await g(`${API}/anomaly-logs?${params}`, { credentials: 'include' })
    const data = await res.json()
    setLogs(data.logs)
    setLogTotal(data.total)
  }, [logPage, logTypeFilter])

  useEffect(() => { fetchAll() }, [fetchAll])
  useEffect(() => { fetchLogs() }, [fetchLogs])

  useEffect(() => {
    const t = setInterval(() => { fetchAll(); fetchLogs() }, 30000)
    return () => clearInterval(t)
  }, [fetchAll, fetchLogs])

  const handleUnlock = async (userId: number, email: string) => {
    if (!confirm(`${email} 계정 잠금을 해제하시겠습니까?`)) return
    const res = await g(`${API}/users/${userId}/unlock`, { method: 'PATCH', credentials: 'include' })
    const d = await res.json()
    alert(d.message)
    fetchAll()
  }

  const handleUnblockIP = async (ip: string) => {
    if (!confirm(`${ip} 차단을 해제하시겠습니까?`)) return
    const res = await g(`${API}/blocked-ips/${encodeURIComponent(ip)}`, { method: 'DELETE', credentials: 'include' })
    const d = await res.json()
    alert(d.message)
    fetchAll()
  }

  const section: React.CSSProperties = {
    backgroundColor: '#fff', borderRadius: '16px', padding: '24px',
    boxShadow: '0 2px 12px rgba(0,0,0,0.07)', marginBottom: '20px',
  }
  const sectionTitle: React.CSSProperties = {
    fontSize: '15px', fontWeight: 700, color: '#1a1a1a', marginBottom: '16px',
  }
  const th: React.CSSProperties = {
    padding: '10px 14px', textAlign: 'left', fontSize: '12px', fontWeight: 700,
    color: '#888', borderBottom: '2px solid #f0f0f0', whiteSpace: 'nowrap',
  }
  const td: React.CSSProperties = {
    padding: '10px 14px', fontSize: '13px', color: '#333',
    borderBottom: '1px solid #f8f8f8', verticalAlign: 'middle',
  }
  const btn = (bg: string, color = '#fff'): React.CSSProperties => ({
    padding: '6px 14px', backgroundColor: bg, color, border: 'none',
    borderRadius: '7px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
  })
  const badge = (color: string): React.CSSProperties => ({
    padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 700,
    backgroundColor: color + '20', color,
  })

  const totalPages = Math.ceil(logTotal / 20)

  // 적응형 인증 등급 분포 — 서버 집계(GET /adaptive-auth)를 그대로 쓴다.
  // 통과(NONE)는 애초에 기록 대상이 아니므로 항목에 넣지 않는다. 넣으면 없는 값을
  // 0 으로 그려 "통과가 한 건도 없었다"는 잘못된 해석을 만든다.
  // 현재 정책의 재인증 수단은 지갑 서명 하나다. PIN·이메일 OTP 는 정책 변경 이전
  // 기록에만 존재하므로, 값이 0 이면 아래 filter 에서 자동으로 빠진다.
  const ADAPTIVE_META: { key: string; name: string; color: string }[] = [
    { key: 'WALLET',    name: '지갑서명 (WALLET)', color: '#1e88e5' },
    { key: 'PIN',       name: 'PIN 인증 (구정책)',  color: '#8e24aa' },
    { key: 'EMAIL_OTP', name: '이메일 OTP (구정책)', color: '#fb8c00' },
  ]
  const adaptiveAuthData = ADAPTIVE_META
    .map(m => ({ name: m.name, value: Number(adaptive?.byRequirement?.[m.key] ?? 0), color: m.color }))
    .filter(d => d.value > 0)

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f4f6f9', padding: '32px 28px', fontFamily: 'sans-serif' }}>
      <div style={{ maxWidth: '1300px', margin: '0 auto' }}>

        {/* 헤더 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '28px' }}>
          <div>
            <h1 style={{ fontSize: '22px', fontWeight: 'bold', color: '#1a1a1a', margin: 0 }}>
              보안 관제 대시보드
            </h1>
            <p style={{ fontSize: '12px', color: '#aaa', marginTop: '4px', margin: '4px 0 0' }}>
              {lastUpdated ? `마지막 갱신: ${lastUpdated.toLocaleTimeString('ko-KR')} · 30초마다 자동 새로고침` : '로딩 중...'}
            </p>
          </div>
          <button onClick={() => { fetchAll(); fetchLogs() }} disabled={loading}
            style={{ ...btn('#3CB371'), padding: '10px 20px', fontSize: '13px', opacity: loading ? 0.6 : 1 }}>
            {loading ? '갱신 중...' : '새로고침'}
          </button>
        </div>

        {/* ── 1. 요약 통계 카드 ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '16px', marginBottom: '20px' }}>
          {[
            { label: '전체 이상탐지', value: stats?.total ?? '—', color: '#1e88e5', icon: '🔍', note: '' },
            { label: '오늘 탐지',     value: stats?.today ?? '—', color: '#e53935', icon: '⚡', note: '' },
            { label: '허니팟 히트',  value: stats?.honeypotHits ?? '—', color: '#b71c1c', icon: '🍯', note: '' },
            { label: '요청 무결성 위반', value: stats?.integrityViolations ?? '—', color: '#00897b', icon: '✍️', note: '' },
            {
              label: '거래 이상탐지', value: stats?.tradeAnomalies ?? '—', color: '#c62828', icon: '📈',
              note: stats ? `주문 거절 ${stats.tradeBlocked}건` : '',
            },
            {
              label: '다계정 단말', value: stats?.multiAccountDevices ?? '—', color: '#6a1b9a', icon: '👥',
              note: stats ? `전환·연결 경보 ${stats.multiAccountAlerts}건 · 가입 차단 ${stats.multiAccountBlocked}건` : '',
            },
            {
              label: '체결 장부 고정(일)', value: stats?.ledgerAnchored ?? '—', color: '#bf360c', icon: '⛓️',
              note: stats ? `위·변조 경보 ${stats.ledgerTampering}건 · ${stats.ledgerOnChain ? '체인 고정' : 'DB 고정'}` : '',
            },
            {
              label: '권한 상승 시도',
              value: stats ? stats.escalationApi + stats.escalationRoute : '—',
              color: '#d50000', icon: '🛂',
              note: stats ? `관리자 API 거부 ${stats.escalationApi}건 · 화면 진입 ${stats.escalationRoute}건` : '',
            },
            {
              label: '커뮤니티 남용',
              value: stats ? stats.communityIdor + stats.communityImage + stats.communitySpam : '—',
              color: '#00838f', icon: '💬',
              note: stats
                ? `남의 글 삭제 시도 ${stats.communityIdor}건 · 이미지 위장 ${stats.communityImage}건 · 도배 차단 ${stats.communitySpam}건`
                : '',
            },
            { label: '잠긴 계정',    value: stats?.locked ?? '—', color: '#8e24aa', icon: '🔒', note: '' },
            { label: '차단된 IP',    value: stats?.blockedIPs ?? '—', color: '#fb8c00', icon: '🚫', note: '' },
          ].map(card => (
            <div key={card.label} style={{
              backgroundColor: '#fff', borderRadius: '14px', padding: '20px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.06)', borderTop: `4px solid ${card.color}`,
            }}>
              <div style={{ fontSize: '22px', marginBottom: '8px' }}>{card.icon}</div>
              <div style={{ fontSize: '28px', fontWeight: 800, color: card.color }}>{typeof card.value === 'number' ? card.value.toLocaleString() : card.value}</div>
              <div style={{ fontSize: '12px', color: '#888', marginTop: '4px' }}>{card.label}</div>
              {card.note && <div style={{ fontSize: '11px', color: '#bbb', marginTop: '2px' }}>{card.note}</div>}
            </div>
          ))}
        </div>

        {/* ── 2. 차트 영역 (유형별, 추이, 적응형 인증 통계) ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '20px', marginBottom: '20px' }}>

          {/* 유형별 탐지 현황 */}
          <div style={section}>
            <p style={sectionTitle}>유형별 탐지 현황</p>
            {chartType.length === 0
              ? <p style={{ textAlign: 'center', color: '#ccc', padding: '40px 0' }}>탐지 데이터 없음</p>
              : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartType} margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip formatter={(v: any) => [`${v ?? 0}건`, '탐지 수']} />
                    <Bar dataKey="count" radius={[6, 6, 0, 0]}
                      fill="#3CB371"
                    />
                  </BarChart>
                </ResponsiveContainer>
              )
            }
          </div>

          {/* 7일간 탐지 추이 */}
          <div style={section}>
            <p style={sectionTitle}>7일간 탐지 추이</p>
            {chartDay.length === 0
              ? <p style={{ textAlign: 'center', color: '#ccc', padding: '40px 0' }}>탐지 데이터 없음</p>
              : (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={chartDay} margin={{ top: 0, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }}
                      tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip formatter={(v: any) => [`${v ?? 0}건`, '탐지 수']}
                      labelFormatter={(l: any) => `날짜: ${l}`} />
                    <Legend />
                    <Line type="monotone" dataKey="count" stroke="#e53935" strokeWidth={2}
                      dot={{ r: 4, fill: '#e53935' }} name="탐지 건수" />
                  </LineChart>
                </ResponsiveContainer>
              )
            }
          </div>

          {/* 적응형 인증 등급 분포 카드 (추가된 명세 통계) */}
          <div style={section}>
            <p style={sectionTitle}>
              적응형 인증 등급 분포
              <span style={{ fontSize: '11px', color: '#aaa', fontWeight: 400, marginLeft: '6px' }}>
                최근 {adaptive?.windowDays ?? 7}일 · 통과(NONE) 제외
              </span>
            </p>
            {adaptiveAuthData.length === 0 ? (
              <p style={{ textAlign: 'center', color: '#ccc', padding: '40px 0' }}>재인증 판정 기록 없음</p>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={190}>
                  <PieChart>
                    <Pie data={adaptiveAuthData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} innerRadius={35} label={{ fontSize: 10 }}>
                      {adaptiveAuthData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v: any) => [`${v}건`, '판정 수']} />
                    <Legend iconSize={8} wrapperStyle={{ fontSize: '11px' }} />
                  </PieChart>
                </ResponsiveContainer>
                <p style={{ fontSize: '11px', color: '#888', textAlign: 'center', margin: 0 }}>
                  총 {adaptive?.total ?? 0}건 · 평균 위험점수 {adaptive?.averageScore ?? '—'} ·
                  {' '}{(adaptive?.byMode?.['강제'] ?? 0) > 0 ? '강제 모드 포함' : '관측 모드'}
                </p>
              </>
            )}
          </div>

        </div>

        {/* ── 3. 허니팟 히트 현황 ── */}
        <div style={section}>
          <p style={sectionTitle}>허니팟 히트 현황 <span style={{ fontSize: '12px', color: '#b71c1c', fontWeight: 400 }}>— 공격자/스캐너가 탐색 중인 경로</span></p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>{['시각', 'IP', '탐지 경로', 'User-Agent'].map(h => <th key={h} style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {honeypots.length === 0
                  ? <tr><td colSpan={4} style={{ ...td, textAlign: 'center', color: '#ccc', padding: '32px' }}>허니팟 히트 없음</td></tr>
                  : honeypots.map(h => (
                    <tr key={h.id}>
                      <td style={{ ...td, color: '#888', whiteSpace: 'nowrap' }}>{new Date(h.created_at).toLocaleString('ko-KR')}</td>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: '12px' }}>{h.ip}</td>
                      <td style={{ ...td, color: '#b71c1c' }}>{h.detail.replace('허니팟 접근 탐지: ', '')}</td>
                      <td style={{ ...td, color: '#aaa', fontSize: '11px', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={h.user_agent ?? ''}>
                        {h.user_agent ?? '—'}
                      </td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 4. 잠긴 계정 + 차단 IP ── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>

          {/* 잠긴 계정 */}
          <div style={section}>
            <p style={sectionTitle}>잠긴 계정 관리
              <span style={{ marginLeft: '8px', fontSize: '12px', color: '#8e24aa', fontWeight: 400 }}>
                {lockedUsers.length > 0 ? `${lockedUsers.length}개 잠김` : '없음'}
              </span>
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>{['이름', '이메일', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {lockedUsers.length === 0
                  ? <tr><td colSpan={3} style={{ ...td, textAlign: 'center', color: '#ccc', padding: '28px' }}>잠긴 계정 없음</td></tr>
                  : lockedUsers.map(u => (
                    <tr key={u.id}>
                      <td style={td}>{u.name}</td>
                      <td style={{ ...td, color: '#555' }}>{u.email}</td>
                      <td style={td}>
                        <button onClick={() => handleUnlock(u.id, u.email)} style={btn('#3CB371')}>
                          잠금 해제
                        </button>
                      </td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>

          {/* 차단된 IP */}
          <div style={section}>
            <p style={sectionTitle}>차단된 IP 관리
              <span style={{ marginLeft: '8px', fontSize: '12px', color: '#fb8c00', fontWeight: 400 }}>
                인메모리 · 서버 재시작 시 초기화
              </span>
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>{['차단 IP', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {blockedIPs.length === 0
                  ? <tr><td colSpan={2} style={{ ...td, textAlign: 'center', color: '#ccc', padding: '28px' }}>차단된 IP 없음</td></tr>
                  : blockedIPs.map(ip => (
                    <tr key={ip}>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: '14px' }}>{ip}</td>
                      <td style={td}>
                        <button onClick={() => handleUnblockIP(ip)} style={btn('#e53935')}>
                          차단 해제
                        </button>
                      </td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        </div>

        {/* ── AI 추론 요청 감사 로그 ── */}
        <div style={section}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <p style={{ ...sectionTitle, margin: 0 }}>AI 추론 요청 감사 로그
              {/* 표는 전체 기간 최신순이라 24시간 수치만 보이면 서로 모순처럼 읽힌다 — 두 창을 함께 표기한다. */}
              <span style={{ marginLeft: '8px', fontSize: '12px', color: '#888', fontWeight: 400 }}>
                최근 24시간 허용 {inferenceSummary?.allowed24h ?? 0} / 차단 {inferenceSummary?.denied24h ?? 0}
                <span style={{ margin: '0 6px', color: '#ddd' }}>|</span>
                누적 허용 {inferenceSummary?.allowedTotal ?? 0} / 차단 {inferenceSummary?.deniedTotal ?? 0}
              </span>
            </p>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {(inferenceSummary?.denyByReason ?? []).map(r => (
                <span key={r.deny_reason ?? 'unknown'} style={badge('#00897b')}>
                  {(r.deny_reason ?? 'UNKNOWN')} {Number(r.count)}
                </span>
              ))}
            </div>
          </div>
          <p style={{ fontSize: '11.5px', color: '#aaa', margin: '0 0 8px' }}>
            아래 표는 기간 제한 없이 최신 {inferenceLogs.length}건입니다 (24시간 이전 기록 포함).
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>{['시각', '사용자', 'IP', '종목', '구간', '판정', '사유/결과', '지연'].map(h => <th key={h} style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {inferenceLogs.length === 0
                  ? <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: '#ccc', padding: '28px' }}>추론 요청 없음</td></tr>
                  : inferenceLogs.map(l => (
                    <tr key={l.id}>
                      <td style={{ ...td, whiteSpace: 'nowrap', color: '#888', fontSize: '12px' }}>
                        {new Date(l.created_at).toLocaleString('ko-KR')}
                      </td>
                      <td style={td}>{l.user_id ?? '—'}</td>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: '12px' }}>{l.ip}</td>
                      <td style={td}>{l.stock_code ?? '—'}</td>
                      <td style={td}>{l.horizon ?? '—'}</td>
                      <td style={td}>
                        <span style={badge(l.decision === 'ALLOW' ? '#3CB371' : '#e53935')}>
                          {l.decision === 'ALLOW' ? '허용' : '차단'}
                        </span>
                      </td>
                      <td style={{ ...td, color: '#555', fontSize: '12px' }}>
                        {l.decision === 'DENY' ? (l.deny_reason ?? '—') : (l.label === 1 ? '상승' : l.label === 0 ? '하락' : '—')}
                      </td>
                      <td style={{ ...td, color: '#888', fontSize: '12px' }}>{l.latency_ms != null ? `${l.latency_ms}ms` : '—'}</td>
                    </tr>
                  ))
                }
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 로그 상세 ──
            detail 은 목록에서 260px 로 잘린다. 특히 ADAPTIVE_STEPUP 은 어떤 신호가 몇 점을
            올려 그 등급이 나왔는지가 detail 뒤쪽에 들어 있어, 잘리면 판정 근거를 볼 수 없다. */}
        {selectedLog && (() => {
          const tm = TYPE_META[selectedLog.anomaly_type] ?? { label: selectedLog.anomaly_type, color: '#999' }
          const am = ACTION_META[selectedLog.action] ?? { label: selectedLog.action, color: '#999' }
          const row = (label: string, value: React.ReactNode) => (
            <div style={{ display: 'flex', gap: '12px', padding: '9px 0', borderBottom: '1px solid #f2f2f2' }}>
              <span style={{ width: '96px', flexShrink: 0, fontSize: '12px', color: '#999', fontWeight: 600 }}>{label}</span>
              <span style={{ fontSize: '13px', color: '#333', wordBreak: 'break-all' }}>{value}</span>
            </div>
          )
          return (
            <div
              onClick={() => setSelectedLog(null)}
              style={{
                position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.45)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '24px',
              }}
            >
              <div
                onClick={e => e.stopPropagation()}
                style={{
                  backgroundColor: '#fff', borderRadius: '16px', padding: '24px 26px',
                  width: '100%', maxWidth: '620px', maxHeight: '82vh', overflowY: 'auto',
                  boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '18px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={badge(tm.color)}>{tm.label}</span>
                    <span style={badge(am.color)}>{am.label}</span>
                    <span style={{ fontSize: '12px', color: selectedLog.resolved ? '#3CB371' : '#e53935', fontWeight: 600 }}>
                      {selectedLog.resolved ? '해결됨' : '미해결'}
                    </span>
                  </div>
                  <button
                    onClick={() => setSelectedLog(null)}
                    style={{ border: 'none', background: 'none', fontSize: '20px', color: '#bbb', cursor: 'pointer', lineHeight: 1 }}
                  >
                    ×
                  </button>
                </div>

                {row('로그 ID', `#${selectedLog.id}`)}
                {row('발생 시각', new Date(selectedLog.created_at).toLocaleString('ko-KR'))}
                {row('계정', selectedLog.email ?? '—')}
                {row('사용자 ID', selectedLog.user_id ?? '—')}
                {row('IP', <span style={{ fontFamily: 'monospace' }}>{selectedLog.ip}</span>)}
                {row('국가', selectedLog.country ?? '—')}
                {row('User-Agent', <span style={{ fontSize: '12px', color: '#666' }}>{selectedLog.user_agent ?? '—'}</span>)}

                <div style={{ marginTop: '16px' }}>
                  <p style={{ fontSize: '12px', color: '#999', fontWeight: 600, marginBottom: '8px' }}>상세 내용</p>
                  <pre style={{
                    margin: 0, padding: '14px', backgroundColor: '#f8f9fa', borderRadius: '10px',
                    fontSize: '12.5px', lineHeight: 1.7, color: '#333',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    fontFamily: 'inherit',
                  }}>
                    {selectedLog.detail}
                  </pre>
                </div>
              </div>
            </div>
          )
        })()}

        {/* ── 5. 이상탐지 로그 전체 ── */}
        <div style={section}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <p style={{ ...sectionTitle, margin: 0 }}>이상탐지 로그
              <span style={{ marginLeft: '8px', fontSize: '12px', color: '#888', fontWeight: 400 }}>총 {logTotal.toLocaleString()}건</span>
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <select value={logTypeFilter} onChange={e => { setLogTypeFilter(e.target.value); setLogPage(1) }}
                style={{ padding: '6px 12px', border: '1px solid #ddd', borderRadius: '8px', fontSize: '12px' }}>
                <option value="">전체 유형</option>
                {Object.entries(TYPE_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <button onClick={fetchLogs} style={btn('#3CB371')}>조회</button>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>{['시각', '유형', '조치', '이메일', 'IP', '국가', '상세', '상태'].map(h => <th key={h} style={th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {logs.length === 0
                  ? <tr><td colSpan={8} style={{ ...td, textAlign: 'center', color: '#ccc', padding: '32px' }}>로그 없음</td></tr>
                  : logs.map(log => {
                    const tm = TYPE_META[log.anomaly_type] ?? { label: log.anomaly_type, color: '#999' }
                    const am = ACTION_META[log.action] ?? { label: log.action, color: '#999' }
                    return (
                      <tr key={log.id}
                        onClick={() => setSelectedLog(log)}
                        style={{ backgroundColor: log.resolved ? '#fafafa' : '#fff', cursor: 'pointer' }}
                        onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f0f7f4')}
                        onMouseLeave={e => (e.currentTarget.style.backgroundColor = log.resolved ? '#fafafa' : '#fff')}
                      >
                        <td style={{ ...td, whiteSpace: 'nowrap', color: '#888', fontSize: '12px' }}>
                          {new Date(log.created_at).toLocaleString('ko-KR')}
                        </td>
                        <td style={td}><span style={badge(tm.color)}>{tm.label}</span></td>
                        <td style={td}><span style={badge(am.color)}>{am.label}</span></td>
                        <td style={{ ...td, color: '#555' }}>{log.email ?? '—'}</td>
                        <td style={{ ...td, fontFamily: 'monospace', fontSize: '12px' }}>{log.ip}</td>
                        <td style={td}>{log.country ?? '—'}</td>
                        <td style={{ ...td, maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={log.detail}>{log.detail}</td>
                        <td style={td}>
                          <span style={{ color: log.resolved ? '#3CB371' : '#e53935', fontWeight: 600, fontSize: '12px' }}>
                            {log.resolved ? '해결됨' : '미해결'}
                          </span>
                        </td>
                      </tr>
                    )
                  })
                }
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '16px' }}>
              <button onClick={() => setLogPage(p => Math.max(1, p - 1))} disabled={logPage === 1}
                style={{ ...btn('#eee', '#555'), opacity: logPage === 1 ? 0.5 : 1 }}>이전</button>
              <span style={{ lineHeight: '30px', fontSize: '13px', color: '#555' }}>{logPage} / {totalPages}</span>
              <button onClick={() => setLogPage(p => Math.min(totalPages, p + 1))} disabled={logPage === totalPages}
                style={{ ...btn('#eee', '#555'), opacity: logPage === totalPages ? 0.5 : 1 }}>다음</button>
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
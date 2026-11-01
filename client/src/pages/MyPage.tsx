import { useEffect, useState, useCallback, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTradeModeStore } from '../store/tradeModeStore'
import { useProfileStore } from '../store/profileStore'
import VirtualPortfolio from '../components/trade/VirtualPortfolio'
import PinPad from '../components/trade/PinPad'

import { API_BASE } from '../utils/api'
import { signedFetch } from '../utils/tradeSigning'
import { clearSession } from '../utils/session'

// ─── 실거래 포트폴리오 섹션 ─────────────────────────────────────
function RealPortfolioSection({ onRegister, refreshKey }: { onRegister: () => void; refreshKey: number }) {
  const [status, setStatus] = useState<'loading' | 'registered' | 'not_registered'>('loading')

  useEffect(() => {
    fetch(`${API_BASE}/api/trade/real/account`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => setStatus(data.isRegistered ? 'registered' : 'not_registered'))
      .catch(() => setStatus('not_registered'))
  }, [refreshKey])

  if (status === 'loading') return <p className="text-sm text-gray-400">로딩 중...</p>

  if (status === 'not_registered') {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4">
        <div className="text-4xl">🏦</div>
        <p className="font-bold text-gray-800">아직 실거래 계좌가 등록되지 않았습니다</p>
        <p className="text-sm text-gray-500">KIS 앱키를 등록하면 실제 주식 거래 및 포트폴리오를 확인할 수 있습니다.</p>
        <button
          onClick={onRegister}
          className="mt-2 px-6 py-3 bg-orange-600 text-white font-bold rounded-xl hover:bg-orange-700 transition text-sm"
        >
          계좌 등록하기
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-20">
      <div className="w-56 h-56 bg-slate-50 rounded-full border-2 border-dashed border-gray-200 flex items-center justify-center text-gray-300 text-sm">
        그래프 영역 (데이터 대기 중)
      </div>
      <div className="flex-1 flex flex-col gap-6">
        <div className="h-40 bg-slate-50 rounded-xl border border-dashed border-gray-200 flex items-center justify-center text-gray-300 text-sm">
          보유 주식 목록이 여기에 표시됩니다.
        </div>
      </div>
    </div>
  )
}

// ─── 모의투자 계좌 섹션 ──────────────────────────────────────────
function VirtualAccountSection() {
  const [hasAccount, setHasAccount] = useState<boolean | null>(null)

  useEffect(() => {
    fetch(`${API_BASE}/api/trade/virtual/portfolio`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data) => setHasAccount(!!data.balance || data.balance === 0))
      .catch(() => setHasAccount(false))
  }, [])

  if (hasAccount === null) return <p className="text-sm text-gray-400">로딩 중...</p>

  if (hasAccount) {
    return (
      <div className="p-4 bg-green-50 border border-green-200 rounded-xl text-center">
        <p className="text-sm text-[#22C55E] font-semibold">✅ 모의투자 계좌가 개설되어 있습니다.</p>
      </div>
    )
  }

  // 개설은 아래 모의투자 섹션의 PIN 설정 흐름에서만 처리한다.
  // 여기에 있던 개설 버튼은 PIN 없이 요청을 보내 서버가 항상 400 으로 거절했고,
  // PIN 설정 단계를 건너뛰어 거래 인증 수단이 없는 계좌를 만들려 했다.
  return (
    <div className="p-5 bg-gray-50 border border-gray-200 rounded-2xl text-center space-y-1">
      <p className="text-sm text-gray-600">아직 모의투자 계좌가 없습니다.</p>
      <p className="text-xs text-gray-400">계좌 개설 시 초기 자금 1,000만원이 지급됩니다.</p>
      <p className="text-xs text-gray-500 pt-2">
        아래 <span className="font-semibold text-[#22C55E]">모의투자</span> 섹션에서 거래용 PIN을 설정하면 계좌가 개설됩니다.
      </p>
    </div>
  )
}

// ─── 실거래 KIS 계좌 섹션 ────────────────────────────────────────
function RealAccountSection({ onAccountChange }: { onAccountChange: () => void }) {
  const [status, setStatus] = useState<'loading' | 'registered' | 'not_registered'>('loading')
  const [maskedCano, setMaskedCano] = useState('')
  const [form, setForm] = useState({ appKey: '', appSecret: '', cano: '', acntPrdtCd: '01' })
  const [showForm, setShowForm] = useState(false)

  // 계좌 등록·해제의 PIN 도 화면 키패드로 받는다 — 모의투자·PIN 설정과 같은 경로다.
  // 'register' 는 KIS 정보 입력을 마친 뒤, 'remove' 는 해제 버튼을 누른 뒤 뜬다.
  const [pinFlow, setPinFlow] = useState<'register' | 'remove' | null>(null)
  const [pinPadKey, setPinPadKey] = useState(0)
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/trade/real/account`, { credentials: 'include' })
      const data = await res.json()
      if (data.isRegistered) {
        setStatus('registered')
        setMaskedCano(data.maskedCano ?? '')
      } else {
        setStatus('not_registered')
      }
    } catch {
      setStatus('not_registered')
    }
  }

  useEffect(() => { fetchStatus() }, [])

  // KIS 정보만 먼저 검증하고, PIN 은 키패드로 따로 받는다.
  const startRegister = () => {
    const { appKey, appSecret, cano, acntPrdtCd } = form
    if (!appKey || !appSecret || !cano || !acntPrdtCd) {
      setMsg({ text: '모든 항목을 입력해주세요', ok: false })
      return
    }
    setMsg(null)
    setPinFlow('register')
    setPinPadKey(k => k + 1)
  }

  const handleRegister = async (pin: string) => {
    const { appKey, appSecret, cano, acntPrdtCd } = form
    setLoading(true)
    setMsg(null)
    try {
      const res = await signedFetch(`${API_BASE}/api/trade/real/account`, {
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ appKey, appSecret, cano, acntPrdtCd, pin }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setMsg({ text: '실거래 계좌가 등록되었습니다', ok: true })
      setShowForm(false)
      setForm({ appKey: '', appSecret: '', cano: '', acntPrdtCd: '01' })
      fetchStatus()
      onAccountChange()
    } catch (e: any) {
      setMsg({ text: e.message, ok: false })
    } finally {
      setPinFlow(null)
      setLoading(false)
    }
  }

  const handleRemove = async (pin: string) => {
    setLoading(true)
    setMsg(null)
    try {
      const res = await signedFetch(`${API_BASE}/api/trade/real/account`, {
        method: 'DELETE',
        credentials: 'include',
        body: JSON.stringify({ pin }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setMsg({ text: '계좌 연동이 해제되었습니다', ok: true })
      fetchStatus()
      onAccountChange()
    } catch (e: any) {
      setMsg({ text: e.message, ok: false })
    } finally {
      setPinFlow(null)
      setLoading(false)
    }
  }

  if (status === 'loading') return <p className="text-sm text-gray-400">로딩 중...</p>

  if (status === 'registered') {
    return (
      <div className="space-y-3">
        <div className="p-5 bg-orange-50 border border-orange-200 rounded-2xl">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-orange-600 font-bold text-sm">✅ 실거래 계좌 연동됨</span>
          </div>
          <p className="text-xs text-gray-500">계좌번호: {maskedCano || '등록됨'}</p>
        </div>
        {msg && (
          <p className={`text-sm font-semibold text-center ${msg.ok ? 'text-[#22C55E]' : 'text-red-500'}`}>{msg.text}</p>
        )}
        <button
          onClick={() => { setMsg(null); setPinFlow('remove'); setPinPadKey(k => k + 1) }}
          disabled={loading}
          className="w-full py-2.5 border-2 border-red-200 text-red-500 font-bold rounded-xl hover:bg-red-50 transition text-sm disabled:opacity-50"
        >
          {loading ? '처리 중...' : '계좌 연동 해제'}
        </button>

        {pinFlow === 'remove' && (
          <PinPad
            key={pinPadKey}
            title="계좌 연동 해제"
            subtitle="본인 확인을 위해 거래 PIN을 입력하세요"
            onConfirm={handleRemove}
            onCancel={() => setPinFlow(null)}
          />
        )}
      </div>
    )
  }

  // not_registered
  return (
    <div className="space-y-3">
      {!showForm ? (
        <>
          <div className="p-5 bg-orange-50 border border-orange-200 rounded-2xl text-center">
            <p className="text-sm text-gray-700 font-semibold mb-1">KIS 실거래 계좌 연동</p>
            <p className="text-xs text-gray-500 leading-relaxed">
              한국투자증권 Open API 앱키를 등록하면<br />실제 주식 매매가 가능합니다
            </p>
          </div>
          {msg && (
            <p className={`text-sm font-semibold text-center ${msg.ok ? 'text-[#22C55E]' : 'text-red-500'}`}>{msg.text}</p>
          )}
          <button
            onClick={() => { setShowForm(true); setMsg(null) }}
            className="w-full py-3 bg-orange-600 text-white font-bold rounded-xl hover:bg-orange-700 transition text-sm"
          >
            계좌 등록하기
          </button>
        </>
      ) : (
        <div className="space-y-3">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
            <p className="text-xs text-amber-700 font-semibold">KIS 오픈 API 앱키 입력</p>
            <p className="text-xs text-gray-500 mt-0.5">한국투자증권 개발자센터에서 발급한 본인 계좌 앱키를 입력하세요.</p>
          </div>
          {[
            { key: 'appKey', label: 'APP KEY', placeholder: 'PS...' },
            { key: 'appSecret', label: 'APP SECRET', placeholder: 'APP SECRET 입력' },
            { key: 'cano', label: '계좌번호 (앞 8자리)', placeholder: '12345678' },
            { key: 'acntPrdtCd', label: '계좌상품코드 (뒤 2자리)', placeholder: '01' },
          ].map(({ key, label, placeholder }) => (
            <div key={key}>
              <label className="block text-xs font-semibold text-gray-500 mb-1">{label}</label>
              <input
                type={key === 'appSecret' ? 'password' : 'text'}
                value={(form as any)[key]}
                onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                placeholder={placeholder}
                maxLength={key === 'cano' ? 8 : key === 'acntPrdtCd' ? 2 : undefined}
                className="w-full px-3 py-2.5 border-2 border-gray-200 rounded-xl text-sm outline-none focus:border-orange-400"
              />
            </div>
          ))}
          <div>
            <p className="text-xs text-gray-400 leading-relaxed">
              🔒 등록 버튼을 누르면 본인 확인을 위한 거래 PIN 입력창이 열립니다.
            </p>
          </div>
          {msg && (
            <p className={`text-sm font-semibold text-center ${msg.ok ? 'text-[#22C55E]' : 'text-red-500'}`}>{msg.text}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={startRegister}
              disabled={loading}
              className="flex-1 py-3 bg-orange-600 text-white font-bold rounded-xl hover:bg-orange-700 transition text-sm disabled:opacity-50"
            >
              {loading ? '등록 중...' : '등록 완료'}
            </button>
            <button
              onClick={() => { setShowForm(false); setMsg(null) }}
              className="flex-1 py-3 border-2 border-gray-200 text-gray-500 font-bold rounded-xl hover:bg-gray-50 transition text-sm"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {pinFlow === 'register' && (
        <PinPad
          key={pinPadKey}
          title="실거래 계좌 등록"
          subtitle="본인 확인을 위해 거래 PIN을 입력하세요"
          onConfirm={handleRegister}
          onCancel={() => setPinFlow(null)}
        />
      )}
    </div>
  )
}

function AccountSection({ mode, onAccountChange }: { mode: 'real' | 'virtual'; onAccountChange: () => void }) {
  if (mode === 'real') return <RealAccountSection onAccountChange={onAccountChange} />
  return <VirtualAccountSection />
}

interface TrustedDevice {
  id: number
  device_type: string
  label: string
  ip: string
  last_used_at: string
  expires_at: string
}

interface LoginRecord {
  id: number
  ip_address: string
  country?: string
  region?: string
  city?: string
  user_agent?: string
  logged_at: string
}

interface UserInfo {
  id: number
  email: string | null
  name: string
  nickname: string | null
  phone: string | null
  is_email_verified: boolean
  is_phone_verified: boolean
  email_changed_at: string | null
}

const API = `${API_BASE}/api/auth`

export default function MyPage() {
  const navigate = useNavigate()
  const location = useLocation()

  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'investment' | 'settings'>('profile')
  const [realAccountKey, setRealAccountKey] = useState(0)

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const tab = params.get('tab')
    if (tab === 'security' || tab === 'investment' || tab === 'profile' || tab === 'settings') {
      setActiveTab(tab)
    }
  }, [location.search])
  const { mode } = useTradeModeStore()
  const { profileImage, setProfileImage } = useProfileStore()
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── 유저 정보 ──────────────────────────────────────────────
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null)
  const [nickname, setNickname] = useState('')
  const [nicknameCheck, setNicknameCheck] = useState<{ ok: boolean; msg: string } | null>(null)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMsg, setProfileMsg] = useState('')

  // ── 이메일 변경 ─────────────────────────────────────────────
  const [emailChanging, setEmailChanging] = useState(false)
  const [newEmail, setNewEmail] = useState('')
  const [emailCode, setEmailCode] = useState('')
  const [emailStep, setEmailStep] = useState<'input' | 'verify'>('input')
  const [emailMsg, setEmailMsg] = useState('')
  const [emailLoading, setEmailLoading] = useState(false)

  // ── 비밀번호 변경 ───────────────────────────────────────────
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwMetamaskStep, setPwMetamaskStep] = useState<'idle' | 'signing'>('idle')

  // ── 휴대폰 인증 ─────────────────────────────────────────────
  const [phone, setPhone] = useState('')
  const [phoneCode, setPhoneCode] = useState('')
  const [phoneStep, setPhoneStep] = useState<'input' | 'verify'>('input')
  const [phoneMsg, setPhoneMsg] = useState('')
  const [phoneLoading, setPhoneLoading] = useState(false)

  // ── 로그인 기록 ─────────────────────────────────────────────
  const [loginRecords, setLoginRecords] = useState<LoginRecord[]>([])

  // ── 기기 기억하기 ───────────────────────────────────────────
  const [devices, setDevices] = useState<TrustedDevice[]>([])
  const [isCurrentDeviceTrusted, setIsCurrentDeviceTrusted] = useState(false)
  const [deviceRegisterLoading, setDeviceRegisterLoading] = useState(false)

  // ── 탈퇴 ────────────────────────────────────────────────────
  const [withdrawError, setWithdrawError] = useState('')
  const [withdrawLoading, setWithdrawLoading] = useState(false)

  // ── 투자성향 ────────────────────────────────────────────────
  const userStr = localStorage.getItem('upTick_user')
  const user = userStr ? JSON.parse(userStr) : {}
  const investmentTypeName = user.investment_type_name || null
  const isSurveyCompleted = !!user.is_survey_completed

  // ── 데이터 로드 ─────────────────────────────────────────────
  const fetchMyInfo = useCallback(async () => {
    try {
      const res = await fetch(`${API}/me`, { credentials: 'include' })
      if (!res.ok) return
      const data: UserInfo = await res.json()
      setUserInfo(data)
      setNickname(data.nickname ?? '')
      setPhone(data.phone ?? '')
    } catch {}

    try {
      const res = await fetch(`${API_BASE}/api/user/profile-image`, { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      setProfileImage(data.imageUrl ?? null)
    } catch {}
  }, [])

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch(`${API}/devices`, { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      setDevices(data.devices ?? [])
      setIsCurrentDeviceTrusted(data.isTrustedDevice ?? false)
    } catch {}
  }, [])

  const fetchLoginRecords = useCallback(async () => {
    try {
      const res = await fetch(`${API}/login-records`, { credentials: 'include' })
      if (!res.ok) return
      const data = await res.json()
      setLoginRecords(data.records ?? [])
    } catch {}
  }, [])

  useEffect(() => {
    fetchMyInfo()
  }, [fetchMyInfo])

  useEffect(() => {
    if (activeTab === 'security') {
      fetchDevices()
      fetchLoginRecords()
    }
  }, [activeTab, fetchDevices, fetchLoginRecords])

  // ── 프로필 이미지 ──────────────────────────────────────────
  const [imageError, setImageError] = useState('')

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImageError('')
    const allowed = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowed.includes(file.type)) { setImageError('JPG, PNG, WEBP 형식만 업로드 가능합니다'); return }
    if (file.size > 5 * 1024 * 1024) { setImageError('파일 크기는 5MB 이하여야 합니다'); return }

    const reader = new FileReader()
    reader.onload = async (ev) => {
      const imageBase64 = ev.target?.result as string
      setProfileImage(imageBase64) // 업로드 전 미리보기
      try {
        const res = await fetch(`${API_BASE}/api/user/profile-image`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64, mimeType: file.type }),
        })
        const data = await res.json()
        if (!res.ok) { setImageError(data.message ?? '업로드 실패'); return }
        setProfileImage(data.imageUrl)
      } catch {
        setImageError('업로드 중 오류가 발생했습니다')
      }
    }
    reader.readAsDataURL(file)
  }

  const handleRemoveImage = async () => {
    setProfileImage(null)
    setImageError('')
    if (fileInputRef.current) fileInputRef.current.value = ''
    try {
      await fetch(`${API_BASE}/api/user/profile-image`, {
        method: 'DELETE',
        credentials: 'include',
      })
    } catch {}
  }

  // ── 닉네임 중복 확인 ────────────────────────────────────────
  const handleCheckNickname = async () => {
    if (!nickname.trim()) { setNicknameCheck({ ok: false, msg: '닉네임을 입력해주세요' }); return }
    try {
      const res = await fetch(`${API}/nickname/check?nickname=${encodeURIComponent(nickname)}`, { credentials: 'include' })
      const data = await res.json()
      setNicknameCheck({ ok: res.ok, msg: data.message })
    } catch {
      setNicknameCheck({ ok: false, msg: '확인 중 오류가 발생했습니다' })
    }
  }

  // ── 닉네임 저장 ─────────────────────────────────────────────
  const handleSaveProfile = async () => {
    if (!nickname.trim()) { setProfileMsg('닉네임을 입력해주세요'); return }
    if (nicknameCheck?.ok === false) { setProfileMsg('닉네임 중복 확인을 먼저 해주세요'); return }
    try {
      setProfileSaving(true)
      setProfileMsg('')
      const res = await fetch(`${API}/me`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setProfileMsg('저장되었습니다')
      setNicknameCheck(null)
      fetchMyInfo()
    } catch (err: any) {
      setProfileMsg(err.message)
    } finally {
      setProfileSaving(false)
    }
  }

  // ── 이메일 변경 ─────────────────────────────────────────────
  const handleSendEmailChangeCode = async () => {
    if (!newEmail.trim()) { setEmailMsg('새 이메일을 입력해주세요'); return }
    try {
      setEmailLoading(true)
      setEmailMsg('')
      const res = await fetch(`${API}/email/change/send`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setEmailStep('verify')
      setEmailMsg('인증코드가 발송되었습니다')
    } catch (err: any) {
      setEmailMsg(err.message)
    } finally {
      setEmailLoading(false)
    }
  }

  const handleVerifyEmail = async () => {
    if (!emailCode.trim()) { setEmailMsg('인증코드를 입력해주세요'); return }
    try {
      setEmailLoading(true)
      setEmailMsg('')
      const res = await fetch(`${API}/email`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, code: emailCode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setEmailMsg('이메일이 변경되었습니다')
      setEmailChanging(false)
      setEmailStep('input')
      setNewEmail('')
      setEmailCode('')
      fetchMyInfo()
    } catch (err: any) {
      setEmailMsg(err.message)
    } finally {
      setEmailLoading(false)
    }
  }

  // ── 비밀번호 변경 (MetaMask 2차 인증 포함) ─────────────────
  const handleChangePassword = async () => {
    if (!currentPw || !newPw || !confirmPw) { setPwMsg('모든 항목을 입력해주세요'); return }
    if (newPw !== confirmPw) { setPwMsg('새 비밀번호가 일치하지 않습니다'); return }
    try {
      setPwLoading(true)
      setPwMsg('')

      // 1. nonce 조회
      const nonceRes = await fetch(`${API}/password/nonce`, { credentials: 'include' })
      const nonceData = await nonceRes.json()

      let walletAddress: string | null = null
      let signature: string | null = null

      if (nonceRes.ok && nonceData.walletAddress) {
        // 2. MetaMask 서명
        if (!window.ethereum) throw new Error('MetaMask가 설치되어 있지 않습니다')
        setPwMetamaskStep('signing')

        const { keccak256, concat, toBytes, getAddress } = await import('viem')
        const CONTRACT_ADDRESS = '0x2058646be3248D72D21AfB0f888d49f841b7571C'
        const CHAIN_ID = BigInt(11155111)

        const innerHash = keccak256(
          concat([
            toBytes(CHAIN_ID, { size: 32 }),
            toBytes(getAddress(CONTRACT_ADDRESS), { size: 20 }),
            toBytes(getAddress(nonceData.walletAddress), { size: 20 }),
            toBytes(BigInt(nonceData.nonce), { size: 32 }),
          ])
        )

        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
        signature = await window.ethereum.request({
          method: 'personal_sign',
          params: [innerHash, accounts[0]],
        })
        walletAddress = nonceData.walletAddress
        setPwMetamaskStep('idle')
      }

      // 3. 비밀번호 변경 요청
      const res = await fetch(`${API}/password`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: currentPw,
          newPassword: newPw,
          walletAddress,
          signature,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setPwMsg('비밀번호가 변경되었습니다')
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
    } catch (err: any) {
      if (err.code === 4001) {
        setPwMsg('MetaMask 서명이 거부되었습니다')
      } else {
        setPwMsg(err.message)
      }
      setPwMetamaskStep('idle')
    } finally {
      setPwLoading(false)
    }
  }

  // ── 휴대폰 인증 ─────────────────────────────────────────────
  const handleSendPhoneCode = async () => {
    if (!phone.trim()) { setPhoneMsg('휴대폰 번호를 입력해주세요'); return }
    try {
      setPhoneLoading(true)
      setPhoneMsg('')
      const res = await fetch(`${API}/phone/send`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setPhoneStep('verify')
      setPhoneMsg('인증번호가 발송되었습니다')
    } catch (err: any) {
      setPhoneMsg(err.message)
    } finally {
      setPhoneLoading(false)
    }
  }

  const handleVerifyPhone = async () => {
    if (!phoneCode.trim()) { setPhoneMsg('인증번호를 입력해주세요'); return }
    try {
      setPhoneLoading(true)
      setPhoneMsg('')
      const res = await fetch(`${API}/phone/verify`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code: phoneCode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setPhoneMsg('휴대폰 인증이 완료되었습니다')
      setPhoneStep('input')
      setPhoneCode('')
      fetchMyInfo()
    } catch (err: any) {
      setPhoneMsg(err.message)
    } finally {
      setPhoneLoading(false)
    }
  }

  // ── 기기 등록 / 해제 ────────────────────────────────────────
  const handleRegisterDevice = async () => {
    if (!window.confirm('현재 기기를 신뢰 기기로 등록합니다.\n기존에 등록된 모든 기기는 자동으로 해제됩니다.')) return
    try {
      setDeviceRegisterLoading(true)
      const res = await fetch(`${API}/devices/register`, { method: 'POST', credentials: 'include' })
      if (!res.ok) throw new Error('등록 실패')
      await fetchDevices()
    } catch (err: any) {
      alert(err.message)
    } finally {
      setDeviceRegisterLoading(false)
    }
  }

  const handleRemoveDevice = async (deviceId: number) => {
    if (!window.confirm('해당 기기의 신뢰를 해제하시겠습니까?')) return
    try {
      const res = await fetch(`${API}/devices/${deviceId}`, { method: 'DELETE', credentials: 'include' })
      if (!res.ok) throw new Error('해제 실패')
      await fetchDevices()
    } catch (err: any) {
      alert(err.message)
    }
  }

  // ── 탈퇴 ────────────────────────────────────────────────────
  const handleWithdraw = async () => {
    if (!window.confirm('정말 탈퇴하시겠습니까? 이 작업은 되돌릴 수 없습니다.')) return
    try {
      setWithdrawLoading(true)
      setWithdrawError('')
      const res = await fetch(`${API}/withdraw`, { method: 'DELETE', credentials: 'include' })
      // 본문이 비었거나 JSON 이 아니면 res.json() 이 던진다 — 탈퇴에 성공하고도 화면이
      // 그대로 남아 "아무 일도 안 일어난" 것처럼 보이므로, 성공 판정은 상태 코드로만 한다.
      const data = await res.json().catch(() => ({} as { message?: string }))
      if (!res.ok) throw new Error(data.message ?? '탈퇴 처리에 실패했습니다')
      clearSession()
      window.location.href = '/'
    } catch (err: any) {
      setWithdrawError(err.message)
    } finally {
      setWithdrawLoading(false)
    }
  }

  // ── 투자성향 재설문 ─────────────────────────────────────────
  const handleRetakeSurvey = () => {
    if (window.confirm('투자 성향을 다시 분석하시겠습니까? 기존 분석 데이터가 초기화됩니다.')) {
      localStorage.setItem('upTick_user', JSON.stringify({
        ...user,
        is_survey_completed: false,
        investment_type_id: null,
        investment_type_name: null,
        survey_raw_data: null,
      }))
      navigate('/survey')
    }
  }

  // ── 로그인 기록 기기 요약 ───────────────────────────────────
  const parseUserAgent = (ua?: string) => {
    if (!ua) return '알 수 없는 기기'
    const browser = /Edg\//i.test(ua) ? 'Edge' : /Chrome/i.test(ua) ? 'Chrome' : /Firefox/i.test(ua) ? 'Firefox' : /Safari/i.test(ua) ? 'Safari' : '기타'
    const os = /iPhone|iPad/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'Mac' : 'Linux'
    return `${browser}, ${os}`
  }

  return (
    <div className="w-full min-h-screen bg-white pb-20 font-sans text-gray-800">
      <div className="container mx-auto px-6 max-w-5xl">

        {/* 1. 자산 관리 섹션 */}
        <section className="py-12 border-b border-gray-200">
          <div className="flex items-center gap-3 mb-8">
            <h2 className="text-2xl font-black">자산 관리</h2>
            <span style={{
              fontSize: '12px', fontWeight: '700', padding: '3px 10px', borderRadius: '20px',
              backgroundColor: mode === 'virtual' ? '#f0fdf4' : '#fff7ed',
              color: mode === 'virtual' ? '#15803d' : '#c2410c',
            }}>
              {mode === 'virtual' ? '📊 모의투자' : '💼 실거래'}
            </span>
          </div>
          {mode === 'virtual' ? (
            <VirtualPortfolio />
          ) : (
            <RealPortfolioSection onRegister={() => setActiveTab('security')} refreshKey={realAccountKey} />
          )}
        </section>

        {/* 2. 계정 관리 섹션 */}
        <section className="py-12">
          <h2 className="text-2xl font-black mb-8">계정 관리</h2>

          <div className="flex items-start gap-8">
            {/* 좌측: 탭 메뉴 */}
            <div className="w-52 shrink-0">
              <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
                {([
                  { key: 'profile', icon: '👤', label: '프로필 & 개인정보' },
                  { key: 'security', icon: '🔒', label: '보안 및 인증' },
                  { key: 'investment', icon: '📊', label: '투자 성향 정보' },
                  { key: 'settings', icon: '⚙️', label: '환경설정' },
                ] as const).map((item, i, arr) => (
                  <button
                    key={item.key}
                    onClick={() => setActiveTab(item.key)}
                    className={`w-full text-left px-5 py-4 flex items-center gap-3 transition font-semibold text-sm
                      ${activeTab === item.key ? 'bg-[#22C55E]/8 text-[#22C55E] border-l-[3px] border-[#22C55E]' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-800 border-l-[3px] border-transparent'}
                      ${i < arr.length - 1 ? 'border-b border-gray-50' : ''}`}
                  >
                    <span className="text-base">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 우측: 탭별 콘텐츠 */}
            <div className="flex-1 min-h-[400px] bg-white border border-gray-100 rounded-2xl shadow-sm p-8">

              {/* ── 프로필 탭 ── */}
              {activeTab === 'profile' && (
                <div className="space-y-8">
                  <h3 className="font-black text-xl text-gray-900">프로필 설정</h3>

                  {/* 프로필 사진 */}
                  <div className="flex items-center gap-6 p-5 bg-gray-50 rounded-2xl">
                    <div className="w-18 h-18 rounded-full bg-[#22C55E] flex items-center justify-center overflow-hidden shrink-0 border-2 border-white shadow-md" style={{width:72,height:72}}>
                      {profileImage
                        ? <img src={profileImage} alt="프로필" className="w-full h-full object-cover" />
                        : <span className="text-3xl">👤</span>
                      }
                    </div>
                    <div className="flex-1">
                      <p className="font-bold text-sm text-gray-700 mb-1">{userInfo?.name ?? ''}</p>
                      <p className="text-xs text-gray-400 mb-3">{userInfo?.email ?? ''}</p>
                      <div className="flex gap-2">
                        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={handleImageChange} />
                        <button onClick={() => fileInputRef.current?.click()} className="px-3 py-1.5 bg-white border border-gray-200 text-gray-600 font-semibold rounded-lg hover:border-[#22C55E] hover:text-[#22C55E] transition text-xs shadow-sm">
                          사진 변경
                        </button>
                        {profileImage && (
                          <button onClick={handleRemoveImage} className="px-3 py-1.5 bg-white border border-gray-200 text-gray-400 font-semibold rounded-lg hover:bg-gray-50 transition text-xs shadow-sm">
                            제거
                          </button>
                        )}
                      </div>
                      {imageError && <p className="text-xs text-red-500 mt-2 font-semibold">{imageError}</p>}
                    </div>
                  </div>

                  {/* 폼 필드들 */}
                  <div className="space-y-5 max-w-md">

                    {/* 이름 */}
                    <div>
                      <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">이름</label>
                      <input
                        type="text"
                        value={userInfo?.name ?? ''}
                        readOnly
                        className="w-full px-4 py-3 bg-gray-50 border border-gray-100 rounded-xl text-gray-400 text-sm outline-none cursor-not-allowed"
                      />
                      <p className="text-xs text-gray-400 mt-1">이름은 변경할 수 없습니다.</p>
                    </div>

                    {/* 닉네임 */}
                    <div>
                      <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">
                        닉네임 <span className="normal-case font-normal text-gray-400">· 커뮤니티에서 사용됩니다</span>
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={nickname}
                          onChange={(e) => { setNickname(e.target.value); setNicknameCheck(null) }}
                          placeholder="2~20자, 한글/영문/숫자/_"
                          className="flex-1 px-4 py-3 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-[#22C55E] focus:ring-2 focus:ring-[#22C55E]/10 transition placeholder-gray-300"
                        />
                        <button
                          onClick={handleCheckNickname}
                          className="px-4 py-3 bg-[#22C55E]/10 text-[#22C55E] font-bold rounded-xl hover:bg-[#22C55E] hover:text-white transition text-sm whitespace-nowrap"
                        >
                          중복확인
                        </button>
                      </div>
                      {nicknameCheck && (
                        <p className={`text-xs mt-1.5 font-semibold ${nicknameCheck.ok ? 'text-[#22C55E]' : 'text-red-500'}`}>
                          {nicknameCheck.ok ? '✓ ' : '✗ '}{nicknameCheck.msg}
                        </p>
                      )}
                    </div>

                    {/* 이메일 */}
                    <div>
                      <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-1.5">
                        이메일
                        {userInfo?.email_changed_at && (() => {
                          const days = Math.floor((Date.now() - new Date(userInfo.email_changed_at!).getTime()) / (1000 * 60 * 60 * 24))
                          const daysLeft = 30 - days
                          return daysLeft > 0
                            ? <span className="ml-2 normal-case font-normal text-orange-400">변경까지 {daysLeft}일 남음</span>
                            : null
                        })()}
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="email"
                          value={userInfo?.email ?? ''}
                          placeholder="등록된 이메일 없음 (휴대폰 번호로 로그인)"
                          readOnly
                          className="flex-1 px-4 py-3 bg-gray-50 border border-gray-100 rounded-xl text-sm text-gray-500 outline-none"
                        />
                        <button
                          onClick={() => { setEmailChanging(v => !v); setEmailMsg(''); setEmailStep('input'); setNewEmail(''); setEmailCode('') }}
                          className="px-4 py-3 bg-white border border-gray-200 text-gray-500 font-semibold rounded-xl hover:border-gray-300 hover:text-gray-700 transition text-sm"
                        >
                          {emailChanging ? '취소' : userInfo?.email ? '변경' : '등록'}
                        </button>
                      </div>
                      {emailChanging && (
                        <div className="mt-3 space-y-2 p-4 bg-gray-50 rounded-xl border border-gray-100">
                          <div className="flex gap-2">
                            <input
                              type="email"
                              placeholder="새 이메일 주소"
                              value={newEmail}
                              onChange={(e) => setNewEmail(e.target.value)}
                              disabled={emailStep === 'verify'}
                              className="flex-1 px-4 py-2.5 bg-white border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] focus:ring-2 focus:ring-[#22C55E]/10 transition text-sm disabled:bg-gray-50 disabled:text-gray-400"
                            />
                            <button
                              onClick={handleSendEmailChangeCode}
                              disabled={emailLoading || emailStep === 'verify'}
                              className="px-4 py-2.5 bg-[#22C55E]/10 text-[#22C55E] font-bold rounded-xl hover:bg-[#22C55E] hover:text-white transition text-sm disabled:opacity-40 whitespace-nowrap"
                            >
                              코드 발송
                            </button>
                          </div>
                          {emailStep === 'verify' && (
                            <div className="flex gap-2">
                              <input
                                type="text"
                                placeholder="인증코드 6자리"
                                value={emailCode}
                                onChange={(e) => setEmailCode(e.target.value)}
                                className="flex-1 px-4 py-2.5 bg-white border border-gray-200 rounded-xl outline-none focus:border-[#22C55E] transition text-sm"
                              />
                              <button
                                onClick={handleVerifyEmail}
                                disabled={emailLoading}
                                className="px-4 py-2.5 bg-[#22C55E] text-white font-bold rounded-xl hover:bg-[#1ba850] transition text-sm disabled:opacity-50"
                              >
                                확인
                              </button>
                            </div>
                          )}
                          {emailMsg && (
                            <p className={`text-xs font-semibold ${emailMsg.includes('발송') || emailMsg.includes('변경되었습니다') ? 'text-[#22C55E]' : 'text-red-500'}`}>{emailMsg}</p>
                          )}
                          <p className="text-xs text-gray-400">* 이메일은 30일에 1번만 변경할 수 있습니다.</p>
                        </div>
                      )}
                    </div>

                    {profileMsg && (
                      <p className={`text-sm font-semibold ${profileMsg === '저장되었습니다' ? 'text-[#22C55E]' : 'text-red-500'}`}>{profileMsg}</p>
                    )}

                    <button
                      onClick={handleSaveProfile}
                      disabled={profileSaving}
                      className="w-full py-3.5 bg-[#22C55E] text-white font-bold rounded-xl hover:bg-[#1ba850] transition text-sm disabled:opacity-50 shadow-sm shadow-[#22C55E]/20"
                    >
                      {profileSaving ? '저장 중...' : '닉네임 저장'}
                    </button>
                  </div>

                  {/* 회원 탈퇴 */}
                  <div className="pt-6 border-t border-gray-100">
                    <p className="text-xs font-bold text-gray-400 uppercase tracking-wide mb-1">계정 탈퇴</p>
                    <p className="text-xs text-gray-400 mb-3">탈퇴 시 모든 데이터는 복구되지 않으며 온체인 지갑 등록도 해제됩니다.</p>
                    {withdrawError && <p className="text-xs text-red-500 mb-2">{withdrawError}</p>}
                    <button
                      onClick={handleWithdraw}
                      disabled={withdrawLoading}
                      className="text-xs font-bold text-red-400 hover:text-red-600 underline underline-offset-4 transition disabled:text-gray-300 disabled:cursor-not-allowed"
                    >
                      {withdrawLoading ? '처리 중...' : '회원 탈퇴하기'}
                    </button>
                  </div>
                </div>
              )}

              {/* ── 보안 탭 ── */}
              {activeTab === 'security' && (
                <div className="space-y-8">
                  <h3 className="font-black text-xl text-gray-900">보안 및 인증</h3>

                  <div className="space-y-7 max-w-lg">

                    {/* 비밀번호 변경 */}
                    <div>
                      <label className="block text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">비밀번호 변경</label>
                      <div className="space-y-2.5">
                        <input
                          type="password"
                          placeholder="현재 비밀번호"
                          value={currentPw}
                          onChange={(e) => setCurrentPw(e.target.value)}
                          className="w-full px-4 py-3 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-[#22C55E] focus:ring-2 focus:ring-[#22C55E]/10 transition placeholder-gray-300"
                        />
                        <input
                          type="password"
                          placeholder="새 비밀번호"
                          value={newPw}
                          onChange={(e) => { setNewPw(e.target.value); if (!e.target.value) setConfirmPw('') }}
                          className="w-full px-4 py-3 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-[#22C55E] focus:ring-2 focus:ring-[#22C55E]/10 transition placeholder-gray-300"
                        />
                        {newPw && (
                          <>
                            <div className="flex flex-wrap gap-2 pt-1">
                              {[
                                { label: '8자 이상', ok: newPw.length >= 8 },
                                { label: '영문 포함', ok: /[a-zA-Z]/.test(newPw) },
                                { label: '숫자 포함', ok: /[0-9]/.test(newPw) },
                                { label: '특수문자 포함', ok: /[!@#$%^&*]/.test(newPw) },
                              ].map(rule => (
                                <span key={rule.label} className={`text-xs px-2.5 py-1 rounded-full font-semibold ${rule.ok ? 'bg-green-50 text-[#22C55E]' : 'bg-red-50 text-red-500'}`}>
                                  {rule.ok ? '✓' : '✗'} {rule.label}
                                </span>
                              ))}
                            </div>
                            <input
                              type="password"
                              placeholder="새 비밀번호 확인"
                              value={confirmPw}
                              onChange={(e) => setConfirmPw(e.target.value)}
                              className={`w-full px-4 py-3 bg-white border rounded-xl text-sm outline-none focus:ring-2 transition placeholder-gray-300
                                ${confirmPw
                                  ? confirmPw === newPw
                                    ? 'border-[#22C55E] focus:ring-[#22C55E]/10'
                                    : 'border-red-400 focus:ring-red-400/10'
                                  : 'border-gray-200 focus:border-[#22C55E] focus:ring-[#22C55E]/10'}`}
                            />
                            {confirmPw && confirmPw !== newPw && (
                              <p className="text-xs text-red-500 font-semibold">비밀번호가 일치하지 않습니다</p>
                            )}
                            {confirmPw && confirmPw === newPw && (
                              <p className="text-xs text-[#22C55E] font-semibold">✓ 비밀번호가 일치합니다</p>
                            )}
                          </>
                        )}
                        {pwMetamaskStep === 'signing' && (
                          <div className="flex items-center gap-2 px-4 py-3 bg-orange-50 border border-orange-200 rounded-xl">
                            <span className="text-base">🦊</span>
                            <p className="text-xs font-semibold text-orange-600">MetaMask에서 서명 요청을 확인해주세요...</p>
                          </div>
                        )}
                        {pwMsg && <p className={`text-xs font-semibold ${pwMsg.includes('변경되었습니다') ? 'text-[#22C55E]' : 'text-red-500'}`}>{pwMsg}</p>}
                        <button
                          onClick={handleChangePassword}
                          disabled={pwLoading || !currentPw || !newPw || !confirmPw || newPw !== confirmPw}
                          className="px-5 py-3 bg-gray-900 text-white font-bold rounded-xl hover:bg-gray-700 transition text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {pwLoading ? (pwMetamaskStep === 'signing' ? '서명 대기 중...' : '변경 중...') : '비밀번호 업데이트'}
                        </button>
                      </div>
                    </div>

                    <div className="border-t border-gray-50" />

                    {/* 휴대폰 번호 인증 */}
                    <div>
                      <div className="flex items-center gap-2 mb-3">
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">휴대폰 번호</label>
                        {userInfo?.is_phone_verified
                          ? <span className="text-xs text-[#22C55E] font-semibold bg-green-50 px-2 py-0.5 rounded-full">✓ 인증 완료</span>
                          : <span className="text-xs text-orange-500 font-semibold bg-orange-50 px-2 py-0.5 rounded-full">미완료</span>
                        }
                      </div>
                      {userInfo?.is_phone_verified ? (
                        <div className="flex items-center gap-3 px-4 py-3 bg-gray-50 border border-gray-100 rounded-xl">
                          <span className="flex-1 text-sm text-gray-700 font-medium">{phone}</span>
                          <span className="text-xs text-gray-400">변경 불가</span>
                        </div>
                      ) : (
                        <div className="space-y-2.5">
                          <div className="flex gap-2">
                            <input
                              type="tel"
                              placeholder="01012345678 (- 없이 입력)"
                              value={phone}
                              onChange={(e) => setPhone(e.target.value)}
                              disabled={phoneStep === 'verify'}
                              className="flex-1 px-4 py-3 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-[#22C55E] focus:ring-2 focus:ring-[#22C55E]/10 transition disabled:bg-gray-50 disabled:text-gray-400 placeholder-gray-300"
                            />
                            <button
                              onClick={handleSendPhoneCode}
                              disabled={phoneLoading || phoneStep === 'verify'}
                              className="px-4 py-3 bg-[#22C55E]/10 text-[#22C55E] font-bold rounded-xl hover:bg-[#22C55E] hover:text-white transition text-sm disabled:opacity-40 whitespace-nowrap"
                            >
                              인증번호 발송
                            </button>
                          </div>
                          {phoneStep === 'verify' && (
                            <div className="flex gap-2">
                              <input
                                type="text"
                                placeholder="인증번호 6자리"
                                value={phoneCode}
                                onChange={(e) => setPhoneCode(e.target.value)}
                                className="flex-1 px-4 py-3 bg-white border border-gray-200 rounded-xl text-sm outline-none focus:border-[#22C55E] focus:ring-2 focus:ring-[#22C55E]/10 transition"
                              />
                              <button
                                onClick={handleVerifyPhone}
                                disabled={phoneLoading}
                                className="px-4 py-3 bg-[#22C55E] text-white font-bold rounded-xl hover:bg-[#1ba850] transition text-sm disabled:opacity-50"
                              >
                                확인
                              </button>
                            </div>
                          )}
                          {phoneMsg && (
                            <p className={`text-xs font-semibold ${phoneMsg.includes('완료') || phoneMsg.includes('발송') ? 'text-[#22C55E]' : 'text-red-500'}`}>{phoneMsg}</p>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="border-t border-gray-50" />

                    {/* 로그인 기록 */}
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">최근 로그인 기록</label>
                        <button onClick={fetchLoginRecords} className="text-xs text-[#22C55E] font-semibold hover:underline">새로고침</button>
                      </div>
                      {loginRecords.length === 0 ? (
                        <div className="py-6 text-center text-sm text-gray-400 bg-gray-50 rounded-xl">기록이 없습니다.</div>
                      ) : (
                        <div className="rounded-xl overflow-hidden border border-gray-100">
                          <table className="w-full text-xs text-left">
                            <thead className="bg-gray-50 text-gray-400">
                              <tr>
                                <th className="px-4 py-2.5 font-semibold">일시</th>
                                <th className="px-4 py-2.5 font-semibold">IP / 기기</th>
                                <th className="px-4 py-2.5 font-semibold">위치</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50 text-gray-600">
                              {loginRecords.map(r => (
                                <tr key={r.id} className="hover:bg-gray-50/50 transition">
                                  <td className="px-4 py-3">{new Date(r.logged_at).toLocaleString('ko-KR')}</td>
                                  <td className="px-4 py-3">
                                    <span className="font-medium">{r.ip_address}</span><br />
                                    <span className="text-gray-400">{parseUserAgent(r.user_agent)}</span>
                                  </td>
                                  <td className="px-4 py-3 text-gray-500">
                                    {[r.country, r.city].filter(Boolean).join(', ') || '알 수 없음'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    <div className="border-t border-gray-50" />

                    {/* 신뢰 기기 */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">신뢰 기기</label>
                        <button onClick={fetchDevices} className="text-xs text-[#22C55E] font-semibold hover:underline">새로고침</button>
                      </div>
                      <p className="text-xs text-gray-400 mb-4">신뢰 기기로 등록하면 로그인 시 MetaMask 2단계 인증을 건너뜁니다.</p>

                      {!isCurrentDeviceTrusted && (
                        <button
                          onClick={handleRegisterDevice}
                          disabled={deviceRegisterLoading}
                          className="mb-3 px-4 py-2.5 bg-[#22C55E]/10 text-[#22C55E] text-sm font-bold rounded-xl hover:bg-[#22C55E] hover:text-white transition disabled:opacity-50"
                        >
                          {deviceRegisterLoading ? '등록 중...' : '현재 기기 신뢰 기기로 등록'}
                        </button>
                      )}

                      {devices.length === 0 ? (
                        <div className="py-6 text-center text-sm text-gray-400 bg-gray-50 rounded-xl">등록된 신뢰 기기가 없습니다.</div>
                      ) : (
                        <div className="space-y-2">
                          {devices.map(d => (
                            <div key={d.id} className="flex justify-between items-center px-4 py-3 bg-gray-50 border border-gray-100 rounded-xl">
                              <div>
                                <p className="font-semibold text-sm text-gray-800">{d.label}</p>
                                <p className="text-xs text-gray-400 mt-0.5">IP {d.ip} · {new Date(d.last_used_at).toLocaleString('ko-KR')}</p>
                              </div>
                              <button
                                onClick={() => handleRemoveDevice(d.id)}
                                className="text-xs text-red-400 hover:text-red-600 font-bold bg-white border border-red-100 hover:border-red-300 px-3 py-1.5 rounded-lg transition"
                              >
                                해제
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-gray-50" />

                  {/* 계좌 설정 */}
                  <div>
                    <h4 className="font-bold text-gray-800 mb-3">
                      {mode === 'virtual' ? '모의투자 계좌' : '실거래 계좌'}
                    </h4>
                    {/* 모의투자는 이메일·휴대폰 중 하나, 실거래는 둘 다 인증해야 계좌를 설정할 수 있다(서버와 같은 규칙) */}
                    {(mode === 'real'
                      ? !(userInfo?.is_email_verified && userInfo?.is_phone_verified)
                      : !(userInfo?.is_email_verified || userInfo?.is_phone_verified)) ? (
                      <div className="bg-orange-50 border border-orange-200 rounded-2xl p-5 text-center">
                        <div className="text-2xl mb-2">🔐</div>
                        <p className="font-semibold text-gray-800 text-sm mb-1">
                          {mode === 'real'
                            ? `실거래 계좌 설정에는 이메일과 휴대폰 인증이 모두 필요합니다 (미완료: ${[!userInfo?.is_email_verified && '이메일', !userInfo?.is_phone_verified && '휴대폰'].filter(Boolean).join('·')})`
                            : '모의투자 계좌 설정에는 이메일 또는 휴대폰 인증이 필요합니다'}
                        </p>
                        <p className="text-xs text-gray-500">위에서 인증을 먼저 완료해주세요.</p>
                      </div>
                    ) : (
                      <AccountSection mode={mode} onAccountChange={() => setRealAccountKey(k => k + 1)} />
                    )}
                  </div>
                </div>
              )}

              {/* ── 투자 성향 탭 ── */}
              {activeTab === 'investment' && (
                <div className="space-y-8 max-w-md">
                  <h3 className="font-black text-xl mb-6">투자 성향</h3>

                  {/* 투자 성향 - 항상 표시 */}
                  <div>
                    <h4 className="font-bold text-gray-800 mb-3">투자 성향 분석 결과</h4>
                    {!isSurveyCompleted ? (
                      <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-6 text-center">
                        <div className="text-3xl mb-2">📋</div>
                        <p className="font-semibold text-gray-800 mb-1">아직 투자 성향 설문이 완료되지 않았습니다.</p>
                        <p className="text-xs text-gray-500 mb-4">설문을 완료하면 맞춤형 투자 정보를 제공받을 수 있습니다.</p>
                        <button
                          onClick={handleRetakeSurvey}
                          className="w-full py-3 bg-[#22C55E] text-white font-bold rounded-xl hover:bg-[#1ba850] transition text-sm"
                        >
                          지금 설문하기
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="bg-gray-50 border border-gray-200 rounded-2xl p-6 text-center mb-3">
                          <p className="text-gray-500 text-sm mb-2">회원님의 현재 투자 유형은</p>
                          <p className="text-2xl font-bold text-[#22C55E] mb-2">{investmentTypeName}</p>
                          <p className="text-sm text-gray-600">입니다.</p>
                        </div>
                        <p className="text-xs text-gray-500 mb-3 leading-relaxed">
                          * 투자 성향은 행동 패턴이나 시장 상황에 따라 변경될 수 있습니다.
                        </p>
                        <button
                          onClick={handleRetakeSurvey}
                          className="w-full py-3 border-2 border-[#22C55E] text-[#22C55E] font-bold rounded-xl hover:bg-[#22C55E]/5 transition flex justify-center items-center gap-2 text-sm"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                          투자 성향 재설문하기
                        </button>
                      </>
                    )}
                  </div>

                </div>
              )}

              {/* ── 환경설정 탭 ── */}
              {activeTab === 'settings' && (
                <div className="space-y-8">
                  <h3 className="font-black text-xl mb-6">환경설정</h3>
                  <div className="space-y-4 max-w-lg">
                    <div className="p-5 border border-gray-100 rounded-2xl flex justify-between items-center bg-gray-50/50">
                      <div>
                        <h4 className="font-bold text-gray-800">앱 알림 (Push)</h4>
                        <p className="text-xs text-gray-500 mt-1">주가 급등락, 자산 변동 알림을 받습니다.</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" defaultChecked />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#22C55E]"></div>
                      </label>
                    </div>
                    <div className="p-5 border border-gray-100 rounded-2xl flex justify-between items-center bg-gray-50/50">
                      <div>
                        <h4 className="font-bold text-gray-800">커뮤니티 활동 공개</h4>
                        <p className="text-xs text-gray-500 mt-1">내가 작성한 글과 댓글을 다른 유저에게 공개합니다.</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" className="sr-only peer" />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#22C55E]"></div>
                      </label>
                    </div>
                    <div className="pt-6">
                      <a href="/terms" target="_blank" rel="noreferrer" className="text-sm font-semibold text-gray-500 hover:text-gray-800 flex items-center gap-1 transition">
                        이용약관 및 개인정보처리방침
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    </div>
                  </div>
                </div>
              )}

            </div>
          </div>
        </section>

      </div>
    </div>
  )
}

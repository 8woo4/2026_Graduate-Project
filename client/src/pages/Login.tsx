import { useState } from 'react'
import { Link } from 'react-router-dom'
import { setSigningSecret } from '../utils/tradeSigning'
import { API_BASE } from '../utils/api'
import { useBehaviorTracker } from '../hooks/useBehaviorTracker'
import { getDeviceComponentsHash } from '../utils/deviceFingerprint'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [honeypot, setHoneypot] = useState('') // 기만 기술(Honeypot) 상태 추가
  const [step, setStep] = useState(1) // 1: 이메일·비밀번호, 2: 지갑 서명
  const { getBehaviorData } = useBehaviorTracker() // 사용자 행동 데이터 추적 훅

  // 2차 인증 수단은 온체인 지갑 서명 하나뿐이다 — PIN·이메일 코드 폴백을 두지 않는다.
  // 폴백이 존재하면 "그 폴백을 고르는 것" 이 곧 가장 약한 우회 경로가 되기 때문이다.
  const [loginData, setLoginData] = useState<any>(null)
  const [rememberDevice, setRememberDevice] = useState(false)
  const [signing, setSigning] = useState(false)

  const [error, setError] = useState('')

  // ─── 로그인 1단계 ─────────────────────────────────────────────
  const handleLoginStep1 = async () => {
    try {
      setError('')
      const deviceFingerprint = localStorage.getItem('device_fingerprint') || 'unknown'
      // 강화된 디바이스 핑거프린트 — 하드웨어 컴포넌트 조합 해시(캔버스·WebGL·오디오·폰트·타임존)
      const deviceComponents = await getDeviceComponentsHash()
      const behaviorData = getBehaviorData()// 현재까지 수집된 마우스/키보드 행동 데이터를 가져옴

      const res = await fetch(`${API_BASE}/api/auth/login/step1`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Fingerprint': deviceFingerprint,
          'X-Device-Components': deviceComponents
        },
        credentials: 'include',
        // 로그인 아이디는 이메일 또는 휴대폰 번호(휴대폰으로 가입한 계정)
        body: JSON.stringify({ loginId: email.trim(), password, honeypot, behaviorData }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)

      setLoginData(data)

      // 서버가 내려주는 requiredAuth 는 'NONE'(통과) 아니면 'WALLET'(지갑 서명) 둘뿐이다.
      // 값이 없는 구버전 응답이면 신뢰 기기 여부로 판단한다.
      const authType: string = data.requiredAuth ?? (data.isTrustedDevice ? 'NONE' : 'WALLET')

      if (authType === 'NONE') {
        // 신뢰 기기 + 위험 신호 없음 → 서명 없이 바로 2단계
        await executeStep2({
          userId: data.userId,
          walletAddress: data.walletAddress,
          signature: '',
        })
      } else {
        setStep(2)
      }
    } catch (err: any) {
      setError(err.message)
    }
  }

  // ─── 로그인 2단계 공통 실행 함수 ─────────────────────────────────────────────
  const executeStep2 = async (payload: { userId: number; walletAddress: string; signature?: string; rememberDevice?: boolean }) => {
    try {
      setError('')
      const deviceFingerprint = localStorage.getItem('device_fingerprint') || 'unknown'
      const deviceComponents = await getDeviceComponentsHash()
      const res = await fetch(`${API_BASE}/api/auth/login/step2`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Fingerprint': deviceFingerprint, // 헤더에 기기 지문 값 추가
          'X-Device-Components': deviceComponents
        },
        credentials: 'include',
        body: JSON.stringify(payload),
      })
      const data = await res.json()

      if (!res.ok) {
        // 서버가 재인증을 요구했다 — 서명 화면으로 넘긴다.
        // (신뢰 기기로 통과하려던 요청이 위험 신호로 승격된 경우)
        if (data.code === 'WALLET_REQUIRED') setStep(2)
        // 1단계 챌린지가 만료·소진됐다. 서명 화면에 남겨두면 이미 죽은 nonce 로 계속
        // 서명만 반복하게 되므로(MetaMask 경고까지 매번 다시 통과해야 한다) 1단계로 되돌린다.
        if (data.code === 'LOGIN_CHALLENGE_REQUIRED') {
          setLoginData(null)
          setPassword('')
          setStep(1)
        }
        throw new Error(data.message)
      }

      // 로그인 성공 처리
      if (data.signingSecret) setSigningSecret(data.signingSecret)
      localStorage.setItem('loginTime', Date.now().toString())
      localStorage.setItem('upTick_user', JSON.stringify(data.user))

      const targetUrl = data.user?.is_survey_completed ? '/' : '/survey'
      window.location.href = targetUrl

    } catch (err: any) {
      setError(err.message)
    }
  }

  // ─── 지갑 서명 제출 ─────────────────────────────────────────────
  const handleWalletSign = async () => {
    if (!loginData || signing) return

    setError('')
    setSigning(true)
    try {
      if (!window.ethereum) {
        setError('MetaMask가 설치되어 있지 않습니다. 확장 프로그램을 설치한 뒤 다시 시도해주세요.')
        return
      }

      const accounts: string[] = await window.ethereum.request({ method: 'eth_requestAccounts' })
      const address = accounts?.[0]
      if (!address) {
        setError('MetaMask에서 계정을 선택해주세요.')
        return
      }

      // 서명 요청 전에 계정을 대조한다.
      //
      // MetaMask 에 여러 계정이 있으면 현재 선택된 계정이 가입 때 등록한 지갑과 다를 수 있다.
      // 그대로 서명하면 서버의 온체인 검증이 실패해 "서명이 올바르지 않습니다" 로만 떨어져,
      // 사용자는 무엇을 고쳐야 하는지 알 수 없다. 여기서 미리 잡아 계정 전환을 안내한다.
      const registered = String(loginData.walletAddress ?? '')
      if (address.toLowerCase() !== registered.toLowerCase()) {
        setError(
          `MetaMask에 선택된 지갑 주소가 등록된 주소와 다릅니다.
` +
            `등록된 주소: ${registered.slice(0, 6)}...${registered.slice(-4)}
` +
            `현재 선택된 주소: ${address.slice(0, 6)}...${address.slice(-4)}
` +
            `MetaMask에서 등록된 계정으로 전환한 뒤 다시 시도해주세요.`,
        )
        return
      }

      const { keccak256, concat, toBytes, getAddress } = await import('viem')
      const CONTRACT_ADDRESS = '0x2058646be3248D72D21AfB0f888d49f841b7571C'
      const CHAIN_ID = BigInt(11155111)

      const innerHash = keccak256(
        concat([
          toBytes(CHAIN_ID, { size: 32 }),
          toBytes(getAddress(CONTRACT_ADDRESS), { size: 20 }),
          toBytes(getAddress(registered), { size: 20 }),
          toBytes(BigInt(loginData.nonce), { size: 32 }),
        ])
      )

      const signature: string = await window.ethereum.request({
        method: 'personal_sign',
        params: [innerHash, address],
      })

      await executeStep2({
        userId: loginData.userId,
        walletAddress: registered,
        signature,
        rememberDevice,
      })
    } catch (err: any) {
      // MetaMask 사용자가 서명 창을 닫은 경우(4001)는 오류가 아니라 취소다.
      if (err?.code === 4001) setError('서명이 취소되었습니다. 로그인하려면 서명이 필요합니다.')
      else setError(err?.message ?? '지갑 서명에 실패했습니다.')
    } finally {
      setSigning(false)
    }
  }

  const inputStyle = {
    width: '100%',
    padding: '12px 14px',
    border: '1px solid #ddd',
    borderRadius: '10px',
    fontSize: '14px',
    outline: 'none',
    boxSizing: 'border-box' as const,
  }

  const btnStyle = {
    width: '100%',
    padding: '14px',
    backgroundColor: '#3CB371',
    color: '#fff',
    border: 'none',
    borderRadius: '10px',
    fontSize: '15px',
    fontWeight: '600',
    cursor: 'pointer',
    marginBottom: '16px',
  }

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f9fafb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif' }}>
      <div style={{ backgroundColor: '#fff', borderRadius: '20px', padding: '48px 40px', width: '400px', boxShadow: '0 4px 20px rgba(0,0,0,0.08)', position: 'relative' }}>
        
        {/* 로고 */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <span style={{ fontSize: '28px', fontWeight: 'bold', color: '#3CB371' }}>UpTick</span>
          <span style={{ fontSize: '22px', marginLeft: '6px' }}>📈</span>
          <p style={{ fontSize: '14px', color: '#888', marginTop: '8px' }}>투자의 기준을 높이다</p>
        </div>

        {error && (
          <p style={{
            fontSize: '13px', color: '#e53935', marginBottom: '12px', textAlign: 'center',
            whiteSpace: 'pre-line', lineHeight: 1.6,
          }}>
            {error}
          </p>
        )}

        {/* Step 1 - 이메일 + 비밀번호 */}
        {step === 1 && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '24px' }}>
              {/* [추가] 기만 기술 (Honeypot) - 봇만 입력하도록 유도하는 숨김 필드 */}
              <input
                type="text"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
                style={{ display: 'none' }}
                tabIndex={-1}
                autoComplete="off" /* 허니팟 보호 — 비밀번호 관리자가 미끼 필드를 채워 정상 사용자가 봇으로 오탐되는 것 방지 */
              />
              
              <div>
                <label style={{ fontSize: '13px', color: '#555', fontWeight: '600', display: 'block', marginBottom: '6px' }}>이메일 또는 휴대폰 번호</label>
                <input type="text" inputMode="email" autoComplete="username" placeholder="이메일 또는 휴대폰 번호('-' 없이)" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={{ fontSize: '13px', color: '#555', fontWeight: '600', display: 'block', marginBottom: '6px' }}>비밀번호</label>
                <input 
                  type="password" 
                  placeholder="비밀번호를 입력하세요" 
                  value={password} 
                  onChange={(e) => setPassword(e.target.value)} 
                  onKeyDown={(e) => e.key === 'Enter' && handleLoginStep1()}
                  style={inputStyle}
                  onCopy={(e) => { e.preventDefault(); alert("보안상 복사할 수 없습니다."); }}
                  onPaste={(e) => { e.preventDefault(); alert("보안상 붙여넣기를 지원하지 않습니다. 직접 입력해주세요."); }}
                />
              </div>
            </div>
            <button onClick={handleLoginStep1} style={btnStyle}>로그인</button>
          </>
        )}

        {/* Step 2 - 온체인 지갑 서명 (2차 인증 수단은 이것 하나뿐) */}
        {step === 2 && (
          <>
            <div style={{ marginBottom: '24px', textAlign: 'center' }}>
              <p style={{ fontSize: '15px', fontWeight: 'bold', color: '#333', marginBottom: '8px' }}>
                안전을 위해 본인 확인이 필요합니다
              </p>
              <p style={{ fontSize: '13px', color: '#666', lineHeight: 1.6 }}>
                가입 시 등록한 MetaMask 지갑으로 서명해 주세요.
              </p>

              <div style={{ marginTop: '16px', textAlign: 'left', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input type="checkbox" id="remember" checked={rememberDevice} onChange={(e) => setRememberDevice(e.target.checked)} />
                <label htmlFor="remember" style={{ color: '#555', cursor: 'pointer' }}>이 기기 기억하기</label>
              </div>
            </div>

            <button
              onClick={handleWalletSign}
              disabled={signing}
              style={{ ...btnStyle, opacity: signing ? 0.6 : 1, cursor: signing ? 'default' : 'pointer' }}
            >
              {signing ? '서명 대기 중…' : 'MetaMask 서명'}
            </button>
          </>
        )}

        {/* 하단 링크 */}
        <div style={{ textAlign: 'center', fontSize: '13px', color: '#888' }}>
          아직 계정이 없으신가요?{' '}
          <Link to="/register" style={{ color: '#3CB371', fontWeight: '600', textDecoration: 'none' }}>회원가입</Link>
        </div>
      </div>
    </div>
  )
}
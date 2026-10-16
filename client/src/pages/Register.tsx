import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'

import { API_BASE } from '../utils/api'

export default function Register() {
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    confirm: '',
    phone: '',
    emailCode: '',
    smsCode: '',
  })
  const [agreements, setAgreements] = useState({
    terms_agreed: false,
    privacy_agreed: false,
    location_agreed: false,
    age_agreed: false,
    marketing_agreed: false,
  })
  const [emailSent, setEmailSent] = useState(false)
  const [emailVerified, setEmailVerified] = useState(false)
  const [smsSent, setSmsSent] = useState(false)
  const [smsVerified, setSmsVerified] = useState(false)
  const [walletAddress, setWalletAddress] = useState('')
  const [walletSignature, setWalletSignature] = useState('')
  // 지갑 서명에 묶은 가입 신원. 서명 뒤에 인증 수단이 바뀌면 서버가 서명을 거절하므로 다시 받는다.
  const [signedIdentity, setSignedIdentity] = useState('')
  const [walletConflict, setWalletConflict] = useState(false)
  const [error, setError] = useState('')
  const [showSuccessModal, setShowSuccessModal] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    if (error) window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [error])
  const [authMethod, setAuthMethod] = useState<'email' | 'phone' | null>(null)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value })
    // 지갑 서명은 가입 이메일에 묶여 있다. 이메일이 바뀌면 이전 서명은 서버에서 거절되므로 다시 받는다.
    if (e.target.name === 'email' || e.target.name === 'phone') setWalletSignature('')
  }

  const handleAgreement = (e: React.ChangeEvent<HTMLInputElement>) => {
    setAgreements({ ...agreements, [e.target.name]: e.target.checked })
  }

  // 비밀번호 규칙 체크
  const pwRules = [
    { label: '8자 이상', ok: form.password.length >= 8 },
    { label: '영문 포함', ok: /[a-zA-Z]/.test(form.password) },
    { label: '숫자 포함', ok: /[0-9]/.test(form.password) },
    { label: '특수문자 포함 (!@#$%^&*)', ok: /[!@#$%^&*]/.test(form.password) },
  ]

  const requiredAgreed =
    agreements.terms_agreed &&
    agreements.privacy_agreed &&
    agreements.location_agreed &&
    agreements.age_agreed

  // 본인 인증은 이메일·휴대폰 중 하나면 된다. 이메일은 로그인 아이디라 어느 쪽이든 입력해야 한다.
  // 가입 신원 — 인증한 이메일이 있으면 이메일, 없으면 인증한 휴대폰 번호
  const signupIdentity = emailVerified
    ? form.email.trim().toLowerCase()
    : smsVerified ? `phone:${form.phone.trim()}` : ''

  // 본인 인증은 이메일·휴대폰 중 하나면 된다. 인증한 쪽이 로그인 아이디가 된다.
  const canSubmit =
    (emailVerified || smsVerified) &&
    !!walletSignature &&
    signedIdentity === signupIdentity &&
    requiredAgreed &&
    form.password === form.confirm &&
    pwRules.every((r) => r.ok)

  // ─── API 호출 ──────────────────────────────────────────────

  const sendEmailCode = async () => {
    try {
      setError('')
      const res = await fetch(`${API_BASE}/api/auth/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setEmailSent(true)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const verifyEmailCode = async () => {
    try {
      setError('')
      const res = await fetch(`${API_BASE}/api/auth/email/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: form.email, code: form.emailCode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setEmailVerified(true)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const sendSmsCode = async () => {
    try {
      setError('')
      const res = await fetch(`${API_BASE}/api/auth/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: form.phone }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setSmsSent(true)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const verifySmsCode = async () => {
    try {
      setError('')
      const res = await fetch(`${API_BASE}/api/auth/sms/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: form.phone, code: form.smsCode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setSmsVerified(true)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const connectWalletAndSign = async (forceAccountSelect = false) => {
    try {
      setError('')
      setWalletConflict(false)
      if (!window.ethereum) throw new Error('MetaMask가 설치되어 있지 않습니다')
      if (!signupIdentity) throw new Error('지갑 서명 전에 이메일 또는 휴대폰 인증을 먼저 완료해주세요')

      if (forceAccountSelect) {
        await window.ethereum.request({
          method: 'wallet_requestPermissions',
          params: [{ eth_accounts: {} }],
        })
      }

      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts',
      })
      const address = accounts[0]

      // 지갑 주소 사전 체크 (DB + 온체인)
      const checkRes = await fetch(`${API_BASE}/api/auth/wallet/check?address=${address}`)
      const checkData = await checkRes.json()
      if (!checkData.available) {
        setWalletConflict(true)
        const msg = checkData.reason === 'onchain'
          ? '이미 온체인에 등록된 지갑 주소입니다. 다른 지갑으로 변경해주세요.'
          : '이미 등록된 지갑 주소입니다. 다른 지갑으로 변경해주세요.'
        throw new Error(msg)
      }

      setWalletAddress(address)

      // 백엔드 buildAuthMessage와 동일한 메시지 생성
      const { keccak256, concat, toBytes, getAddress } = await import('viem')

      const CONTRACT_ADDRESS = '0x2058646be3248D72D21AfB0f888d49f841b7571C'
      const CHAIN_ID = BigInt(11155111) // Sepolia

      // 서버 buildRegisterMessage 와 같은 형식. 로그인 메시지(논스 0)와 해시가 겹치지 않도록
      // 가입 용도 태그를 넣고, 가입 이메일을 묶어 이 서명을 다른 계정 가입에 쓰지 못하게 한다.
      const innerHash = keccak256(
        concat([
          toBytes(CHAIN_ID, { size: 32 }),
          toBytes(getAddress(CONTRACT_ADDRESS), { size: 20 }),
          toBytes(getAddress(address), { size: 20 }),
          keccak256(toBytes('UPTICK_WALLET_REGISTRATION_V1'), 'bytes'),
          keccak256(toBytes(signupIdentity), 'bytes'),
        ]),
      )

      const signature = await window.ethereum.request({
        method: 'personal_sign',
        params: [innerHash, address],
      })
      setWalletSignature(signature)
      setSignedIdentity(signupIdentity)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const handleRegister = async () => {
    try {
      setError('')
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: emailVerified ? form.email.trim() : '',
          password: form.password,
          name: form.name,
          // 인증하지 않은 번호는 보내지 않는다 — 서버는 보낸 번호가 인증된 번호인지 확인하고 아니면 가입을 거부한다
          phone: smsVerified ? form.phone : '',
          walletAddress,
          walletSignature,
          ...agreements,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message)
      setShowSuccessModal(true)
    } catch (err: any) {
      setError(err.message)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '12px 14px',
    border: '1px solid #ddd',
    borderRadius: '10px',
    fontSize: '14px',
    outline: 'none',
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: '13px',
    color: '#555',
    fontWeight: '600',
    display: 'block',
    marginBottom: '6px',
  }

  const btnStyle = (active: boolean): React.CSSProperties => ({
    padding: '10px 16px',
    backgroundColor: active ? '#3CB371' : '#ccc',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontSize: '13px',
    fontWeight: '600',
    cursor: active ? 'pointer' : 'not-allowed',
    whiteSpace: 'nowrap',
  })

  return (
    <>
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: '#f9fafb',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
        padding: '40px 0',
      }}
    >
      <div
        style={{
          backgroundColor: '#fff',
          borderRadius: '20px',
          padding: '48px 40px',
          width: '440px',
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
        }}
      >
        {/* 로고 */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <span
            style={{ fontSize: '28px', fontWeight: 'bold', color: '#3CB371' }}
          >
            UpTick
          </span>
          <span style={{ fontSize: '22px', marginLeft: '6px' }}>📈</span>
          <p style={{ fontSize: '14px', color: '#888', marginTop: '8px' }}>
            회원가입
          </p>
        </div>

        {error && (
          <p
            style={{
              fontSize: '13px',
              color: '#e53935',
              marginBottom: '12px',
              textAlign: 'center',
            }}
          >
            {error}
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* 이름 */}
          <div>
            <label style={labelStyle}>이름</label>
            <input
              type="text"
              name="name"
              placeholder="이름을 입력하세요"
              value={form.name}
              onChange={handleChange}
              style={inputStyle}
            />
          </div>

          {/* 비밀번호 */}
          <div>
            <label style={labelStyle}>비밀번호</label>
            <input
              type="password"
              name="password"
              placeholder="비밀번호를 입력하세요"
              value={form.password}
              onChange={handleChange}
              style={inputStyle}
              // 클립보드 복사/붙여넣기 차단
              onCopy={(e) => { e.preventDefault(); alert("보안상 복사할 수 없습니다."); }}
              onPaste={(e) => { e.preventDefault(); alert("보안상 붙여넣기를 지원하지 않습니다. 직접 입력해주세요."); }}
            />
            {form.password && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '6px',
                  marginTop: '8px',
                }}
              >
                {pwRules.map((rule) => (
                  <span
                    key={rule.label}
                    style={{
                      fontSize: '11px',
                      padding: '2px 8px',
                      borderRadius: '12px',
                      backgroundColor: rule.ok ? '#e8f5e9' : '#fce4ec',
                      color: rule.ok ? '#2e7d32' : '#c62828',
                    }}
                  >
                    {rule.ok ? '✓' : '✗'} {rule.label}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 비밀번호 확인 */}
          <div>
            <label style={labelStyle}>비밀번호 확인</label>
            <input
              type="password"
              name="confirm"
              placeholder="비밀번호를 다시 입력하세요"
              value={form.confirm}
              onChange={handleChange}
              style={{
                ...inputStyle,
                borderColor: form.confirm
                  ? form.password === form.confirm
                    ? '#3CB371'
                    : '#e53935'
                  : '#ddd',
              }}
              // 클립보드 복사/붙여넣기 차단
              onCopy={(e) => { e.preventDefault(); alert("보안상 복사할 수 없습니다."); }}
              onPaste={(e) => { e.preventDefault(); alert("보안상 붙여넣기를 지원하지 않습니다. 직접 입력해주세요."); }}
            />
            {form.confirm && form.password !== form.confirm && (
              <p
                style={{ fontSize: '12px', color: '#e53935', marginTop: '4px' }}
              >
                비밀번호가 일치하지 않습니다.
              </p>
            )}
            {form.confirm && form.password === form.confirm && (
              <p
                style={{ fontSize: '12px', color: '#3CB371', marginTop: '4px' }}
              >
                ✅ 비밀번호 일치
              </p>
            )}
          </div>

          {/* 인증 방법 선택 */}
          <div>
            <label style={labelStyle}>본인 인증</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => setAuthMethod('email')}
                style={{
                  flex: 1,
                  padding: '12px',
                  border: `2px solid ${authMethod === 'email' ? '#3CB371' : '#ddd'}`,
                  borderRadius: '10px',
                  backgroundColor: authMethod === 'email' ? '#f0faf4' : '#fff',
                  color: authMethod === 'email' ? '#3CB371' : '#888',
                  fontWeight: '600',
                  fontSize: '14px',
                  cursor: 'pointer',
                }}
              >
                📧 이메일 인증
              </button>
              <button
                type="button"
                onClick={() => setAuthMethod('phone')}
                style={{
                  flex: 1,
                  padding: '12px',
                  border: `2px solid ${authMethod === 'phone' ? '#3CB371' : '#ddd'}`,
                  borderRadius: '10px',
                  backgroundColor: authMethod === 'phone' ? '#f0faf4' : '#fff',
                  color: authMethod === 'phone' ? '#3CB371' : '#888',
                  fontWeight: '600',
                  fontSize: '14px',
                  cursor: 'pointer',
                }}
              >
                📱 휴대폰 인증
              </button>
            </div>

            {/* 이메일 인증 입력창 */}
            {authMethod === 'email' && (
              <div style={{ marginTop: '12px' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="email"
                    name="email"
                    placeholder="이메일을 입력하세요"
                    value={form.email}
                    onChange={handleChange}
                    style={{ ...inputStyle, flex: 1 }}
                    disabled={emailVerified}
                  />
                  {form.email && !emailVerified && (
                    <button onClick={sendEmailCode} style={btnStyle(true)}>
                      {emailSent ? '재발송' : '인증코드 발송'}
                    </button>
                  )}
                </div>
                {emailSent && !emailVerified && (
                  <div
                    style={{ display: 'flex', gap: '8px', marginTop: '8px' }}
                  >
                    <input
                      type="text"
                      name="emailCode"
                      placeholder="6자리 인증코드"
                      value={form.emailCode}
                      onChange={handleChange}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    <button
                      onClick={verifyEmailCode}
                      style={btnStyle(!!form.emailCode)}
                    >
                      인증 확인
                    </button>
                  </div>
                )}
                {emailVerified && (
                  <p
                    style={{
                      fontSize: '12px',
                      color: '#3CB371',
                      marginTop: '6px',
                    }}
                  >
                    ✅ 이메일 인증 완료
                  </p>
                )}
              </div>
            )}

            {/* 휴대폰 인증 입력창 */}
            {authMethod === 'phone' && (
              <div style={{ marginTop: '12px' }}>
                <p style={{ fontSize: '12px', color: '#888', margin: '0 0 10px' }}>
                  휴대폰으로 가입하면 휴대폰 번호로 로그인합니다. 이메일은 가입 후 마이페이지에서 등록할 수 있습니다.
                </p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    name="phone"
                    placeholder="'-' 없이 입력하세요"
                    value={form.phone}
                    onChange={handleChange}
                    style={{ ...inputStyle, flex: 1 }}
                    disabled={smsVerified}
                  />
                  {form.phone && !smsVerified && (
                    <button onClick={sendSmsCode} style={btnStyle(true)}>
                      {smsSent ? '재발송' : '인증코드 발송'}
                    </button>
                  )}
                </div>
                {smsSent && !smsVerified && (
                  <div
                    style={{ display: 'flex', gap: '8px', marginTop: '8px' }}
                  >
                    <input
                      type="text"
                      name="smsCode"
                      placeholder="6자리 인증코드"
                      value={form.smsCode}
                      onChange={handleChange}
                      style={{ ...inputStyle, flex: 1 }}
                    />
                    <button
                      onClick={verifySmsCode}
                      style={btnStyle(!!form.smsCode)}
                    >
                      인증 확인
                    </button>
                  </div>
                )}
                {smsVerified && (
                  <p
                    style={{
                      fontSize: '12px',
                      color: '#3CB371',
                      marginTop: '6px',
                    }}
                  >
                    ✅ 휴대폰 인증 완료
                  </p>
                )}
              </div>
            )}
          </div>

          {(emailVerified || smsVerified) && (
            <div>
              <label style={labelStyle}>지갑 연결</label>
              {!walletSignature ? (
                walletConflict ? (
                  <button
                    onClick={() => connectWalletAndSign(true)}
                    style={{
                      ...btnStyle(true),
                      width: '100%',
                      padding: '12px',
                      backgroundColor: '#e53935',
                    }}
                  >
                    다른 지갑으로 변경
                  </button>
                ) : (
                  <button
                    onClick={() => connectWalletAndSign()}
                    style={{
                      ...btnStyle(true),
                      width: '100%',
                      padding: '12px',
                      backgroundColor: '#f0a500',
                    }}
                  >
                    MetaMask 연결 및 서명
                  </button>
                )
              ) : (
                <p style={{ fontSize: '12px', color: '#3CB371' }}>
                  ✅ 지갑 서명 완료 ({walletAddress.slice(0, 6)}...
                  {walletAddress.slice(-4)})
                </p>
              )}
            </div>
          )}

          {/* 약관 동의 */}
          <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: '16px' }}>
            <p
              style={{
                fontSize: '13px',
                fontWeight: '600',
                color: '#555',
                marginBottom: '10px',
              }}
            >
              약관 동의
            </p>
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}
            >
              {[
                { name: 'terms_agreed', label: '[필수] 서비스 이용약관 동의' },
                {
                  name: 'privacy_agreed',
                  label: '[필수] 개인정보 수집 및 이용 동의',
                },
                { name: 'location_agreed', label: '[필수] 위치정보 수집 동의' },
                { name: 'age_agreed', label: '[필수] 만 14세 이상 확인' },
                { name: 'marketing_agreed', label: '[선택] 마케팅 수신 동의' },
              ].map((item) => (
                <label
                  key={item.name}
                  style={{
                    fontSize: '13px',
                    color: '#555',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <input
                    type="checkbox"
                    name={item.name}
                    checked={agreements[item.name as keyof typeof agreements]}
                    onChange={handleAgreement}
                  />
                  {item.label}
                </label>
              ))}
            </div>
          </div>

          {/* 회원가입 버튼 */}
          <button
            onClick={handleRegister}
            disabled={!canSubmit}
            style={{
              width: '100%',
              padding: '14px',
              backgroundColor: canSubmit ? '#3CB371' : '#ccc',
              color: '#fff',
              border: 'none',
              borderRadius: '10px',
              fontSize: '15px',
              fontWeight: '600',
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              marginTop: '8px',
            }}
          >
            회원가입
          </button>

          <div style={{ textAlign: 'center', fontSize: '13px', color: '#888' }}>
            이미 계정이 있으신가요?{' '}
            <Link
              to="/login"
              style={{
                color: '#3CB371',
                fontWeight: '600',
                textDecoration: 'none',
              }}
            >
              로그인
            </Link>
          </div>
        </div>
      </div>
    </div>

    {/* 회원가입 완료 모달 */}
    {showSuccessModal && (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000, padding: '20px',
      }}>
        <div style={{
          backgroundColor: '#fff', borderRadius: '24px', padding: '40px',
          width: '100%', maxWidth: '400px', textAlign: 'center',
          boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
        }}>
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>🎉</div>
          <h3 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1a1a1a', marginBottom: '8px' }}>
            회원가입 완료!
          </h3>
          <p style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>
            투자 성향 설문을 완료하면<br />맞춤형 투자 정보를 제공받을 수 있습니다.
          </p>
          <p style={{ fontSize: '12px', color: '#aaa', marginBottom: '28px' }}>
            로그인 후 설문이 자동으로 시작됩니다.
          </p>
          <button
            onClick={() => navigate('/login')}
            style={{
              width: '100%', padding: '14px', backgroundColor: '#3CB371',
              color: '#fff', border: 'none', borderRadius: '12px',
              fontSize: '15px', fontWeight: '600', cursor: 'pointer',
              marginBottom: '12px',
            }}
          >
            로그인 & 설문 시작하기
          </button>
          <button
            onClick={() => navigate('/login')}
            style={{
              background: 'none', border: 'none', color: '#aaa',
              fontSize: '13px', cursor: 'pointer', textDecoration: 'underline',
            }}
          >
            다음에 하기
          </button>
        </div>
      </div>
    )}
    </>
  )
}

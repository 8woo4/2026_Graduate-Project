import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { createWalletClient, custom, keccak256, concat, toBytes, getAddress } from 'viem'
import { sepolia } from 'viem/chains'
import { useTradeModeStore } from '../../store/tradeModeStore'
import PinPad from './PinPad'
import { useBehaviorTracker } from '../../hooks/useBehaviorTracker'

import { API_BASE } from '../../utils/api'
import { isLoggedIn } from '../../utils/session'

interface Props {
  stockId: number
  stockCode: string
  stockName: string
  currentPrice: number
}

type OrderType = 'market' | 'limit'
type Side = 'buy' | 'sell'

export default function OrderPanel({ stockId, stockCode, stockName, currentPrice }: Props) {
  const { mode } = useTradeModeStore()
  const navigate = useNavigate()
  // 거래 화면 자동화 탐지(S12) — 마우스 없는 즉시 클릭·일정 주문 간격 판정용 행동 수집.
  const { getBehaviorData } = useBehaviorTracker()

  const [side, setSide] = useState<Side>('buy')
  const [orderType, setOrderType] = useState<OrderType>('market')
  const [quantity, setQuantity] = useState('')
  const [limitPrice, setLimitPrice] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  // 인증 등급 — 모의투자는 이메일·휴대폰 중 하나, 실거래는 둘 다(서버 verificationTierMiddleware 와 같은 규칙)
  const [verified, setVerified] = useState<{ email: boolean; phone: boolean } | null>(null)

  // 실거래 상태
  const [realStatus, setRealStatus] = useState<'loading' | 'not_registered' | 'registered'>('loading')
  const [realBuyable, setRealBuyable] = useState<number | null>(null)
  // 모의투자 장 운영 상태 — 서버(marketCalendar)가 정규장·휴장일을 판정한다. 화면은 안내와 버튼 잠금만 한다.
  const [market, setMarket] = useState<{ open: boolean; state: string; nextOpen: string } | null>(null)

  useEffect(() => {
    if (mode === 'real' || !isLoggedIn()) return
    let alive = true
    const load = () =>
      axios.get(`${API_BASE}/api/trade/virtual/market-status`, { withCredentials: true })
        .then(r => { if (alive) setMarket(r.data) })
        .catch(() => { if (alive) setMarket(null) })
    load()
    const timer = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(timer) }
  }, [mode])

  const marketClosed = mode !== 'real' && market !== null && !market.open
  const nextOpenLabel = market
    ? new Date(market.nextOpen).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })
    : ''

  useEffect(() => {
    if (!isLoggedIn()) return
    axios.get(`${API_BASE}/api/auth/me`, { withCredentials: true })
      .then(res => setVerified({ email: !!res.data.is_email_verified, phone: !!res.data.is_phone_verified }))
      .catch(() => setVerified({ email: false, phone: false }))
  }, [])

  useEffect(() => {
    if (mode !== 'real' || !isLoggedIn()) return
    setRealStatus('loading')
    fetch(`${API_BASE}/api/trade/real/account`, { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        if (data.isRegistered) {
          setRealStatus('registered')
          if (data.buyableAmount != null) setRealBuyable(data.buyableAmount)
        } else {
          setRealStatus('not_registered')
        }
      })
      .catch(() => setRealStatus('not_registered'))
  }, [mode])

  const price = orderType === 'market' ? currentPrice : Number(limitPrice)
  const totalCost = price * Number(quantity)
  const fee = Math.floor(totalCost * 0.00015)
  const total = side === 'buy' ? totalCost + fee : totalCost - fee

  const handleOrderClick = () => {
    if (!quantity || Number(quantity) <= 0) {
      setMessage({ text: '수량을 입력해주세요', ok: false })
      return
    }
    if (orderType === 'limit' && (!limitPrice || Number(limitPrice) <= 0)) {
      setMessage({ text: '지정가를 입력해주세요', ok: false })
      return
    }
    setMessage(null)
    setShowPin(true)
  }

  const handlePinConfirm = async (pin: string) => {
    setShowPin(false)
    setLoading(true)
    setMessage(null)

    try {
      if (mode === 'real') {
        // 실거래 — KIS API 직접 주문
        const endpoint = side === 'buy' ? '/api/trade/real/buy' : '/api/trade/real/sell'
        const res = await axios.post(
          `${API_BASE}${endpoint}`,
          { stockId, stockCode, quantity: Number(quantity), orderType, price: orderType === 'limit' ? Number(limitPrice) : currentPrice, pin },
          { withCredentials: true },
        )
        setMessage({ text: res.data.message, ok: true })
        setQuantity('')
        // 잔고 갱신
        fetch(`${API_BASE}/api/trade/real/account`, { credentials: 'include' })
          .then(r => r.json())
          .then(data => { if (data.buyableAmount != null) setRealBuyable(data.buyableAmount) })
          .catch(() => {})
        return
      }

      // 모의투자 — 기존 로직 유지 (MetaMask 포함)
      const endpoint = side === 'buy' ? '/api/trade/virtual/buy' : '/api/trade/virtual/sell'
      let tradeSignature: string | undefined
      // 거래 화면 자동화(S12-b) 판정용 행동 데이터 — 서버는 관측 신호로만 쓴다.
      const behaviorData = getBehaviorData()

      try {
        const res = await axios.post(
          `${API_BASE}${endpoint}`,
          { stockId, stockCode, quantity: Number(quantity), orderType, limitPrice: limitPrice ? Number(limitPrice) : undefined, pin, behaviorData },
          { withCredentials: true },
        )
        setMessage({ text: res.data.message, ok: true })
        setQuantity('')
        return
      } catch (err: any) {
        if (err.response?.data?.message !== 'LARGE_ORDER') throw err
      }

      setMessage({ text: '고액 거래입니다. MetaMask 서명을 진행해주세요...', ok: false })

      if (!window.ethereum) throw new Error('MetaMask가 설치되어 있지 않습니다')

      const walletClient = createWalletClient({ chain: sepolia, transport: custom(window.ethereum) })
      const [address] = await walletClient.requestAddresses()

      const nonceRes = await axios.get(
        `${API_BASE}/api/auth/trade-nonce?address=${address}`,
        { withCredentials: true },
      )
      const nonce = BigInt(nonceRes.data.nonce)
      const contractAddress = getAddress(import.meta.env.VITE_CONTRACT_AUTH_ADDRESS as string)
      const amount = BigInt(Math.round(price * Number(quantity)))
      // 서버 buildTradeDescriptor 와 같은 형식. 종목만이 아니라 매수/매도·주문 유형·수량·지정가까지
      // 서명에 묶어야, 이 서명으로 다른 수량이나 반대 방향 주문을 통과시킬 수 없다.
      const descriptor = [
        stockCode,
        side,
        orderType,
        String(Number(quantity)),
        orderType === 'limit' ? String(Number(limitPrice)) : '0',
      ].join('|')

      const msgHash = keccak256(
        concat([
          toBytes(BigInt(sepolia.id), { size: 32 }),
          toBytes(contractAddress,    { size: 20 }),
          toBytes(address,            { size: 20 }),
          toBytes(nonce,              { size: 32 }),
          toBytes(amount,             { size: 32 }),
          new TextEncoder().encode(descriptor),
        ])
      )

      tradeSignature = await walletClient.signMessage({ account: address, message: { raw: msgHash } })

      const res = await axios.post(
        `${API_BASE}${endpoint}`,
        { stockId, stockCode, quantity: Number(quantity), orderType, limitPrice: limitPrice ? Number(limitPrice) : undefined, pin, tradeSignature, signedAmount: amount.toString(), behaviorData },
        { withCredentials: true },
      )
      setMessage({ text: res.data.message, ok: true })
      setQuantity('')
    } catch (err: any) {
      setMessage({ text: err.response?.data?.message ?? err.message ?? '주문 실패', ok: false })
    } finally {
      setLoading(false)
    }
  }

  if (!isLoggedIn()) {
    return (
      <div style={{
        backgroundColor: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: '20px',
        padding: '36px 24px',
        textAlign: 'center',
      }}>
        <p style={{ fontSize: '28px', marginBottom: '12px' }}>🔒</p>
        <p style={{ fontWeight: '700', fontSize: '15px', color: '#111', marginBottom: '6px' }}>로그인 후 이용 가능합니다</p>
        <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '20px' }}>주문 서비스는 로그인이 필요해요</p>
        <button
          onClick={() => navigate('/login')}
          style={{
            padding: '10px 28px',
            backgroundColor: '#22C55E',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            fontWeight: '700',
            fontSize: '14px',
            cursor: 'pointer',
          }}
        >
          로그인하기
        </button>
      </div>
    )
  }

  const missingForMode = verified === null ? [] : mode === 'real'
    ? [!verified.email && '이메일', !verified.phone && '휴대폰'].filter(Boolean) as string[]
    : (verified.email || verified.phone) ? [] : ['이메일 또는 휴대폰']
  if (isLoggedIn() && missingForMode.length > 0) {
    return (
      <div style={{
        backgroundColor: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: '20px',
        padding: '36px 24px',
        textAlign: 'center',
      }}>
        <p style={{ fontSize: '28px', marginBottom: '12px' }}>📵</p>
        <p style={{ fontWeight: '700', fontSize: '15px', color: '#111', marginBottom: '6px' }}>{missingForMode.join('·')} 인증이 필요합니다</p>
        <p style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '20px' }}>
          {mode === 'real'
            ? <>실거래는 이메일과 휴대폰 인증을<br />모두 완료한 뒤 이용할 수 있습니다</>
            : <>모의투자는 이메일 또는 휴대폰 인증을<br />완료한 뒤 이용할 수 있습니다</>}
        </p>
        <button
          onClick={() => navigate('/mypage?tab=security')}
          style={{
            padding: '10px 28px',
            backgroundColor: '#22C55E',
            color: '#fff',
            border: 'none',
            borderRadius: '10px',
            fontWeight: '700',
            fontSize: '14px',
            cursor: 'pointer',
          }}
        >
          인증하러 가기
        </button>
      </div>
    )
  }

  if (mode === 'real') {
    if (realStatus === 'loading') {
      return (
        <div style={{ backgroundColor: '#fff', border: '1px solid #e5e7eb', borderRadius: '20px', padding: '36px 24px', textAlign: 'center' }}>
          <p style={{ color: '#9ca3af', fontSize: '13px' }}>계좌 정보 확인 중...</p>
        </div>
      )
    }

    if (realStatus === 'not_registered') {
      return (
        <div style={{ backgroundColor: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '20px', padding: '28px 24px', textAlign: 'center' }}>
          <p style={{ fontSize: '28px', marginBottom: '12px' }}>🏦</p>
          <p style={{ fontWeight: '700', fontSize: '15px', color: '#c2410c', marginBottom: '6px' }}>실거래 계좌 미등록</p>
          <p style={{ fontSize: '12px', color: '#6b7280', marginBottom: '20px', lineHeight: '1.6' }}>
            KIS 앱키를 등록하면<br />실제 주식 거래가 가능합니다
          </p>
          <button
            onClick={() => navigate('/mypage?tab=security')}
            style={{
              padding: '11px 24px',
              backgroundColor: '#ea580c',
              color: '#fff',
              border: 'none',
              borderRadius: '10px',
              fontWeight: '700',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            마이페이지에서 계좌 등록
          </button>
        </div>
      )
    }

    // registered — 실거래 주문 폼
    return (
      <>
        {showPin && (
          <PinPad
            title={`실거래 ${side === 'buy' ? '매수' : '매도'} 확인`}
            subtitle={`${stockName} · ${quantity}주 · ₩${total.toLocaleString()}`}
            onConfirm={handlePinConfirm}
            onCancel={() => setShowPin(false)}
          />
        )}
        <div style={{ backgroundColor: '#fff', border: '1px solid #fed7aa', borderRadius: '20px', overflow: 'hidden' }}>
          {/* 매수/매도 탭 */}
          <div style={{ display: 'flex' }}>
            {(['buy', 'sell'] as Side[]).map(s => (
              <button
                key={s}
                onClick={() => setSide(s)}
                style={{
                  flex: 1, padding: '14px', border: 'none', cursor: 'pointer', fontSize: '14px', fontWeight: '700',
                  backgroundColor: side === s ? (s === 'buy' ? '#ef4444' : '#3b82f6') : '#f9fafb',
                  color: side === s ? '#fff' : '#9ca3af', transition: 'all 0.2s',
                  borderBottom: `2px solid ${side === s ? (s === 'buy' ? '#ef4444' : '#3b82f6') : '#f3f4f6'}`,
                }}
              >
                {s === 'buy' ? '매수' : '매도'}
              </button>
            ))}
          </div>

          <div style={{ padding: '20px' }}>
            {/* 실거래 뱃지 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
              <span style={{ fontSize: '11px', fontWeight: '700', color: '#c2410c', backgroundColor: '#fff7ed', padding: '2px 8px', borderRadius: '999px', border: '1px solid #fed7aa' }}>
                실거래
              </span>
              <span style={{ fontSize: '13px', color: '#6b7280', fontWeight: '500' }}>{stockName}</span>
            </div>

            {/* 매수가능금액 */}
            {realBuyable != null && (
              <div style={{ backgroundColor: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '8px', padding: '8px 12px', marginBottom: '12px', display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                <span style={{ color: '#6b7280' }}>매수가능금액</span>
                <span style={{ fontWeight: '700', color: '#15803d' }}>₩{realBuyable.toLocaleString()}</span>
              </div>
            )}

            {/* 주문 유형 */}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
              {(['market', 'limit'] as OrderType[]).map(t => (
                <button
                  key={t}
                  onClick={() => setOrderType(t)}
                  style={{
                    flex: 1, padding: '7px', borderRadius: '8px',
                    border: `1.5px solid ${orderType === t ? '#2563eb' : '#e5e7eb'}`,
                    cursor: 'pointer', fontSize: '12px', fontWeight: '700',
                    backgroundColor: orderType === t ? '#eff6ff' : '#fff',
                    color: orderType === t ? '#1d4ed8' : '#9ca3af', transition: 'all 0.15s',
                  }}
                >
                  {t === 'market' ? '시장가' : '지정가'}
                </button>
              ))}
            </div>

            {/* 현재가 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#f9fafb', borderRadius: '10px', padding: '10px 14px', marginBottom: '12px' }}>
              <span style={{ fontSize: '12px', color: '#9ca3af' }}>현재가</span>
              <span style={{ fontSize: '15px', fontWeight: '800', color: '#111' }}>₩{currentPrice.toLocaleString()}</span>
            </div>

            {/* 지정가 입력 */}
            {orderType === 'limit' && (
              <div style={{ marginBottom: '12px' }}>
                <label style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600', display: 'block', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>지정가 (원)</label>
                <input
                  type="number" value={limitPrice} onChange={e => setLimitPrice(e.target.value)} placeholder="0"
                  style={{ width: '100%', padding: '10px 12px', border: '1.5px solid #e5e7eb', borderRadius: '10px', fontSize: '15px', fontWeight: '700', outline: 'none', boxSizing: 'border-box', textAlign: 'right', color: '#111' }}
                  onFocus={e => (e.currentTarget.style.borderColor = '#2563eb')}
                  onBlur={e => (e.currentTarget.style.borderColor = '#e5e7eb')}
                />
              </div>
            )}

            {/* 수량 */}
            <div style={{ marginBottom: '12px' }}>
              <label style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600', display: 'block', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>수량 (주)</label>
              <div style={{ display: 'flex', alignItems: 'center', border: '1.5px solid #e5e7eb', borderRadius: '10px', overflow: 'hidden' }}>
                <button onClick={() => setQuantity(q => String(Math.max(0, Number(q) - 1)))} style={{ padding: '10px 14px', border: 'none', background: '#f9fafb', color: '#374151', fontSize: '18px', fontWeight: '300', cursor: 'pointer' }}>−</button>
                <input
                  type="number" value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="0" min="1"
                  style={{ flex: 1, padding: '10px 0', border: 'none', fontSize: '15px', fontWeight: '700', outline: 'none', textAlign: 'center', color: '#111' }}
                />
                <button onClick={() => setQuantity(q => String(Number(q) + 1))} style={{ padding: '10px 14px', border: 'none', background: '#f9fafb', color: '#374151', fontSize: '18px', fontWeight: '300', cursor: 'pointer' }}>+</button>
              </div>
            </div>

            {/* 예상 금액 */}
            {quantity && Number(quantity) > 0 && (
              <div style={{ borderRadius: '10px', border: '1px solid #f3f4f6', overflow: 'hidden', marginBottom: '14px' }}>
                {[
                  { label: '주문금액', value: `₩${totalCost.toLocaleString()}` },
                  { label: '수수료 (0.015%)', value: `₩${fee.toLocaleString()}` },
                ].map(({ label, value }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', fontSize: '12px', borderBottom: '1px solid #f3f4f6' }}>
                    <span style={{ color: '#9ca3af' }}>{label}</span>
                    <span style={{ fontWeight: '600', color: '#374151' }}>{value}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 12px', fontSize: '13px', backgroundColor: '#f9fafb' }}>
                  <span style={{ fontWeight: '700', color: '#111' }}>최종 {side === 'buy' ? '결제' : '수령'}</span>
                  <span style={{ fontWeight: '800', color: side === 'buy' ? '#ef4444' : '#3b82f6', fontSize: '15px' }}>₩{total.toLocaleString()}</span>
                </div>
              </div>
            )}

            {/* 실거래 경고 */}
            <div style={{ backgroundColor: '#fefce8', border: '1px solid #fde68a', borderRadius: '8px', padding: '8px 12px', marginBottom: '12px', fontSize: '11px', color: '#92400e' }}>
              ⚠️ 실제 계좌에서 실행됩니다. 신중히 확인 후 주문하세요.
            </div>

            {/* 피드백 */}
            {message && (
              <div style={{ padding: '9px 12px', borderRadius: '8px', marginBottom: '12px', fontSize: '12px', fontWeight: '600', backgroundColor: message.ok ? '#f0fdf4' : '#fef2f2', color: message.ok ? '#15803d' : '#dc2626', border: `1px solid ${message.ok ? '#bbf7d0' : '#fecaca'}` }}>
                {message.text}
              </div>
            )}

            {/* 주문 버튼 */}
            <button
              onClick={handleOrderClick}
              disabled={loading}
              style={{
                width: '100%', padding: '14px', borderRadius: '12px', border: 'none',
                cursor: loading ? 'not-allowed' : 'pointer', fontSize: '15px', fontWeight: '800',
                backgroundColor: loading ? '#e5e7eb' : (side === 'buy' ? '#ef4444' : '#3b82f6'),
                color: loading ? '#9ca3af' : '#fff', transition: 'all 0.15s',
              }}
            >
              {loading ? '처리 중...' : `실거래 ${side === 'buy' ? '매수' : '매도'}`}
            </button>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      {showPin && (
        <PinPad
          title={`${side === 'buy' ? '매수' : '매도'} PIN 확인`}
          subtitle={`${stockName} · ${quantity}주 · ₩${total.toLocaleString()}`}
          onConfirm={handlePinConfirm}
          onCancel={() => setShowPin(false)}
        />
      )}

      <div style={{
        backgroundColor: '#fff',
        border: '1px solid #e5e7eb',
        borderRadius: '20px',
        overflow: 'hidden',
      }}>
        {/* 매수/매도 탭 */}
        <div style={{ display: 'flex' }}>
          {(['buy', 'sell'] as Side[]).map(s => (
            <button
              key={s}
              onClick={() => setSide(s)}
              style={{
                flex: 1,
                padding: '14px',
                border: 'none',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '700',
                backgroundColor: side === s ? (s === 'buy' ? '#ef4444' : '#3b82f6') : '#f9fafb',
                color: side === s ? '#fff' : '#9ca3af',
                transition: 'all 0.2s',
                borderBottom: `2px solid ${side === s ? (s === 'buy' ? '#ef4444' : '#3b82f6') : '#f3f4f6'}`,
              }}
            >
              {s === 'buy' ? '매수' : '매도'}
            </button>
          ))}
        </div>

        <div style={{ padding: '20px' }}>
          {/* 모의투자 뱃지 + 종목명 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px' }}>
            <span style={{ fontSize: '11px', fontWeight: '700', color: '#15803d', backgroundColor: '#f0fdf4', padding: '2px 8px', borderRadius: '999px', border: '1px solid #bbf7d0' }}>
              모의투자
            </span>
            <span style={{ fontSize: '13px', color: '#6b7280', fontWeight: '500' }}>{stockName}</span>
            {market && (
              <span style={{ marginLeft: 'auto', fontSize: '11px', fontWeight: '700', color: market.open ? '#15803d' : '#b45309' }}>
                {market.open ? '● 장 중' : `장 마감 · 다음 개장 ${nextOpenLabel}`}
              </span>
            )}
          </div>

          {/* 주문 유형 */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
            {(['market', 'limit'] as OrderType[]).map(t => (
              <button
                key={t}
                onClick={() => setOrderType(t)}
                style={{
                  flex: 1,
                  padding: '7px',
                  borderRadius: '8px',
                  border: `1.5px solid ${orderType === t ? '#22C55E' : '#e5e7eb'}`,
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: '700',
                  backgroundColor: orderType === t ? '#f0fdf4' : '#fff',
                  color: orderType === t ? '#15803d' : '#9ca3af',
                  transition: 'all 0.15s',
                }}
              >
                {t === 'market' ? '시장가' : '지정가'}
              </button>
            ))}
          </div>

          {/* 현재가 */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: '#f9fafb',
            borderRadius: '10px',
            padding: '10px 14px',
            marginBottom: '12px',
          }}>
            <span style={{ fontSize: '12px', color: '#9ca3af' }}>현재가</span>
            <span style={{ fontSize: '15px', fontWeight: '800', color: '#111' }}>₩{currentPrice.toLocaleString()}</span>
          </div>

          {/* 지정가 입력 */}
          {orderType === 'limit' && (
            <div style={{ marginBottom: '12px' }}>
              <label style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600', display: 'block', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>지정가 (원)</label>
              <input
                type="number"
                value={limitPrice}
                onChange={e => setLimitPrice(e.target.value)}
                placeholder="0"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  border: '1.5px solid #e5e7eb',
                  borderRadius: '10px',
                  fontSize: '15px',
                  fontWeight: '700',
                  outline: 'none',
                  boxSizing: 'border-box',
                  textAlign: 'right',
                  color: '#111',
                }}
                onFocus={e => (e.currentTarget.style.borderColor = '#22C55E')}
                onBlur={e => (e.currentTarget.style.borderColor = '#e5e7eb')}
              />
            </div>
          )}

          {/* 수량 */}
          <div style={{ marginBottom: '12px' }}>
            <label style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600', display: 'block', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>수량 (주)</label>
            <div style={{ display: 'flex', alignItems: 'center', border: '1.5px solid #e5e7eb', borderRadius: '10px', overflow: 'hidden' }}>
              <button
                onClick={() => setQuantity(q => String(Math.max(0, Number(q) - 1)))}
                style={{ padding: '10px 14px', border: 'none', background: '#f9fafb', color: '#374151', fontSize: '18px', fontWeight: '300', cursor: 'pointer' }}
              >−</button>
              <input
                type="number"
                value={quantity}
                onChange={e => setQuantity(e.target.value)}
                placeholder="0"
                min="1"
                style={{
                  flex: 1,
                  padding: '10px 0',
                  border: 'none',
                  fontSize: '15px',
                  fontWeight: '700',
                  outline: 'none',
                  textAlign: 'center',
                  color: '#111',
                }}
              />
              <button
                onClick={() => setQuantity(q => String(Number(q) + 1))}
                style={{ padding: '10px 14px', border: 'none', background: '#f9fafb', color: '#374151', fontSize: '18px', fontWeight: '300', cursor: 'pointer' }}
              >+</button>
            </div>
          </div>

          {/* 예상 금액 요약 */}
          {quantity && Number(quantity) > 0 && (
            <div style={{ borderRadius: '10px', border: '1px solid #f3f4f6', overflow: 'hidden', marginBottom: '14px' }}>
              {[
                { label: '주문금액', value: `₩${totalCost.toLocaleString()}` },
                { label: '수수료 (0.015%)', value: `₩${fee.toLocaleString()}` },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', fontSize: '12px', borderBottom: '1px solid #f3f4f6' }}>
                  <span style={{ color: '#9ca3af' }}>{label}</span>
                  <span style={{ fontWeight: '600', color: '#374151' }}>{value}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 12px', fontSize: '13px', backgroundColor: '#f9fafb' }}>
                <span style={{ fontWeight: '700', color: '#111' }}>최종 {side === 'buy' ? '결제' : '수령'}</span>
                <span style={{ fontWeight: '800', color: side === 'buy' ? '#ef4444' : '#3b82f6', fontSize: '15px' }}>
                  ₩{total.toLocaleString()}
                </span>
              </div>
            </div>
          )}

          {/* 피드백 메시지 */}
          {message && (
            <div style={{
              padding: '9px 12px',
              borderRadius: '8px',
              marginBottom: '12px',
              fontSize: '12px',
              fontWeight: '600',
              backgroundColor: message.ok ? '#f0fdf4' : '#fef2f2',
              color: message.ok ? '#15803d' : '#dc2626',
              border: `1px solid ${message.ok ? '#bbf7d0' : '#fecaca'}`,
            }}>
              {message.text}
            </div>
          )}

          {/* 주문 버튼 */}
          <button
            onClick={handleOrderClick}
            disabled={loading || marketClosed}
            style={{
              width: '100%',
              padding: '14px',
              borderRadius: '12px',
              border: 'none',
              cursor: loading || marketClosed ? 'not-allowed' : 'pointer',
              fontSize: '15px',
              fontWeight: '800',
              backgroundColor: loading || marketClosed ? '#e5e7eb' : (side === 'buy' ? '#ef4444' : '#3b82f6'),
              color: loading || marketClosed ? '#9ca3af' : '#fff',
              transition: 'all 0.15s',
              letterSpacing: '0.02em',
            }}
            onMouseEnter={e => { if (!loading) e.currentTarget.style.opacity = '0.88' }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
          >
            {loading ? '처리 중...' : marketClosed ? '정규장(09:00~15:30)에만 주문할 수 있습니다' : `${side === 'buy' ? '매수' : '매도'} 주문`}
          </button>
        </div>
      </div>
    </>
  )
}

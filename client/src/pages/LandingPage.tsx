import React, { useEffect, useState } from 'react'
import { io, Socket } from 'socket.io-client'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

import { SOCKET_URL, apiUrl } from '../utils/api'

// ─── 타입 ─────────────────────────────────────────────────────

interface IndexData {
  code: string
  name: string
  price: number
  change: number
  changeRate: number
  market: 'KR' | 'US'
  delayed?: boolean
}

type Timeframe = '1D' | '1M' | '3M' | '6M' | '1Y'

// ─── 초기 지수 데이터 ─────────────────────────────────────────

const INITIAL_INDICES: Record<string, IndexData> = {
  '0001':   { code: '0001',   name: 'KOSPI',   price: 0, change: 0, changeRate: 0, market: 'KR' },
  '1001':   { code: '1001',   name: 'KOSDAQ',  price: 0, change: 0, changeRate: 0, market: 'KR' },
  'SP500':  { code: 'SP500',  name: 'S&P 500', price: 0, change: 0, changeRate: 0, market: 'US', delayed: true },
  'NASDAQ': { code: 'NASDAQ', name: 'NASDAQ',  price: 0, change: 0, changeRate: 0, market: 'US', delayed: true },
  'DOW':    { code: 'DOW',    name: 'DOW',     price: 0, change: 0, changeRate: 0, market: 'US', delayed: true },
}

const INDEX_ORDER = ['0001', '1001', 'SP500', 'NASDAQ', 'DOW']

// ─── 숫자 포맷 유틸 ───────────────────────────────────────────

const formatPrice = (price: number): string => {
  if (price === 0) return '-'
  return price.toLocaleString('ko-KR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

const formatChangeRate = (changeRate: number): string => {
  if (changeRate === 0) return '-'
  const absRate = Math.abs(changeRate).toFixed(2)
  return `${absRate}%`
}

// ─── 날짜 계산 유틸 (기간 탭 지원) ─────────────────────────────

const getFormattedDates = (isUS: boolean = false, timeframe: Timeframe = '1Y') => {
  const toDate = new Date()
  const fromDate = new Date()

  switch (timeframe) {
    case '1D':
      fromDate.setDate(toDate.getDate() - 1) // 1일 전
      break
    case '1M':
      fromDate.setMonth(toDate.getMonth() - 1) // 1개월 전
      break
    case '3M':
      fromDate.setMonth(toDate.getMonth() - 3) // 3개월 전
      break
    case '6M':
      fromDate.setMonth(toDate.getMonth() - 6) // 6개월 전
      break
    case '1Y':
      fromDate.setFullYear(toDate.getFullYear() - 1) // 1년 전
      break
  }

  const formatDate = (date: Date) => {
    const yyyy = date.getFullYear()
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    return isUS ? `${yyyy}-${mm}-${dd}` : `${yyyy}${mm}${dd}`
  }

  return {
    from: formatDate(fromDate),
    to: formatDate(toDate),
  }
}

// ─── 차트 컴포넌트 ────────────────────────────────────────────

interface ChartProps {
  indexType: 'KOSPI' | 'KOSDAQ' | 'SP500' | 'NASDAQ' | 'DOW'
  color?: string
}

const IndexChart = ({ indexType, color = '#22C55E' }: ChartProps) => {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [timeframe, setTimeframe] = useState<Timeframe>('1Y')

  const timeframes: { label: string; value: Timeframe }[] = [
    { label: '1일', value: '1D' },
    { label: '1개월', value: '1M' },
    { label: '3개월', value: '3M' },
    { label: '6개월', value: '6M' },
    { label: '1년', value: '1Y' },
  ]

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true)
        const isUS = ['SP500', 'NASDAQ', 'DOW'].includes(indexType)
        const { from, to } = getFormattedDates(isUS, timeframe)
        
        let endpoint = ''
        switch (indexType) {
          case 'KOSPI':  endpoint = `/api/market/ecos/kospi?from=${from}&to=${to}`; break;
          case 'KOSDAQ': endpoint = `/api/market/ecos/kosdaq?from=${from}&to=${to}`; break;
          case 'SP500':  endpoint = `/api/market/ecos/index/US500?from=${from}&to=${to}`; break;
          case 'NASDAQ': endpoint = `/api/market/ecos/index/IXIC?from=${from}&to=${to}`; break;
          case 'DOW':    endpoint = `/api/market/ecos/index/DJI?from=${from}&to=${to}`; break;
        }

        const response = await fetch(apiUrl(endpoint))
        const result = await response.json()

        const rawData = result.data || []

        const formattedData = rawData.map((item: any) => {
          let displayDate = item.time_period
          if (displayDate && !displayDate.includes('-') && displayDate.length === 8) {
            displayDate = `${displayDate.slice(0, 4)}-${displayDate.slice(4, 6)}-${displayDate.slice(6, 8)}`
          }

          return {
            date: displayDate,
            value: parseFloat(item.value) 
          }
        })

        setData(formattedData)
      } catch (error) {
        console.error(`${indexType} 차트 데이터를 불러오는데 실패했습니다:`, error)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [indexType, timeframe])

  // 최소/최대 범위 계산
  const minVal = data.length > 0 ? Math.min(...data.map(d => d.value)) : 0
  const maxVal = data.length > 0 ? Math.max(...data.map(d => d.value)) : 100
  const offset = (maxVal - minVal) * 0.1 

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 차트 상단: 타이틀 & 기간 선택 탭 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h3 style={{ fontSize: '16px', color: '#111', margin: 0, fontWeight: 'bold' }}>
          {indexType} 추이
        </h3>
        <div style={{ display: 'flex', gap: '4px', backgroundColor: '#f3f4f6', padding: '4px', borderRadius: '8px' }}>
          {timeframes.map((tf) => (
            <button
              key={tf.value}
              onClick={() => setTimeframe(tf.value)}
              style={{
                border: 'none',
                background: timeframe === tf.value ? '#ffffff' : 'transparent',
                color: timeframe === tf.value ? '#111' : '#888',
                fontWeight: timeframe === tf.value ? 'bold' : 'normal',
                padding: '4px 10px',
                borderRadius: '6px',
                fontSize: '12px',
                cursor: 'pointer',
                boxShadow: timeframe === tf.value ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                transition: 'all 0.2s',
              }}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>

      {/* 차트 영역 */}
      <div style={{ flex: 1, width: '100%', position: 'relative' }}>
        {loading ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', backgroundColor: 'rgba(255,255,255,0.7)', zIndex: 10 }}>
            데이터를 불러오는 중...
          </div>
        ) : data.length === 0 ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
            데이터가 없습니다.
          </div>
        ) : null}

        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <XAxis dataKey="date" hide />
            <YAxis 
              domain={[minVal - offset, maxVal + offset]} 
              hide 
            />
            <Tooltip 
              contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', fontSize: '13px' }}
              labelStyle={{ color: '#666', marginBottom: '4px' }}
              itemStyle={{ color: color, fontWeight: 'bold' }}
              formatter={(value: any) => [
                typeof value === 'number' 
                  ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) 
                  : value, 
                '지수'
              ]}
            />
            <Line 
              type="monotone" 
              dataKey="value" 
              stroke={color} 
              strokeWidth={2} 
              dot={false} 
              activeDot={{ r: 4, strokeWidth: 0 }}
              animationDuration={300}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── 메인 컴포넌트 ─────────────────────────────────────────────

export default function LandingPage(): React.ReactElement {
  const [indices, setIndices] = useState<Record<string, IndexData>>(INITIAL_INDICES)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const socket: Socket = io(SOCKET_URL, {
      transports: ['websocket'],
    })

    socket.on('connect', () => setConnected(true))
    socket.on('disconnect', () => setConnected(false))

    socket.on('index:price', (data: IndexData) => {
      setIndices((prev) => ({
        ...prev,
        [data.code]: data,
      }))
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  return (
    <div style={{ fontFamily: 'sans-serif' }}>
      {/* 히어로 섹션 */}
      <section
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '80px 120px',
          backgroundColor: '#f9fafb',
        }}
      >
        <div>
          <h1
            style={{
              fontSize: '42px',
              fontWeight: 'bold',
              color: '#111',
              lineHeight: 1.3,
            }}
          >
            투자의 기준을 높이다,
            <br />
            <span style={{ color: '#22C55E' }}>UpTick</span>
          </h1>
          <p
            style={{
              fontSize: '16px',
              color: '#666',
              marginTop: '16px',
              marginBottom: '32px',
            }}
          >
            실시간 시장 데이터와 AI 분석으로
            <br />더 스마트한 투자를 시작하세요.
          </p>
        </div>

        {/* 오른쪽 이미지 */}
        <div
          style={{
            width: '500px',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <img
            src="/main.png"
            alt="UpTick 메인 이미지"
            style={{
              width: '100%',
              height: 'auto',
              borderRadius: '16px',
              objectFit: 'contain',
            }}
          />
        </div>
      </section>

      {/* 지수 티커 바 */}
      <section
        style={{
          display: 'flex',
          justifyContent: 'space-around',
          alignItems: 'center',
          padding: '24px 120px',
          backgroundColor: '#ffffff',
          borderTop: '1px solid #eee',
          borderBottom: '1px solid #eee',
          position: 'relative',
        }}
      >
        {INDEX_ORDER.map((code) => {
          const item = indices[code]
          const isUp = item.change >= 0
          const hasData = item.price !== 0

          return (
            <div key={code} style={{ textAlign: 'left', minWidth: '120px' }}>
              <div style={{ fontSize: '13px', color: '#888', marginBottom: '4px' }}>
                {item.name}
                {item.delayed && (
                  <span style={{ fontSize: '10px', color: '#bbb', marginLeft: '4px' }}>
                    15분지연
                  </span>
                )}
              </div>

              <div
                style={{
                  fontSize: '22px',
                  fontWeight: 'bold',
                  color: '#111',
                  marginBottom: '4px',
                }}
              >
                {formatPrice(item.price)}
              </div>

              {hasData ? (
                <div
                  style={{
                    fontSize: '13px',
                    color: isUp ? '#3CB371' : '#e53935',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '3px',
                  }}
                >
                  <span>{isUp ? '▲' : '▼'}</span>
                  <span>{formatChangeRate(item.changeRate)}</span>
                </div>
              ) : (
                <div style={{ fontSize: '13px', color: '#ccc' }}>-</div>
              )}
            </div>
          )
        })}

        <div style={{ position: 'absolute', right: '24px', top: '12px' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: connected ? '#22C55E' : '#ccc',
              display: 'inline-block',
            }}
          />
        </div>
      </section>

      {/* 시장 정보 섹션 */}
      <section style={{ padding: '60px 120px' }}>
        <h2 style={{ fontSize: '24px', fontWeight: 'bold', marginBottom: '32px', color: '#111' }}>
          시장 정보
        </h2>
        <div style={{ display: 'flex', gap: '24px' }}>
          
          <div
            style={{
              flex: 1,
              height: '300px', // 탭 버튼이 들어갈 공간을 위해 높이 살짝 늘림
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              border: '1px solid #eee',
              padding: '24px',
              boxShadow: '0 2px 10px rgba(0,0,0,0.02)'
            }}
          >
            <IndexChart indexType="KOSPI" color="#22C55E" />
          </div>

          <div
            style={{
              flex: 1,
              height: '300px',
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              border: '1px solid #eee',
              padding: '24px',
              boxShadow: '0 2px 10px rgba(0,0,0,0.02)'
            }}
          >
            <IndexChart indexType="KOSDAQ" color="#3B82F6" />
          </div>

        </div>
      </section>
    </div>
  )
}
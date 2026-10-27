import { useEffect, useRef, useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { createChart, CandlestickSeries, AreaSeries } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, UTCTimestamp, Time } from 'lightweight-charts'
import { io, Socket } from 'socket.io-client'
import axios from 'axios'
import OrderPanel from '../components/trade/OrderPanel'
import { formatStockName } from '../utils/formatStockName'
import toast from 'react-hot-toast';

import { API_BASE, SOCKET_URL } from '../utils/api'

interface StockInfo {
    id: number
    name: string
    code: string
    market: string
    type: string
    /** AI 예측 대상 여부(서버 stocks.is_ml_target). 구버전 API 는 내려주지 않으므로 optional. */
    aiTarget?: number
    price: number
    change: number
    changeRate: number
    volume: number
}

interface CandleBar {
    time: string
    open: number
    high: number
    low: number
    close: number
    volume: number
}

type ChartMode = 'line' | 'candle'
type LinePeriod = '1d' | '1w' | '3m' | '1y' | '3y' | '5y' | '10y'
type CandleType = 'minute' | 'day' | 'week' | 'month'

// AI 예측 — 서버 응답 계약 그대로다(POST /api/ai/predict).
//
// 모델은 상승/하락 이진 분류와 그 방향의 확률만 낸다. 목표주가나 매수/매도 의견 같은
// 필드는 존재하지 않으므로 화면에서도 만들어 쓰지 않는다.
// confidence 는 0~1 이며 5%p 격자로 양자화되어 내려온다(원 확률 복원 방지).
type AiHorizon = '1d' | '1w' | '1m' | '1y'

interface AiPrediction {
    recommended: boolean
    direction?: 'UP' | 'DOWN'
    confidence?: number
    predictDate?: string
    message?: string
    disclaimer: string
}

const AI_HORIZONS: { key: AiHorizon; label: string }[] = [
    { key: '1d', label: '1일' },
    { key: '1w', label: '1주' },
    { key: '1m', label: '1개월' },
    { key: '1y', label: '1년' },
]

const LINE_PERIODS: { key: LinePeriod; label: string; days: number }[] = [
    { key: '1d',  label: '1일',   days: 0    },
    { key: '1w',  label: '1주',   days: 7    },
    { key: '3m',  label: '3개월', days: 90   },
    { key: '1y',  label: '1년',   days: 365  },
    { key: '3y',  label: '3년',   days: 1095 },
    { key: '5y',  label: '5년',   days: 1825 },
    { key: '10y', label: '10년',  days: 3650 },
]

const CANDLE_TYPES: { key: CandleType; label: string }[] = [
    { key: 'minute', label: '분봉' },
    { key: 'day',    label: '일봉' },
    { key: 'week',   label: '주봉' },
    { key: 'month',  label: '월봉' },
]

// KST 기준 평일 장 중(09:00-15:30) 또는 시간외(16:00-18:00)인지 확인
const isChartUpdateAllowed = (): boolean => {
    const d = new Date(Date.now() + 9 * 3600 * 1000)
    const dow = d.getUTCDay()
    if (dow === 0 || dow === 6) return false
    const m = d.getUTCHours() * 60 + d.getUTCMinutes()
    return (m >= 9 * 60 && m < 15 * 60 + 30) || (m >= 16 * 60 && m < 18 * 60)
}

// "YYYY-MM-DD" → UTCTimestamp (자정 UTC)
const dateToTs = (d: string): UTCTimestamp =>
    Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000) as UTCTimestamp

// "YYYY-MM-DD HH:mm:ss" KST → UTCTimestamp
const datetimeToTs = (d: string): UTCTimestamp => {
    const iso = d.includes('T') ? d : d.replace(' ', 'T')
    return Math.floor(new Date(iso + 'Z').getTime() / 1000) as UTCTimestamp
}

export default function StockDetail() {
    const { stockId } = useParams<{ stockId: string }>()
    const navigate = useNavigate()

    const chartContainerRef = useRef<HTMLDivElement>(null)
    const chartRef = useRef<IChartApi | null>(null)
    const seriesRef = useRef<ISeriesApi<any> | null>(null)
    const socketRef = useRef<Socket | null>(null)
    const chartModeRef = useRef<ChartMode>('line')
    const linePeriodRef = useRef<LinePeriod>('1y')

    const [info, setInfo] = useState<StockInfo | null>(null)
    const [minuteCandles, setMinuteCandles] = useState<CandleBar[]>([])
    const [minuteLoaded, setMinuteLoaded] = useState(false)
    const [minuteLoading, setMinuteLoading] = useState(false)
    const [histData, setHistData] = useState<CandleBar[]>([])
    const [histLoading, setHistLoading] = useState(false)
    
    // 캐시 저장소 (KIS 히스토리 및 AI 예측 데이터 중복 호출 방지)
    const kisCache = useRef<Map<string, CandleBar[]>>(new Map())
    // 캐시 키는 예측 구간(horizon)이다. 예전에는 차트 탭(cacheKey)을 키로 썼는데,
    // 차트 기간과 예측 구간은 아무 관계가 없어서 탭을 옮길 때마다 같은 예측을
    // 다시 요청했다 — 서버 호출 한도(inferenceGuard)를 그냥 태우는 구조였다.
    const aiCache = useRef<Map<AiHorizon, AiPrediction>>(new Map())

    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)
    const [livePrice, setLivePrice] = useState<{
        price: number; change: number; changeRate: number; volume: number
    } | null>(null)

    const [chartMode, setChartMode] = useState<ChartMode>('line')
    const [linePeriod, setLinePeriod] = useState<LinePeriod>('1y')
    const [candleType, setCandleType] = useState<CandleType>('day')

    // AI 예측 상태
    const [aiHorizon, setAiHorizon] = useState<AiHorizon>('1w')
    const [aiPrediction, setAiPrediction] = useState<AiPrediction | null>(null)
    const [aiLoading, setAiLoading] = useState(false)
    const [aiError, setAiError] = useState('')

    // 초기 데이터: 종목 기본정보만 로드
    useEffect(() => {
        if (!stockId) return
        const load = async () => {
            try {
                const res = await axios.get(`${API_BASE}/api/market/stock-prices/${stockId}/detail`)
                if (!res.data.info) { setError(true); return }
                setInfo(res.data.info)
                setLivePrice({
                    price:    Number(res.data.info.price),
                    change:    Number(res.data.info.change),
                    changeRate: Number(res.data.info.changeRate),
                    volume:    Number(res.data.info.volume),
                })
            } catch {
                setError(true)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [stockId])

    // 분봉 필요 시 로드
    const needsMinute = (chartMode === 'line' && linePeriod === '1d') ||
                        (chartMode === 'candle' && candleType === 'minute')
    useEffect(() => {
        if (!needsMinute || minuteLoaded || !stockId) return
        setMinuteLoading(true)
        axios.get(`${API_BASE}/api/market/stock-prices/${stockId}/minute?interval=1`)
            .then(res => { setMinuteCandles(res.data.candles ?? []); setMinuteLoaded(true) })
            .catch(() => setMinuteLoaded(true))
            .finally(() => setMinuteLoading(false))
    }, [needsMinute, minuteLoaded, stockId])

    // KIS 히스토리 조회 및 탭 기반 AI 예측 데이터 캐싱 처리
    useEffect(() => {
        if (!stockId) return

        const kstDate = (daysOffset = 0) => {
            const d = new Date(Date.now() + 9 * 3600 * 1000)
            d.setDate(d.getDate() - daysOffset)
            return d.toISOString().slice(0, 10).replace(/-/g, '')
        }

        let periodCode: 'D' | 'W' | 'M' | null = null
        let from: string | null = null
        let cacheKey: string | null = null

        if (chartMode === 'line') {
            const map: Record<LinePeriod, { code: 'D'|'W'|'M'; days: number } | null> = {
                '1d':  null,
                '1w':  { code: 'D', days: 7    },
                '3m':  { code: 'D', days: 90   },
                '1y':  { code: 'W', days: 365  },
                '3y':  { code: 'M', days: 1095 },
                '5y':  { code: 'M', days: 1825 },
                '10y': { code: 'M', days: 3650 },
            }
            const cfg = map[linePeriod]
            if (cfg) { periodCode = cfg.code; from = kstDate(cfg.days); cacheKey = `line:${linePeriod}` }
        } else {
            if (candleType === 'day') {
                periodCode = 'D'; from = kstDate(90);  cacheKey = 'candle:day'
            } else if (candleType === 'week') {
                periodCode = 'W'; from = kstDate(180); cacheKey = 'candle:week'
            } else if (candleType === 'month') {
                periodCode = 'M'; from = kstDate(365 * 5); cacheKey = 'candle:month'
            }
        }

        if (!cacheKey) return

        // 1. KIS 히스토리 캐시 처리
        if (kisCache.current.has(cacheKey)) {
            setHistData(kisCache.current.get(cacheKey)!)
        } else if (periodCode && from) {
            setHistLoading(true)
            setHistData([])
            axios.get(`${API_BASE}/api/market/stock-prices/${stockId}/history`, {
                params: { period_code: periodCode, from, to: kstDate() },
            })
                .then(res => {
                    const candles: CandleBar[] = res.data.candles ?? []
                    kisCache.current.set(cacheKey!, candles)
                    setHistData(candles)
                })
                .catch(() => setHistData([]))
                .finally(() => setHistLoading(false))
        }

    }, [chartMode, linePeriod, candleType, stockId])

    // 종목이 바뀌면 예측 캐시를 버린다 — 캐시 키가 horizon 뿐이라 종목별로 격리해야 한다.
    useEffect(() => {
        aiCache.current.clear()
        setAiPrediction(null)
        setAiError('')
    }, [stockId])

    // AI 예측 조회 — 실제 엔드포인트(POST /api/ai/predict).
    //
    // 인증(JWT)과 추론 가드(입력 스키마·예측 대상 여부·호출 한도)를 통과해야 응답이 온다.
    // 실패했을 때 임의의 값을 지어내지 않는다 — 투자 화면에서 근거 없는 방향·확신도를
    // 보여주는 건 그 자체로 사고다. 사유를 그대로 노출하고 카드는 비워 둔다.
    useEffect(() => {
        if (!info?.code) return

        // AI 예측 비대상(ETF·리츠·펀드·예탁증서)은 아예 호출하지 않는다. 호출하면 추론
        // 가드가 UNKNOWN_CODE 로 거부하고, 그 거부는 반복 시 ADVERSARIAL_INPUT 으로
        // 승격돼 ETF 를 둘러본 정상 사용자가 이상탐지에 걸린다.
        // aiTarget 이 undefined 면 구버전 API 이므로 기존처럼 호출한다(서버가 최종 판단).
        if (info.aiTarget === 0) {
            setAiPrediction(null)
            setAiError('이 종목은 AI 예측 대상이 아닙니다. 개별 기업 재무·수급으로 학습한 모델이라 ETF·리츠·펀드에는 종목 단위 예측을 제공하지 않습니다.')
            setAiLoading(false)
            return
        }

        const cached = aiCache.current.get(aiHorizon)
        if (cached) {
            setAiPrediction(cached)
            setAiError('')
            return
        }

        let cancelled = false
        setAiLoading(true)
        setAiError('')

        axios.post(
            `${API_BASE}/api/ai/predict`,
            { code: info.code, horizon: aiHorizon },   // 서버가 이 두 필드 외에는 거부한다
            { withCredentials: true },
        )
            .then(res => {
                if (cancelled) return
                const data = res.data as AiPrediction
                aiCache.current.set(aiHorizon, data)
                setAiPrediction(data)
            })
            .catch(err => {
                if (cancelled) return
                setAiPrediction(null)
                const status = err?.response?.status
                if (status === 429) {
                    setAiError('예측 조회 한도를 초과했습니다. 잠시 후 다시 시도해주세요.')
                } else if (status === 401) {
                    setAiError('로그인이 필요한 기능입니다.')
                } else {
                    setAiError(err?.response?.data?.message ?? '예측을 불러오지 못했습니다.')
                }
            })
            .finally(() => { if (!cancelled) setAiLoading(false) })

        return () => { cancelled = true }
    }, [info?.code, info?.aiTarget, aiHorizon])

    // 차트에 그릴 데이터 계산
    const { chartItems, isMinute, isLine } = useMemo(() => {
        if (chartMode === 'line') {
            if (linePeriod === '1d') {
                return {
                    chartItems: minuteCandles.map(c => ({
                        time:  datetimeToTs(c.time),
                        value: Number(c.close),
                    })),
                    isMinute: true,
                    isLine:   true,
                }
            }
            return {
                chartItems: histData.map(c => ({ time: dateToTs(c.time), value: Number(c.close) })),
                isMinute:  false,
                isLine:    true,
            }
        }

        if (candleType === 'minute') {
            return {
                chartItems: minuteCandles.map(c => ({
                    time:  datetimeToTs(c.time),
                    open:  Number(c.open), high: Number(c.high),
                    low:   Number(c.low),  close: Number(c.close),
                })),
                isMinute: true,
                isLine:   false,
            }
        }

        return {
            chartItems: histData.map(c => ({
                time:  c.time as Time,
                open:  Number(c.open), high: Number(c.high),
                low:   Number(c.low),  close: Number(c.close),
            })),
            isMinute: false,
            isLine:   false,
        }
    }, [chartMode, linePeriod, candleType, histData, minuteCandles])

    // 차트 생성/재생성
    useEffect(() => {
        const el = chartContainerRef.current
        if (!el || chartItems.length === 0) return

        chartRef.current?.remove()
        chartRef.current = null
        seriesRef.current = null

        const chart = createChart(el, {
            autoSize: true,
            height: 380,
            layout: {
                background: { color: '#ffffff' },
                textColor: '#6b7280',
            },
            grid: {
                vertLines: { color: '#f3f4f6' },
                horzLines: { color: '#f3f4f6' },
            },
            timeScale: {
                borderColor: '#e5e7eb',
                timeVisible: isMinute,
                secondsVisible: false,
                rightOffset: 0,
                fixRightEdge: true,
                fixLeftEdge: true,
                minBarSpacing: isMinute ? 1 : 2,
            },
            rightPriceScale: { borderColor: '#e5e7eb' },
        })

        const priceFormat = { type: 'price' as const, precision: 0, minMove: 1 }

        if (isLine) {
            const series = chart.addSeries(AreaSeries, {
                lineColor: '#2ecc71',
                topColor: 'rgba(46,204,113,0.25)',
                bottomColor: 'rgba(46,204,113,0.02)',
                lineWidth: 2,
                priceFormat,
            })
            series.setData(chartItems as any)
            seriesRef.current = series
        } else {
            const series = chart.addSeries(CandlestickSeries, {
                upColor:        '#ef4444',
                downColor:       '#3b82f6',
                borderUpColor:   '#ef4444',
                borderDownColor: '#3b82f6',
                wickUpColor:     '#ef4444',
                wickDownColor:   '#3b82f6',
                priceFormat,
            })
            series.setData(chartItems as any)
            seriesRef.current = series
        }

        chartRef.current = chart

        requestAnimationFrame(() => {
            const len = chartItems.length
            if (len === 0) return

            if (isLine && !isMinute && len >= 2) {
                const first = (chartItems[0] as any).time as UTCTimestamp
                const last  = (chartItems[len - 1] as any).time as UTCTimestamp
                chart.timeScale().setVisibleRange({ from: first, to: last })
            } else if (isMinute) {
                chart.timeScale().fitContent()
            } else {
                chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: len - 0.5 })
            }
        })

        return () => {
            chart.remove()
            chartRef.current = null
            seriesRef.current = null
        }
    }, [chartItems, isMinute, isLine])

    useEffect(() => { chartModeRef.current = chartMode }, [chartMode])
    useEffect(() => { linePeriodRef.current = linePeriod }, [linePeriod])
    const candleTypeRef = useRef<CandleType>('day')
    useEffect(() => { candleTypeRef.current = candleType }, [candleType])

    useEffect(() => {
        if (!info) return
        
        const socket = io(SOCKET_URL, { withCredentials: true })
        socketRef.current = socket

        socket.on('connect', () => socket.emit('subscribe:stock', info.code))
        if (socket.connected) socket.emit('subscribe:stock', info.code)

        socket.on('stock:price', (data: {
            code: string; price: number; change: number
            changeRate: number; open: number; high: number; low: number; volume: number
        }) => {
            if (data.code !== info.code) return
            setLivePrice({ price: data.price, change: data.change, changeRate: data.changeRate, volume: data.volume })

            if (!seriesRef.current || !isChartUpdateAllowed()) return
            const mode = chartModeRef.current
            const period = linePeriodRef.current

            const kstTs = Math.floor((Date.now() + 9 * 3600 * 1000) / 1000) as any
            const todayStr = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10) as any

            if (mode === 'line') {
                const time = period === '1d' ? kstTs : Math.floor(new Date(todayStr).getTime() / 1000) as any
                seriesRef.current.update({ time, value: data.price } as any)
            } else {
                const candleMode = candleTypeRef.current
                if (candleMode === 'minute') {
                    seriesRef.current.update({
                        time: kstTs, open: data.open, high: data.high, low: data.low, close: data.price,
                    } as any)
                } else {
                    seriesRef.current.update({
                        time: todayStr, open: data.open, high: data.high, low: data.low, close: data.price,
                    } as any)
                }
            }
        })

        socket.on('order:filled', (data: any) => {
            const sideText = data.side === 'buy' ? '매수' : '매도';
            toast.success(`[체결 알림] ${data.stockCode} ${data.quantity}주 ${sideText} 완료`);
        })

        return () => {
            socket.emit('unsubscribe:stock', info.code)
            socket.off('order:filled')
            socket.disconnect()
        }
    }, [info])

    if (loading) return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#9ca3af', fontSize: '14px' }}>
            로딩 중...
        </div>
    )
    if (error || !info) return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#9ca3af', fontSize: '14px' }}>
             데이터를 불러올 수 없습니다
        </div>
    )

    const current = livePrice!
    const isUp = current.change >= 0

    const tabBtnStyle = (active: boolean): React.CSSProperties => ({
        padding: '4px 12px',
        borderRadius: '6px',
        border: 'none',
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: '700',
        backgroundColor: active ? '#fff' : 'transparent',
        color: active ? '#0f172a' : '#94a3b8',
        boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
        transition: 'all 0.15s',
    })

    return (
        <div style={{ backgroundColor: '#f8fafc', minHeight: '100vh' }}>
            {/* 헤더 */}
            <div style={{ backgroundColor: '#fff', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '20px 32px' }}>
                    <button
                        onClick={() => navigate(-1)}
                        style={{
                            display: 'inline-flex', alignItems: 'center', gap: '4px',
                            fontSize: '13px', color: '#9ca3af', background: 'none',
                            border: 'none', cursor: 'pointer', padding: '0',
                            marginBottom: '16px', fontWeight: '500',
                        }}
                    >
                        ← 목록으로
                    </button>

                    <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '16px' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
                            <span style={{ fontSize: '22px', fontWeight: '900', color: isUp ? '#ef4444' : '#3b82f6', lineHeight: 1, flexShrink: 0, marginTop: '3px' }}>
                                {isUp ? '▲' : '▼'}
                            </span>
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                                    <h1 style={{ fontSize: '22px', fontWeight: '900', color: '#0f172a', margin: 0 }}>{formatStockName(info.name)}</h1>
                                    <span style={{ fontSize: '11px', fontWeight: '700', color: '#64748b', backgroundColor: '#f1f5f9', padding: '2px 8px', borderRadius: '999px' }}>
                                        {info.type ?? info.market}
                                    </span>
                                </div>
                                <span style={{ fontSize: '13px', color: '#94a3b8', fontWeight: '500' }}>{info.code}</span>
                            </div>
                        </div>

                        <div style={{ textAlign: 'right' }}>
                            <div style={{ fontSize: '32px', fontWeight: '900', color: '#0f172a', lineHeight: 1, marginBottom: '6px' }}>
                                ₩{current.price.toLocaleString()}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' }}>
                                <span style={{ fontSize: '15px', fontWeight: '700', color: isUp ? '#ef4444' : '#3b82f6' }}>
                                    {isUp ? '▲' : '▼'} {Math.abs(current.change).toLocaleString()}
                                </span>
                                <span style={{ fontSize: '13px', fontWeight: '600', color: '#fff', backgroundColor: isUp ? '#ef4444' : '#3b82f6', padding: '2px 8px', borderRadius: '6px' }}>
                                    {isUp ? '+' : ''}{current.changeRate.toFixed(2)}%
                                </span>
                            </div>
                        </div>
                    </div>

                    <div style={{ display: 'flex', gap: '32px', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #f1f5f9' }}>
                        <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                            거래량 <span style={{ fontWeight: '700', color: '#374151', marginLeft: '4px' }}>{current.volume.toLocaleString()}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: '#22C55E', fontWeight: '600' }}>
                            <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#22C55E', display: 'inline-block', animation: 'pulse-dot 1.8s ease-in-out infinite' }} />
                            실시간
                        </div>
                    </div>
                </div>
            </div>

            {/* 메인 콘텐츠 */}
            <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '24px 32px', display: 'flex', gap: '24px', alignItems: 'flex-start' }}>
                {/* 차트 영역 */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    <div style={{ backgroundColor: '#fff', borderRadius: '20px', padding: '24px', border: '1px solid #f1f5f9', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                        {/* 차트 모드 탭 */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                            <div style={{ display: 'flex', gap: '4px', backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '3px' }}>
                                {(['line', 'candle'] as const).map(mode => (
                                    <button
                                        key={mode}
                                        onClick={() => setChartMode(mode)}
                                        style={tabBtnStyle(chartMode === mode)}
                                    >
                                        {mode === 'line' ? '선차트' : '봉차트'}
                                    </button>
                                ))}
                            </div>

                            {/* 기간/타입 탭 */}
                            <div style={{ display: 'flex', gap: '4px', backgroundColor: '#f1f5f9', borderRadius: '8px', padding: '3px' }}>
                                {chartMode === 'line'
                                    ? LINE_PERIODS.map(({ key, label }) => (
                                        <button key={key} onClick={() => setLinePeriod(key)} style={tabBtnStyle(linePeriod === key)}>
                                            {label}
                                        </button>
                                      ))
                                    : CANDLE_TYPES.map(({ key, label }) => (
                                        <button key={key} onClick={() => setCandleType(key)} style={tabBtnStyle(candleType === key)}>
                                            {label}
                                        </button>
                                      ))
                                }
                            </div>
                        </div>

                        {(minuteLoading || histLoading) && (
                            <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: '13px', padding: '60px 0' }}>로딩 중...</div>
                        )}
                        <div ref={chartContainerRef} style={{ width: '100%' }} />
                    </div>

                    {/* ★ UpTick AI 예측 카드 (요구사항 반영) ★ */}
                    <div style={{ backgroundColor: '#fff', borderRadius: '20px', padding: '20px 24px', border: '1px solid #f1f5f9', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ fontSize: '16px' }}>🤖</span>
                                <h3 style={{ fontSize: '15px', fontWeight: 'bold', color: '#0f172a', margin: 0 }}>UpTick AI 스마트 예측</h3>
                            </div>
                            {/* 예측 구간 선택 — 차트 기간과 무관하다 */}
                            <div style={{ display: 'flex', gap: '4px' }}>
                                {AI_HORIZONS.map(h => (
                                    <button
                                        key={h.key}
                                        onClick={() => setAiHorizon(h.key)}
                                        style={{
                                            padding: '3px 10px', borderRadius: '999px', fontSize: '11px', fontWeight: '700',
                                            border: '1px solid ' + (aiHorizon === h.key ? '#0f172a' : '#e2e8f0'),
                                            backgroundColor: aiHorizon === h.key ? '#0f172a' : '#fff',
                                            color: aiHorizon === h.key ? '#fff' : '#64748b',
                                            cursor: 'pointer',
                                        }}
                                    >
                                        {h.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {aiLoading ? (
                            <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: '13px', padding: '20px 0' }}>예측을 불러오는 중입니다...</div>
                        ) : aiError ? (
                            <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: '13px', padding: '20px 0' }}>{aiError}</div>
                        ) : aiPrediction?.recommended === false ? (
                            <div style={{ padding: '16px 0' }}>
                                <p style={{ fontSize: '13px', color: '#64748b', margin: '0 0 6px 0', fontWeight: '600' }}>
                                    {aiPrediction.message ?? '확신도가 낮아 예측을 제공하지 않습니다.'}
                                </p>
                                <p style={{ fontSize: '11px', color: '#cbd5e1', margin: 0 }}>{aiPrediction.disclaimer}</p>
                            </div>
                        ) : aiPrediction?.recommended ? (
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
                                    <div style={{
                                        padding: '8px 14px', borderRadius: '10px', fontWeight: '800', fontSize: '14px',
                                        backgroundColor: aiPrediction.direction === 'UP' ? '#fee2e2' : '#dbeafe',
                                        color: aiPrediction.direction === 'UP' ? '#ef4444' : '#3b82f6',
                                    }}>
                                        {aiPrediction.direction === 'UP' ? '▲ 상승 예상' : '▼ 하락 예상'}
                                    </div>
                                    <div>
                                        <p style={{ fontSize: '13px', color: '#334155', fontWeight: '600', margin: '0 0 4px 0' }}>
                                            확신도{' '}
                                            <strong style={{ color: '#0f172a' }}>
                                                {aiPrediction.confidence != null ? `${Math.round(aiPrediction.confidence * 100)}%` : '—'}
                                            </strong>
                                        </p>
                                        <p style={{ fontSize: '12px', color: '#94a3b8', margin: 0 }}>
                                            예측 구간 {AI_HORIZONS.find(h => h.key === aiHorizon)?.label}
                                            {aiPrediction.predictDate ? ` · 기준일 ${aiPrediction.predictDate}` : ''}
                                        </p>
                                    </div>
                                </div>
                                <p style={{ fontSize: '11px', color: '#cbd5e1', margin: '12px 0 0 0' }}>{aiPrediction.disclaimer}</p>
                            </div>
                        ) : null}
                    </div>
                </div>

                {/* 주문 패널 */}
                <div style={{ width: '300px', flexShrink: 0 }}>
                    <OrderPanel
                        stockId={info.id}
                        stockCode={info.code}
                        stockName={formatStockName(info.name)}
                        currentPrice={current.price}
                    />
                </div>
            </div>
        </div>
    )
}
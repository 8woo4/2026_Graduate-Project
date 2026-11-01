import { Request, Response } from 'express'
import * as tradeService from '../../services/trade/virtualTradeService'
import { getClientIp } from '../../utils/getClientIp'
import { getLocationFromIp } from '../../utils/getLocationFromIp'
import { evaluateTradeRequest, TradeAssessment } from '../../services/auth/tradeAnomalyService'
import { getOrderProof as getLedgerOrderProof } from '../../services/web3/ledgerAnchorService'
import { assertMarketOpen, getMarketSession, isMarketHoursEnforced, MarketClosedError } from '../../services/market/marketCalendar'

// 조회 계열은 요청 문맥을 서비스로 넘기지 않았다. 카나리 탐지 로그에 IP·UA 가
// 남아야 이후 위험 점수 산정(riskEngine)에서 그 IP 를 다시 식별할 수 있다.
const reqContext = (req: Request) => ({
  ip: getClientIp(req),
  userAgent: req.headers['user-agent'],
})

// ─── 거래 이상탐지 게이트 (M-1) ───────────────────────────────
// 주문 실행 직전에 무결성·이상금액을 판정한다.
//  BLOCK   : 정상 클라이언트가 만들 수 없는 주문 → 400 으로 거절
//  STEP_UP : 지갑 서명이 없으면 403 LARGE_ORDER 로 재인증 요구(기존 고액거래 흐름)
// 판정 결과를 응답으로 바꿨으면 true 를 돌려준다(호출부는 즉시 반환).
const rejectByAssessment = (res: Response, a: TradeAssessment): boolean => {
  if (a.verdict === 'BLOCK') {
    res.status(400).json({ message: a.userMessage, code: 'INVALID_ORDER' })
    return true
  }
  return false
}

// 거래 화면 자동화(S12-b) 판정용 행동 데이터. 사용자가 조작할 수 있고 로그 문구에 들어가므로
// 유한한 숫자만 통과시킨다. 형식이 틀리면 null → 해당 신호는 미평가.
const parseTradeBehavior = (raw: any): { mouseMoveCount: number; timeOnPage: number } | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw.mouseMoveCount
  const t = raw.timeOnPage
  if (typeof m !== 'number' || !Number.isFinite(m) || m < 0 || !Number.isInteger(m)) return null
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) return null
  return { mouseMoveCount: m, timeOnPage: t }
}

// ─── PIN 설정 ─────────────────────────────────────────────────

export const openAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { pin } = req.body
    if (!pin) return res.status(400).json({ message: 'PIN을 입력해주세요' })

    await tradeService.verifyPin(userId, pin, {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      email: (req as any).user?.email,
    })
    const account = await tradeService.openAccount(userId)
    res.status(201).json({
      message: '모의투자 계좌가 개설되었습니다',
      balance: Number(account.seed_balance),
    })
  } catch (err: any) {
    // code 를 함께 내려 화면이 "이미 개설됨"과 "개설 실패"를 구분하게 한다 —
    // 메시지 문구로 가르면 문구를 손볼 때마다 화면이 조용히 깨진다.
    res.status(400).json({ message: err.message, ...(err.code ? { code: err.code } : {}) })
  }
}

// ─── 계좌 리셋 ────────────────────────────────────────────────

export const resetAccount = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { pin } = req.body
    if (!pin) return res.status(400).json({ message: 'PIN을 입력해주세요' })

    await tradeService.verifyPin(userId, pin, {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      email: (req as any).user?.email,
    })
    await tradeService.resetAccount(userId)
    res.json({ message: '계좌가 초기화되었습니다' })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 매수 ─────────────────────────────────────────────────────

export const buyStock = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { stockId, stockCode, quantity, orderType, limitPrice, pin, tradeSignature, signedAmount, behaviorData } = req.body

    if (!stockId || !stockCode || !quantity || !orderType || !pin) {
      return res.status(400).json({ message: '필수 파라미터가 누락되었습니다' })
    }
    if (orderType === 'limit' && !limitPrice) {
      return res.status(400).json({ message: '지정가 주문에는 가격이 필요합니다' })
    }

    // 장 운영 시간 — PIN·이상탐지보다 먼저 본다. 장 외 주문이 PIN 시도·거래 판정 기록을 남기지 않게 한다.
    try {
      await assertMarketOpen()
    } catch (err) {
      if (err instanceof MarketClosedError) {
        return res.status(409).json({ message: err.message, code: 'MARKET_CLOSED', nextOpen: err.nextOpen.toISOString() })
      }
      throw err
    }

    const ip = getClientIp(req)
    const userAgent = req.headers['user-agent']

    // PIN 검증 결과를 기록해야 "반복 실패 후 성공"(M-5)을 판정할 수 있으므로 문맥을 넘긴다.
    await tradeService.verifyPin(userId, pin, { ip, userAgent, email: (req as any).user?.email })

    const { price, portfolioValue } = await tradeService.getOrderValuation({
      userId,
      stockId: Number(stockId),
      stockCode,
      quantity: Number(quantity),
      orderType,
      limitPrice: limitPrice != null ? Number(limitPrice) : undefined,
    })

    const assessment = await evaluateTradeRequest({
      userId, ip, userAgent, market: 'virtual', side: 'buy', stockCode,
      quantity: Number(quantity), price, portfolioValue,
      hasSignature: Boolean(tradeSignature),
      behavior: parseTradeBehavior(behaviorData),
    })
    if (rejectByAssessment(res, assessment)) return
    if (assessment.verdict === 'STEP_UP' && !tradeSignature) {
      return res.status(403).json({ message: 'LARGE_ORDER', detail: assessment.userMessage })
    }

    const location = await getLocationFromIp(ip)

    const result = await tradeService.buyStock({
      userId,
      stockId: Number(stockId),
      stockCode,
      quantity: Number(quantity),
      orderType,
      limitPrice: limitPrice ? Number(limitPrice) : undefined,
      tradeSignature,
      signedAmount: signedAmount ? BigInt(signedAmount) : undefined,
      ipAddress: ip,
      ...location,
      userAgent: req.headers['user-agent'],
    })

    const msg = orderType === 'market' ? '매수가 완료되었습니다' : '매수 지정가 주문이 접수되었습니다'
    res.json({
      message: msg,
      orderId: result.order.id,
      remainingBalance: result.remainingBalance,
    })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 매도 ─────────────────────────────────────────────────────

export const sellStock = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const { stockId, stockCode, quantity, orderType, limitPrice, pin, tradeSignature, signedAmount, behaviorData } = req.body

    if (!stockId || !stockCode || !quantity || !orderType || !pin) {
      return res.status(400).json({ message: '필수 파라미터가 누락되었습니다' })
    }
    if (orderType === 'limit' && !limitPrice) {
      return res.status(400).json({ message: '지정가 주문에는 가격이 필요합니다' })
    }

    // 장 운영 시간 — PIN·이상탐지보다 먼저 본다. 장 외 주문이 PIN 시도·거래 판정 기록을 남기지 않게 한다.
    try {
      await assertMarketOpen()
    } catch (err) {
      if (err instanceof MarketClosedError) {
        return res.status(409).json({ message: err.message, code: 'MARKET_CLOSED', nextOpen: err.nextOpen.toISOString() })
      }
      throw err
    }

    const ip = getClientIp(req)
    const userAgent = req.headers['user-agent']

    // PIN 검증 결과를 기록해야 "반복 실패 후 성공"(M-5)을 판정할 수 있으므로 문맥을 넘긴다.
    await tradeService.verifyPin(userId, pin, { ip, userAgent, email: (req as any).user?.email })

    const { price, portfolioValue } = await tradeService.getOrderValuation({
      userId,
      stockId: Number(stockId),
      stockCode,
      quantity: Number(quantity),
      orderType,
      limitPrice: limitPrice != null ? Number(limitPrice) : undefined,
    })

    const assessment = await evaluateTradeRequest({
      userId, ip, userAgent, market: 'virtual', side: 'sell', stockCode,
      quantity: Number(quantity), price, portfolioValue,
      hasSignature: Boolean(tradeSignature),
      behavior: parseTradeBehavior(behaviorData),
    })
    if (rejectByAssessment(res, assessment)) return
    if (assessment.verdict === 'STEP_UP' && !tradeSignature) {
      return res.status(403).json({ message: 'LARGE_ORDER', detail: assessment.userMessage })
    }

    const location = await getLocationFromIp(ip)

    const result = await tradeService.sellStock({
      userId,
      stockId: Number(stockId),
      stockCode,
      quantity: Number(quantity),
      orderType,
      limitPrice: limitPrice ? Number(limitPrice) : undefined,
      tradeSignature,
      signedAmount: signedAmount ? BigInt(signedAmount) : undefined,
      ipAddress: ip,
      ...location,
      userAgent: req.headers['user-agent'],
    })

    const msg = orderType === 'market' ? '매도가 완료되었습니다' : '매도 지정가 주문이 접수되었습니다'
    res.json({
      message: msg,
      orderId: result.order.id,
      remainingBalance: result.remainingBalance,
    })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 미체결 주문 조회 ─────────────────────────────────────────

export const getPendingOrders = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const orders = await tradeService.getPendingOrders(userId, reqContext(req))
    res.json(orders)
  } catch (err: any) {
    res.status(500).json({ message: err.message })
  }
}

// ─── 미체결 주문 취소 ─────────────────────────────────────────

export const cancelOrder = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const orderId = Number(req.params.orderId)
    if (!orderId) return res.status(400).json({ message: '유효하지 않은 주문 ID입니다' })

    await tradeService.cancelOrder(userId, orderId, reqContext(req))
    res.json({ message: '주문이 취소되었습니다' })
  } catch (err: any) {
    res.status(400).json({ message: err.message })
  }
}

// ─── 거래내역 조회 ────────────────────────────────────────────

export const getOrders = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const orders = await tradeService.getOrders(userId, reqContext(req))
    res.json(orders)
  } catch (err: any) {
    res.status(500).json({ message: err.message })
  }
}

// ─── 체결 장부 포함 증명 ──────────────────────────────────────
// 자기 체결 주문이 그날 고정된 장부에 들어 있다는 머클 증명. 조회 대상은 본인 주문으로 한정한다
// (getOrderProof 가 user_id 로 함께 조회 — 다른 사람 주문 번호를 넣으면 "찾을 수 없음").
export const getOrderProof = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const orderId = Number(req.params.orderId)
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: '주문 번호가 올바르지 않습니다' })
    }
    res.json(await getLedgerOrderProof(userId, orderId))
  } catch (err: any) {
    res.status(404).json({ message: err.message })
  }
}

// ─── 포트폴리오 조회 ──────────────────────────────────────────

export const getPortfolio = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id
    const portfolio = await tradeService.getPortfolio(userId, reqContext(req))
    if (!portfolio) return res.status(404).json({ message: '모의투자 계좌가 없습니다' })
    res.json(portfolio)
  } catch (err: any) {
    res.status(500).json({ message: err.message })
  }
}

// ─── 장 운영 상태 ─────────────────────────────────────────────
// 주문 화면이 장 외 시간에 주문 버튼을 막고 다음 개장 시각을 보여 주는 데 쓴다.
export const getMarketStatus = async (_req: Request, res: Response) => {
  try {
    const s = await getMarketSession()
    res.json({
      enforced: isMarketHoursEnforced(),
      state: s.state,
      open: isMarketHoursEnforced() ? s.open : true,
      hours: '09:00-15:30',
      nextOpen: s.nextOpen.toISOString(),
      todayClose: s.todayClose.toISOString(),
    })
  } catch (err: any) {
    res.status(500).json({ message: err.message })
  }
}

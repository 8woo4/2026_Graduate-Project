import bcrypt from 'bcryptjs'
import { Transaction } from 'sequelize'
import sequelize from '../../config/database'
import VirtualAccount from '../../models/trade/VirtualAccount'
import VirtualHolding from '../../models/trade/VirtualHolding'
import VirtualOrder from '../../models/trade/VirtualOrder'
import User from '../../models/user/User'
import { priceMap } from '../market/KisRealtime'
import { QueryTypes } from 'sequelize'
import { recordSeed, logTrade, getTradeNonce, verifyTradeSignature, buildTradeDescriptor, detachOnChain } from '../web3/contractService'
import Wallet from '../../models/user/Wallet'
import { TRADE_POLICY } from '../auth/tradeAnomalyService'
import { recordTradeAuthAttempt } from '../auth/anomalyService'
import { assertNotCanary } from '../security/canaryService'

// 조회 계열 함수는 원래 userId 만 받는다. 카나리 탐지 기록에 IP·UA 를 남기려면
// 호출부(컨트롤러)의 요청 문맥이 필요하므로 선택 인자로 받는다 — 기존 호출부는 그대로 동작한다.
export interface AccessContext {
  ip?: string
  userAgent?: string
}

export const INITIAL_BALANCE = 10_000_000

const FEE_RATE = 0.00015

// 이미 계좌가 있다는 사실은 클라이언트가 "실패"와 구분해야 한다 — 재시도로 들어온 요청이면
// 앞선 시도가 사실 성공한 것이므로, 화면은 다시 묻지 말고 개설 완료로 넘어가야 한다.
export class AccountExistsError extends Error {
    readonly code = 'ACCOUNT_EXISTS'
    constructor() {
        super('이미 모의투자 계좌가 존재합니다')
        this.name = 'AccountExistsError'
    }
}

// 체인 감사 기록은 사용자 응답과 무관하므로 detachOnChain 으로 떼어 보낸다.
// DB 는 이미 커밋된 뒤라 기록이 늦거나 실패해도 거래 결과는 달라지지 않는다
// (온체인 기록 누락 가능성은 논문 6.6.3 에 적어 둔 알려진 한계다).

// ─── PIN 잠금 (in-memory) ────────────────────────────────────

const PIN_MAX_FAIL = 5
const PIN_LOCK_MIN = 30

interface PinLockState { count: number; lockedUntil: Date | null }
const pinLockMap = new Map<number, PinLockState>()

export const setPin = async (userId: number, pin: string): Promise<void> => {
  if (!/^\d{6}$/.test(pin)) throw new Error('PIN은 숫자 6자리여야 합니다')
  const hash = await bcrypt.hash(pin, 10)
  await User.update({ pin_hash: hash }, { where: { id: userId } })
  pinLockMap.delete(userId)
}

/**
 * 거래 PIN 검증.
 *
 * 인메모리 잠금(pinLockMap)은 서버 재시작 시 사라지고 성공하면 지워지므로, "반복 실패
 * 후 성공"(M-5 크리덴셜 스터핑)을 판정할 근거가 남지 않는다. 그래서 시도 결과를
 * trade_auth_attempts 에 영속 기록한다. ctx 는 그 기록에 필요한 요청 문맥이다.
 * (기록은 실패해도 인증 흐름을 막지 않는다 — anomalyService 내부에서 오류를 흡수한다)
 */
export const verifyPin = async (
  userId: number,
  pin: string,
  ctx?: { ip: string; userAgent?: string; email?: string },
): Promise<void> => {
  const state = pinLockMap.get(userId)

  if (state?.lockedUntil && new Date() < state.lockedUntil) {
    const remain = Math.ceil((state.lockedUntil.getTime() - Date.now()) / 60000)
    throw new Error(`PIN이 ${PIN_MAX_FAIL}회 틀려 ${remain}분간 잠금 상태입니다`)
  }

  const user = await User.findByPk(userId)
  if (!user?.pin_hash) throw new Error('PIN이 설정되지 않았습니다')
  const ok = await bcrypt.compare(pin, user.pin_hash)

  if (ctx) {
    void recordTradeAuthAttempt({
      userId,
      method: 'PIN',
      success: ok,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      email: ctx.email ?? user.email ?? undefined,
    })
  }

  if (!ok) {
    const current = pinLockMap.get(userId) ?? { count: 0, lockedUntil: null }
    const newCount = current.count + 1
    if (newCount >= PIN_MAX_FAIL) {
      const lockedUntil = new Date(Date.now() + PIN_LOCK_MIN * 60 * 1000)
      pinLockMap.set(userId, { count: newCount, lockedUntil })
      throw new Error(`PIN 오류 ${PIN_MAX_FAIL}회 초과. ${PIN_LOCK_MIN}분간 잠금됩니다`)
    }
    pinLockMap.set(userId, { count: newCount, lockedUntil: null })
    throw new Error(`PIN이 올바르지 않습니다 (${newCount}/${PIN_MAX_FAIL})`)
  }

  pinLockMap.delete(userId)
}

export const changePin = async (userId: number, oldPin: string, newPin: string): Promise<void> => {
  await verifyPin(userId, oldPin)
  await setPin(userId, newPin)
}

// ─── 계좌 개설 ────────────────────────────────────────────────

export const openAccount = async (userId: number): Promise<VirtualAccount> => {
  const existing = await VirtualAccount.findOne({ where: { user_id: userId } })
  if (existing) throw new AccountExistsError()

  const account = await VirtualAccount.create({
    user_id: userId,
    seed_balance: INITIAL_BALANCE,
    initial_seed: INITIAL_BALANCE,
    is_active: true,
    activated_at: new Date(),
  })

  detachOnChain('recordSeed', async () => {
    const wallet = await Wallet.findOne({ where: { user_id: userId } })
    if (!wallet) return
    await recordSeed(wallet.address, BigInt(INITIAL_BALANCE))
  })

  return account
}

// ─── 계좌 리셋 ────────────────────────────────────────────────

export const resetAccount = async (userId: number): Promise<void> => {
  const t: Transaction = await sequelize.transaction()
  try {
    const account = await VirtualAccount.findOne({ where: { user_id: userId }, transaction: t, lock: true })
    if (!account) throw new Error('모의투자 계좌가 없습니다')

    // 미체결 매수 주문 예약금 환불 없이 계좌 초기화 (전액 initial_seed로 리셋)
    await VirtualOrder.update(
      { status: 'cancelled' },
      { where: { user_id: userId, status: 'pending' }, transaction: t }
    )
    await VirtualHolding.destroy({ where: { user_id: userId }, transaction: t })
    await account.update({ seed_balance: account.initial_seed }, { transaction: t })

    await t.commit()
  } catch (err) {
    await t.rollback()
    throw err
  }
}

// ─── 현재가 조회 ──────────────────────────────────────────────

const getCurrentPrice = async (stockCode: string, stockId: number): Promise<number> => {
  const cached = priceMap.get(stockCode)
  if (cached) return cached

  const rows = await sequelize.query<{ close: number }>(
    `SELECT close FROM stock_prices WHERE stock_id = :stockId ORDER BY price_date DESC LIMIT 1`,
    { replacements: { stockId }, type: QueryTypes.SELECT }
  )
  if (!rows.length) throw new Error('현재가를 조회할 수 없습니다')
  return rows[0].close
}

// ─── 포트폴리오 평가액 ────────────────────────────────────────
// 예수금 + 보유 종목 평가액. 실시간 시세가 없는 종목은 평균단가로 대체한다.
// 이상탐지(M-1)의 비율 규칙과 고액 거래 판정이 같은 값을 쓰도록 여기서만 계산한다.

export const getPortfolioValue = async (userId: number): Promise<number> => {
  const account = await VirtualAccount.findOne({ where: { user_id: userId } })
  if (!account) throw new Error('모의투자 계좌가 없습니다')

  const rows = await sequelize.query<{ code: string; quantity: number; avg_price: string }>(
    `SELECT s.code AS code, h.quantity AS quantity, h.avg_price AS avg_price
       FROM virtual_holdings h
       JOIN stocks s ON s.id = h.stock_id
      WHERE h.user_id = :userId`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  )

  let stockValue = 0
  for (const r of rows) {
    const price = priceMap.get(r.code) ?? Number(r.avg_price)
    if (Number.isFinite(price)) stockValue += price * Number(r.quantity)
  }

  const total = Number(account.seed_balance) + stockValue
  return Number.isFinite(total) ? total : 0
}

// ─── 주문 평가 (체결가·주문금액·평가액) ───────────────────────
// 시장가는 현재가를, 지정가는 지정가를 기준으로 한다. 이상탐지와 실제 체결이
// 서로 다른 가격을 보지 않도록 buyStock/sellStock 과 동일한 가격 결정 규칙을 쓴다.

export const getOrderValuation = async (params: {
  userId: number
  stockId: number
  stockCode: string
  quantity: number
  orderType: 'market' | 'limit'
  limitPrice?: number
}): Promise<{ price: number; amount: number; portfolioValue: number }> => {
  const price = params.orderType === 'market'
    ? await getCurrentPrice(params.stockCode, params.stockId)
    : Number(params.limitPrice)

  const portfolioValue = await getPortfolioValue(params.userId)
  return { price, amount: price * params.quantity, portfolioValue }
}

// ─── 고액 거래 판정 ───────────────────────────────────────────
// 포트폴리오 평가액 대비 임계 비율 초과 여부. 임계는 이상탐지 정책과 공유한다.

export const isLargeOrder = async (
  userId: number,
  tradeAmount: number,
  stockCode?: string,
  quantity?: number
): Promise<boolean> => {
  let actualAmount = tradeAmount
  if (actualAmount === 0 && stockCode && quantity) {
    const currentPrice = priceMap.get(stockCode)
    if (currentPrice) actualAmount = currentPrice * quantity
  }

  const totalPortfolio = await getPortfolioValue(userId)
  const threshold = totalPortfolio > 0 ? totalPortfolio : INITIAL_BALANCE
  return actualAmount > threshold * TRADE_POLICY.RATIO.STEP_UP
}

// ─── 고액 주문 재인증(지갑 서명) ─────────────────────────────

// 시장가 주문은 서명 시점의 화면 가격과 체결 시점의 서버 가격이 다를 수 있다.
// 사용자가 서명한 금액의 ±3% 를 넘는 차이는 가격 변동이 아니라 서명과 다른 주문으로 보고
// 다시 서명을 요구한다. 기준을 서명 금액에 두어야 상승·하락 방향 모두 같은 폭이 허용된다.
export const MARKET_SIGNED_AMOUNT_TOLERANCE = 0.03

// 서명된 금액이 서버가 계산한 실제 주문 금액과 맞는지 확인한다.
// 이전에는 클라이언트가 보낸 signedAmount 로 서명을 검증하기만 하고 실제 금액과 비교하지 않아,
// 작은 금액에 받은 서명으로 큰 주문을 통과시킬 수 있었다.
export const checkSignedAmount = (
  orderType: 'market' | 'limit',
  signedAmount: bigint | undefined,
  actualAmount: number,
): void => {
  if (signedAmount === undefined || signedAmount <= BigInt(0)) {
    throw new Error('서명한 주문 금액이 전달되지 않았습니다. 다시 서명해주세요')
  }
  const actual = BigInt(Math.round(actualAmount))
  if (orderType === 'limit') {
    if (signedAmount !== actual) throw new Error('서명한 주문 금액과 실제 주문 금액이 다릅니다. 다시 서명해주세요')
    return
  }
  const diff = signedAmount > actual ? signedAmount - actual : actual - signedAmount
  if (Number(diff) > Number(signedAmount) * MARKET_SIGNED_AMOUNT_TOLERANCE) {
    throw new Error('서명 이후 가격이 크게 변동했습니다. 다시 서명해주세요')
  }
}

// 서명을 검증하고, 검증에 쓴 거래 논스를 돌려준다(감사 기록에 같은 논스를 남기기 위함).
// 서명 대상은 서버가 직접 만든 주문 서술자다 — 수량·매수/매도·주문 유형을 클라이언트가
// 바꾸면 해시가 달라져 서명 검증이 실패한다.
export const verifyOrderSignature = async (p: {
  userId: number
  side: 'buy' | 'sell'
  stockCode: string
  orderType: 'market' | 'limit'
  quantity: number
  limitPrice?: number
  signedAmount?: bigint
  tradeSignature: string
  actualAmount: number
  ipAddress: string
  userAgent?: string
}): Promise<{ walletAddress: string; nonce: bigint }> => {
  // 지갑이 없는 계정에 서명이 붙어 오면 검증할 수 없다. 이전에는 이 경우 서명을 그냥 건너뛰어
  // 재인증이 필요한 주문이 임의 문자열 서명으로 통과했다.
  const wallet = await Wallet.findOne({ where: { user_id: p.userId, is_primary: true } })
  if (!wallet) throw new Error('지갑이 등록되지 않은 계정은 고액 주문을 할 수 없습니다')

  checkSignedAmount(p.orderType, p.signedAmount, p.actualAmount)

  const descriptor = buildTradeDescriptor({
    stockCode: p.stockCode,
    side: p.side,
    orderType: p.orderType,
    quantity: p.quantity,
    limitPrice: p.limitPrice,
  })
  const nonce = await getTradeNonce(wallet.address)
  // 고액 거래 재인증(지갑 서명)의 성공·실패도 M-5 판정 대상이다. 서명 위조를 반복하다
  // 결국 통과한 경우가 PIN 반복 실패 후 성공과 같은 성격의 신호이기 때문이다.
  try {
    await verifyTradeSignature(wallet.address, nonce, p.signedAmount!, descriptor, p.tradeSignature)
  } catch (err) {
    void recordTradeAuthAttempt({
      userId: p.userId, method: 'WALLET_SIGNATURE', success: false,
      ip: p.ipAddress, userAgent: p.userAgent,
    })
    throw err
  }
  void recordTradeAuthAttempt({
    userId: p.userId, method: 'WALLET_SIGNATURE', success: true,
    ip: p.ipAddress, userAgent: p.userAgent,
  })
  return { walletAddress: wallet.address, nonce }
}

// ─── 매수 ─────────────────────────────────────────────────────

interface BuyParams {
  userId: number
  stockId: number
  stockCode: string
  quantity: number
  orderType: 'market' | 'limit'
  limitPrice?: number
  tradeSignature?: string
  signedAmount?: bigint
  ipAddress: string
  country?: string
  region?: string
  city?: string
  userAgent?: string
}

export const buyStock = async (params: BuyParams) => {
  const SIDE = 'buy' as const
  const { userId, stockId, stockCode, quantity, orderType, limitPrice, tradeSignature, signedAmount, ipAddress, country, region, city, userAgent } = params

  await assertNotCanary({ userId, code: 'CN-01', action: '모의투자 매수', ip: ipAddress, userAgent })

  const price = orderType === 'market'
    ? await getCurrentPrice(stockCode, stockId)
    : limitPrice!

  const totalAmount = price * quantity
  const fee = Math.floor(totalAmount * FEE_RATE)
  const totalCost = totalAmount + fee

  const signed = tradeSignature
    ? await verifyOrderSignature({
        userId, side: SIDE, stockCode, orderType, quantity, limitPrice,
        signedAmount, tradeSignature, actualAmount: totalAmount, ipAddress, userAgent,
      })
    : null

  const t: Transaction = await sequelize.transaction()
  try {
    const account = await VirtualAccount.findOne({ where: { user_id: userId }, transaction: t, lock: true })
    if (!account) throw new Error('모의투자 계좌가 없습니다')
    if (Number(account.seed_balance) < totalCost) throw new Error('잔고가 부족합니다')

    // 시장가/지정가 모두 즉시 잔고 차감 (지정가는 예약금)
    await account.update({ seed_balance: Number(account.seed_balance) - totalCost }, { transaction: t })

    if (orderType === 'market') {
      // 시장가: 즉시 보유 종목 생성
      const [holding] = await VirtualHolding.findOrCreate({
        where: { user_id: userId, stock_id: stockId },
        defaults: { user_id: userId, stock_id: stockId, quantity: 0, avg_price: 0 },
        transaction: t,
      })
      const newQty = holding.quantity + quantity
      const newAvg = (Number(holding.avg_price) * holding.quantity + price * quantity) / newQty
      await holding.update({ quantity: newQty, avg_price: newAvg }, { transaction: t })
    }
    // 지정가: 보유 종목은 스케줄러가 체결 시 생성

    const order = await VirtualOrder.create({
      user_id: userId,
      stock_id: stockId,
      order_type: orderType,
      side: 'buy',
      quantity,
      price,
      total_amount: totalCost,
      status: orderType === 'market' ? 'filled' : 'pending',
      ip_address: ipAddress,
      country,
      region,
      city,
      user_agent: userAgent,
      ordered_at: new Date(),
      filled_at: orderType === 'market' ? new Date() : undefined,
    }, { transaction: t })

    await t.commit()

    if (signed) {
      detachOnChain('logTrade(buy)', () =>
        logTrade(signed.walletAddress, stockCode, 'buy', BigInt(Math.round(totalCost)), signed.nonce),
      )
    }

    return { order, remainingBalance: Number(account.seed_balance) }
  } catch (err) {
    await t.rollback()
    throw err
  }
}

// ─── 매도 ─────────────────────────────────────────────────────

interface SellParams {
  userId: number
  stockId: number
  stockCode: string
  quantity: number
  orderType: 'market' | 'limit'
  limitPrice?: number
  tradeSignature?: string
  signedAmount?: bigint
  ipAddress: string
  country?: string
  region?: string
  city?: string
  userAgent?: string
}

export const sellStock = async (params: SellParams) => {
  const SIDE = 'sell' as const
  const { userId, stockId, stockCode, quantity, orderType, limitPrice, tradeSignature, signedAmount, ipAddress, country, region, city, userAgent } = params

  await assertNotCanary({ userId, code: 'CN-02', action: '모의투자 매도', ip: ipAddress, userAgent })

  const price = orderType === 'market'
    ? await getCurrentPrice(stockCode, stockId)
    : limitPrice!

  const totalAmount = price * quantity
  const fee = Math.floor(totalAmount * FEE_RATE)
  const proceeds = totalAmount - fee

  const signed = tradeSignature
    ? await verifyOrderSignature({
        userId, side: SIDE, stockCode, orderType, quantity, limitPrice,
        signedAmount, tradeSignature, actualAmount: totalAmount, ipAddress, userAgent,
      })
    : null

  const t: Transaction = await sequelize.transaction()
  try {
    const holding = await VirtualHolding.findOne({
      where: { user_id: userId, stock_id: stockId },
      transaction: t,
      lock: true,
    })
    if (!holding) throw new Error('보유 수량이 부족합니다')

    if (orderType === 'market') {
      if (holding.quantity < quantity) throw new Error('보유 수량이 부족합니다')
    } else {
      // 지정가: 미체결 매도 수량 제외한 가용 수량 확인
      const pendingRows = await sequelize.query<{ pending: string }>(
        `SELECT COALESCE(SUM(quantity), 0) AS pending FROM virtual_orders
         WHERE user_id = :userId AND stock_id = :stockId AND side = 'sell' AND status = 'pending'`,
        { replacements: { userId, stockId }, type: QueryTypes.SELECT, transaction: t }
      )
      const pendingQty = Number(pendingRows[0]?.pending ?? 0)
      if (holding.quantity - pendingQty < quantity) {
        throw new Error('보유 수량이 부족합니다 (미체결 주문 포함)')
      }
    }

    const account = await VirtualAccount.findOne({ where: { user_id: userId }, transaction: t, lock: true })
    if (!account) throw new Error('모의투자 계좌가 없습니다')

    if (orderType === 'market') {
      const newQty = holding.quantity - quantity
      if (newQty === 0) {
        await holding.destroy({ transaction: t })
      } else {
        await holding.update({ quantity: newQty }, { transaction: t })
      }
      await account.update({ seed_balance: Number(account.seed_balance) + proceeds }, { transaction: t })
    }
    // 지정가: 보유/잔고 변경 없이 pending 주문만 생성

    const order = await VirtualOrder.create({
      user_id: userId,
      stock_id: stockId,
      order_type: orderType,
      side: 'sell',
      quantity,
      price,
      total_amount: totalAmount,
      status: orderType === 'market' ? 'filled' : 'pending',
      ip_address: ipAddress,
      country,
      region,
      city,
      user_agent: userAgent,
      ordered_at: new Date(),
      filled_at: orderType === 'market' ? new Date() : undefined,
    }, { transaction: t })

    await t.commit()

    if (signed) {
      detachOnChain('logTrade(sell)', () =>
        logTrade(signed.walletAddress, stockCode, 'sell', BigInt(Math.round(totalAmount)), signed.nonce),
      )
    }

    return {
      order,
      remainingBalance: Number(account.seed_balance) + (orderType === 'market' ? proceeds : 0),
    }
  } catch (err) {
    await t.rollback()
    throw err
  }
}

// ─── 미체결 주문 조회 ─────────────────────────────────────────

export const getPendingOrders = async (userId: number, ctx?: AccessContext) => {
  await assertNotCanary({ userId, code: 'CN-04', action: '미체결 주문 조회', ...ctx })
  return sequelize.query<{
    id: number
    side: string
    stock_name: string
    stock_code: string
    quantity: number
    price: number
    total_amount: number
    ordered_at: string
  }>(
    `SELECT vo.id, vo.side, s.name AS stock_name, s.code AS stock_code,
            vo.quantity, vo.price, vo.total_amount,
            DATE_FORMAT(vo.ordered_at, '%Y-%m-%d %H:%i') AS ordered_at
     FROM virtual_orders vo
     JOIN stocks s ON s.id = vo.stock_id
     WHERE vo.user_id = :userId AND vo.status = 'pending'
     ORDER BY vo.ordered_at DESC`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  )
}

// ─── 미체결 주문 취소 ─────────────────────────────────────────

export const cancelOrder = async (userId: number, orderId: number, ctx?: AccessContext): Promise<void> => {
  await assertNotCanary({ userId, code: 'CN-05', action: '미체결 주문 취소', ...ctx })
  const t: Transaction = await sequelize.transaction()
  try {
    const order = await VirtualOrder.findOne({
      where: { id: orderId, user_id: userId },
      transaction: t,
      lock: true,
    })
    if (!order) throw new Error('주문을 찾을 수 없습니다')
    if (order.status !== 'pending') throw new Error('미체결 주문만 취소할 수 있습니다')

    if (order.side === 'buy') {
      // 매수 예약금 환불
      const account = await VirtualAccount.findOne({ where: { user_id: userId }, transaction: t, lock: true })
      if (account) {
        await account.update(
          { seed_balance: Number(account.seed_balance) + Number(order.total_amount) },
          { transaction: t }
        )
      }
    }
    // 매도 취소: 보유 수량은 변동 없으므로 그냥 cancelled로만 변경

    // cancelled_at 기록 — 허수주문(스푸핑) 판정이 생성→취소 지연과 취소 빈도를 본다.
    await order.update({ status: 'cancelled', cancelled_at: new Date() }, { transaction: t })
    await t.commit()
  } catch (err) {
    await t.rollback()
    throw err
  }
}

// ─── 거래내역 조회 ────────────────────────────────────────────

export const getOrders = async (userId: number, ctx?: AccessContext) => {
  await assertNotCanary({ userId, code: 'CN-06', action: '모의투자 거래내역 조회', ...ctx })
  return sequelize.query<{
    id: number; side: string; order_type: string; stock_name: string; stock_code: string;
    quantity: number; price: number; total_amount: number; status: string;
    ordered_at: string; filled_at: string | null;
  }>(
    `SELECT vo.id, vo.side, vo.order_type, s.name AS stock_name, s.code AS stock_code,
            vo.quantity, vo.price, vo.total_amount, vo.status,
            DATE_FORMAT(vo.ordered_at, '%Y-%m-%d %H:%i') AS ordered_at,
            DATE_FORMAT(vo.filled_at,  '%Y-%m-%d %H:%i') AS filled_at
     FROM virtual_orders vo
     JOIN stocks s ON s.id = vo.stock_id
     WHERE vo.user_id = :userId
     ORDER BY vo.ordered_at DESC
     LIMIT 50`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  )
}

// ─── 포트폴리오 조회 ──────────────────────────────────────────

export const getPortfolio = async (userId: number, ctx?: AccessContext) => {
  await assertNotCanary({ userId, code: 'CN-03', action: '포트폴리오 조회', ...ctx })

  const account = await VirtualAccount.findOne({ where: { user_id: userId } })
  if (!account) return null

  const holdings = await sequelize.query<{
    stock_id: number
    code: string
    name: string
    quantity: number
    avg_price: number
    db_close: number
    pending_sell: number
  }>(
    `SELECT vh.stock_id, s.code, s.name, vh.quantity, vh.avg_price,
            (SELECT sp.close FROM stock_prices sp WHERE sp.stock_id = vh.stock_id ORDER BY sp.price_date DESC LIMIT 1) AS db_close,
            COALESCE((SELECT SUM(vo.quantity) FROM virtual_orders vo
                      WHERE vo.user_id = vh.user_id AND vo.stock_id = vh.stock_id
                        AND vo.side = 'sell' AND vo.status = 'pending'), 0) AS pending_sell
     FROM virtual_holdings vh
     JOIN stocks s ON s.id = vh.stock_id
     WHERE vh.user_id = :userId`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  )

  const holdingsWithPnl = holdings.map(h => {
    const currentPrice = priceMap.get(h.code) ?? Number(h.db_close) ?? Number(h.avg_price)
    const evalAmount = currentPrice * h.quantity
    const costAmount = Number(h.avg_price) * h.quantity
    const pnl = evalAmount - costAmount
    const pnlRate = costAmount > 0 ? (pnl / costAmount) * 100 : 0
    return { ...h, currentPrice, evalAmount, pnl, pnlRate }
  })

  const totalEval = holdingsWithPnl.reduce((sum, h) => sum + h.evalAmount, 0)
  const totalCost = holdingsWithPnl.reduce((sum, h) => sum + Number(h.avg_price) * h.quantity, 0)

  return {
    balance: Number(account.seed_balance),
    initialBalance: Number(account.initial_seed),
    totalEval,
    totalAsset: Number(account.seed_balance) + totalEval,
    totalPnl: totalEval - totalCost,
    totalPnlRate: totalCost > 0 ? ((totalEval - totalCost) / totalCost) * 100 : 0,
    holdings: holdingsWithPnl,
  }
}

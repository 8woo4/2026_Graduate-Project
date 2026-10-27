import { Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import sequelize from '../../config/database';
import StockPrice from '../../models/market/StockPrice';
import { collectStockPrices } from '../../schedulers/market/StockPrice';
import { priceMap, changeMap, changeRateMap, volumeMap, getRealtimeStatus } from '../../services/market/KisRealtime';
import { fetchDayCandles, upsertMinuteCandles } from '../../services/market/MinuteCandle';
import { fetchDailyPrices } from '../../services/market/StockPrice';

/**
 * [GET] 전체 종목의 최신 시세 리스트 조회
 * UI의 '국내 종목 리스트'와 '시장 필터(코스피/코스닥)'를 위한 API입니다.
 * * * 수정 사항: 
 * 1. s.market 컬럼을 추가하여 프론트엔드에서 시장별 필터링이 가능하게 함.
 */
export const getAllLatestPrices = async (_req: Request, res: Response): Promise<void> => {
    try {
        const query = `
            SELECT
                s.id,
                s.name,
                s.code,
                s.market,
                CASE
                     WHEN s.security_group = 'EF' THEN 'ETF'
                     WHEN s.security_group = 'MF' THEN '펀드'
                     WHEN s.security_group IS NOT NULL THEN s.market
                     -- security_group 이 NULL 인 행(= StockMaster 동기화 전)은 이름 꼬리로
                     -- 판정하던 기존 규칙을 그대로 쓴다. 마이그레이션만 적용된 상태에서도 분류가 끊기지 않는다.
                     WHEN s.name REGEXP '\\\\s+EF[A-Z0-9]*(\\\\s+[0-9]+)?$' THEN 'ETF'
                     WHEN s.name REGEXP '\\\\s+MF[A-Z0-9]*(\\\\s+[0-9]+)?$' THEN '펀드'
                     ELSE s.market
                END AS type,
                sp.close AS price,
                COALESCE(sp.close - sp_prev.close, 0) AS \`change\`,
                CASE WHEN COALESCE(sp_prev.close, 0) > 0
                     THEN (sp.close - sp_prev.close) / sp_prev.close * 100
                     ELSE 0 END AS changeRate,
                sp.volume
            FROM stocks s
            JOIN stock_prices sp ON s.id = sp.stock_id
            LEFT JOIN stock_prices sp_prev ON sp_prev.stock_id = s.id
                AND sp_prev.price_date = (
                    SELECT MAX(p.price_date) FROM stock_prices p
                    WHERE p.stock_id = s.id AND p.price_date < sp.price_date
                )
            WHERE sp.price_date = (
                SELECT price_date FROM stock_prices
                GROUP BY price_date
                ORDER BY COUNT(*) DESC, price_date DESC
                LIMIT 1
            )
              AND s.is_active = 1
              AND s.market IN ('KOSPI', 'KOSDAQ')
        `;

        const latestPrices = await sequelize.query(query, {
            type: QueryTypes.SELECT
        });

        // 실시간 시세가 있으면 가격/전일대비 모두 덮어씌우기
        const merged = (latestPrices as any[]).map(row => {
            const live = priceMap.get(row.code)
            if (live != null) return {
                ...row,
                price:      live,
                change:     changeMap.get(row.code)     ?? row.change,
                changeRate: changeRateMap.get(row.code) ?? row.changeRate,
                volume:     volumeMap.get(row.code)     ?? row.volume,
            }
            return row
        })

        res.json({
            success: true,
            data: merged
        });
    } catch (err) {
        console.error('[StockPrice] 전체 리스트 조회 오류:', err);
        res.status(500).json({ 
            success: false, 
            message: '전체 종목 리스트를 불러오는데 실패했습니다.' 
        });
    }
};

/**
 * [GET] 특정 종목 상세 조회 (기본 유지)
 */
export const getStockPrices = async (req: Request, res: Response): Promise<void> => {
    try {
        const { stockId } = req.params
        const { from, to } = req.query

        const where: any = { stock_id: stockId }
        if (from) where.price_date = { ...where.price_date, $gte: from }
        if (to) where.price_date = { ...where.price_date, $lte: to }

        const prices = await StockPrice.findAll({
            where,
            order: [['price_date', 'ASC']],
        })

        res.json({ success: true, data: prices })
    } catch (err) {
        console.error('[StockPrice] 조회 오류:', err)
        res.status(500).json({ success: false, message: '시세 조회 실패' })
    }
}

/**
 * [GET] 종목 기본정보만 조회 (차트 데이터는 /history 엔드포인트 사용)
 * 주소: GET /api/market/stock-prices/:stockId/detail
 */
export const getStockDetail = async (req: Request, res: Response): Promise<void> => {
    try {
        const { stockId } = req.params

        const [info] = await sequelize.query<{
            id: number; name: string; code: string; market: string; type: string;
            aiTarget: number;
            price: number; change: number; changeRate: number; volume: number;
        }>(
            `SELECT s.id, s.name, s.code, s.market,
                    CASE
                         WHEN s.security_group = 'EF' THEN 'ETF'
                         WHEN s.security_group = 'MF' THEN '펀드'
                         WHEN s.security_group IS NOT NULL THEN s.market
                         -- security_group 이 NULL 인 행(= StockMaster 동기화 전)은 이름 꼬리로
                         -- 판정하던 기존 규칙을 그대로 쓴다. 마이그레이션만 적용된 상태에서도 분류가 끊기지 않는다.
                         WHEN s.name REGEXP '\\\\s+EF[A-Z0-9]*(\\\\s+[0-9]+)?$' THEN 'ETF'
                         WHEN s.name REGEXP '\\\\s+MF[A-Z0-9]*(\\\\s+[0-9]+)?$' THEN '펀드'
                         ELSE s.market
                    END AS type,
                    sp.close AS price,
                    COALESCE(sp.close - sp_prev.close, 0) AS \`change\`,
                    CASE WHEN COALESCE(sp_prev.close, 0) > 0
                         THEN (sp.close - sp_prev.close) / sp_prev.close * 100
                         ELSE 0 END AS changeRate,
                    sp.volume,
                    -- 클라이언트가 AI 예측 비대상 종목에 /api/ai/predict 를 호출하지 않도록 내려준다.
                    -- 호출하면 추론 가드가 UNKNOWN_CODE 로 거부하고, 그 거부는 반복 시
                    -- ADVERSARIAL_INPUT 으로 승격돼 정상 사용자가 이상탐지에 걸린다.
                    s.is_ml_target AS aiTarget
             FROM stocks s
             JOIN stock_prices sp ON s.id = sp.stock_id
             LEFT JOIN stock_prices sp_prev ON sp_prev.stock_id = s.id
                 AND sp_prev.price_date = (
                     SELECT MAX(p.price_date) FROM stock_prices p
                     WHERE p.stock_id = :stockId AND p.price_date < sp.price_date
                 )
             WHERE s.id = :stockId
               AND sp.price_date = (SELECT MAX(price_date) FROM stock_prices WHERE stock_id = :stockId)`,
            { replacements: { stockId }, type: QueryTypes.SELECT }
        )

        if (!info) { res.status(404).json({ success: false, message: '종목을 찾을 수 없습니다' }); return }

        // 실시간 시세가 있으면 가격/전일대비 모두 덮어씌우기
        const live = priceMap.get(info.code)
        if (live != null) {
            info.price      = live
            info.change     = changeMap.get(info.code)     ?? info.change
            info.changeRate = changeRateMap.get(info.code) ?? info.changeRate
        }

        res.json({ success: true, info })
    } catch (err) {
        console.error('[StockPrice] 상세 조회 오류:', err)
        res.status(500).json({ success: false, message: '상세 조회 실패' })
    }
}

/**
 * [GET] KIS에서 직접 과거 캔들 조회 (D/W/M 기간 지원)
 * 주소: GET /api/market/stock-prices/:stockId/history?period_code=D|W|M&from=YYYYMMDD&to=YYYYMMDD
 */
export const getKisHistory = async (req: Request, res: Response): Promise<void> => {
    try {
        const { stockId } = req.params
        const periodDivCode = ((req.query.period_code as string) || 'D') as 'D' | 'W' | 'M'
        const from = req.query.from as string
        const todayKst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '')
        const to = (req.query.to as string) || todayKst

        if (!from) {
            res.status(400).json({ success: false, message: 'from 파라미터(YYYYMMDD) 필요' })
            return
        }

        const [stock] = await sequelize.query<{ code: string }>(
            'SELECT code FROM stocks WHERE id = :stockId',
            { replacements: { stockId }, type: QueryTypes.SELECT }
        )
        if (!stock) { res.status(404).json({ success: false, message: '종목 없음' }); return }

        const prices = await fetchDailyPrices(stock.code, from, to, periodDivCode)

        let candles = prices
            .map(p => ({
                time:   `${p.date.slice(0, 4)}-${p.date.slice(4, 6)}-${p.date.slice(6, 8)}`,
                open:   p.open,
                high:   p.high,
                low:    p.low,
                close:  p.close,
                volume: p.volume,
            }))
            .sort((a, b) => a.time.localeCompare(b.time))

        // 주봉(W) 빈 배열이면 월봉(M)으로 재시도
        if (candles.length === 0 && periodDivCode === 'W') {
            const mPrices = await fetchDailyPrices(stock.code, from, to, 'M')
            candles = mPrices
                .map(p => ({
                    time:   `${p.date.slice(0, 4)}-${p.date.slice(4, 6)}-${p.date.slice(6, 8)}`,
                    open:   p.open,
                    high:   p.high,
                    low:    p.low,
                    close:  p.close,
                    volume: p.volume,
                }))
                .sort((a, b) => a.time.localeCompare(b.time))
        }

        res.json({ success: true, candles })
    } catch (err) {
        console.error('[KisHistory] 조회 오류:', err)
        res.status(500).json({ success: false, message: 'KIS 히스토리 조회 실패' })
    }
}

/**
 * [GET] 특정 종목 분봉 조회 (오늘 or 최근 거래일)
 * 주소: GET /api/market/stock-prices/:stockId/minute?interval=1
 */
export const getMinuteCandles = async (req: Request, res: Response): Promise<void> => {
    try {
        const { stockId } = req.params
        const interval = parseInt((req.query.interval as string) ?? '1')

        // date 파라미터: YYYYMMDD 형식. 없으면 오늘(KST)
        const dateParam = req.query.date as string | undefined
        let targetDate: string   // YYYY-MM-DD (DB용)
        let targetDateKis: string // YYYYMMDD (KIS API용)
        if (dateParam) {
            const d = dateParam.replace(/-/g, '')
            targetDateKis = d
            targetDate = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`
        } else {
            const nowKst = new Date(Date.now() + 9 * 3600 * 1000)
            targetDate    = nowKst.toISOString().slice(0, 10)
            targetDateKis = targetDate.replace(/-/g, '')
        }

        // DB에 해당 날짜 데이터가 있는지 확인
        const [dateCheck] = await sequelize.query<{ cnt: number }>(
            `SELECT COUNT(*) AS cnt FROM stock_minute_candles
             WHERE stock_id = :stockId AND interval_min = :interval AND DATE(candle_time) = :targetDate`,
            { replacements: { stockId, interval, targetDate }, type: QueryTypes.SELECT }
        )

        // DB에 없으면 KIS에서 수집
        // - 오늘 + 장중: 현재 시간까지만
        // - 과거 날짜(weekday): 종가 기준 전체 수집
        if (Number(dateCheck.cnt) === 0) {
            const [stockRow] = await sequelize.query<{ code: string }>(
                `SELECT code FROM stocks WHERE id = :stockId`,
                { replacements: { stockId }, type: QueryTypes.SELECT }
            )
            if (stockRow) {
                const nowKst   = new Date(Date.now() + 9 * 3600 * 1000)
                const todayKst = nowKst.toISOString().slice(0, 10).replace(/-/g, '')
                const isToday  = targetDateKis === todayKst
                const kstHour  = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes()
                const isMarket = kstHour >= 9 * 60 && kstHour < 15 * 60 + 30

                let startHour: string | undefined
                if (isToday && isMarket) {
                    startHour = `${String(nowKst.getUTCHours()).padStart(2,'0')}${String(nowKst.getUTCMinutes()).padStart(2,'0')}00`
                }
                // 오늘(장 외) 또는 과거 날짜: startHour 없이 15:30(종가)부터 역방향 전체 수집
                const rows = await fetchDayCandles(stockRow.code, targetDateKis, startHour).catch(() => [])
                if (rows.length > 0) {
                    await upsertMinuteCandles(Number(stockId), targetDateKis, rows)
                }
            }
        }

        // 해당 날짜 분봉 반환 (date 파라미터 있을 때는 그 날짜 고정, 없으면 최근일)
        const whereDate = dateParam
            ? ':targetDate'
            : `(SELECT DATE(MAX(candle_time)) FROM stock_minute_candles WHERE stock_id = :stockId AND interval_min = :interval)`

        const candles = await sequelize.query<{
            time: string; open: number; high: number; low: number; close: number; volume: number;
        }>(
            `SELECT DATE_FORMAT(candle_time, '%Y-%m-%dT%H:%i:%S') AS time,
                    open, high, low, close, volume
             FROM stock_minute_candles
             WHERE stock_id = :stockId
               AND interval_min = :interval
               AND DATE(candle_time) = ${whereDate}
             ORDER BY candle_time ASC`,
            { replacements: { stockId, interval, targetDate }, type: QueryTypes.SELECT }
        )

        res.json({ success: true, candles })
    } catch (err) {
        console.error('[StockPrice] 분봉 조회 오류:', err)
        res.status(500).json({ success: false, message: '분봉 조회 실패' })
    }
}

/**
 * [GET] 실시간 시세 연결 상태 진단
 * 주소: GET /api/market/stock-prices/realtime-status
 */
export const getRealtimeStatusController = (_req: Request, res: Response): void => {
    res.json({ success: true, data: getRealtimeStatus() })
}

/**
 * [POST] 수동 수집 트리거 (기본 유지)
 */
export const triggerCollect = async (_req: Request, res: Response): Promise<void> => {
    try {
        collectStockPrices().catch((err) =>
            console.error('[StockPrice] 수동 수집 오류:', err)
        )
        res.json({ success: true, message: '수집 시작됨' })
    } catch (err) {
        console.error('[StockPrice] 수집 트리거 오류:', err)
        res.status(500).json({ success: false, message: '수집 트리거 실패' })
    }
}
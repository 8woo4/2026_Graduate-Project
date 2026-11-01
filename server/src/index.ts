import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import dotenv from 'dotenv'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import morgan from 'morgan'
import { connectDB } from './config/database'
import { verifyCanaryBindings } from './services/security/canaryService'
import { corsOptions, socketCorsOptions, describeCorsPolicy } from './config/cors'
import { describeCookiePolicy } from './config/cookies'
import { originGuard } from './middleware/security/originGuard'
import { initUserChannels } from './services/socket/userChannel'
import authRouter from './routes/auth/authRouter'
import contractTestRouter, { contractTestRoutesEnabled } from './routes/auth/contractTestRouter'
import honeypotRouter from './routes/security/honeypotRouter'
import { deviceIdMiddleware } from './middleware/security/deviceIdMiddleware'
import adminRouter from './routes/security/adminRouter'
import securityReportRouter from './routes/security/securityReportRouter'
import { ipBlockMiddleware } from './middleware/security/ipBlockMiddleware'
import virtualTradeRouter from './routes/trade/virtualTradeRouter'
import tradePinRouter from './routes/trade/tradePinRouter'
import realTradeRouter from './routes/trade/realTradeRouter'
import surveyRouter from './routes/user/surveyRouter'
import userRouter from './routes/user/userRouter'
import predictionRouter from './routes/ai/predictionRouter'
import communityRouter from './routes/community/communityRouter'

// 스케줄러
import stockPriceRouter from './routes/market/StockPrice'
import { startStockPriceScheduler } from './schedulers/market/StockPrice'
import { startFinancialStatementScheduler } from './schedulers/market/FinancialStatement'
import ecosIndicatorRouter from './routes/market/EcosIndicator'
import { startEcosIndicatorScheduler } from './schedulers/market/EcosIndicator'
import { startShortSellingScheduler } from './schedulers/market/ShortSelling'
import { startStock52WeekScheduler } from './schedulers/market/Stock52Week'
import { startForeignAndInstitutionalScheduler } from './schedulers/market/ForeignAndInstitutional'
import { startMarketIndexScheduler } from './schedulers/market/MarketIndex'
import { startListedSharesScheduler } from './schedulers/market/ListedShares'
import { startStockMasterScheduler } from './schedulers/market/StockMaster'
import { startMinuteCandleScheduler } from './schedulers/market/MinuteCandle'
import { startCommodityScheduler } from './schedulers/market/Commodity'
import { startStabilityScheduler } from './schedulers/market/Stability'
import { startKisRealtime } from './services/market/KisRealtime'
import { startMarketIndexRealtime } from './services/market/MarketIndexRealtime'
import { startLimitOrderScheduler } from './schedulers/trade/limitOrderScheduler'
import { startLedgerAnchorScheduler } from './schedulers/trade/ledgerAnchorScheduler'


dotenv.config()

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: socketCorsOptions })
// 개인 이벤트(체결 알림 등)를 위한 사용자별 채널 — 쿠키 JWT 로 방을 배정한다.
initUserChannels(io)
const PORT = process.env.PORT || 3000

// 미들웨어
// 커뮤니티는 이미지(data URL, 최대 1MB)를 본문에 실으므로 이 경로만 한도를 넓힌다.
// 먼저 파싱된 본문은 아래 전역 파서가 다시 읽지 않는다. (HMAC 대상이 아니라 rawBody 불필요)
app.use('/api/community', express.json({ limit: '2mb' }))
// 전역 에러 핸들러가 없어 본문이 한도를 넘으면 express 기본 HTML 오류가 나가고, 화면은 사유를
// 읽지 못해 "요청을 처리하지 못했습니다" 만 띄웠다. 이 구간만 JSON 으로 돌려준다.
app.use('/api/community', (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!err) return next()
  if (err.type === 'entity.too.large')
    return res.status(413).json({ message: '첨부 사진이 너무 큽니다. 1MB 이하 이미지를 사용해주세요' })
  if (err instanceof SyntaxError || err.type === 'entity.parse.failed')
    return res.status(400).json({ message: '잘못된 요청 형식입니다' })
  return next(err)
})
// HMAC 요청서명 검증을 위해 raw body를 보존 (서명 재계산 시 파싱 전 원본 필요)
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf.toString('utf8') } }))
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser())
app.use(morgan('dev'))
app.use(helmet())
app.set('trust proxy', true) // 이상탐지 테스트용
app.use(cors(corsOptions))

// 보안 미들웨어 — 모든 라우터보다 먼저 실행
app.use(ipBlockMiddleware)  // 인메모리 IP 차단 목록 검사
app.use(honeypotRouter)     // 허니팟 경로 탐지
// 상태 변경 요청의 출처 검사 — 교차 사이트 배포에서 SameSite=Strict 가 하던 CSRF 방어를 대체한다
app.use('/api', originGuard)
app.use('/api', deviceIdMiddleware) // 단말 식별 쿠키 — 1인 1계정 감시(다계정 단말 탐지)

// 라우터
app.use('/api/auth', authRouter)
app.use('/api/admin/security', adminRouter)
app.use('/api/security', securityReportRouter)
// 온체인 쓰기까지 하는 무인증 점검용 라우터 — 옵트인 없이는 경로 자체를 만들지 않는다
if (contractTestRoutesEnabled()) {
    console.warn('[보안] /api/test 점검용 라우터가 켜져 있다 (ENABLE_CONTRACT_TEST_ROUTES=true). 운영 환경에서는 끌 것.')
    app.use('/api/test', contractTestRouter)
}
// 거래 PIN 은 모의투자·실거래 공용이라 어느 한쪽 라우터에도 두지 않는다.
app.use('/api/trade/pin', tradePinRouter)
app.use('/api/trade/virtual', virtualTradeRouter)
app.use('/api/trade/real', realTradeRouter)
app.use('/api/survey', surveyRouter)
app.use('/api/user', userRouter)
app.use('/api/ai', predictionRouter)
app.use('/api/community', communityRouter)

// 스케줄러 라우터
app.use('/api/market/stock-prices', stockPriceRouter)
app.use('/api/market/ecos', ecosIndicatorRouter)

// DB 연결 — 카나리 바인딩은 DB 조회가 필요하므로 연결 뒤에 검증한다
connectDB().then(() => verifyCanaryBindings())

// 서버 실행
httpServer.listen(PORT, () => {
    console.log(`서버 실행 중 : http://localhost:${PORT}`)
    console.log(describeCorsPolicy())
    console.log(describeCookiePolicy())
    // ── 시장 데이터 수집 ────────────────────────────────────
    // KIS 유량은 앱키 단위로 공유되므로 KIS 수집기는 시각을 겹치지 않게 배치했다.
    // 각 스케줄러 파일의 cron 주석 참고.
    //
    // 기동 직후 1회 수집은 기본으로 꺼져 있다(RUN_INITIAL_COLLECT). 재배포·재시작이
    // 잦은 환경에서 그때마다 전종목 수집이 처음부터 도는 것을 막기 위함이다.
    //
    // 수집은 배포된 서버 한 곳에서만 돌아야 한다. 로컬에서 개발용으로 서버를 띄우면
    // 같은 크론이 두 곳에서 발화해 같은 일을 두 번 하게 되므로, 로컬 .env 에
    // DISABLE_SCHEDULERS=true 를 넣어 끈다. (.env 는 gitignore 라 배포에 안 섞인다 —
    // 소스를 주석 처리하면 커밋에 딸려가 배포 서버까지 멈춘다.)
    if (process.env.DISABLE_SCHEDULERS === 'true') {
        console.log('[Scheduler] 수집 스케줄러 전체 비활성 (DISABLE_SCHEDULERS=true)')
    } else {
        // KIS 사용 — 순차 실행
        // ⚠️ KIS 수집기 전체 일시 중단 — 로컬에서 분봉을 수동 수집하는 동안
        //    같은 앱키를 나눠 쓰면 양쪽 다 유량 초과로 실패한다.
        //    로컬 수집 + 수급 백필이 끝나면 아래 다섯 줄을 모두 되살릴 것.
        startStockPriceScheduler()            // 일봉        평일 16:00
        startShortSellingScheduler()          // 공매도      평일 16:20
        startForeignAndInstitutionalScheduler() // 수급      평일 17:50
        //startMinuteCandleScheduler()          // 분봉        평일 08:00 / 19:20
        startStockMasterScheduler()           // 종목 마스터 매주 월 06:30 (KIS 마스터파일)
        startListedSharesScheduler()          // 상장주식수  매주 월 07:00 (KIS)

        // 외부 API — KIS 와 무관
        startMarketIndexScheduler()             // 미국지수    평일 18:00 (Yahoo)
        startCommodityScheduler()               // 원자재      평일 18:00 (Yahoo)
        startEcosIndicatorScheduler()           // 거시경제    평일 18:00 (ECOS)
        startFinancialStatementScheduler()      // 재무제표    분기 1회 (DART)

        // DB 계산 — 수집이 끝난 뒤 실행
        startStock52WeekScheduler()             // 52주 신고저 평일 19:50

        // 모의투자 체결 장부 고정 — 배포 서버 한 곳에서만(로컬이 공유 DB 에 고정 기록을 남기지 않게)
        startLedgerAnchorScheduler()            // 체결 장부   매일 00:10

        startStabilityScheduler() //안정성 계산 — AI 피처에 쓰이지 않아 보류
    }

    // 실시간 시세 (온디맨드 폴링 항상 활성, 전종목 크롤링은 ENABLE_FULL_CRAWL=true 필요)
    startKisRealtime(io).catch(err => console.error('[KisRealtime] 시작 실패:', err.message))
    startMarketIndexRealtime(io)        // 코스피, 코스닥, S&P 500, NASDAQ, DOW 실시간 지수

    // 지정가 체결 스케줄러 (항상 활성)
    startLimitOrderScheduler()
})
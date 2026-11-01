import { Sequelize } from 'sequelize'
import dotenv from 'dotenv'
dotenv.config()

// 접속 정보는 DATABASE_URL 하나로만 받는다.
// 예전에는 값이 없으면 DB_HOST/DB_NAME 등으로 조용히 폴백했는데, 그 경로는 실제로
// 쓰이지 않으면서 URL 을 빠뜨렸을 때 "undefined 로 접속 시도" 라는 알아보기 어려운
// 에러만 만들었다. 설정 누락은 기동 시점에 분명한 메시지로 끝내는 편이 낫다.
const DATABASE_URL = process.env.DATABASE_URL?.trim()
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL 이 설정되지 않았습니다 — server/.env 를 확인하세요.')
}

// 레일웨이 내부 네트워크(*.railway.internal)는 컨테이너 간 사설망이라 TLS 를 제공하지
// 않는다. 공개 프록시로 붙을 때만 TLS 를 요구한다 — 내부 주소에 ssl.require 를 걸면
// 핸드셰이크 단계에서 연결 자체가 실패한다.
const DB_HOST = new URL(DATABASE_URL).hostname
const IS_INTERNAL = DB_HOST.endsWith('.railway.internal')

const sequelize = new Sequelize(DATABASE_URL, {
  dialect: 'mysql',
  logging: false,
  dialectOptions: {
    ...(IS_INTERNAL ? {} : {
      ssl: {
        require: true,
        rejectUnauthorized: false,
      },
    }),
    // Railway 프록시 경유라 최초 핸드셰이크가 4초 내외로 느리다. mysql2 기본
    // 10초로는 네트워크가 흔들릴 때 연결 자체가 끊겨 정상 요청까지 실패한다.
    connectTimeout: 60_000,
    charset: 'utf8mb4',
  },
  pool: {
    max: 10,
    // min:0 + idle:10초 였다. 10초만 놀아도 커넥션을 전부 반납하므로, 그 뒤 들어오는
    // 첫 요청이 위 주석의 "4초 내외" 핸드셰이크를 처음부터 다시 치른다. 그 한 번이
    // 네트워크가 흔들릴 때 실패하고 재시도는 따뜻한 커넥션을 타서 성공하는 것이,
    // 사용자가 겪는 "안 됐다가 다시 하면 되는" 증상의 정체다.
    // 상시 2개를 살려 두고, 아래 keepalive 로 프록시·MySQL 의 유휴 종료를 막는다.
    min: 2,
    acquire: 60_000,
    idle: 300_000,
  },
})

// 살려 둔 커넥션도 프록시나 MySQL 의 wait_timeout 이 조용히 끊을 수 있다. 끊긴 커넥션은
// 반납된 사실이 풀에 알려지지 않아 다음 요청에서 ECONNRESET 으로 터지므로, 주기적으로
// 가볍게 찔러 살아 있게 한다. 실패해도 서비스를 멈추지 않고 경고만 남긴다.
const KEEPALIVE_MS = 60_000
let keepAliveTimer: NodeJS.Timeout | null = null

const startKeepAlive = (): void => {
  if (keepAliveTimer) return
  keepAliveTimer = setInterval(() => {
    sequelize
      .query('SELECT 1')
      .catch((err) => console.warn('[DB] keepalive 실패:', (err as Error).message))
  }, KEEPALIVE_MS)
  // 타이머 때문에 프로세스가 종료되지 못하는 일이 없게 한다(검증 스크립트·CLI).
  keepAliveTimer.unref?.()
}

export const connectDB = async () => {
  try {
    await sequelize.authenticate()
    // 접속 대상을 로그로 남기되 자격 증명은 노출하지 않는다
    console.log(`DB 연결 성공 (${new URL(DATABASE_URL).host})`)
    startKeepAlive()
  } catch (error) {
    console.error('DB 연결 실패:', error)
    process.exit(1)
  }
}

export default sequelize
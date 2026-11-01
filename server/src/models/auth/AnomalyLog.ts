import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// DB 마이그레이션: src/database/migrations/20260730_anomaly_type_hmac.sql, 20260730_inference_logs.sql,
//                  20260801_anomaly_type_trade.sql, 20260826_anomaly_type_canary.sql,
//                  20260929_anomaly_type_bot_behavior.sql, 20261001_wallet_nonce_device_links.sql, 20261001_ledger_anchor.sql,
//                  20261004_anomaly_type_union.sql, 20261016_anomaly_type_privilege.sql,
//                  20261028_anomaly_type_community.sql
export type AnomalyType =
  | 'BRUTE_FORCE'
  | 'ABNORMAL_TIME'
  | 'CONCURRENT_SESSION'
  | 'ABNORMAL_COUNTRY'
  | 'HONEYPOT'
  | 'ABUSE_IP'
  | 'REQUEST_TAMPERING'  // HMAC 서명 불일치 — 요청 본문 위·변조
  | 'REPLAY_ATTACK'      // 논스 재사용·유효창 초과 — 요청 재전송
  | 'ADVERSARIAL_INPUT'  // AI 추론 입력 스키마 위반 반복
  // 배치 서빙 구조에서는 성립하지 않는 위협으로 판명되어 폐기했다(2026-08-20).
  // 기존 기록을 읽기 위해 유형만 남겨두며, 신규 기록에는 쓰지 않는다 → INFERENCE_ABUSE 사용.
  | 'MODEL_EXTRACTION'   // (폐기) AI 추론 대량·광범위 질의 — 모델 추출 의심
  | 'ABNORMAL_TRADE_AMOUNT' // 주문 무결성 위반·개인 베이스라인 대비 이상 금액
  | 'INFERENCE_ABUSE'       // AI 예측 조회 API 호출량 남용
  | 'IMPOSSIBLE_TRAVEL'        // M-4 두 접속 지점 간 이동 속도가 물리적으로 불가능
  | 'CREDENTIAL_STUFFING'      // M-5 거래 인증 반복 실패 후 성공
  | 'POST_CHANGE_TRADE'        // M-2 계정 정보 변경 직후 고액 거래
  | 'DORMANT_ACCOUNT_ACTIVITY' // M-3 장기 미사용 계정의 갑작스러운 고액 거래
  | 'TRADE_FREQUENCY_SPIKE'    // M-6 평소 대비 거래 빈도 급증
  | 'MULTI_ACCOUNT_SAME_IP'    // M-7 동일 IP 다계정 동일 종목 집중 거래
  | 'ROUND_AMOUNT_PATTERN'     // M-8 반올림 금액 반복 — 자동화 신호
  | 'ADAPTIVE_STEPUP'          // H  위험 점수로 추가 인증이 요구된 판정
  | 'CANARY_ACCESS'            // 기만 기술 — 미끼(카나리) 계좌 진입점 접근
  | 'BOT_BEHAVIOR_MOUSE'       // 로그인 폼 체류 중 마우스 이동 0회 (관측 신호)
  | 'BOT_BEHAVIOR_TYPING'      // 로그인 폼 평균 타자 간격 50ms 미만 (관측 신호)
  | 'MULTI_ACCOUNT_DEVICE'     // 1인 1계정 — 한 단말에서 여러 계정 사용·전환
  | 'LEDGER_TAMPERING'         // 체인에 고정된 일별 체결 장부와 현재 주문 기록 불일치
  | 'SPOOFING_ORDER'           // 지정가 주문 직후 즉시 취소 반복 — 허수주문(관측 신호)
  | 'WASH_TRADE'               // 단일 계정 동일 종목 양방향 반복 — 자전거래 흔적(관측 신호)
  | 'BOT_TRADE_BEHAVIOR'       // 거래 화면 자동화 — 일정 주문 간격·마우스 없는 즉시 클릭(관측 신호)
  | 'BEHAVIOR_BIOMETRIC_MISMATCH' // 행동 생체인식 — 사용자별 프로필 대비 유사도 미달(관측 신호, 토글 시 재인증)
  | 'DEVICE_FINGERPRINT_MISMATCH' // 신뢰 기기의 하드웨어 핑거프린트(캔버스·WebGL·오디오·폰트·타임존) 변화(관측 신호)
  | 'PRIVILEGE_ESCALATION'        // 일반 계정의 관리자 API 호출·관리자 화면 진입 시도
  | 'COMMUNITY_ABUSE'             // 커뮤니티 남용 — 남의 글·댓글 삭제 시도(IDOR)·이미지 위장 첨부·도배
export type AnomalyAction = 'ALERT' | 'BLOCK' | 'LOCK'

interface AnomalyLogAttributes {
  id: number
  user_id: number | null
  email: string | null
  ip: string
  user_agent: string | null
  anomaly_type: AnomalyType
  action: AnomalyAction
  detail: string
  country: string | null
  resolved: boolean
  created_at?: Date
}

interface AnomalyLogCreationAttributes
  extends Optional<AnomalyLogAttributes, 'id' | 'resolved'> {}

class AnomalyLog
  extends Model<AnomalyLogAttributes, AnomalyLogCreationAttributes>
  implements AnomalyLogAttributes
{
  public id!: number
  public user_id!: number | null
  public email!: string | null
  public ip!: string
  public user_agent!: string | null
  public anomaly_type!: AnomalyType
  public action!: AnomalyAction
  public detail!: string
  public country!: string | null
  public resolved!: boolean
  public readonly created_at!: Date
}

AnomalyLog.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.BIGINT, allowNull: true },
    email: { type: DataTypes.STRING(100), allowNull: true },
    ip: { type: DataTypes.STRING(45), allowNull: false },
    user_agent: { type: DataTypes.TEXT, allowNull: true },
    anomaly_type: {
      type: DataTypes.ENUM(
        'BRUTE_FORCE',
        'ABNORMAL_TIME',
        'CONCURRENT_SESSION',
        'ABNORMAL_COUNTRY',
        'HONEYPOT',
        'ABUSE_IP',
        'REQUEST_TAMPERING',
        'REPLAY_ATTACK',
        'ADVERSARIAL_INPUT',
        'MODEL_EXTRACTION',
        'ABNORMAL_TRADE_AMOUNT',
        'INFERENCE_ABUSE',
        'IMPOSSIBLE_TRAVEL',
        'CREDENTIAL_STUFFING',
        'POST_CHANGE_TRADE',
        'DORMANT_ACCOUNT_ACTIVITY',
        'TRADE_FREQUENCY_SPIKE',
        'MULTI_ACCOUNT_SAME_IP',
        'ROUND_AMOUNT_PATTERN',
        'ADAPTIVE_STEPUP',
        'CANARY_ACCESS',
        'BOT_BEHAVIOR_MOUSE',
        'BOT_BEHAVIOR_TYPING',
        'MULTI_ACCOUNT_DEVICE',
        'LEDGER_TAMPERING',
        'SPOOFING_ORDER',
        'WASH_TRADE',
        'BOT_TRADE_BEHAVIOR',
        'BEHAVIOR_BIOMETRIC_MISMATCH',
        'DEVICE_FINGERPRINT_MISMATCH',
        'PRIVILEGE_ESCALATION',
        'COMMUNITY_ABUSE',
      ),
      allowNull: false,
    },
    action: {
      type: DataTypes.ENUM('ALERT', 'BLOCK', 'LOCK'),
      allowNull: false,
    },
    detail: { type: DataTypes.TEXT, allowNull: false },
    country: { type: DataTypes.STRING(100), allowNull: true },
    resolved: { type: DataTypes.BOOLEAN, defaultValue: false },
    created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'anomaly_logs',
    timestamps: false,
    indexes: [
      { fields: ['user_id'] },
      { fields: ['ip'] },
      { fields: ['anomaly_type'] },
      { fields: ['created_at'] },
    ],
  },
)

export default AnomalyLog

-- 2026-10-16 : anomaly_logs.anomaly_type 에 PRIVILEGE_ESCALATION 추가
--
--   일반 계정의 관리자 API 호출(isAdmin 거부)과 관리자 화면 진입 시도(클라이언트 보고)를 기록한다.
--   MODIFY 는 목록 전체를 덮어쓰므로 20261004_anomaly_type_union.sql 의 30종 전부에 1종을 더한 합집합이다.
--   기존 값은 하나도 빠지지 않으므로 이 값을 모르는 팀원 서버(구 코드)도 그대로 동작한다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261016_anomaly_type_privilege.sql

ALTER TABLE anomaly_logs
  MODIFY COLUMN anomaly_type ENUM(
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
    'PRIVILEGE_ESCALATION'
  ) NOT NULL;

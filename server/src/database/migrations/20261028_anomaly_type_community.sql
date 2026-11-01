-- 2026-10-28 : anomaly_logs.anomaly_type 에 COMMUNITY_ABUSE 추가
--
--   커뮤니티에서 막아낸 시도를 기록한다. detail 접두어로 세 종류를 구분한다.
--     '커뮤니티 소유자 불일치 거부:'  남의 글·댓글 삭제 시도(IDOR) — 서버 판정, 위조 불가
--     '커뮤니티 이미지 위장 거부:'    SVG·MIME 불일치·크기 초과 첨부
--     '커뮤니티 도배 차단:'           레이트 리미터가 막은 쓰기 요청
--
--   MODIFY 는 목록 전체를 덮어쓰므로 20261016_anomaly_type_privilege.sql 의 31종 전부에 1종을
--   더한 합집합이다. 기존 값은 하나도 빠지지 않으므로 이 값을 모르는 팀원 서버(구 코드)도 그대로 동작한다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261028_anomaly_type_community.sql

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
    'PRIVILEGE_ESCALATION',
    'COMMUNITY_ABUSE'
  ) NOT NULL;

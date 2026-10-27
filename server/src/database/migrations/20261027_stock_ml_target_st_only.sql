-- 2026-10-27 : is_ml_target 을 주권(ST)으로 한정 (데이터 정정)
--
--   활성 3,951건 전부 is_ml_target=1 이어서 AI 조회 허용목록(inferenceSecurityService
--   .isPredictableCode)이 사실상 아무것도 걸러내지 못하는 상태였다. 허용목록의 목적은
--   임의 코드 대입으로 모델 응답 표면을 넓히는 시도를 막는 것인데, 전 종목이 통과하면
--   그 방어가 성립하지 않는다.
--
--   모델은 개별 기업의 재무·수급·감성으로 학습되므로 ETF·리츠·펀드·예탁증서에 종목
--   단위 상승 예측을 붙이는 것은 범주 오류다. 그래서 주권(ST)만 대상으로 남긴다.
--   현재 예측이 적재된 50종목은 전부 ST·활성이라 이 정정으로 빠지는 예측은 없다.
--
--   is_ml_target=1 로 되돌려야 하는 종목이 생기면 그 행만 UPDATE 하면 된다 —
--   StockMaster 주간 동기화는 기존 행의 is_ml_target 을 건드리지 않는다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261027_stock_ml_target_st_only.sql

UPDATE stocks
   SET is_ml_target = 0
 WHERE security_group IS NOT NULL
   AND security_group <> 'ST'
   AND is_ml_target = 1;

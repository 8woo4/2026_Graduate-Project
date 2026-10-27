-- 2026-10-27 : stocks 에 security_group(KIS 증권그룹구분) 추가
--
--   종목 유형(ETF·펀드) 판정이 지금은 stocks.name 끝에 섞여 들어간 KIS 내부 코드를
--   정규식으로 읽어서 이뤄진다(controllers/market/StockPrice.ts). 최초 적재가 마스터
--   파일의 고정폭 꼬리를 잘못 잘라 이름에 "ST30", "EF 00" 같은 값이 남은 결과물이고,
--   이름을 정상으로 되돌리면 그 판정이 조용히 전부 ELSE 로 빠진다.
--   그래서 유형을 이름이 아닌 전용 컬럼에서 읽도록 분리한다.
--
--   값은 KIS 마스터 파일의 증권그룹구분 2자리를 그대로 둔다.
--     ST 주권 / EF ETF / RT 리츠 / FS 외국주권 / DR 주식예탁증서
--     IF 사회간접자본투융자회사 / MF 투자회사 / EN ETN / BC 수익증권
--   NULL 은 "아직 동기화되지 않음"이며, 동기화가 한 번 돌면 채워진다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261027_stock_security_group.sql

ALTER TABLE stocks
  ADD COLUMN security_group VARCHAR(2) NULL COMMENT 'KIS 증권그룹구분 (ST/EF/RT/FS/DR/IF/MF)' AFTER market,
  ADD INDEX idx_stocks_security_group (security_group);

import sequelize from '../../config/database'
import { QueryTypes } from 'sequelize'

// ─────────────────────────────────────────────────────────────
// 마이그레이션 적용 결과 확인기 — 스키마가 실제로 바뀌었는지 DB에 직접 묻는다.
// 실행: cd server && npx ts-node src/database/migrations/verify.ts
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const t0 = Date.now()
  await sequelize.authenticate()
  console.log(`DB 연결 OK (${Date.now() - t0}ms)`)

  const [col] = await sequelize.query<{ COLUMN_TYPE: string }>(
    `SELECT COLUMN_TYPE FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'anomaly_logs' AND column_name = 'anomaly_type'`,
    { type: QueryTypes.SELECT },
  )
  const types = (col?.COLUMN_TYPE ?? '').replace(/^enum\(|\)$/g, '').split(',').map((s) => s.replace(/'/g, ''))
  console.log(`anomaly_type ENUM ${types.length}종: ${types.join(', ')}`)
  for (const required of ['ABNORMAL_TRADE_AMOUNT', 'ADVERSARIAL_INPUT', 'INFERENCE_ABUSE', 'MULTI_ACCOUNT_DEVICE', 'LEDGER_TAMPERING', 'SPOOFING_ORDER', 'WASH_TRADE', 'BOT_TRADE_BEHAVIOR', 'BEHAVIOR_BIOMETRIC_MISMATCH', 'DEVICE_FINGERPRINT_MISMATCH', 'PRIVILEGE_ESCALATION']) {
    console.log(`  ${types.includes(required) ? 'OK  ' : 'MISS'} ${required}`)
  }

  const idx = await sequelize.query<{ TABLE_NAME: string; INDEX_NAME: string; COLS: string }>(
    `SELECT table_name AS TABLE_NAME, index_name AS INDEX_NAME,
            GROUP_CONCAT(column_name ORDER BY seq_in_index) AS COLS
       FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND index_name IN ('idx_virtual_orders_user_time', 'idx_real_orders_user_time',
                           'uq_wallet_nonce_use', 'uq_device_account', 'idx_device_last_seen',
                           'uq_ledger_anchor_date')
      GROUP BY table_name, index_name`,
    { type: QueryTypes.SELECT },
  )
  console.log(`조회·유일 인덱스 ${idx.length}개 (기대 6개)`)
  for (const r of idx) console.log(`  OK   ${r.TABLE_NAME}.${r.INDEX_NAME} (${r.COLS})`)

  await sequelize.close()
}

main().catch((err) => {
  console.error('확인 실패:', err?.message ?? err)
  process.exit(1)
})

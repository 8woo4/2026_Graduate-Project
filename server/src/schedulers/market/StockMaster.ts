import cron from 'node-cron'
import { formatReport, syncStockMaster } from '../../services/market/StockMaster'
import { runInitialCollect } from '../../utils/initialCollect'

// ─── 스케줄러 등록 ────────────────────────────────────────────

export const startStockMasterScheduler = (): void => {
    // 매주 월요일 06:30 — ListedShares(07:00) 앞에 둔다. 그래야 이번 주 신규 상장 종목도
    // 같은 날 상장주식수를 받는다. 반대 순서면 신규 종목은 한 주 뒤에나 채워진다.
    cron.schedule(
        '30 6 * * 1',
        () => {
            syncStockMaster()
                .then((r) => console.log(formatReport(r)))
                .catch((err) => console.error('[StockMaster] 스케줄러 오류:', err?.message ?? err))
        },
        { timezone: 'Asia/Seoul' },
    )

    console.log('[StockMaster] 스케줄러 등록 완료 (매주 월요일 06:30 KST)')

    runInitialCollect('StockMaster', async () => {
        console.log(formatReport(await syncStockMaster()))
    })
}

// ─── CLI (서버와 분리해 단독 실행) ────────────────────────────
//   cd server && npx ts-node src/schedulers/market/StockMaster.ts --dry     → 계획만 출력(DB 쓰기 없음)
//   cd server && npx ts-node src/schedulers/market/StockMaster.ts           → 적용
//   cd server && npx ts-node src/schedulers/market/StockMaster.ts --force   → 비활성 임계를 넘겨도 적용
//   cd server && npx ts-node src/schedulers/market/StockMaster.ts --dry -v  → 변경 대상 표본까지 출력
if (require.main === module) {
    const argv = process.argv.slice(2)
    const dryRun = argv.includes('--dry')
    const force = argv.includes('--force')
    const verbose = argv.includes('-v') || argv.includes('--verbose')

    syncStockMaster({ dryRun, force })
        .then((r) => {
            console.log(formatReport(r))

            if (verbose) {
                const show = <T>(label: string, list: T[], fmt: (x: T) => string) => {
                    if (list.length === 0) return
                    console.log(`\n  ${label} (${list.length}건, 최대 20건 표시)`)
                    for (const x of list.slice(0, 20)) console.log(`    ${fmt(x)}`)
                }
                show('신규 상장', r.inserts, (m) => `${m.code} ${m.market} ${m.group} ${m.name}`)
                show('비활성(상장폐지)', r.deactivates, (d) => `${d.code} ${d.market} ${d.name}`)
                show('변경', r.updates, (u) => `${u.code} ← ${u.fields.join(', ')}`)
                show('재상장 복구', r.reactivates, (c) => c)
            }

            process.exit(r.blockedReason ? 1 : 0)
        })
        .catch((err) => {
            console.error('[StockMaster] 실패:', err?.message ?? err)
            process.exit(1)
        })
}

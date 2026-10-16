import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import { createPublicClient, createWalletClient, http, getAddress, formatEther, Hex, Address } from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { QueryTypes } from 'sequelize'

dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true } as any)

// ─────────────────────────────────────────────────────────────
// AuthVerifier · MockTrade Sepolia 재배포 + 기존 지갑 재등록
//
// 실행 (server/ 에서)
//   npx ts-node src/scripts/redeployContracts.ts                 사전 점검·가스 추정만 (쓰기 없음)
//   npx ts-node src/scripts/redeployContracts.ts --execute       배포 + 재등록
//   npx ts-node src/scripts/redeployContracts.ts --execute --auth=0x… --mock=0x…
//                                                                배포는 끝났고 재등록만 이어서 할 때
//
// 배포 계정은 반드시 SERVER_PRIVATE_KEY 다. 두 컨트랙트의 쓰기 함수가 전부 onlyOwner 이고
// 서버가 이 키로 호출하므로, 다른 계정으로 배포하면 서버의 모든 서명 검증이 revert 한다.
//
// 주소 교체(.env · 프론트 하드코딩)는 이 스크립트가 하지 않는다. 배포 결과를 확인한 뒤 사람이
// 바꾸게 해, 배포가 중간에 실패했을 때 설정만 새 주소로 넘어가 있는 상태를 만들지 않는다.
// ─────────────────────────────────────────────────────────────

const ARTIFACT_DIR = path.resolve(__dirname, '../../../contracts/artifacts/contracts')
const SERVER_ABI_DIR = path.resolve(__dirname, '../../abi')

type ContractName = 'AuthVerifier' | 'MockTrade'
const SOURCE_DIR: Record<ContractName, string> = { AuthVerifier: 'auth', MockTrade: 'trade' }

const args = process.argv.slice(2)
const EXECUTE = args.includes('--execute')
const argValue = (key: string): string | undefined =>
  args.find((a) => a.startsWith(`--${key}=`))?.split('=')[1]

const fail = (msg: string): never => {
  console.error(`중단: ${msg}`)
  process.exit(1)
}

// 서버가 읽는 ABI(server/abi)와 배포할 바이트코드가 같은 컴파일 결과인지 확인한다.
// 다르면 새 주소에 배포된 컨트랙트를 서버가 다른 함수 시그니처로 호출하게 된다.
const loadArtifact = (name: ContractName): { abi: any[]; bytecode: Hex } => {
  const file = path.join(ARTIFACT_DIR, SOURCE_DIR[name], `${name}.sol`, `${name}.json`)
  if (!fs.existsSync(file)) fail(`${file} 없음 — contracts/ 에서 npx hardhat compile --build-profile production 먼저 실행`)
  const art = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const serverAbi = JSON.parse(fs.readFileSync(path.join(SERVER_ABI_DIR, `${name}.abi.json`), 'utf-8'))
  if (JSON.stringify(art.abi) !== JSON.stringify(serverAbi)) {
    fail(`${name} 아티팩트 ABI 와 server/abi/${name}.abi.json 이 다르다 — ABI 복사 후 재실행`)
  }
  if (typeof art.bytecode !== 'string' || art.bytecode.length < 4) fail(`${name} 바이트코드 없음`)
  return { abi: art.abi, bytecode: art.bytecode as Hex }
}

const parseAddress = (raw: string | undefined, label: string): Address | undefined => {
  if (raw === undefined) return undefined
  try {
    return getAddress(raw)
  } catch {
    return fail(`${label} 주소 형식 오류: ${raw}`)
  }
}

const main = async () => {
  const { SERVER_PRIVATE_KEY, SEPOLIA_RPC_URL, CONTRACT_AUTH_ADDRESS, CONTRACT_MOCK_TRADE_ADDRESS } = process.env
  if (!SERVER_PRIVATE_KEY || !SEPOLIA_RPC_URL) fail('SERVER_PRIVATE_KEY · SEPOLIA_RPC_URL 미설정')

  const account = privateKeyToAccount(SERVER_PRIVATE_KEY as Hex)
  const publicClient = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) })
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(SEPOLIA_RPC_URL) })

  const auth = loadArtifact('AuthVerifier')
  const mock = loadArtifact('MockTrade')
  const resumeAuth = parseAddress(argValue('auth'), '--auth')
  const resumeMock = parseAddress(argValue('mock'), '--mock')
  if ((resumeAuth === undefined) !== (resumeMock === undefined)) fail('--auth 와 --mock 은 함께 지정해야 한다')

  // DB 는 모델을 거치지 않고 읽기 전용 쿼리만 쓴다. 이 스크립트가 DB 에 쓰는 일은 없다.
  const { default: sequelize } = await import('../config/database')
  const q = <T extends object>(sql: string): Promise<T[]> =>
    sequelize.query<T>(sql, { type: QueryTypes.SELECT })

  console.log('[컨트랙트 재배포] ' + (EXECUTE ? '실행 모드' : '점검 모드 (쓰기 없음)'))
  console.log(`배포 계정        : ${account.address}`)

  // ── 사전 점검 ── 주소가 바뀌면 깨지는 DB 상태가 남아 있으면 진행하지 않는다.
  // wallet_nonce_uses 는 컨트랙트 주소 없이 (지갑, 용도, 논스)로만 기록한다. 새 컨트랙트 논스는
  // 0 부터 다시 시작하므로, 남아 있는 기록과 겹쳐 해당 사용자의 로그인이 재사용 오류로 막힌다.
  const [{ c: nonceRows }] = await q<{ c: number }>('SELECT COUNT(*) c FROM wallet_nonce_uses')
  // SUBMITTED 장부는 옛 MockTrade 에 루트가 있다. 새 주소에서 읽으면 0 이라 위·변조로 오판한다.
  const [{ c: submittedAnchors }] = await q<{ c: number }>(
    "SELECT COUNT(*) c FROM ledger_anchors WHERE status = 'SUBMITTED'",
  )
  console.log(`논스 소비 기록    : ${nonceRows}행 (0 이어야 진행)`)
  console.log(`체인 고정 장부    : ${submittedAnchors}일 (0 이어야 진행)`)
  if (Number(nonceRows) > 0) fail('wallet_nonce_uses 에 기록이 있다 — 백업·정리 방침을 정한 뒤 재실행')
  if (Number(submittedAnchors) > 0) fail('옛 MockTrade 에 고정된 장부가 있다 — 이관 방침을 정한 뒤 재실행')

  // 재등록 대상: 활성 계정의 지갑만. 탈퇴 계정 지갑은 등록하지 않는다(재가입 차단 정책과 같은 기준).
  const wallets = await q<{ address: string; user_id: number }>(
    "SELECT w.address, w.user_id FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.status = 'active' ORDER BY w.user_id",
  )
  const targets = [...new Set(wallets.map((w) => getAddress(w.address)))]
  console.log(`재등록 대상 지갑  : ${targets.length}개 (활성 계정)`)

  const balance = await publicClient.getBalance({ address: account.address })
  const fees = await publicClient.estimateFeesPerGas()
  const gasAuth = await publicClient.estimateGas({ account: account.address, data: auth.bytecode })
  const gasMock = await publicClient.estimateGas({ account: account.address, data: mock.bytecode })
  // 등록 1건 가스는 새 컨트랙트가 없으면 추정할 수 없어 보수적 상한(SSTORE 1회 + 이벤트)을 쓴다.
  const GAS_PER_REGISTER = 60_000n
  const totalGas = gasAuth + gasMock + GAS_PER_REGISTER * BigInt(targets.length)
  const estCost = totalGas * fees.maxFeePerGas
  console.log(`가스 추정        : AuthVerifier ${gasAuth} · MockTrade ${gasMock} · 등록 ${targets.length}×${GAS_PER_REGISTER}`)
  console.log(`예상 비용 상한    : ${formatEther(estCost)} ETH / 잔액 ${formatEther(balance)} ETH`)
  if (balance < estCost) fail('잔액이 예상 비용 상한보다 적다 — Sepolia ETH 충전 후 재실행')

  if (!EXECUTE) {
    console.log(`현재 주소        : AuthVerifier ${CONTRACT_AUTH_ADDRESS} · MockTrade ${CONTRACT_MOCK_TRADE_ADDRESS}`)
    console.log('판정: 점검 통과 — --execute 로 실행')
    await sequelize.close()
    return
  }

  const deploy = async (name: ContractName, art: { abi: any[]; bytecode: Hex }): Promise<Address> => {
    const hash = await walletClient.deployContract({ abi: art.abi, bytecode: art.bytecode })
    console.log(`${name} 배포 전송 : ${hash}`)
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success' || !receipt.contractAddress) fail(`${name} 배포 실패 (${receipt.status})`)
    console.log(`${name} 배포 완료 : ${receipt.contractAddress} (블록 ${receipt.blockNumber}, 가스 ${receipt.gasUsed})`)
    return getAddress(receipt.contractAddress!)
  }

  const authAddress = resumeAuth ?? (await deploy('AuthVerifier', auth))
  const mockAddress = resumeMock ?? (await deploy('MockTrade', mock))

  // owner 가 서버 계정이 아니면 이후 서버의 모든 onlyOwner 호출이 revert 한다.
  for (const [name, address, abi] of [
    ['AuthVerifier', authAddress, auth.abi],
    ['MockTrade', mockAddress, mock.abi],
  ] as const) {
    const owner = (await publicClient.readContract({ address, abi, functionName: 'owner' })) as Address
    if (getAddress(owner) !== account.address) fail(`${name} owner 불일치: ${owner}`)
  }
  console.log('owner 확인       : 두 컨트랙트 모두 서버 계정')

  let registered = 0
  let skipped = 0
  for (const wallet of targets) {
    const already = await publicClient.readContract({
      address: authAddress, abi: auth.abi, functionName: 'isRegistered', args: [wallet],
    })
    if (already) {
      skipped++
      continue
    }
    const hash = await walletClient.writeContract({
      address: authAddress, abi: auth.abi, functionName: 'registerWalletFor', args: [wallet],
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') fail(`지갑 ${wallet} 등록 실패 — --auth=${authAddress} --mock=${mockAddress} 로 이어서 실행`)
    registered++
  }

  let verified = 0
  for (const wallet of targets) {
    const ok = await publicClient.readContract({
      address: authAddress, abi: auth.abi, functionName: 'isRegistered', args: [wallet],
    })
    if (ok) verified++
  }

  console.log(`지갑 재등록      : 신규 ${registered} · 기존 ${skipped} · 확인 ${verified}/${targets.length}`)
  console.log('')
  console.log('새 주소 — 아래 값으로 교체:')
  console.log(`  CONTRACT_AUTH_ADDRESS=${authAddress}`)
  console.log(`  CONTRACT_MOCK_TRADE_ADDRESS=${mockAddress}`)
  console.log(`  VITE_CONTRACT_AUTH_ADDRESS=${authAddress}   (+ Login/Register/MyPage.tsx 하드코딩)`)
  console.log(`판정: ${verified === targets.length ? 'PASS' : 'FAIL'}`)
  await sequelize.close()
  if (verified !== targets.length) process.exit(1)
}

main().catch((err) => {
  console.error('실행 실패:', err?.shortMessage ?? err?.message ?? err)
  process.exit(2)
})

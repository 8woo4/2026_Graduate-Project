import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  encodeAbiParameters,
  keccak256,
  concat,
  toBytes,
  toHex,
} from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import fs from 'fs'
import path from 'path'
import { UniqueConstraintError } from 'sequelize'
import WalletNonceUse, { NoncePurpose } from '../../models/auth/WalletNonceUse'
import type { LedgerLeafFields } from './ledgerMerkle'

// ABI 로드
//
// 원본은 저장소 루트의 contracts/abi 지만, 배포 단위는 server/ 하나다(레일웨이 Root
// Directory = server). 루트를 참조하면 컨테이너에 그 경로가 없어 모듈 로드 시점에
// ENOENT 로 죽는다. 그래서 server/abi 에 사본을 두고 그쪽을 읽는다.
// 컨트랙트를 다시 컴파일하면 contracts/abi → server/abi 로 복사해야 한다.
//
// 경로는 src(ts-node)와 dist(빌드본) 양쪽에서 같은 깊이라 그대로 통한다.
const ABI_DIR = path.join(__dirname, '../../../abi')

const loadAbi = (file: string): any => {
  const full = path.join(ABI_DIR, file)
  try {
    return JSON.parse(fs.readFileSync(full, 'utf-8'))
  } catch (err: any) {
    throw new Error(
      `컨트랙트 ABI 를 읽지 못했습니다: ${full}\n` +
      `contracts/abi 의 ${file} 을 server/abi 로 복사했는지 확인하세요. (${err.code ?? err.message})`,
    )
  }
}

const abi = loadAbi('AuthVerifier.abi.json')
const mockTradeAbi = loadAbi('MockTrade.abi.json')

const contractAddress = getAddress(process.env.CONTRACT_AUTH_ADDRESS as string)
const mockTradeAddress = getAddress(process.env.CONTRACT_MOCK_TRADE_ADDRESS as string)

const account = privateKeyToAccount(
  process.env.SERVER_PRIVATE_KEY as `0x${string}`,
)

// Public Client (읽기 전용)
const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(process.env.SEPOLIA_RPC_URL),
})

// Wallet Client (쓰기 전용)
const walletClient = createWalletClient({
  account,
  chain: sepolia,
  transport: http(process.env.SEPOLIA_RPC_URL),
})

// ─── 읽기 함수 ────────────────────────────────────────────────

// 지갑 등록 여부 확인
export const isWalletRegistered = async (
  walletAddress: string,
): Promise<boolean> => {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'isRegistered',
    args: [getAddress(walletAddress)],
  })
  return result as boolean
}

// 로그인 nonce 조회
export const getAuthNonce = async (walletAddress: string): Promise<bigint> => {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'getAuthNonce',
    args: [getAddress(walletAddress)],
  })
  return result as bigint
}

// 거래 nonce 조회
export const getTradeNonce = async (walletAddress: string): Promise<bigint> => {
  const result = await publicClient.readContract({
    address: contractAddress,
    abi,
    functionName: 'getTradeNonce',
    args: [getAddress(walletAddress)],
  })
  return result as bigint
}

// ─── 서명 메시지 생성 헬퍼 (클라이언트 서명용) ────────────────

// 로그인 서명 메시지 생성
export const buildAuthMessage = (
  walletAddress: string,
  nonce: bigint,
): `0x${string}` => {
  const innerHash = keccak256(
    concat([
      toBytes(BigInt(sepolia.id), { size: 32 }),
      toBytes(contractAddress, { size: 20 }),
      toBytes(getAddress(walletAddress), { size: 20 }),
      toBytes(nonce, { size: 32 }),
    ]),
  )
  return innerHash
}

// 회원가입 지갑 소유 증명 메시지
//
// 이전에는 가입 서명이 buildAuthMessage(지갑, 0) 과 같은 메시지였다. 가입 직후 인증 논스가
// 0 이므로 가입 때 낸 서명이 그대로 첫 로그인 서명으로도 유효했다. 용도 태그를 넣어
// 로그인 메시지와 다른 해시가 되게 하고, 가입 이메일을 묶어 다른 계정 가입에 재사용할 수 없게 한다.
export const REGISTER_DOMAIN_TAG = 'UPTICK_WALLET_REGISTRATION_V1'

export const buildRegisterMessage = (
  walletAddress: string,
  email: string,
): `0x${string}` => {
  return keccak256(
    concat([
      toBytes(BigInt(sepolia.id), { size: 32 }),
      toBytes(contractAddress, { size: 20 }),
      toBytes(getAddress(walletAddress), { size: 20 }),
      keccak256(new TextEncoder().encode(REGISTER_DOMAIN_TAG), 'bytes'),
      keccak256(new TextEncoder().encode(email.trim().toLowerCase()), 'bytes'),
    ]),
  )
}

// 거래 서명 대상 주문 서술자
//
// 배포된 컨트랙트의 거래 메시지는 (금액, 종목 코드) 두 필드뿐이라 수량·매수/매도·주문 유형이
// 서명에 들어가지 않았다. 컨트랙트를 다시 배포하지 않고 이 값들을 묶기 위해 종목 코드
// 자리에 주문 전체를 서술하는 문자열을 넣는다. 컨트랙트는 이 값을 해시 입력으로만 쓰므로
// 형식을 바꿔도 검증 로직은 그대로이고, TradeVerified 이벤트에도 주문 전체가 남는다.
export interface TradeDescriptorInput {
  stockCode: string
  side: 'buy' | 'sell'
  orderType: 'market' | 'limit'
  quantity: number
  limitPrice?: number
}

export const buildTradeDescriptor = (o: TradeDescriptorInput): string =>
  [
    o.stockCode,
    o.side,
    o.orderType,
    String(o.quantity),
    o.orderType === 'limit' ? String(o.limitPrice ?? 0) : '0',
  ].join('|')

// 거래 서명 메시지 생성
export const buildTradeMessage = (
  walletAddress: string,
  nonce: bigint,
  amount: bigint,
  stockCode: string,
): `0x${string}` => {
  return keccak256(
    concat([
      toBytes(BigInt(sepolia.id),          { size: 32 }),
      toBytes(contractAddress,             { size: 20 }),
      toBytes(getAddress(walletAddress),   { size: 20 }),
      toBytes(nonce,                       { size: 32 }),
      toBytes(amount,                      { size: 32 }),
      new TextEncoder().encode(stockCode),
    ]),
  )
}

// ─── 논스 소비 기록 ───────────────────────────────────────────
//
// 컨트랙트 논스는 검증 트랜잭션이 블록에 포함된 뒤에야 오른다. 포함을 기다리면 로그인마다
// 10초 이상이 걸리므로, 기다리는 대신 "서버가 이 논스를 소비했다"를 DB 유일 제약으로 먼저
// 확정한다. 포함 전 창에 같은 서명이 다시 들어오면 사전 실행은 통과해도 여기서 막힌다.

export class SignatureReplayError extends Error {
  constructor() {
    super('이미 사용된 서명입니다. 다시 서명해주세요.')
    this.name = 'SignatureReplayError'
  }
}

export class SignatureInFlightError extends Error {
  constructor() {
    super('직전 인증이 블록체인에 기록되는 중입니다. 잠시 후 다시 시도해주세요.')
    this.name = 'SignatureInFlightError'
  }
}

// 전송 전에 서버가 죽어 해시가 남지 않은 기록은 이 시간이 지나면 버린다.
const ORPHAN_CLAIM_MS = 2 * 60 * 1000
// 전송은 됐으나 네트워크에서 사라진 트랜잭션을 버리기까지의 시간.
const DROPPED_TX_MS = 10 * 60 * 1000
const RECEIPT_WAIT_MS = 45 * 1000

const normalize = (walletAddress: string) => getAddress(walletAddress).toLowerCase()

// 체인 조회 의존성. 검증 스크립트가 블록 포함 전·후·되돌림 상태를 재현할 수 있도록 바꿔 끼울 수 있게 둔다.
export const chainProbe = {
  getReceiptStatus: async (hash: `0x${string}`): Promise<'success' | 'reverted'> =>
    (await publicClient.getTransactionReceipt({ hash })).status,
  waitReceiptStatus: async (hash: `0x${string}`): Promise<'success' | 'reverted'> =>
    (await publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_WAIT_MS })).status,
  txExists: async (hash: `0x${string}`): Promise<boolean> => {
    try {
      await publicClient.getTransaction({ hash })
      return true
    } catch {
      return false
    }
  },
}

// 기존 소비 기록이 "실제로는 체인에서 소비되지 않은" 기록인지 판정한다.
// 체인이 기준이다 — 트랜잭션이 되돌려졌거나 사라졌다면 그 논스는 아직 유효하므로 기록을 지운다.
const isStaleClaim = async (row: WalletNonceUse): Promise<boolean> => {
  const age = Date.now() - new Date(row.created_at).getTime()
  if (!row.tx_hash) return age > ORPHAN_CLAIM_MS
  const hash = row.tx_hash as `0x${string}`
  try {
    return (await chainProbe.getReceiptStatus(hash)) === 'reverted'
  } catch {
    if (age <= DROPPED_TX_MS) return false
    return !(await chainProbe.txExists(hash))
  }
}

export const claimNonce = async (
  walletAddress: string,
  purpose: NoncePurpose,
  nonce: bigint,
): Promise<WalletNonceUse> => {
  const key = { wallet_address: normalize(walletAddress), purpose, nonce: nonce.toString() }
  try {
    return await WalletNonceUse.create(key)
  } catch (err) {
    if (!(err instanceof UniqueConstraintError)) throw err
    const existing = await WalletNonceUse.findOne({ where: key })
    if (existing && (await isStaleClaim(existing))) {
      await existing.destroy()
      return WalletNonceUse.create(key)
    }
    throw new SignatureReplayError()
  }
}

// 서명을 요청하기 직전에 쓸 논스. 같은 지갑의 직전 검증이 아직 블록에 포함되지 않았다면
// 체인은 옛 논스를 돌려주고, 그 논스로 만든 서명은 소비 기록에 막힌다. 그래서 그 경우에만
// 포함을 기다린 뒤 다시 읽는다. 빠른 재로그인 같은 드문 경우만 지연을 부담한다.
export const usableNonce = async (
  walletAddress: string,
  purpose: NoncePurpose,
  read: () => Promise<bigint>,
): Promise<bigint> => {
  const current = await read()
  const pending = await WalletNonceUse.findOne({
    where: { wallet_address: normalize(walletAddress), purpose, nonce: current.toString() },
  })
  if (!pending) return current
  if (!pending.tx_hash) throw new SignatureInFlightError()
  let status: 'success' | 'reverted'
  try {
    status = await chainProbe.waitReceiptStatus(pending.tx_hash as `0x${string}`)
  } catch {
    throw new SignatureInFlightError()
  }
  if (status === 'reverted') {
    await pending.destroy()
    return current
  }
  return read()
}

export const getUsableAuthNonce = (walletAddress: string) =>
  usableNonce(walletAddress, 'AUTH', () => getAuthNonce(walletAddress))

export const getUsableTradeNonce = (walletAddress: string) =>
  usableNonce(walletAddress, 'TRADE', () => getTradeNonce(walletAddress))

// 이 지갑이 과거에 서명 인증에 쓰인 적이 있는가 — 재등록 차단 근거.
// 컨트랙트는 등록 해제 시 논스를 0 으로 되돌리므로, 같은 지갑을 다시 등록하면
// 과거에 쓰인 0..k 번 서명이 체인 기준으로 다시 유효해진다.
export const hasNonceHistory = async (walletAddress: string): Promise<boolean> => {
  const row = await WalletNonceUse.findOne({ where: { wallet_address: normalize(walletAddress) } })
  return row !== null
}

// 사전 실행으로 검증을 마친 요청에 대해 논스를 소비 기록하고 트랜잭션을 전송한다.
export const submitVerified = async (
  walletAddress: string,
  purpose: NoncePurpose,
  nonce: bigint,
  send: () => Promise<`0x${string}`>,
): Promise<void> => {
  const claim = await claimNonce(walletAddress, purpose, nonce)
  let hash: `0x${string}`
  try {
    hash = await send()
  } catch (err) {
    // 전송 자체가 실패했다면 체인에서 논스가 소비되지 않았다. 기록을 남기면 정당한 재시도가 막힌다.
    await claim.destroy().catch(() => undefined)
    throw err
  }
  await claim.update({ tx_hash: hash }).catch((err: any) => {
    console.error('[contractService] 논스 소비 기록에 트랜잭션 해시 저장 실패:', err?.message ?? err)
  })
}

const isRevert = (e: any): boolean => {
  const msg: string = e?.message ?? ''
  return msg.includes('Invalid signature') || msg.includes('reverted') || msg.includes('Invalid nonce')
}

// ─── 쓰기 함수 ────────────────────────────────────────────────

// 서버 대리 지갑 등록 (회원가입 시)
export const registerWalletFor = async (
  walletAddress: string,
): Promise<void> => {
  const { request } = await publicClient.simulateContract({
    address: contractAddress,
    abi,
    functionName: 'registerWalletFor',
    args: [getAddress(walletAddress)],
    account,
  })
  await walletClient.writeContract(request)
}

// 서버 대리 지갑 등록 취소 (탈퇴 시)
export const unregisterWallet = async (
  walletAddress: string,
): Promise<void> => {
  const { request } = await publicClient.simulateContract({
    address: contractAddress,
    abi,
    functionName: 'unregisterWallet',
    args: [getAddress(walletAddress)],
    account,
  })
  await walletClient.writeContract(request)
}

// 로그인 2차 인증 서명 검증
//
// 사전 실행이 서명자·논스·등록 여부를 검증하고, 소비 기록이 블록 포함 전 재사용을 막는다.
export const verifySignature = async (
  walletAddress: string,
  nonce: bigint,
  signature: string,
): Promise<boolean> => {
  let request: any
  try {
    ;({ request } = await publicClient.simulateContract({
      address: contractAddress,
      abi,
      functionName: 'verifySignature',
      args: [getAddress(walletAddress), nonce, signature as `0x${string}`],
      account,
    }))
  } catch (e: any) {
    if (isRevert(e)) {
      throw new Error('MetaMask 서명이 올바르지 않습니다. 등록된 지갑 주소로 서명해주세요.')
    }
    throw e
  }
  await submitVerified(walletAddress, 'AUTH', nonce, () => walletClient.writeContract(request))
  return true
}

// 거래 서명 검증
export const verifyTradeSignature = async (
  walletAddress: string,
  nonce: bigint,
  amount: bigint,
  stockCode: string,
  signature: string,
): Promise<boolean> => {
  let request: any
  try {
    ;({ request } = await publicClient.simulateContract({
      address: contractAddress,
      abi,
      functionName: 'verifyTradeSignature',
      args: [
        getAddress(walletAddress),
        nonce,
        amount,
        stockCode,
        signature as `0x${string}`,
      ],
      account,
    }))
  } catch (e: any) {
    if (isRevert(e)) {
      throw new Error('MetaMask 서명이 올바르지 않습니다. 등록된 지갑 주소로 서명해주세요.')
    }
    throw e
  }
  await submitVerified(walletAddress, 'TRADE', nonce, () => walletClient.writeContract(request))
  return true
}

export const signMessage = async (
  message: `0x${string}`,
): Promise<`0x${string}`> => {
  const signature = await walletClient.signMessage({
    message: { raw: message },
  })
  return signature
}

// ─── MockTrade: 버짓 지급 기록 ────────────────────────────────

export const recordSeed = async (
  walletAddress: string,
  amount: bigint,
): Promise<void> => {
  const { request } = await publicClient.simulateContract({
    address: mockTradeAddress,
    abi: mockTradeAbi,
    functionName: 'recordSeed',
    args: [getAddress(walletAddress), amount],
    account,
  })
  await walletClient.writeContract(request)
}

/**
 * 체인 호출을 요청 처리에서 떼어 낸다.
 *
 * 감사 기록·등록 해제처럼 사용자 응답의 내용을 바꾸지 않는 호출을 await 하면, 응답이
 * Sepolia RPC 왕복(simulate+write)만큼 늦어진다. RPC 가 느릴 때는 viem 기본값
 * (타임아웃 10초 × 재시도 3회)으로 수십 초까지 밀려 화면이 멈춘 것처럼 보인다.
 * 더 나쁜 것은 await 한 호출이 던지면 그 앞의 DB 작업까지 실패로 되돌려 보낸다는 점이다.
 * 그래서 DB 를 확정한 뒤 체인 호출은 분리해 보내고, 실패는 로그로만 남긴다.
 */
export const detachOnChain = (label: string, run: () => Promise<unknown>): void => {
  void (async () => {
    try {
      await run()
    } catch (err) {
      console.error(`[Chain] ${label} 실패:`, (err as Error).message)
    }
  })()
}

// ─── MockTrade: 고액 거래 감사 로그 ──────────────────────────

export const logTrade = async (
  walletAddress: string,
  stockCode: string,
  side: 'buy' | 'sell',
  amount: bigint,
  tradeNonce: bigint,
): Promise<void> => {
  const { request } = await publicClient.simulateContract({
    address: mockTradeAddress,
    abi: mockTradeAbi,
    functionName: 'logTrade',
    args: [getAddress(walletAddress), stockCode, side, amount, tradeNonce],
    account,
  })
  await walletClient.writeContract(request)
}

// ─── MockTrade: 일별 체결 장부 고정 ───────────────────────────
// 현재 Sepolia 배포본에는 이 함수들이 없다. 재배포 전까지 호출부(ledgerAnchorService)는
// LEDGER_ANCHOR_ON_CHAIN=true 일 때만 이 경로를 탄다.

export const anchorLedgerOnChain = async (
  day: number,
  root: `0x${string}`,
  count: number,
): Promise<`0x${string}`> => {
  const { request } = await publicClient.simulateContract({
    address: mockTradeAddress,
    abi: mockTradeAbi,
    functionName: 'anchorLedger',
    args: [day, root, count],
    account,
  })
  return walletClient.writeContract(request)
}

export const getLedgerRootOnChain = async (day: number): Promise<`0x${string}`> => {
  const result = await publicClient.readContract({
    address: mockTradeAddress,
    abi: mockTradeAbi,
    functionName: 'ledgerRoots',
    args: [day],
  })
  return result as `0x${string}`
}

export const verifyInclusionOnChain = async (
  day: number,
  order: LedgerLeafFields,
  proof: `0x${string}`[],
): Promise<boolean> => {
  const result = await publicClient.readContract({
    address: mockTradeAddress,
    abi: mockTradeAbi,
    functionName: 'verifyOrderInclusion',
    args: [day, order, proof],
  })
  return result as boolean
}

export const MOCK_TRADE_ADDRESS = mockTradeAddress

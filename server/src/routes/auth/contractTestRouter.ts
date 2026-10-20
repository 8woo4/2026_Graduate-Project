import { Router, Request, Response } from 'express'
import * as contractService from '../../services/web3/contractService'

const router = Router()

// ─────────────────────────────────────────────────────────────
// 이 라우터는 인증이 없고 서버 owner 키로 온체인 쓰기까지 한다
// (register·unregister·서명 생성). 즉 공개되면 아무나 남의 지갑을
// 등록 해제해 로그인을 영구히 막을 수 있다.
//
// 기존 가드는 `NODE_ENV !== 'development'` 하나였고, 배포 환경변수가
// development 로 떠 있던 탓에 공개 인터넷에서 전부 호출 가능했다.
// 환경변수 하나가 틀리면 열리는 구조라 **명시적 옵트인**을 추가한다 —
// ENABLE_CONTRACT_TEST_ROUTES=true 를 직접 켜지 않는 한 어떤 환경에서도 닫힌다.
// 운영 모드에서는 옵트인이 있어도 열지 않는다(index.ts 가 마운트 자체를 하지 않는다).
// ─────────────────────────────────────────────────────────────
export const contractTestRoutesEnabled = (): boolean =>
  process.env.NODE_ENV !== 'production' &&
  process.env.ENABLE_CONTRACT_TEST_ROUTES === 'true'

router.use((req, res, next) => {
  if (!contractTestRoutesEnabled()) {
    return res.status(404).json({ message: 'Not found' })
  }
  next()
})

router.get('/is-registered/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string
    const result = await contractService.isWalletRegistered(address)
    return res.status(200).json({ isRegistered: result })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})

router.get('/nonce/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string
    const result = await contractService.getAuthNonce(address)
    return res.status(200).json({ nonce: result.toString() })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})

router.get('/trade-nonce/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string
    const result = await contractService.getTradeNonce(address)
    return res.status(200).json({ tradeNonce: result.toString() })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})

router.post('/register/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string
    await contractService.registerWalletFor(address)
    return res.status(200).json({ message: '온체인 등록 완료' })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})

router.delete('/unregister/:address', async (req: Request, res: Response) => {
  try {
    const address = req.params.address as string
    await contractService.unregisterWallet(address)
    return res.status(200).json({ message: '온체인 등록 취소 완료' })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})
router.post('/sign-auth', async (req: Request, res: Response) => {
  try {
    const { walletAddress } = req.body
    const message = contractService.buildAuthMessage(
      walletAddress as `0x${string}`,
      BigInt(0),
    )
    const signature = await contractService.signMessage(message)
    return res.status(200).json({ message, signature })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})
router.post('/sign-with-key', async (req: Request, res: Response) => {
  try {
    const { privateKey, walletAddress, nonce } = req.body
    const { privateKeyToAccount } = await import('viem/accounts')
    const { createWalletClient, http } = await import('viem')
    const { sepolia } = await import('viem/chains')
    const { buildAuthMessage } =
      await import('../../services/web3/contractService')

    const testAccount = privateKeyToAccount(privateKey as `0x${string}`)
    const testClient = createWalletClient({
      account: testAccount,
      chain: sepolia,
      transport: http(process.env.SEPOLIA_RPC_URL),
    })

    const message = buildAuthMessage(walletAddress, BigInt(nonce))
    const signature = await testClient.signMessage({
      message: { raw: message },
    })

    return res.status(200).json({ signature })
  } catch (error: any) {
    return res.status(500).json({ message: error.message })
  }
})
export default router

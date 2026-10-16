import { Router, Request, Response } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import { recordPrivilegeEscalation, sanitizeReportedPath } from '../../services/auth/privilegeEscalationService'
import { getClientIp } from '../../utils/getClientIp'

// 클라이언트 보안 보고 — 화면 가드처럼 서버를 거치지 않는 거부를 기록하기 위한 수신점.
// 보고는 클라이언트가 보내므로 공격자가 끄거나 꾸밀 수 있다. 그래서 로그인 사용자 본인 명의로만
// 받고(남의 이름으로 보고 불가), 결과는 항상 204 로 같게 돌려 기록 여부·중복 창을 드러내지 않는다.

const router = Router()

router.post('/admin-route-denied', isAuthenticated, (req: Request, res: Response) => {
  const user = (req as any).user
  if (user.role !== 'admin') {
    void recordPrivilegeEscalation({
      userId: Number(user.id),
      email: user.email ?? null,
      role: String(user.role),
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
      source: 'CLIENT_ROUTE',
      method: 'GET',
      path: sanitizeReportedPath(req.body?.path),
    }).catch(() => undefined)
  }
  res.status(204).end()
})

export default router

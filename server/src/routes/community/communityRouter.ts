import { Router } from 'express'
import { isAuthenticated } from '../../middleware/auth/authMiddleware'
import { communityViewRateLimiter, communityWriteRateLimiter } from '../../middleware/auth/rateLimitMiddleware'
import * as ctrl from '../../controllers/community/communityController'

const router = Router()

// 이미지는 <img> 태그가 직접 받는다. 교차 사이트 배포에서는 서드파티 쿠키 차단으로 인증 쿠키가
// 실리지 않을 수 있어 인증 없이 제공한다 — 게시판 공개 이미지이고, 형식은 저장·제공 시 모두 검증한다.
router.get('/images/posts/:id', ctrl.getPostImage)
router.get('/images/comments/:id', ctrl.getCommentImage)

router.use(isAuthenticated)

router.get('/posts', ctrl.listPosts)                                                    // 목록
router.get('/posts/:id', ctrl.getPost)                                                  // 상세(댓글 포함)
router.post('/posts/:id/view', communityViewRateLimiter, ctrl.addView)                  // 조회수(1인 1회)
router.post('/posts', communityWriteRateLimiter, ctrl.createPost)                       // 작성
router.delete('/posts/:id', communityWriteRateLimiter, ctrl.deletePost)                 // 삭제(작성자·관리자)
router.post('/posts/:id/like', communityWriteRateLimiter, ctrl.likePost)                // 추천(1인 1회)
router.post('/posts/:id/comments', communityWriteRateLimiter, ctrl.createComment)       // 댓글·대댓글
router.delete('/comments/:commentId', communityWriteRateLimiter, ctrl.deleteComment)    // 댓글 삭제(작성자·관리자)

export default router

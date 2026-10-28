import { Request, Response } from 'express'
import * as service from '../../services/community/communityService'
import {
  CommunityError,
  parseId,
  validateCommentInput,
  validatePostInput,
} from '../../services/community/communityValidation'

type Handler = (req: Request, res: Response) => Promise<unknown>

// 서비스가 던진 CommunityError 는 그 상태 코드로, 나머지는 내부 메시지를 숨기고 500 으로 응답한다
const handle = (fn: Handler) => async (req: Request, res: Response) => {
  try {
    await fn(req, res)
  } catch (err) {
    if (err instanceof CommunityError) return res.status(err.status).json({ message: err.message })
    console.error('[Community] 처리 오류:', (err as Error)?.message ?? err)
    return res.status(500).json({ message: '요청을 처리하지 못했습니다' })
  }
}

const actorOf = (req: Request) => (req as any).user

export const listPosts = handle(async (req, res) => {
  res.json(await service.listPosts(actorOf(req)))
})

export const getPost = handle(async (req, res) => {
  res.json(await service.getPost(actorOf(req), parseId(req.params.id)))
})

export const createPost = handle(async (req, res) => {
  res.status(201).json(await service.createPost(actorOf(req), validatePostInput(req.body)))
})

export const deletePost = handle(async (req, res) => {
  await service.deletePost(actorOf(req), parseId(req.params.id))
  res.status(204).end()
})

export const addView = handle(async (req, res) => {
  await service.addView(parseId(req.params.id))
  res.status(204).end()
})

export const likePost = handle(async (req, res) => {
  res.json(await service.likePost(actorOf(req), parseId(req.params.id)))
})

export const createComment = handle(async (req, res) => {
  const postId = parseId(req.params.id)
  res.status(201).json(await service.createComment(actorOf(req), postId, validateCommentInput(req.body)))
})

export const deleteComment = handle(async (req, res) => {
  await service.deleteComment(actorOf(req), parseId(req.params.commentId))
  res.status(204).end()
})

// 이미지는 검증된 형식만, 다른 콘텐츠로 해석되지 않도록 nosniff·CSP 를 붙여 내보낸다
const sendImage = (kind: 'posts' | 'comments') =>
  handle(async (req, res) => {
    const { mime, data } = await service.getImage(kind, parseId(req.params.id))
    res.set({
      'Content-Type': mime,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      // helmet 기본값(same-origin)이면 다른 도메인에 배포된 화면(Vercel)이 <img> 로 불러오지 못한다
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'private, max-age=300',
    })
    res.send(data)
  })

export const getPostImage = sendImage('posts')
export const getCommentImage = sendImage('comments')

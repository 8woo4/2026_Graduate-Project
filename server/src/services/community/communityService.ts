import { literal, UniqueConstraintError } from 'sequelize'
import sequelize from '../../config/database'
import Post from '../../models/community/Post'
import Comment from '../../models/community/Comment'
import PostLike from '../../models/community/PostLike'
import { CommunityError, CommentInput, PostInput, decodeImage } from './communityValidation'

// ─────────────────────────────────────────────────────────────
// 커뮤니티 서비스
//
// 소유자 판정은 user_id 로만 한다(author 는 표시용 닉네임). 관리자는 모든 글·댓글을 지울 수 있다.
// 목록·상세 응답에는 이미지 본문(data URL, 최대 1MB)을 싣지 않고 이미지 경로만 준다 —
// 목록 하나에 수십 MB 가 실리는 것을 막고, 이미지는 브라우저가 따로 받아 캐시한다.
// ─────────────────────────────────────────────────────────────

interface Actor {
  id: number
  nickname?: string | null
  role?: string
}

const HAS_IMAGE = literal('(image_url IS NOT NULL)')
const LIST_ATTRS = ['id', 'user_id', 'title', 'author', 'date', 'views', 'likes', 'category'] as const

const postImagePath = (id: number) => `/api/community/images/posts/${id}`
const commentImagePath = (id: number) => `/api/community/images/comments/${id}`

const canModify = (actor: Actor, ownerId: number | null) =>
  actor.role === 'admin' || (ownerId !== null && Number(ownerId) === Number(actor.id))

const requireNickname = (actor: Actor): string => {
  const nickname = actor.nickname?.trim()
  if (!nickname) throw new CommunityError(403, '닉네임을 먼저 설정해야 작성할 수 있습니다')
  return nickname
}

const findPost = async (postId: number): Promise<Post> => {
  const post = await Post.findByPk(postId, { attributes: [...LIST_ATTRS, 'content', [HAS_IMAGE, 'has_image']] })
  if (!post) throw new CommunityError(404, '게시글을 찾을 수 없습니다')
  return post
}

const serializePost = (p: Post, actor: Actor) => ({
  id: p.id,
  title: p.title,
  author: p.author,
  date: p.date,
  views: p.views ?? 0,
  likes: p.likes ?? 0,
  category: p.category,
  imageUrl: p.get('has_image') ? postImagePath(p.id) : null,
  isMine: p.user_id !== null && Number(p.user_id) === Number(actor.id),
})

const serializeComment = (c: Comment, actor: Actor) => ({
  id: c.id,
  author: c.author,
  content: c.content,
  date: c.date,
  imageUrl: c.get('has_image') ? commentImagePath(c.id) : null,
  isMine: c.user_id !== null && Number(c.user_id) === Number(actor.id),
  canDelete: canModify(actor, c.user_id),
})

export const listPosts = async (actor: Actor) => {
  const posts = await Post.findAll({
    attributes: [...LIST_ATTRS, [HAS_IMAGE, 'has_image']],
    order: [['id', 'DESC']],
  })
  return posts.map((p) => serializePost(p, actor))
}

export const getPost = async (actor: Actor, postId: number) => {
  const post = await findPost(postId)
  const [comments, liked] = await Promise.all([
    Comment.findAll({
      where: { post_id: postId },
      attributes: ['id', 'user_id', 'parent_id', 'author', 'content', 'date', [HAS_IMAGE, 'has_image']],
      order: [['id', 'ASC']],
    }),
    PostLike.findOne({ where: { post_id: postId, user_id: actor.id } }),
  ])

  // 대댓글은 한 단계만 — 부모 아래에 묶는다
  const top = comments.filter((c) => c.parent_id === null)
  const tree = top.map((c) => ({
    ...serializeComment(c, actor),
    replies: comments.filter((r) => r.parent_id === c.id).map((r) => serializeComment(r, actor)),
  }))

  return {
    ...serializePost(post, actor),
    content: post.content,
    canDelete: canModify(actor, post.user_id),
    liked: Boolean(liked),
    comments: tree,
  }
}

export const createPost = async (actor: Actor, input: PostInput) => {
  const author = requireNickname(actor)
  const post = await Post.create({
    user_id: actor.id,
    author,
    title: input.title,
    category: input.category,
    content: input.content,
    image_url: input.imageUrl,
  })
  return { id: post.id }
}

export const deletePost = async (actor: Actor, postId: number) => {
  const post = await Post.findByPk(postId, { attributes: ['id', 'user_id'] })
  if (!post) throw new CommunityError(404, '게시글을 찾을 수 없습니다')
  if (!canModify(actor, post.user_id)) throw new CommunityError(403, '본인이 작성한 게시글만 삭제할 수 있습니다')
  // 댓글·추천은 FK(ON DELETE CASCADE)로 함께 지워진다
  await post.destroy()
}

export const addView = async (postId: number) => {
  const [affected] = await Post.update({ views: literal('COALESCE(views, 0) + 1') as any }, { where: { id: postId } })
  if (affected === 0) throw new CommunityError(404, '게시글을 찾을 수 없습니다')
}

export const likePost = async (actor: Actor, postId: number) => {
  return sequelize.transaction(async (t) => {
    const post = await Post.findByPk(postId, { attributes: ['id', 'likes'], transaction: t, lock: t.LOCK.UPDATE })
    if (!post) throw new CommunityError(404, '게시글을 찾을 수 없습니다')
    try {
      await PostLike.create({ post_id: postId, user_id: actor.id }, { transaction: t })
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw new CommunityError(409, '이미 추천한 게시글입니다')
      throw err
    }
    await post.increment('likes', { by: 1, transaction: t })
    return { likes: (post.likes ?? 0) + 1 }
  })
}

export const createComment = async (actor: Actor, postId: number, input: CommentInput) => {
  const author = requireNickname(actor)
  const post = await Post.findByPk(postId, { attributes: ['id'] })
  if (!post) throw new CommunityError(404, '게시글을 찾을 수 없습니다')

  if (input.parentId !== null) {
    const parent = await Comment.findByPk(input.parentId, { attributes: ['id', 'post_id', 'parent_id'] })
    // 다른 게시글의 댓글이나 대댓글에는 답글을 달 수 없다(한 단계만)
    if (!parent || parent.post_id !== postId || parent.parent_id !== null)
      throw new CommunityError(400, '답글을 달 수 없는 댓글입니다')
  }

  const comment = await Comment.create({
    post_id: postId,
    user_id: actor.id,
    parent_id: input.parentId,
    author,
    content: input.content,
    image_url: input.imageUrl,
  })
  return { id: comment.id }
}

export const deleteComment = async (actor: Actor, commentId: number) => {
  const comment = await Comment.findByPk(commentId, { attributes: ['id', 'user_id'] })
  if (!comment) throw new CommunityError(404, '댓글을 찾을 수 없습니다')
  if (!canModify(actor, comment.user_id)) throw new CommunityError(403, '본인이 작성한 댓글만 삭제할 수 있습니다')
  // 대댓글은 FK(ON DELETE CASCADE)로 함께 지워진다
  await comment.destroy()
}

/** 저장된 data URL 을 다시 검증해 바이너리로 돌려준다 — 저장 이후 DB 가 변조돼도 검증된 형식만 내보낸다 */
export const getImage = async (kind: 'posts' | 'comments', id: number) => {
  const row = kind === 'posts'
    ? await Post.findByPk(id, { attributes: ['image_url'] })
    : await Comment.findByPk(id, { attributes: ['image_url'] })
  if (!row?.image_url) throw new CommunityError(404, '이미지를 찾을 수 없습니다')
  return decodeImage(row.image_url)
}

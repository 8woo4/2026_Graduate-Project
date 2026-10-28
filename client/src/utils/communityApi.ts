import { apiUrl } from './api'

// ─────────────────────────────────────────────────────────────
// 커뮤니티 API (서버: /api/community)
//
// 게시글·댓글은 서버 DB 에 저장된다. 이미지는 응답에 경로만 오고 <img> 가 따로 받는다.
// 삭제 버튼 노출은 서버가 판정한 canDelete 로 한다 — 닉네임 문자열 비교는 닉네임을 바꾸면 틀어진다.
// ─────────────────────────────────────────────────────────────

export interface CommunityComment {
  id: number
  author: string
  content: string
  date: string
  imageUrl: string | null
  isMine: boolean
  canDelete: boolean
  replies?: CommunityComment[]
}

export interface CommunityPost {
  id: number
  title: string
  author: string
  date: string
  views: number
  likes: number
  category: string
  imageUrl: string | null
  isMine: boolean
  // 상세 조회에만 온다
  content?: string
  canDelete?: boolean
  liked?: boolean
  comments?: CommunityComment[]
}

export class CommunityApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(apiUrl(`/api/community${path}`), {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => null)
    throw new CommunityApiError(res.status, data?.message ?? '요청을 처리하지 못했습니다')
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

export const communityApi = {
  listPosts: () => request<CommunityPost[]>('/posts'),
  getPost: (id: number) => request<CommunityPost>(`/posts/${id}`),
  addView: (id: number) => request<void>(`/posts/${id}/view`, { method: 'POST' }),
  createPost: (body: { title: string; category: string; content: string; imageUrl?: string }) =>
    request<{ id: number }>('/posts', { method: 'POST', body }),
  deletePost: (id: number) => request<void>(`/posts/${id}`, { method: 'DELETE' }),
  likePost: (id: number) => request<{ likes: number }>(`/posts/${id}/like`, { method: 'POST' }),
  createComment: (postId: number, body: { content: string; imageUrl?: string; parentId?: number }) =>
    request<{ id: number }>(`/posts/${postId}/comments`, { method: 'POST', body }),
  deleteComment: (commentId: number) => request<void>(`/comments/${commentId}`, { method: 'DELETE' }),
}

/** 서버가 준 이미지 경로를 <img src> 로 쓸 수 있는 전체 주소로 */
export const imageSrc = (path: string | null | undefined): string => (path ? apiUrl(path) : '')

/** 서버 시각(ISO) → 화면 표시 형식 */
export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })

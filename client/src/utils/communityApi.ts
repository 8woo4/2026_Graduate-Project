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
  // 조회수는 서버가 1인 1회로 센다 — 이미 본 글이면 현재 값이 그대로 온다
  addView: (id: number) => request<{ views: number }>(`/posts/${id}/view`, { method: 'POST' }),
  createPost: (body: { title: string; category: string; content: string; imageUrl?: string }) =>
    request<{ id: number }>('/posts', { method: 'POST', body }),
  deletePost: (id: number) => request<void>(`/posts/${id}`, { method: 'DELETE' }),
  likePost: (id: number) => request<{ likes: number }>(`/posts/${id}/like`, { method: 'POST' }),
  createComment: (postId: number, body: { content: string; imageUrl?: string; parentId?: number }) =>
    request<{ id: number }>(`/posts/${postId}/comments`, { method: 'POST', body }),
  deleteComment: (commentId: number) => request<void>(`/comments/${commentId}`, { method: 'DELETE' }),
}

/** 첨부 사진 정책 — 서버 COMMUNITY_POLICY 와 같은 값이어야 한다(어긋나면 서버가 400 으로 거른다) */
export const IMAGE_POLICY = {
  MAX_BYTES: 1024 * 1024,
  MIME: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as readonly string[],
}

/**
 * 고른 파일을 서버가 받는 data URL 로 바꾼다. 형식·크기를 보내기 전에 거른다 —
 * 그냥 올리면 본문 한도(2MB)에 먼저 걸려 사용자는 사유를 알 수 없는 오류만 보게 된다.
 */
export function readImageFile(file: File): Promise<string> {
  if (!IMAGE_POLICY.MIME.includes(file.type))
    return Promise.reject(new Error('사진은 PNG·JPEG·GIF·WEBP 형식만 첨부할 수 있습니다'))
  if (file.size > IMAGE_POLICY.MAX_BYTES)
    return Promise.reject(
      new Error(`사진 용량이 ${(file.size / 1024 / 1024).toFixed(1)}MB 입니다. 1MB 이하로 줄여주세요`),
    )
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('사진을 읽지 못했습니다'))
    reader.onloadend = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('사진을 읽지 못했습니다'))
    }
    reader.readAsDataURL(file)
  })
}

/** 서버가 준 이미지 경로를 <img src> 로 쓸 수 있는 전체 주소로 */
export const imageSrc = (path: string | null | undefined): string => (path ? apiUrl(path) : '')

/** 서버 시각(ISO) → 화면 표시 형식 */
export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })

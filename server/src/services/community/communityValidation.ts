// ─────────────────────────────────────────────────────────────
// 커뮤니티 입력 검증 — DB 와 무관한 순수 함수 (src/test/security/communityValidation.test.ts)
//
// 이미지: 화면은 FileReader 로 만든 data URL 을 보낸다. 별도 파일 저장소 없이 DB 에 담으므로
//   · 형식은 png·jpeg·gif·webp 만 — SVG 는 스크립트를 품을 수 있어 받지 않는다
//   · 선언한 MIME 과 실제 파일 시그니처가 일치해야 한다 — 확장자만 바꾼 파일·폴리글랏 차단
//   · 디코딩 크기 1MB 이하
// 텍스트: 길이 상한만 둔다. 화면(React)이 텍스트로만 출력하므로 HTML 이스케이프는 하지 않는다.
// ─────────────────────────────────────────────────────────────

export const COMMUNITY_POLICY = {
  CATEGORIES: ['질문', '뉴스'] as readonly string[],
  TITLE_MAX: 100,
  CONTENT_MAX: 5000,
  COMMENT_MAX: 1000,
  IMAGE_MAX_BYTES: 1024 * 1024,
} as const

export class CommunityError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

const IMAGE_SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.length > 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a'),
  'image/webp': (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
}

const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/

export interface DecodedImage {
  mime: string
  data: Buffer
}

/** data URL 을 검증·디코딩한다. 형식이 틀리면 CommunityError(400). */
export function decodeImage(dataUrl: string): DecodedImage {
  const m = DATA_URL.exec(dataUrl)
  if (!m) throw new CommunityError(400, '이미지는 png·jpeg·gif·webp 형식만 첨부할 수 있습니다')
  const [, mime, b64] = m
  // base64 길이로 먼저 상한을 본다 — 거대한 문자열을 디코딩하기 전에 거른다
  if (Math.floor((b64.length * 3) / 4) > COMMUNITY_POLICY.IMAGE_MAX_BYTES + 2)
    throw new CommunityError(400, '이미지는 1MB 이하만 첨부할 수 있습니다')
  const data = Buffer.from(b64, 'base64')
  if (data.length > COMMUNITY_POLICY.IMAGE_MAX_BYTES)
    throw new CommunityError(400, '이미지는 1MB 이하만 첨부할 수 있습니다')
  if (!IMAGE_SIGNATURES[mime](data))
    throw new CommunityError(400, '이미지 파일 형식이 올바르지 않습니다')
  return { mime, data }
}

const optionalImage = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string') throw new CommunityError(400, '이미지 형식이 올바르지 않습니다')
  decodeImage(v)
  return v
}

const text = (v: unknown, label: string, max: number, required: boolean): string => {
  if (v === undefined || v === null) v = ''
  if (typeof v !== 'string') throw new CommunityError(400, `${label} 형식이 올바르지 않습니다`)
  const s = v.trim()
  if (required && s.length === 0) throw new CommunityError(400, `${label}을(를) 입력해주세요`)
  if (s.length > max) throw new CommunityError(400, `${label}은(는) ${max}자 이하로 입력해주세요`)
  return s
}

export interface PostInput {
  title: string
  category: string
  content: string
  imageUrl: string | null
}

export function validatePostInput(body: any): PostInput {
  const title = text(body?.title, '제목', COMMUNITY_POLICY.TITLE_MAX, true)
  const content = text(body?.content, '내용', COMMUNITY_POLICY.CONTENT_MAX, true)
  const category = body?.category
  if (typeof category !== 'string' || !COMMUNITY_POLICY.CATEGORIES.includes(category))
    throw new CommunityError(400, '카테고리가 올바르지 않습니다')
  return { title, category, content, imageUrl: optionalImage(body?.imageUrl) }
}

export interface CommentInput {
  content: string
  imageUrl: string | null
  parentId: number | null
}

export function validateCommentInput(body: any): CommentInput {
  const content = text(body?.content, '댓글', COMMUNITY_POLICY.COMMENT_MAX, false)
  const imageUrl = optionalImage(body?.imageUrl)
  if (!content && !imageUrl) throw new CommunityError(400, '내용이나 사진을 입력해주세요')
  const raw = body?.parentId
  const parentId = raw === undefined || raw === null ? null : parseId(raw)
  return { content, imageUrl, parentId }
}

/** 경로·본문의 id — 양의 정수만 받는다 */
export function parseId(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : NaN
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) throw new CommunityError(400, '잘못된 요청입니다')
  return n
}

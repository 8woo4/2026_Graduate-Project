import express from 'express'
import { UniqueConstraintError } from 'sequelize'

// ─────────────────────────────────────────────────────────────
// [보안 검증] 커뮤니티 — 입력 검증·소유자 판정·추천 중복·인증 배선
//
// 배경: 커뮤니티는 localStorage 에만 저장되던 화면 시제품이었다. 서버 저장으로 옮기면서
// 다음 위협을 막는지 확인한다.
//   1) 이미지 위장 — SVG(스크립트 포함 가능)·HTML 을 이미지로, MIME 을 속인 파일, 1MB 초과
//   2) 입력 형식 — 길이 상한, 허용되지 않은 카테고리, 숫자가 아닌 id
//   3) IDOR — 남의 글·댓글 삭제. 특히 "옛 닉네임을 가져간 다른 사용자"
//      대조군 = 화면이 쓰던 닉네임 문자열 비교(nickname === author)
//   4) 추천 중복 — 같은 사용자가 추천 수를 계속 올리기
//   5) 답글 경로 — 다른 게시글의 댓글·대댓글에 답글 달기
//   6) 인증 배선 — 로그인 없이 쓰기·조회 요청
//   7) 조회수 조작 — 같은 사용자가 새로고침으로 조회수·'조회순' 정렬 올리기
//   8) 탐지 기록 — 막아낸 시도가 anomaly_logs 에 남는지(남지 않으면 대시보드·논문에 수치가 0 이다)
//
// 모델·DB 는 스텁으로 대체해 DB 없이 돌린다. 인증 미들웨어는 실제 코드를 쓴다(쿠키가 없으면 DB 전에 401).
// 실행: cd server && npx ts-node src/test/security/communitySecurity.test.ts
// ─────────────────────────────────────────────────────────────

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── 스텁: 메모리 위의 posts·comments·post_likes ──────────────────
type Row = Record<string, any>
const db = {
  posts: new Map<number, Row>(),
  comments: new Map<number, Row>(),
  likes: new Set<string>(),
  views: new Set<string>(),
}

const rowOf = (table: Map<number, Row>, r: Row) => ({
  ...r,
  get: (k: string) => (k === 'has_image' ? r.image_url != null : r[k]),
  destroy: async () => { table.delete(r.id) },
  increment: async (f: string) => { r[f] = (r[f] ?? 0) + 1 },
})

function stubModule(modulePath: string, exports: any): void {
  const resolved = require.resolve(modulePath)
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { __esModule: true, ...exports } } as any
}

// 실제 인증 미들웨어가 User 모델을 쓰므로 DB 설정 모듈은 그대로 두고(연결은 하지 않음) 트랜잭션만 바꾼다
;(require('../../config/database').default as any).transaction = async (fn: any) => fn({ LOCK: { UPDATE: 'UPDATE' } })
stubModule('../../models/community/Post', {
  default: {
    findByPk: async (id: number) => (db.posts.has(id) ? rowOf(db.posts, db.posts.get(id)!) : null),
  },
})
stubModule('../../models/community/Comment', {
  default: {
    findByPk: async (id: number) => (db.comments.has(id) ? rowOf(db.comments, db.comments.get(id)!) : null),
    create: async (r: Row) => { const id = db.comments.size + 100; db.comments.set(id, { id, ...r }); return { id } },
  },
})
stubModule('../../models/community/PostLike', {
  default: {
    findOne: async () => null,
    create: async (r: Row) => {
      const key = `${r.post_id}:${r.user_id}`
      if (db.likes.has(key)) throw new UniqueConstraintError({ message: 'dup' } as any)
      db.likes.add(key)
    },
  },
})

stubModule('../../models/community/PostView', {
  default: {
    create: async (r: Row) => {
      const key = `${r.post_id}:${r.user_id}`
      if (db.views.has(key)) throw new UniqueConstraintError({ message: 'dup' } as any)
      db.views.add(key)
    },
  },
})

// 탐지 기록 경로: AnomalyLog·관리자 조회·메일·IP 지오코딩을 모두 메모리로 바꾼다
const logged: Row[] = []
const mailed: Row[] = []
stubModule('../../models/auth/AnomalyLog', {
  default: { create: async (r: Row) => { logged.push(r); return r } },
})
stubModule('../../models/user/User', {
  default: {
    findOne: async () => ({ email: 'admin@example.test', role: 'admin' }),
    findByPk: async () => null,
  },
})
stubModule('../../services/auth/emailService', {
  sendAnomalyAlertEmail: async (to: string, body: Row) => { mailed.push({ to, ...body }) },
})
stubModule('../../utils/getLocationFromIp', {
  getLocationFromIp: async () => ({ city: 'Seoul', region: 'Seoul', country: 'KR' }),
})

const v = require('../../services/community/communityValidation')
const service = require('../../services/community/communityService')

// ── 테스트용 이미지 ─────────────────────────────────────────────
const b64 = (bytes: number[] | Buffer) => Buffer.from(bytes as any).toString('base64')
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10]
const GIF = [...Buffer.from('GIF89a'), 1, 0]
const WEBP = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP'), 0]
const dataUrl = (mime: string, bytes: number[] | Buffer) => `data:${mime};base64,${b64(bytes)}`

const rejects = (fn: () => unknown, status = 400): boolean => {
  try { fn(); return false } catch (e: any) { return e instanceof v.CommunityError && e.status === status }
}
const rejectsAsync = async (p: Promise<unknown>, status: number): Promise<boolean> => {
  try { await p; return false } catch (e: any) { return e instanceof v.CommunityError && e.status === status }
}

async function main(): Promise<void> {
  // ─────────────────────────────────────────────
  // 1) 이미지 위장
  // ─────────────────────────────────────────────
  const imageAttacks: [string, string][] = [
    ['SVG(스크립트 포함 가능)', `data:image/svg+xml;base64,${b64(Buffer.from('<svg onload="alert(1)"/>'))}`],
    ['HTML 을 PNG 로 선언', dataUrl('image/png', Buffer.from('<html><script>alert(1)</script>'))],
    ['PNG 를 JPEG 로 선언(MIME 불일치)', dataUrl('image/jpeg', PNG)],
    ['javascript: URL', 'javascript:alert(1)'],
    ['외부 URL', 'https://evil.example/x.png'],
    ['base64 아님', 'data:image/png;base64,@@@@'],
    ['1MB 초과 PNG', dataUrl('image/png', Buffer.concat([Buffer.from(PNG), Buffer.alloc(1024 * 1024)]))],
  ]
  let imgBlocked = 0
  for (const [label, url] of imageAttacks) {
    const ok = rejects(() => v.decodeImage(url))
    if (ok) imgBlocked++
    check(`이미지 공격 차단: ${label}`, ok)
  }
  const imageNormals: [string, string][] = [
    ['PNG', dataUrl('image/png', PNG)],
    ['JPEG', dataUrl('image/jpeg', JPEG)],
    ['GIF', dataUrl('image/gif', GIF)],
    ['WEBP', dataUrl('image/webp', WEBP)],
    ['1MB 경계 PNG', dataUrl('image/png', Buffer.concat([Buffer.from(PNG), Buffer.alloc(1024 * 1024 - PNG.length)]))],
  ]
  let imgAllowed = 0
  for (const [label, url] of imageNormals) {
    const ok = !rejects(() => v.decodeImage(url))
    if (ok) imgAllowed++
    check(`정상 이미지 허용: ${label}`, ok)
  }

  // ─────────────────────────────────────────────
  // 2) 입력 형식
  // ─────────────────────────────────────────────
  const base = { title: '제목', category: '질문', content: '내용' }
  const inputAttacks: [string, () => unknown][] = [
    ['제목 101자', () => v.validatePostInput({ ...base, title: 'a'.repeat(101) })],
    ['제목 공백뿐', () => v.validatePostInput({ ...base, title: '   ' })],
    ['내용 5001자', () => v.validatePostInput({ ...base, content: 'a'.repeat(5001) })],
    ['허용되지 않은 카테고리', () => v.validatePostInput({ ...base, category: '공지' })],
    ['제목이 객체', () => v.validatePostInput({ ...base, title: { $gt: '' } })],
    ['게시글 이미지가 SVG', () => v.validatePostInput({ ...base, imageUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })],
    ['댓글 1001자', () => v.validateCommentInput({ content: 'a'.repeat(1001) })],
    ['댓글 내용·사진 모두 없음', () => v.validateCommentInput({ content: '  ' })],
    ['parentId SQL 조각', () => v.validateCommentInput({ content: 'x', parentId: '1 OR 1=1' })],
    ['id 음수', () => v.parseId('-1')],
    ['id 소수', () => v.parseId('1.5')],
    ['id INT 범위 초과', () => v.parseId('9999999999')],
  ]
  let inputBlocked = 0
  for (const [label, fn] of inputAttacks) {
    const ok = rejects(fn)
    if (ok) inputBlocked++
    check(`입력 거절: ${label}`, ok)
  }
  check('정상 게시글 입력 통과', !rejects(() => v.validatePostInput({ ...base, imageUrl: dataUrl('image/png', PNG) })))
  check('사진만 있는 댓글 통과', !rejects(() => v.validateCommentInput({ content: '', imageUrl: dataUrl('image/jpeg', JPEG) })))
  check('제목 앞뒤 공백 제거', v.validatePostInput({ ...base, title: '  제목  ' }).title === '제목')

  // ─────────────────────────────────────────────
  // 3) IDOR — 소유자는 user_id 로만 판정
  // ─────────────────────────────────────────────
  // alice(id 1) 가 글을 쓴 뒤 닉네임을 바꿨고, bob(id 2) 이 그 닉네임 'alice' 를 가져갔다.
  const alice = { id: 1, nickname: 'alice-new', role: 'user' }
  const bobAsAlice = { id: 2, nickname: 'alice', role: 'user' }
  const admin = { id: 9, nickname: 'admin', role: 'admin' }
  const reset = () => {
    db.posts.clear(); db.comments.clear(); db.likes.clear(); db.views.clear()
    db.posts.set(10, { id: 10, user_id: 1, author: 'alice', likes: 0, views: 0, image_url: null })
    db.posts.set(20, { id: 20, user_id: 1, author: 'alice', likes: 0, views: 0, image_url: null })
    db.comments.set(1, { id: 1, post_id: 10, user_id: 1, parent_id: null, author: 'alice' })
    db.comments.set(2, { id: 2, post_id: 10, user_id: 1, parent_id: 1, author: 'alice' })
    db.comments.set(3, { id: 3, post_id: 20, user_id: 1, parent_id: null, author: 'alice' })
  }

  reset()
  const legacyAllowsTakeover = bobAsAlice.nickname === db.posts.get(10)!.author
  check('[대조군] 닉네임 비교는 옛 닉네임 사용자에게 삭제를 허용한다', legacyAllowsTakeover)

  const idorCases: [string, () => Promise<unknown>][] = [
    ['옛 닉네임을 가져간 사용자가 글 삭제', () => service.deletePost(bobAsAlice, 10)],
    ['옛 닉네임을 가져간 사용자가 댓글 삭제', () => service.deleteComment(bobAsAlice, 1)],
  ]
  let idorBlocked = 0
  for (const [label, fn] of idorCases) {
    const ok = await rejectsAsync(fn(), 403)
    if (ok) idorBlocked++
    check(`IDOR 차단: ${label}`, ok)
    check(`IDOR 후 데이터 보존: ${label}`, db.posts.has(10) && db.comments.has(1))
  }
  await service.deletePost(alice, 10)
  check('작성자(닉네임 변경 후)는 자기 글 삭제 가능', !db.posts.has(10))
  reset()
  await service.deleteComment(admin, 1)
  check('관리자는 남의 댓글 삭제 가능', !db.comments.has(1))
  check('없는 글 삭제 → 404', await rejectsAsync(service.deletePost(alice, 999), 404))

  // ─────────────────────────────────────────────
  // 4) 추천 중복
  // ─────────────────────────────────────────────
  reset()
  const first = await service.likePost(alice, 10)
  const dup = await rejectsAsync(service.likePost(alice, 10), 409)
  check('첫 추천 성공', first.likes === 1)
  check('같은 사용자 두 번째 추천 → 409', dup)
  check('중복 시 추천 수 그대로', db.posts.get(10)!.likes === 1)
  await service.likePost(bobAsAlice, 10)
  check('다른 사용자 추천은 허용', db.posts.get(10)!.likes === 2)

  // ─────────────────────────────────────────────
  // 5) 답글 경로
  // ─────────────────────────────────────────────
  reset()
  const replyCases: [string, number, number][] = [
    ['다른 게시글의 댓글에 답글', 10, 3],
    ['대댓글에 답글(두 단계)', 10, 2],
    ['없는 댓글에 답글', 10, 777],
  ]
  let replyBlocked = 0
  for (const [label, postId, parentId] of replyCases) {
    const ok = await rejectsAsync(service.createComment(alice, postId, { content: 'x', imageUrl: null, parentId }), 400)
    if (ok) replyBlocked++
    check(`답글 거절: ${label}`, ok)
  }
  const okReply = await service.createComment(alice, 10, { content: '답글', imageUrl: null, parentId: 1 })
  check('같은 게시글 댓글에 답글 허용', typeof okReply.id === 'number')
  check('닉네임 없는 사용자 작성 → 403',
    await rejectsAsync(service.createComment({ id: 3, nickname: null }, 10, { content: 'x', imageUrl: null, parentId: null }), 403))

  // ─────────────────────────────────────────────
  // 6) 인증 배선 — 실제 라우터, 쿠키 없는 요청
  // ─────────────────────────────────────────────
  const router = require('../../routes/community/communityRouter').default
  const app = express()
  app.use(express.json())
  app.use('/api/community', router)
  const server = await new Promise<any>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const routes: [string, string][] = [
    ['GET', '/api/community/posts'],
    ['GET', '/api/community/posts/10'],
    ['POST', '/api/community/posts'],
    ['DELETE', '/api/community/posts/10'],
    ['POST', '/api/community/posts/10/view'],
    ['POST', '/api/community/posts/10/like'],
    ['POST', '/api/community/posts/10/comments'],
    ['DELETE', '/api/community/comments/1'],
  ]
  let authBlocked = 0
  try {
    for (const [method, path] of routes) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(base),
      })
      const ok = res.status === 401
      if (ok) authBlocked++
      check(`비로그인 거절: ${method} ${path}`, ok, `status=${res.status}`)
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // ─────────────────────────────────────────────
  // 7) 조회수 조작 — 같은 사용자의 재조회는 올리지 않는다
  // ─────────────────────────────────────────────
  reset()
  const view1 = await service.addView(alice, 10)
  const view2 = await service.addView(alice, 10)
  // 다른 사용자가 조회하기 전에 확인한다 — 뒤에서 재면 정상 증가와 구분되지 않는다
  const viewsAfterRepeat = db.posts.get(10)!.views
  const viewBlocked = view2.views === 1 && viewsAfterRepeat === 1
  const view3 = await service.addView(bobAsAlice, 10)
  check('첫 조회는 +1', view1.views === 1)
  check('같은 사용자 재조회는 조회수를 올리지 않는다', viewBlocked, `views=${viewsAfterRepeat}`)
  check('다른 사용자 조회는 +1', view3.views === 2)
  check('없는 글 조회 → 404', await rejectsAsync(service.addView(alice, 999), 404))

  // ─────────────────────────────────────────────
  // 8) 탐지 기록 — 실제 컨트롤러를 통과시켜 anomaly_logs 행을 확인한다
  //
  // 서비스 단위 검증만으로는 "거부했다"까지만 증명된다. 기록이 빠지면 대시보드·논문의
  // 수치가 0 이 되므로, 컨트롤러 → 기록 서비스 → AnomalyLog 경로를 함께 통과시킨다.
  // ─────────────────────────────────────────────
  const abuse = require('../../services/community/communityAbuseService')
  const ctrl = require('../../controllers/community/communityController')
  const PREFIX = abuse.COMMUNITY_DETAIL_PREFIX

  const logApp = express()
  logApp.use(express.json())
  // 인증은 6) 에서 이미 검증했다 — 여기서는 로그인된 상태를 가정하고 기록 경로만 본다
  logApp.use((req: any, _res: any, next: any) => { req.user = bobAsAlice; next() })
  logApp.delete('/posts/:id', ctrl.deletePost)
  logApp.post('/posts', ctrl.createPost)
  const logServer = await new Promise<any>((resolve) => {
    const s = logApp.listen(0, '127.0.0.1', () => resolve(s))
  })
  const logUrl = `http://127.0.0.1:${logServer.address().port}`

  // 기록은 응답을 기다리지 않고(void) 진행되므로 행이 도착할 때까지 짧게 폴링한다
  const waitForLog = async (n: number): Promise<boolean> => {
    for (let i = 0; i < 60; i++) {
      if (logged.length >= n) return true
      await new Promise((r) => setTimeout(r, 10))
    }
    return false
  }
  const lastLog = () => logged[logged.length - 1] ?? {}

  let idorLogged = false
  let imageLogged = false
  let dedupeWorks = false
  try {
    reset()
    logged.length = 0
    mailed.length = 0
    abuse.resetCommunityAbuseStateForTest()

    // (1) 남의 글 삭제 시도 → 403 + IDOR 기록 + 관리자 메일
    const r1 = await fetch(`${logUrl}/posts/10`, { method: 'DELETE' })
    idorLogged = (await waitForLog(1)) && String(lastLog().detail ?? '').startsWith(PREFIX.IDOR)
    check('IDOR 시도가 403 으로 거부된다', r1.status === 403, `status=${r1.status}`)
    check('IDOR 시도가 anomaly_logs 에 기록된다', idorLogged, `detail=${lastLog().detail ?? '없음'}`)
    check('기록 유형이 COMMUNITY_ABUSE 다', lastLog().anomaly_type === 'COMMUNITY_ABUSE')
    check('IDOR 기록의 action 은 ALERT 다', lastLog().action === 'ALERT')
    check('IDOR 기록에 요청자 user_id 가 남는다', Number(lastLog().user_id) === bobAsAlice.id)
    check('IDOR 은 관리자 메일로도 알린다', mailed.length === 1, `메일=${mailed.length}건`)
    check('기록에 사용자 입력 원문이 들어가지 않는다', !String(lastLog().detail ?? '').includes('alice'))

    // (2) 같은 주체·같은 종류의 연속 시도는 중복 창 안에서 1건으로 센다
    const before = logged.length
    await fetch(`${logUrl}/posts/10`, { method: 'DELETE' })
    await new Promise((r) => setTimeout(r, 120))
    dedupeWorks = logged.length === before
    check('중복 창 안의 반복 시도는 1건으로 센다', dedupeWorks, `추가=${logged.length - before}건`)

    // (3) 이미지 위장 첨부 → 400 + IMAGE_FORGERY 기록
    abuse.resetCommunityAbuseStateForTest()
    const svg = `data:image/svg+xml;base64,${b64(Buffer.from('<svg onload="alert(1)"/>'))}`
    const r2 = await fetch(`${logUrl}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, imageUrl: svg }),
    })
    imageLogged = (await waitForLog(2)) && String(lastLog().detail ?? '').startsWith(PREFIX.IMAGE_FORGERY)
    check('이미지 위장이 400 으로 거부된다', r2.status === 400, `status=${r2.status}`)
    check('이미지 위장이 anomaly_logs 에 기록된다', imageLogged, `detail=${lastLog().detail ?? '없음'}`)
    check('이미지 위장은 메일을 보내지 않는다(경보 피로 방지)', mailed.length === 1)

    // (4) 정상 입력 실수는 기록하지 않는다 — 오탐이 집계를 오염시키면 안 된다
    const beforeFp = logged.length
    const r3 = await fetch(`${logUrl}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...base, title: 'a'.repeat(101) }),
    })
    await new Promise((r) => setTimeout(r, 120))
    check('제목 길이 초과는 400 이지만 기록하지 않는다',
      r3.status === 400 && logged.length === beforeFp, `추가=${logged.length - beforeFp}건`)
  } finally {
    await new Promise<void>((resolve) => logServer.close(() => resolve()))
  }

  // ─────────────────────────────────────────────
  // 결과 출력
  // ─────────────────────────────────────────────
  const attackTotal = imageAttacks.length + inputAttacks.length + idorCases.length + 1 + replyCases.length + routes.length + 1
  const attackBlocked = imgBlocked + inputBlocked + idorBlocked + (dup ? 1 : 0) + replyBlocked + authBlocked + (viewBlocked ? 1 : 0)
  console.log('')
  console.log('[보안 테스트] 커뮤니티')
  console.log(`총 공격 시도: ${attackTotal}회 | 차단: ${attackBlocked}회 | 탐지율: ${((attackBlocked / attackTotal) * 100).toFixed(0)}%`)
  console.log(`- 이미지 위장 차단     : ${imgBlocked}/${imageAttacks.length} | 정상 이미지 허용 ${imgAllowed}/${imageNormals.length}`)
  console.log(`- 입력 형식 거절       : ${inputBlocked}/${inputAttacks.length}`)
  console.log(`- IDOR(옛 닉네임) 차단 : ${idorBlocked}/${idorCases.length} | [대조군] 닉네임 비교 시 탈취 ${legacyAllowsTakeover ? '가능' : '불가'}`)
  console.log(`- 추천 중복 차단       : ${dup ? 1 : 0}/1`)
  console.log(`- 답글 경로 거절       : ${replyBlocked}/${replyCases.length}`)
  console.log(`- 비로그인 요청 거절   : ${authBlocked}/${routes.length}`)
  console.log(`- 조회수 조작 차단     : ${viewBlocked ? 1 : 0}/1 (같은 사용자 재조회)`)
  console.log(`- 탐지 기록(anomaly_logs): IDOR ${idorLogged ? '기록' : '누락'} · 이미지 위장 ${imageLogged ? '기록' : '누락'} · 중복 억제 ${dedupeWorks ? '동작' : '실패'}`)

  if (failures.length > 0) {
    console.log('\n[실패 항목]')
    for (const f of failures.slice(0, 20)) console.log(`  · ${f}`)
  }

  console.log(`\n검증 항목: ${pass}건 통과 / ${fail}건 실패`)
  console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
  // process.exit() 는 Windows 에서 fetch 소켓이 닫히는 중에 libuv 단언 실패를 낸다 — 이벤트 루프가 비면 자연 종료
  process.exitCode = fail === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('검증 실행 오류:', err)
  process.exit(1)
})

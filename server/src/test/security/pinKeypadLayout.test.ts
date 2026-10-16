import path from 'path'
import { pathToFileURL } from 'url'

// ─────────────────────────────────────────────────────────────
// [보안 검증] 거래 PIN 보안 키패드 — 숫자 배열 무작위화
//
// 위협: 클릭 좌표만 수집하는 악성 스크립트·확장 프로그램(클릭 로거). 키보드 입력은 이미 받지
// 않으므로 키로거에는 PIN 이 남지 않지만, 배열이 고정이면 좌표가 곧 숫자다.
//
//   1) 공격: 키패드가 열릴 때마다 6자리 PIN 을 입력하고 공격자는 눌린 칸 번호만 얻는다.
//      공격자는 칸 번호를 고정 배열(1~9, 0)로 되돌려 PIN 을 복원한다.
//      대조군 = 수정 전 고정 배열 / 실험군 = 무작위 배열
//   2) 무작위성: 칸마다 숫자 분포가 균등한가(카이제곱), 편향 없는 정수 추출인가
//   3) 배열 계약: 숫자 10개가 정확히 한 번씩, 기능 키 위치 고정
//   4) 안전한 난수원이 없으면 고정 배열로 떨어지지 않고 실패하는가
//
// 공격·균등성 시험은 결정적 난수(시드 고정)를 주입해 실행마다 같은 수치가 나오게 한다.
// 실행: cd server && npx ts-node src/test/security/pinKeypadLayout.test.ts  (Node 22.18+)
//
// 검증 대상은 사본이 아니라 클라이언트가 실제로 번들하는 client/src/utils/pinKeypadLayout.ts 다.
// 클라이언트 패키지는 ESM 이라 ts-node(CJS)의 require 로는 못 읽고, 서버 tsconfig 의 rootDir
// 밖이라 정적 import 도 할 수 없다. 그래서 Node 기본 import() 로 불러 Node 의 타입 제거로 실행한다.
// (TS 가 import() 를 require() 로 바꾸지 않게 Function 으로 감싼다)
// ─────────────────────────────────────────────────────────────

type RandomSource = (buf: Uint32Array) => Uint32Array
interface KeypadModule {
  buildPadLayout: (digits?: string[]) => string[]
  shuffleDigits: (random?: RandomSource) => string[]
  CLEAR_KEY: string
  BACKSPACE_KEY: string
  FIXED_DIGITS: string[]
}
const nativeImport = new Function('u', 'return import(u)') as (u: string) => Promise<KeypadModule>
const MODULE_PATH = path.resolve(__dirname, '../../../../client/src/utils/pinKeypadLayout.ts')

const main = async () => {
const { buildPadLayout, shuffleDigits, CLEAR_KEY, BACKSPACE_KEY, FIXED_DIGITS } =
  await nativeImport(pathToFileURL(MODULE_PATH).href)

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) pass++
  else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

// xorshift32 — getRandomValues 와 같은 시그니처로 주입하는 결정적 난수원
const seeded = (seed: number) => {
  let s = seed >>> 0 || 1
  return (buf: Uint32Array): Uint32Array => {
    for (let i = 0; i < buf.length; i++) {
      s ^= s << 13; s >>>= 0
      s ^= s >>> 17
      s ^= s << 5; s >>>= 0
      buf[i] = s
    }
    return buf
  }
}

const fixedLayout = buildPadLayout(FIXED_DIGITS)

// ── 1) 클릭 좌표 기반 PIN 복원 공격 ──────────────────────────
// 무작위 배열에서도 좌표는 "어느 자리끼리 같은 숫자인가"(반복 패턴)는 드러낸다. 서로 다른 숫자가
// k개인 PIN 은 그 패턴에 맞는 후보가 10·9·…·(10−k+1)개이고 공격자의 최선은 그중 하나를 찍는 것이다.
// 모든 PIN 에 대해 평균하면 성공 확률은 Σ_k S(6,k)/10^6 = Bell(6)/10^6 = 203/1,000,000 이다.
// 고정 배열로 되돌리는 공격도 같은 확률로 맞으므로, 측정값이 이 이론값과 일치하는지를 본다.
const ATTACK_TRIALS = 200_000
const THEORY_RATE = 203 / 1_000_000
const PIN_MAX_FAIL = 5 // virtualTradeService.PIN_MAX_FAIL — 5회 실패 시 30분 잠금
const pinRand = seeded(20261016)
const randomPin = (): string => {
  const b = new Uint32Array(6)
  pinRand(b)
  return Array.from(b, (v) => String(v % 10)).join('')
}

const clickPositions = (pin: string, layout: string[]): number[] =>
  [...pin].map((d) => layout.indexOf(d))

const recoverWithFixedLayout = (positions: number[]): string =>
  positions.map((p) => fixedLayout[p]).join('')

let fixedRecovered = 0
let shuffledRecovered = 0
let shuffledDigitHits = 0
const shuffleRand = seeded(777)
for (let t = 0; t < ATTACK_TRIALS; t++) {
  const pin = randomPin()
  if (recoverWithFixedLayout(clickPositions(pin, fixedLayout)) === pin) fixedRecovered++

  const layout = buildPadLayout(shuffleDigits(shuffleRand))
  const guess = recoverWithFixedLayout(clickPositions(pin, layout))
  if (guess === pin) shuffledRecovered++
  for (let i = 0; i < 6; i++) if (guess[i] === pin[i]) shuffledDigitHits++
}
const fixedRate = fixedRecovered / ATTACK_TRIALS
const shuffledRate = shuffledRecovered / ATTACK_TRIALS
const digitHitRate = shuffledDigitHits / (ATTACK_TRIALS * 6)

check('대조군: 고정 배열은 좌표만으로 PIN 전부 복원', fixedRecovered === ATTACK_TRIALS, `${fixedRecovered}/${ATTACK_TRIALS}`)
// 이항분포 기대값 ±4σ 안이면 이론값과 일치로 본다(우연히 벗어날 확률 < 0.01%)
{
  const mean = ATTACK_TRIALS * THEORY_RATE
  const sd = Math.sqrt(ATTACK_TRIALS * THEORY_RATE * (1 - THEORY_RATE))
  check(
    '무작위 배열: 좌표 복원 성공률이 반복 패턴 이론값(0.0203%)과 일치',
    Math.abs(shuffledRecovered - mean) <= 4 * sd,
    `${shuffledRecovered}회 / 기대 ${mean.toFixed(1)}±${(4 * sd).toFixed(1)}`,
  )
}
// 자리별 적중률은 찍기(10%)와 같아야 한다 — 좌표가 숫자에 대한 정보를 주지 않는다는 뜻
check('무작위 배열: 자리별 적중률이 찍기 수준(10%±1%p)', Math.abs(digitHitRate - 0.1) < 0.01, `${(digitHitRate * 100).toFixed(2)}%`)

// ── 2) 무작위성 ─────────────────────────────────────────────
const UNIFORM_TRIALS = 100_000
const counts = Array.from({ length: 10 }, () => new Array(10).fill(0))
const uniRand = seeded(424242)
for (let t = 0; t < UNIFORM_TRIALS; t++) {
  const d = shuffleDigits(uniRand)
  d.forEach((digit, pos) => counts[pos][Number(digit)]++)
}
const expected = UNIFORM_TRIALS / 10
let worstChi = 0
for (let pos = 0; pos < 10; pos++) {
  const chi = counts[pos].reduce((acc: number, c: number) => acc + (c - expected) ** 2 / expected, 0)
  worstChi = Math.max(worstChi, chi)
}
// 자유도 9, 유의수준 0.001 임계값 27.88 — 칸 10개 중 가장 나쁜 칸도 넘지 않아야 한다
check('칸별 숫자 분포 균등(카이제곱 최대 < 27.88)', worstChi < 27.88, `최대 χ²=${worstChi.toFixed(2)}`)

// 나머지 연산 편향 제거 확인: 거부 구간에 드는 값만 계속 주면 그 값을 쓰지 않아야 한다.
// bound=10 일 때 2^32 - (2^32 mod 10) 이상인 값(4294967290~95)은 버려야 한다.
{
  const seq = [0xffff_ffff, 0xffff_fffa, 3]
  let k = 0
  const scripted = (buf: Uint32Array) => { buf[0] = seq[Math.min(k++, seq.length - 1)]; return buf }
  const d = shuffleDigits(scripted)
  check('거부 구간 값(2^32 근처)은 버리고 다시 뽑는다', k > 2, `난수 소비 ${k}회`)
  check('거부 후에도 숫자 10개 순열 유지', [...d].sort().join('') === '0123456789')
}

// 실제 난수원(crypto)으로 만든 배열은 서로 달라야 한다(10! 중 1,000개, 중복 확률 ≈ 1.4×10^-1)
{
  const seen = new Set<string>()
  for (let i = 0; i < 1000; i++) seen.add(shuffleDigits().join(''))
  check('crypto 배열 1,000개 중 서로 다른 배열 ≥ 998', seen.size >= 998, `${seen.size}/1000`)
  const sameAsFixed = [...seen].filter((s) => s === FIXED_DIGITS.join('')).length
  check('crypto 배열이 고정 배열과 같지 않음', sameAsFixed === 0)
}

// ── 3) 배열 계약 ─────────────────────────────────────────────
{
  let contractOk = 0
  const r = seeded(99)
  for (let i = 0; i < 1000; i++) {
    const l = buildPadLayout(shuffleDigits(r))
    const digits = l.filter((k) => k !== CLEAR_KEY && k !== BACKSPACE_KEY)
    if (
      l.length === 12 &&
      l[9] === CLEAR_KEY &&
      l[11] === BACKSPACE_KEY &&
      digits.length === 10 &&
      [...digits].sort().join('') === '0123456789'
    ) contractOk++
  }
  check('12칸·숫자 10개 각 1회·기능 키 위치 고정', contractOk === 1000, `${contractOk}/1000`)
}

// ── 4) 안전한 난수원 부재 시 실패(고정 배열로 조용히 떨어지지 않음) ──
{
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
  let threw = false
  try { shuffleDigits() } catch { threw = true }
  if (original) Object.defineProperty(globalThis, 'crypto', original)
  check('crypto 없음 → 예외(고정 배열 미반환)', threw)
}

// ── 결과 ────────────────────────────────────────────────────
const total = ATTACK_TRIALS * 2
const blocked = ATTACK_TRIALS - shuffledRecovered
console.log('[보안 테스트] 거래 PIN 보안 키패드 (숫자 배열 무작위화)')
console.log(`총 시도: ${total.toLocaleString()}회 | 탐지: — | 차단: ${blocked.toLocaleString()}회 | 차단율: ${((blocked / ATTACK_TRIALS) * 100).toFixed(3)}%`)
console.log(`- 클릭 좌표 복원 공격 : 고정 배열 ${(fixedRate * 100).toFixed(1)}% → 무작위 배열 ${(shuffledRate * 100).toFixed(4)}% (이론값 ${(THEORY_RATE * 100).toFixed(4)}%, 각 ${ATTACK_TRIALS.toLocaleString()}회)`)
console.log(`- PIN 잠금 포함 상한  : ${PIN_MAX_FAIL}회 시도 후 잠금 → 성공 ≤ ${((1 - (1 - THEORY_RATE) ** PIN_MAX_FAIL) * 100).toFixed(3)}% (반복 패턴만 남는다)`)
console.log(`- 자리별 적중률       : ${(digitHitRate * 100).toFixed(2)}% (찍기 10%와 동일 = 좌표가 숫자 정보를 주지 않음)`)
console.log(`- 칸별 분포 균등성    : 최대 χ²=${worstChi.toFixed(2)} (임계 27.88, ${UNIFORM_TRIALS.toLocaleString()}회)`)
console.log('- 한계               : 화면 녹화·어깨 너머 관찰처럼 배열과 클릭을 함께 보는 공격은 막지 못한다')
console.log(`검증 항목: ${pass}건 통과 / ${fail}건 실패`)
if (failures.length) failures.forEach((f) => console.log(`  ✗ ${f}`))
console.log(`판정: ${fail === 0 ? 'PASS' : 'FAIL'}`)
process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('실행 실패:', err?.message ?? err)
  process.exit(2)
})

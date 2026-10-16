// 거래 PIN 보안 키패드 배열
//
// 배열이 고정되어 있으면 클릭 좌표만 수집하는 악성 스크립트·확장 프로그램이 좌표를 숫자로
// 그대로 되돌릴 수 있다. 키패드가 열릴 때마다 숫자 위치를 섞어, 좌표만으로는 PIN 을
// 복원할 수 없게 한다. 기능 키(전체 삭제·지우기)는 위치를 고정해 조작 실수를 줄인다.

export const CLEAR_KEY = 'clear'
export const BACKSPACE_KEY = 'backspace'
export type PadKey = string

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

// 0 이상 bound 미만의 균등 난수. 단순 나머지 연산은 2^32 가 bound 로 나누어떨어지지 않을 때
// 앞쪽 값이 더 자주 나오므로, 나누어떨어지는 구간 밖의 값은 버리고 다시 뽑는다.
const uniformInt = (bound: number, random: (buf: Uint32Array) => Uint32Array): number => {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound
  const buf = new Uint32Array(1)
  for (;;) {
    random(buf)
    if (buf[0] < limit) return buf[0] % bound
  }
}

const cryptoRandom = (buf: Uint32Array): Uint32Array => {
  // Math.random 은 예측 가능한 PRNG 라 배열을 섞는 용도로 쓰지 않는다. 안전한 난수원이 없으면
  // 고정 배열로 조용히 떨어지는 대신 실패시켜, 보호가 꺼진 줄 모르고 쓰는 상황을 막는다.
  if (!globalThis.crypto?.getRandomValues) throw new Error('안전한 난수 생성기를 사용할 수 없습니다')
  return globalThis.crypto.getRandomValues(buf)
}

// Fisher–Yates. 모든 순열이 같은 확률(1/10!)로 나온다.
export const shuffleDigits = (random: (buf: Uint32Array) => Uint32Array = cryptoRandom): string[] => {
  const d = [...DIGITS]
  for (let i = d.length - 1; i > 0; i--) {
    const j = uniformInt(i + 1, random)
    ;[d[i], d[j]] = [d[j], d[i]]
  }
  return d
}

// 4×3 격자: 숫자 9개 / [전체 삭제, 숫자, 지우기]
export const buildPadLayout = (digits: string[] = shuffleDigits()): PadKey[] => [
  ...digits.slice(0, 9),
  CLEAR_KEY,
  digits[9],
  BACKSPACE_KEY,
]

export const FIXED_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']

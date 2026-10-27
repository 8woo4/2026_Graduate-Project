/**
 * 실시간 시세를 구독할 종목 선택
 *
 * 전종목(약 4천)을 밀면 KIS 유량을 다 먹으므로 지금 눈에 들어온 종목만 구독한다.
 * 서버는 전체 호출 속도를 10 req/s 로 묶기 때문에, 구독이 늘어날수록 종목 하나의
 * 갱신 주기가 비례해 느려진다(50종목이면 종목당 5초). 그래서 상한이 필요하다.
 *
 * 순수 함수로 떼어 둔 이유 — 상한·정렬·폴백·중복 제거의 경계를 단위 검증한다.
 * (server/src/test/market/subscribeCodes.test.ts)
 */

/** 보이는 종목이 많아도 이 수를 넘겨 구독하지 않는다. */
export const VISIBLE_SUBSCRIBE_CAP = 50

/** 가시 정보가 아직 없을 때(최초 렌더, IntersectionObserver 미지원) 구독할 상위 개수. */
export const FALLBACK_TOP_N = 30

export interface CodeHolder {
  code: string
}

/**
 * @param ordered   화면에 그려진 순서(거래량 내림차순 + 검색·탭 필터 적용)
 * @param visible   교차 판정으로 보이는 종목코드 — 순서는 신뢰하지 않는다
 * @param favorites 관심종목 패널은 따로 렌더되므로 보이는지와 무관하게 포함한다
 */
export const pickSubscribeCodes = (
  ordered: readonly CodeHolder[],
  visible: readonly string[],
  favorites: readonly CodeHolder[],
  cap: number = VISIBLE_SUBSCRIBE_CAP,
  fallbackTopN: number = FALLBACK_TOP_N,
): string[] => {
  const codes = new Set<string>()

  if (visible.length > 0) {
    // visible 의 순서는 교차 이벤트가 들어온 순서라 화면 순서와 다르다.
    // 상한을 적용할 때 위쪽 종목이 잘려 나가지 않도록 ordered 를 기준으로 훑는다.
    const seen = new Set(visible)
    let n = 0
    for (const item of ordered) {
      if (!seen.has(item.code)) continue
      codes.add(item.code)
      if (++n >= cap) break
    }
  } else {
    for (const item of ordered.slice(0, fallbackTopN)) codes.add(item.code)
  }

  for (const item of favorites) codes.add(item.code)

  return [...codes]
}

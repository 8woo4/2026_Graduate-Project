-- 2026-10-28 : 커뮤니티 조회수 1인 1회 — post_views 신설
--
--   기존 구현은 POST /posts/:id/view 가 올 때마다 views 를 +1 했다. 중복 방지도, 레이트 리밋도
--   없어 새로고침 한 번이 곧 조회수 1 이었고, 스크립트로 '조회순' 정렬을 조작할 수 있었다.
--   추천(post_likes)과 같은 방식으로 (게시글, 사용자) 복합 기본키를 두어 DB 가 1회를 보장한다.
--
--   views 의 의미가 '요청 수' → '고유 조회자 수' 로 바뀐다. 기존 값은 손대지 않는다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261028_community_post_views.sql

CREATE TABLE IF NOT EXISTS post_views (
  post_id    INT      NOT NULL,
  user_id    BIGINT   NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, user_id),
  CONSTRAINT fk_post_views_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  CONSTRAINT fk_post_views_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

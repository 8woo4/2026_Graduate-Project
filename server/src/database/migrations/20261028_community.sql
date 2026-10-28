-- 2026-10-28 : 커뮤니티 서버 저장 — 기존 posts·comments 테이블 확장
--
--   posts·comments 는 2026-05-26 에 만들어졌지만 서버 코드가 없어 화면은 localStorage 만 썼다.
--   기존 컬럼은 그대로 두고, 서버 저장에 필요한 것만 더한다.
--
--   posts.user_id      작성자 계정. 닉네임은 바꿀 수 있어 author 문자열로 소유자를 판정하면,
--                      옛 닉네임을 새로 가져간 사람이 남의 글을 지울 수 있다(IDOR).
--   posts.image_url    VARCHAR(255) → MEDIUMTEXT. 화면이 보내는 data URL(최대 1MB)을 담는다.
--   comments.user_id   위와 같은 이유
--   comments.parent_id 대댓글(한 단계). 부모 댓글을 지우면 대댓글도 지운다.
--   comments.image_url 댓글 사진
--   post_likes         (게시글, 사용자) 1회 추천. 이것이 없으면 같은 사람이 추천 수를 무한히 올린다.
--
-- 적용:
--   cd server && npx ts-node src/database/migrations/apply.ts 20261028_community.sql

SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'posts' AND column_name = 'user_id');
SET @s := IF(@c = 0, 'ALTER TABLE posts ADD COLUMN user_id BIGINT NULL AFTER id, ADD CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

ALTER TABLE posts MODIFY COLUMN image_url MEDIUMTEXT NULL;

SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'comments' AND column_name = 'user_id');
SET @s := IF(@c = 0, 'ALTER TABLE comments ADD COLUMN user_id BIGINT NULL AFTER post_id, ADD CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'comments' AND column_name = 'parent_id');
SET @s := IF(@c = 0, 'ALTER TABLE comments ADD COLUMN parent_id INT NULL AFTER user_id, ADD CONSTRAINT fk_comments_parent FOREIGN KEY (parent_id) REFERENCES comments (id) ON DELETE CASCADE', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = 'comments' AND column_name = 'image_url');
SET @s := IF(@c = 0, 'ALTER TABLE comments ADD COLUMN image_url MEDIUMTEXT NULL AFTER content', 'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

CREATE TABLE IF NOT EXISTS post_likes (
  post_id    INT      NOT NULL,
  user_id    BIGINT   NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (post_id, user_id),
  CONSTRAINT fk_post_likes_post FOREIGN KEY (post_id) REFERENCES posts (id) ON DELETE CASCADE,
  CONSTRAINT fk_post_likes_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

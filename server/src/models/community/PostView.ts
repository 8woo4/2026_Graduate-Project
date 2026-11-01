import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// ─────────────────────────────────────────────────────────────
// 게시글 조회 기록 — (post_id, user_id) 기본키로 1인 1회를 DB 가 보장한다.
//
// posts.views 는 이 테이블에 행이 새로 생길 때만 증가한다. 기록 없이 매 요청 +1 하면
// 새로고침·스크립트로 '조회순' 정렬을 마음대로 올릴 수 있어, 추천(post_likes)과 같은 방식으로 막는다.
// 그래서 views 의 의미는 '요청 수'가 아니라 '고유 조회자 수'다.
//
// 마이그레이션: src/database/migrations/20261028_community_post_views.sql
// ─────────────────────────────────────────────────────────────

interface PostViewAttributes {
  post_id: number
  user_id: number
  created_at: Date
}

interface PostViewCreationAttributes extends Optional<PostViewAttributes, 'created_at'> {}

class PostView extends Model<PostViewAttributes, PostViewCreationAttributes> implements PostViewAttributes {
  public post_id!: number
  public user_id!: number
  public created_at!: Date
}

PostView.init(
  {
    post_id: { type: DataTypes.INTEGER, primaryKey: true },
    user_id: { type: DataTypes.BIGINT, primaryKey: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'post_views',
    timestamps: false,
  },
)

export default PostView

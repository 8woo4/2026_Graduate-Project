import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// ─────────────────────────────────────────────────────────────
// 게시글 추천 기록 — (post_id, user_id) 기본키로 1인 1회를 DB 가 보장한다.
// posts.likes 는 이 테이블과 같은 트랜잭션에서만 증가시킨다.
//
// 마이그레이션: src/database/migrations/20261028_community.sql
// ─────────────────────────────────────────────────────────────

interface PostLikeAttributes {
  post_id: number
  user_id: number
  created_at: Date
}

interface PostLikeCreationAttributes extends Optional<PostLikeAttributes, 'created_at'> {}

class PostLike extends Model<PostLikeAttributes, PostLikeCreationAttributes> implements PostLikeAttributes {
  public post_id!: number
  public user_id!: number
  public created_at!: Date
}

PostLike.init(
  {
    post_id: { type: DataTypes.INTEGER, primaryKey: true },
    user_id: { type: DataTypes.BIGINT, primaryKey: true },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'post_likes',
    timestamps: false,
  },
)

export default PostLike

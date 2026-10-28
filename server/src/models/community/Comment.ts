import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// ─────────────────────────────────────────────────────────────
// 커뮤니티 댓글 — parent_id 가 있으면 대댓글(한 단계만)
//
// 소유자 판정은 user_id 로만 한다(Post 와 같은 이유).
// 부모 댓글을 지우면 FK(ON DELETE CASCADE)로 대댓글도 함께 지워진다.
//
// 마이그레이션: src/database/migrations/20261028_community.sql
// ─────────────────────────────────────────────────────────────

interface CommentAttributes {
  id: number
  post_id: number
  user_id: number | null
  parent_id: number | null
  author: string
  content: string
  image_url: string | null
  date: Date
}

interface CommentCreationAttributes
  extends Optional<CommentAttributes, 'id' | 'parent_id' | 'image_url' | 'date'> {}

class Comment extends Model<CommentAttributes, CommentCreationAttributes> implements CommentAttributes {
  public id!: number
  public post_id!: number
  public user_id!: number | null
  public parent_id!: number | null
  public author!: string
  public content!: string
  public image_url!: string | null
  public date!: Date
}

Comment.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    post_id: { type: DataTypes.INTEGER, allowNull: false },
    user_id: { type: DataTypes.BIGINT, allowNull: true },
    parent_id: { type: DataTypes.INTEGER, allowNull: true },
    author: { type: DataTypes.STRING(100), allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    image_url: { type: DataTypes.TEXT('medium'), allowNull: true },
    date: { type: DataTypes.DATE, allowNull: true, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: 'comments',
    timestamps: false,
  },
)

export default Comment

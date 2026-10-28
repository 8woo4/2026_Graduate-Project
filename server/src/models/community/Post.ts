import { DataTypes, Model, Optional } from 'sequelize'
import sequelize from '../../config/database'

// ─────────────────────────────────────────────────────────────
// 커뮤니티 게시글
//
// author 는 작성 시점의 닉네임(표시용)이고, 소유자 판정은 user_id 로만 한다.
// 닉네임은 바꿀 수 있어서 문자열로 판정하면 옛 닉네임을 가져간 사람이 남의 글을 지울 수 있다.
// image_url 은 검증된 data URL(png·jpeg·gif·webp, 최대 1MB)이다.
//
// 마이그레이션: src/database/migrations/20261028_community.sql
// ─────────────────────────────────────────────────────────────

interface PostAttributes {
  id: number
  user_id: number | null
  title: string
  author: string
  date: Date
  views: number
  likes: number
  category: string
  content: string
  image_url: string | null
}

interface PostCreationAttributes
  extends Optional<PostAttributes, 'id' | 'date' | 'views' | 'likes' | 'image_url'> {}

class Post extends Model<PostAttributes, PostCreationAttributes> implements PostAttributes {
  public id!: number
  public user_id!: number | null
  public title!: string
  public author!: string
  public date!: Date
  public views!: number
  public likes!: number
  public category!: string
  public content!: string
  public image_url!: string | null
}

Post.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.BIGINT, allowNull: true },
    title: { type: DataTypes.STRING(255), allowNull: false },
    author: { type: DataTypes.STRING(100), allowNull: false },
    date: { type: DataTypes.DATE, allowNull: true, defaultValue: DataTypes.NOW },
    views: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    likes: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
    category: { type: DataTypes.STRING(50), allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    image_url: { type: DataTypes.TEXT('medium'), allowNull: true },
  },
  {
    sequelize,
    tableName: 'posts',
    timestamps: false,
  },
)

export default Post

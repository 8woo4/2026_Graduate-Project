import { useParams, useNavigate } from 'react-router-dom';
import { useEffect, useState, useRef, type ChangeEvent } from 'react';

import { API_BASE } from '../utils/api'
import { communityApi, formatDate, imageSrc, readImageFile, type CommunityPost } from '../utils/communityApi'

export default function PostDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [post, setPost] = useState<CommunityPost | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const hasIncremented = useRef(false);

  const [commentContent, setCommentContent] = useState('');
  const [commentImage, setCommentImage] = useState('');
  const [isCommentSubmitting, setIsCommentSubmitting] = useState(false);
  
  const [replyingTo, setReplyingTo] = useState<number | null>(null);
  const [replyContent, setReplyContent] = useState('');
  const [replyImage, setReplyImage] = useState('');

  const [nickname, setNickname] = useState<string | null>(null);
  const [nicknameLoading, setNicknameLoading] = useState(true);

  const postId = Number(id);

  // 댓글 작성·삭제 뒤에도 서버 상태를 그대로 다시 받는다
  const reloadPost = async () => {
    try {
      setPost(await communityApi.getPost(postId));
    } catch {
      setPost(null);
    }
  };

  useEffect(() => {
    setIsLoading(true);
    communityApi.getPost(postId)
      .then(async (found) => {
        if (!hasIncremented.current) {
          hasIncremented.current = true;
          // 조회수는 서버가 1인 1회로 센다 — 돌려받은 값을 그대로 쓴다(이미 본 글이면 그대로)
          const counted = await communityApi.addView(postId).catch(() => null);
          if (counted) found = { ...found, views: counted.views };
        }
        setPost(found);
      })
      .catch(() => setPost(null))
      .finally(() => setIsLoading(false));
  }, [postId]);

  useEffect(() => {
    const fetchNickname = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/me`, { credentials: 'include' });
        if (!res.ok) { 
          setNicknameLoading(false); 
          return; 
        }
        const data = await res.json();
        setNickname(data.nickname ?? null);
      } catch {
      } finally {
        setNicknameLoading(false);
      }
    };
    fetchNickname();
  }, []);

  const handleLike = async () => {
    if (!post) return;
    try {
      const { likes } = await communityApi.likePost(post.id);
      setPost({ ...post, likes, liked: true });
    } catch (err) {
      alert(err instanceof Error ? err.message : '추천하지 못했습니다.');
    }
  };

  const handleDeletePost = async () => {
    if (!post) return;
    if (window.confirm('정말로 이 게시글을 삭제하시겠습니까?')) {
      try {
        await communityApi.deletePost(post.id);
        alert('게시글이 삭제되었습니다.');
        navigate('/community', { replace: true });
      } catch (err) {
        alert(err instanceof Error ? err.message : '게시글을 삭제하지 못했습니다.');
      }
    }
  };

  const handleCommentImageChange = async (e: ChangeEvent<HTMLInputElement>, isReply: boolean = false) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readImageFile(file);
      if (isReply) setReplyImage(dataUrl);
      else setCommentImage(dataUrl);
    } catch (err) {
      alert(err instanceof Error ? err.message : '사진을 첨부하지 못했습니다');
      input.value = '';
      if (isReply) setReplyImage('');
      else setCommentImage('');
    }
  };

  const handleAddComment = async () => {
    if (!nickname) return alert("닉네임을 먼저 설정해야 댓글을 작성할 수 있습니다.");
    if (!commentContent && !commentImage) return alert("내용이나 사진을 입력해주세요.");

    setIsCommentSubmitting(true);
    try {
      await communityApi.createComment(postId, { content: commentContent, imageUrl: commentImage || undefined });
      await reloadPost();
      setCommentContent('');
      setCommentImage('');
    } catch (err) {
      alert(err instanceof Error ? err.message : '댓글을 등록하지 못했습니다.');
    } finally {
      setIsCommentSubmitting(false);
    }
  };

  const handleAddReply = async (parentId: number) => {
    if (!nickname) return alert("닉네임을 먼저 설정해야 대댓글을 작성할 수 있습니다.");
    if (!replyContent && !replyImage) return alert("내용이나 사진을 입력해주세요.");

    setIsCommentSubmitting(true);
    try {
      await communityApi.createComment(postId, { content: replyContent, imageUrl: replyImage || undefined, parentId });
      await reloadPost();
      setReplyContent('');
      setReplyImage('');
      setReplyingTo(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : '답글을 등록하지 못했습니다.');
    } finally {
      setIsCommentSubmitting(false);
    }
  };

  const handleDeleteComment = async (commentId: number) => {
    if (!post) return;
    if (window.confirm('이 댓글을 삭제하시겠습니까?')) {
      try {
        await communityApi.deleteComment(commentId);
        await reloadPost();
      } catch (err) {
        alert(err instanceof Error ? err.message : '댓글을 삭제하지 못했습니다.');
      }
    }
  };

  if (isLoading) return <div style={{ padding: '100px', textAlign: 'center', color: '#888' }}>게시글을 로딩 중입니다...</div>;
  if (!post) return <div style={{ padding: '100px', textAlign: 'center', color: '#888' }}>게시글을 찾을 수 없습니다.</div>;

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '60px 120px', minHeight: '100vh', backgroundColor: '#f9fafb' }}>
      <button 
        onClick={() => navigate(-1)} 
        style={{ cursor: 'pointer', border: 'none', background: 'none', color: '#888', fontSize: '15px', marginBottom: '20px' }}
      >
        ← 커뮤니티로 돌아가기
      </button>
      
      <div style={{ backgroundColor: '#fff', borderRadius: '24px', padding: '48px', boxShadow: '0 4px 20px rgba(0,0,0,0.05)', marginBottom: '32px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
          <h1 style={{ fontSize: '28px', color: '#222', margin: 0 }}>{post.title}</h1>
          {post.canDelete && (
            <button 
              onClick={handleDeletePost}
              style={{ padding: '6px 12px', border: '1px solid #ff4d4f', backgroundColor: '#fff', color: '#ff4d4f', borderRadius: '8px', fontSize: '13px', cursor: 'pointer' }}
            >
              삭제
            </button>
          )}
        </div>

        <div style={{ color: '#888', fontSize: '14px', marginBottom: '40px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #f0f0f0', paddingBottom: '20px' }}>
          <span>작성자: <strong>{post.author}</strong> | {formatDate(post.date)}</span>
          <span>추천수: <strong style={{ color: '#4CAF4F' }}>{post.likes}</strong> | 조회수: {post.views}</span>
        </div>

        {post.imageUrl && (
          <div style={{ marginBottom: '40px', textAlign: 'center', backgroundColor: '#fdfdfd', borderRadius: '16px', padding: '20px', border: '1px solid #f5f5f5' }}>
            <img 
              src={imageSrc(post.imageUrl)} 
              alt="첨부 이미지" 
              style={{ maxWidth: '100%', borderRadius: '12px', boxShadow: '0 2px 10px rgba(0,0,0,0.05)' }} 
            />
          </div>
        )}

        <div style={{ fontSize: '17px', lineHeight: '1.8', minHeight: '200px', color: '#333', whiteSpace: 'pre-wrap' }}>
          {post.content}
        </div>

        <div style={{ marginTop: '60px', display: 'flex', justifyContent: 'center' }}>
          {/* 추천은 1인 1회다. 서버가 준 liked 를 반영하지 않으면 이미 추천한 글에서도 버튼이
              눌리고, 정상 동작인 거절(409)을 오류 팝업으로 보여주게 된다. */}
          <button
            onClick={handleLike}
            disabled={post.liked}
            title={post.liked ? '이미 추천한 게시글입니다' : ''}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px',
              padding: '20px 48px', borderRadius: '100px', border: '1px solid #4CAF4F',
              backgroundColor: post.liked ? '#4CAF4F' : '#fff', color: post.liked ? '#fff' : '#4CAF4F',
              cursor: post.liked ? 'default' : 'pointer', fontWeight: 'bold',
              transition: '0.2s'
            }}
            onMouseEnter={e => { if (!post.liked) e.currentTarget.style.backgroundColor = '#e8f5e9' }}
            onMouseLeave={e => { if (!post.liked) e.currentTarget.style.backgroundColor = '#fff' }}
          >
            <span style={{ fontSize: '28px' }}>👍</span>
            <span style={{ fontSize: '16px' }}>{post.liked ? '추천함' : '추천'} {post.likes}</span>
          </button>
        </div>
      </div>

      <div style={{ backgroundColor: '#fff', borderRadius: '24px', padding: '48px', boxShadow: '0 4px 20px rgba(0,0,0,0.05)' }}>
        {/* 대댓글도 댓글이다 — 최상위만 세면 실제 개수와 어긋난다 */}
        <h3 style={{ fontSize: '20px', marginBottom: '32px', fontWeight: 'bold' }}>
          댓글 {(post.comments ?? []).reduce((n, c) => n + 1 + (c.replies?.length ?? 0), 0)}
        </h3>
        
        {/* 새 댓글 작성 영역 */}
        <div style={{ marginBottom: '48px', display: 'flex', flexDirection: 'column', gap: '16px', borderBottom: '1px solid #eee', paddingBottom: '32px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', borderRadius: '12px', border: '1px solid #eee', backgroundColor: '#f9fafb', color: '#374151', width: 'fit-content' }}>
            <span style={{ fontSize: '13px', color: '#9ca3af' }}>작성자</span>
            {nicknameLoading
              ? <span style={{ fontSize: '14px', color: '#d1d5db' }}>불러오는 중...</span>
              : <span style={{ fontSize: '14px', fontWeight: '700' }}>{nickname || '닉네임 미설정'}</span>
            }
          </div>

          <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <textarea 
                placeholder={nickname ? "댓글을 남겨보세요." : "닉네임을 설정해야 댓글을 작성할 수 있습니다."} 
                value={commentContent} 
                onChange={e => setCommentContent(e.target.value)}
                disabled={!nickname || nicknameLoading}
                style={{ height: '80px', padding: '16px', borderRadius: '12px', border: '1px solid #eee', resize: 'none', outline: 'none', backgroundColor: (!nickname || nicknameLoading) ? '#f5f5f5' : '#fff' }}
              />
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <label style={{ cursor: (!nickname || nicknameLoading) ? 'not-allowed' : 'pointer', color: '#4CAF4F', fontSize: '14px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <span>📷 사진 첨부</span>
                  <input type="file" accept="image/*" onChange={(e) => handleCommentImageChange(e, false)} disabled={!nickname || nicknameLoading} style={{ display: 'none' }} />
                </label>
                
                {commentImage && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: '#f9fafb', padding: '4px 12px', borderRadius: '20px', border: '1px solid #eee' }}>
                    <span style={{ fontSize: '12px', color: '#555' }}>이미지 첨부됨</span>
                    <button onClick={() => setCommentImage('')} style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: '16px', padding: 0 }}>×</button>
                  </div>
                )}
              </div>
            </div>

            <button 
              onClick={handleAddComment}
              disabled={isCommentSubmitting || nicknameLoading || !nickname}
              style={{ width: '100px', height: '80px', backgroundColor: '#4CAF4F', color: '#fff', border: 'none', borderRadius: '12px', fontWeight: 'bold', cursor: (isCommentSubmitting || nicknameLoading || !nickname) ? 'not-allowed' : 'pointer', opacity: (isCommentSubmitting || nicknameLoading || !nickname) ? 0.6 : 1 }}
            >
              {isCommentSubmitting ? '등록 중...' : '등록'}
            </button>
          </div>
        </div>

        {/* 댓글 목록 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
          {post.comments && post.comments.length > 0 ? (
            [...post.comments].reverse().map(comment => (
              <div key={comment.id} style={{ borderBottom: '1px solid #f9f9f9', paddingBottom: '20px' }}>
                
                {/* 1. 댓글 작성자, 삭제 버튼, 날짜 영역 */}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontWeight: 'bold', color: '#222' }}>{comment.author}</span>
                    {/* ✨ 삭제 버튼을 닉네임 옆으로 복귀 (작은 사이즈) */}
                    {comment.canDelete && (
                      <button 
                        onClick={() => handleDeleteComment(comment.id)}
                        style={{ background: 'none', border: 'none', color: '#ccc', fontSize: '12px', cursor: 'pointer', padding: 0 }}
                      >
                        삭제
                      </button>
                    )}
                  </div>
                  <span style={{ color: '#ccc', fontSize: '12px' }}>{formatDate(comment.date)}</span>
                </div>
                
                {/* 2. 댓글 본문 */}
                <div style={{ fontSize: '15px', color: '#555', lineHeight: '1.6', marginTop: '8px' }}>
                  {comment.content}
                </div>

                {/* 3. 댓글 첨부 이미지 */}
                {comment.imageUrl && (
                  <img src={imageSrc(comment.imageUrl)} alt="댓글 이미지" style={{ marginTop: '12px', maxWidth: '200px', maxHeight: '200px', borderRadius: '8px', border: '1px solid #eee' }} />
                )}

                {/* ✨ 4. 하단 액션 버튼 (답글 달기만 남김) */}
                <div style={{ display: 'flex', gap: '16px', marginTop: '16px', alignItems: 'center' }}>
                  <button 
                    onClick={() => setReplyingTo(replyingTo === comment.id ? null : comment.id)}
                    style={{ background: 'none', border: 'none', color: '#4CAF4F', fontSize: '14px', cursor: 'pointer', padding: 0, fontWeight: 'bold' }}
                  >
                    {replyingTo === comment.id ? '답글 닫기' : '답글 달기'}
                  </button>
                </div>

                {/* 5. 대댓글 입력창 */}
                {replyingTo === comment.id && (
                  <div style={{ marginTop: '16px', padding: '16px', backgroundColor: '#f4fbf6', borderRadius: '12px', borderLeft: '3px solid #4CAF4F' }}>
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <textarea 
                          placeholder={`${comment.author}님에게 답글 남기기...`}
                          value={replyContent} 
                          onChange={e => setReplyContent(e.target.value)}
                          style={{ height: '60px', padding: '12px', borderRadius: '8px', border: '1px solid #ddd', resize: 'none', outline: 'none' }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                          <label style={{ cursor: 'pointer', color: '#4CAF4F', fontSize: '13px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            <span>📷 사진 첨부</span>
                            <input type="file" accept="image/*" onChange={(e) => handleCommentImageChange(e, true)} style={{ display: 'none' }} />
                          </label>
                          {replyImage && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: '#fff', padding: '4px 10px', borderRadius: '20px', border: '1px solid #eee' }}>
                              <span style={{ fontSize: '11px', color: '#555' }}>첨부됨</span>
                              <button onClick={() => setReplyImage('')} style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: '14px', padding: 0 }}>×</button>
                            </div>
                          )}
                        </div>
                      </div>
                      <button 
                        onClick={() => handleAddReply(comment.id)}
                        disabled={isCommentSubmitting || !nickname}
                        style={{ width: '80px', height: '60px', backgroundColor: '#4CAF4F', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}
                      >
                        등록
                      </button>
                    </div>
                  </div>
                )}

                {/* 6. 대댓글 목록 */}
                {comment.replies && comment.replies.length > 0 && (
                  <div style={{ marginTop: '16px', paddingLeft: '16px', borderLeft: '2px solid #eee', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    {comment.replies.map(reply => (
                      <div key={reply.id}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontWeight: 'bold', color: '#444', fontSize: '14px' }}>↳ {reply.author}</span>
                            {/* ✨ 대댓글 삭제 버튼도 닉네임 옆으로 복귀 */}
                            {reply.canDelete && (
                              <button 
                                onClick={() => handleDeleteComment(reply.id)}
                                style={{ background: 'none', border: 'none', color: '#ccc', fontSize: '11px', cursor: 'pointer', padding: 0 }}
                              >
                                삭제
                              </button>
                            )}
                          </div>
                          <span style={{ color: '#ccc', fontSize: '11px' }}>{formatDate(reply.date)}</span>
                        </div>
                        
                        <div style={{ fontSize: '14px', color: '#666', lineHeight: '1.5', paddingLeft: '18px', marginBottom: reply.imageUrl ? '8px' : '0' }}>
                          {reply.content}
                        </div>
                        
                        {reply.imageUrl && (
                          <img src={imageSrc(reply.imageUrl)} alt="대댓글 이미지" style={{ marginLeft: '18px', maxWidth: '150px', maxHeight: '150px', borderRadius: '6px', border: '1px solid #eee' }} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          ) : (
            <div style={{ color: '#bbb', textAlign: 'center', padding: '40px' }}>아직 댓글이 없습니다.</div>
          )}
        </div>
      </div>
    </div>
  );
}
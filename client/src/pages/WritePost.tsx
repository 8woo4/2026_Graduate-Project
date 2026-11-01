import { useState, useEffect, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { API_BASE } from '../utils/api'
import { communityApi, readImageFile } from '../utils/communityApi'

export default function WritePost() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('질문');
  const [content, setContent] = useState('');
  const [image, setImage] = useState('');

  const [nickname, setNickname] = useState<string | null>(null);
  const [nicknameLoading, setNicknameLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 닉네임은 진짜 백엔드 서버에서 불러옵니다.
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
        // 비로그인 or 네트워크 오류
      } finally {
        setNicknameLoading(false);
      }
    };
    
    fetchNickname();
  }, []);

  const handleImageChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      setImage(await readImageFile(file));
    } catch (err) {
      alert(err instanceof Error ? err.message : '사진을 첨부하지 못했습니다');
      input.value = '';
      setImage('');
    }
  };

  const handleSubmit = async () => {
    if (!nickname) return;
    if (!title || !content) return alert('제목과 내용을 입력해주세요!');

    setIsSubmitting(true);
    try {
      await communityApi.createPost({ title, category, content, imageUrl: image || undefined });
      alert('게시글이 성공적으로 등록되었습니다.');
      navigate('/community');
    } catch (err) {
      alert(err instanceof Error ? err.message : '게시글을 등록하지 못했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!nicknameLoading && nickname === null) {
    return (
      <div style={{ fontFamily: 'sans-serif', padding: '60px 20px', minHeight: '100vh', backgroundColor: '#f9fafb', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        <div style={{ textAlign: 'center', backgroundColor: '#fff', borderRadius: '24px', padding: '60px 48px', boxShadow: '0 4px 20px rgba(0,0,0,0.05)', maxWidth: '440px', width: '100%' }}>
          <div style={{ fontSize: '48px', marginBottom: '20px' }}>✏️</div>
          <h2 style={{ fontSize: '20px', fontWeight: '800', color: '#111', marginBottom: '12px' }}>닉네임을 먼저 설정해주세요</h2>
          <p style={{ fontSize: '14px', color: '#6b7280', lineHeight: '1.6', marginBottom: '32px' }}>
            커뮤니티 글쓰기는 닉네임이 필요합니다.<br />
            마이페이지에서 닉네임을 설정한 후 이용해주세요.
          </p>
          <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
            <button
              onClick={() => navigate(-1)}
              style={{ padding: '12px 24px', borderRadius: '12px', border: '1px solid #e5e7eb', backgroundColor: '#fff', color: '#6b7280', fontWeight: '700', fontSize: '14px', cursor: 'pointer' }}
            >
              돌아가기
            </button>
            <button
              onClick={() => navigate('/mypage')}
              style={{ padding: '12px 24px', borderRadius: '12px', border: 'none', backgroundColor: '#4CAF4F', color: '#fff', fontWeight: '700', fontSize: '14px', cursor: 'pointer', boxShadow: '0 4px 12px rgba(76,175,79,0.25)' }}
            >
              마이페이지로 이동
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '60px 20px', minHeight: '100vh', backgroundColor: '#f9fafb', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: '800px', backgroundColor: '#fff', borderRadius: '24px', padding: '48px', boxShadow: '0 4px 20px rgba(0,0,0,0.05)' }}>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
          <h2 style={{ fontSize: '24px', fontWeight: 'bold', color: '#222', margin: 0 }}>새 게시글 작성</h2>
          <button onClick={() => navigate(-1)} style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: '16px' }}>취소</button>
        </div>

        <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', alignItems: 'center' }}>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            style={{ padding: '10px 16px', borderRadius: '12px', border: '1px solid #eee', outline: 'none', backgroundColor: '#fdfdfd', cursor: 'pointer' }}
          >
            <option value="질문">질문</option>
            <option value="뉴스">뉴스</option>
          </select>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px', borderRadius: '12px', border: '1px solid #eee', backgroundColor: '#f9fafb', color: '#374151' }}>
            <span style={{ fontSize: '13px', color: '#9ca3af' }}>작성자</span>
            {nicknameLoading
              ? <span style={{ fontSize: '14px', color: '#d1d5db' }}>불러오는 중...</span>
              : <span style={{ fontSize: '14px', fontWeight: '700' }}>{nickname}</span>
            }
          </div>
        </div>

        <div style={{ marginBottom: '32px' }}>
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '10px 16px',
            borderRadius: '12px', border: '1px solid #4CAF4F', color: '#4CAF4F',
            fontSize: '14px', fontWeight: '600', cursor: 'pointer', backgroundColor: '#fff',
          }}>
            <span>📷 사진 첨부하기</span>
            <input type="file" accept="image/*" onChange={handleImageChange} style={{ display: 'none' }} />
          </label>

          {image && (
            <div style={{ marginTop: '16px', position: 'relative', display: 'inline-block' }}>
              <img src={image} alt="preview" style={{ maxWidth: '100%', maxHeight: '300px', borderRadius: '16px', border: '1px solid #eee' }} />
              <button
                onClick={() => setImage('')}
                style={{ position: 'absolute', top: '10px', right: '10px', backgroundColor: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none', borderRadius: '50%', width: '28px', height: '28px', cursor: 'pointer' }}
              >
                ×
              </button>
            </div>
          )}
        </div>

        <input
          placeholder="제목을 입력하세요"
          value={title}
          onChange={e => setTitle(e.target.value)}
          style={{
            width: '100%', fontSize: '22px', fontWeight: '600', padding: '12px 0',
            border: 'none', borderBottom: '2px solid #f0f0f0', outline: 'none',
            marginBottom: '32px', transition: 'border-color 0.3s',
          }}
          onFocus={e => e.currentTarget.style.borderBottomColor = '#4CAF4F'}
          onBlur={e => e.currentTarget.style.borderBottomColor = '#f0f0f0'}
        />

        <textarea
          placeholder="내용을 입력하세요..."
          value={content}
          onChange={e => setContent(e.target.value)}
          style={{
            width: '100%', height: '350px', border: 'none', outline: 'none',
            fontSize: '16px', lineHeight: '1.6', resize: 'none', color: '#444',
          }}
        />

        <button
          onClick={handleSubmit}
          disabled={!nickname || nicknameLoading || isSubmitting}
          style={{
            width: '100%', padding: '18px', backgroundColor: '#4CAF4F', color: '#fff',
            border: 'none', borderRadius: '16px', fontSize: '18px', fontWeight: 'bold',
            marginTop: '20px', cursor: (!nickname || nicknameLoading || isSubmitting) ? 'not-allowed' : 'pointer', 
            transition: '0.2s',
            boxShadow: '0 4px 12px rgba(76, 175, 79, 0.2)',
            opacity: (!nickname || nicknameLoading || isSubmitting) ? 0.5 : 1,
          }}
          onMouseEnter={e => { if (nickname && !isSubmitting) e.currentTarget.style.backgroundColor = '#3e8e41' }}
          onMouseLeave={e => { if (!isSubmitting) e.currentTarget.style.backgroundColor = '#4CAF4F' }}
        >
          {isSubmitting ? '등록 중...' : '게시글 등록하기'}
        </button>
      </div>
    </div>
  );
}
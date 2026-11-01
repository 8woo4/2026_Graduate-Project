import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { communityApi, formatDate, imageSrc, type CommunityPost } from '../utils/communityApi'

// '인기글' 은 카테고리가 아니라 기준선이다. 탭을 카테고리로만 비교해 이 탭은 항상 비어 있었다.
const POPULAR_MIN_LIKES = 10

export default function Community() {
  const navigate = useNavigate();

  const [postList, setPostList] = useState<CommunityPost[]>([]);
  const [activeTab, setActiveTab] = useState('전체');
  const [activeFilter, setActiveFilter] = useState('최신순');
  const [searchTerm, setSearchTerm] = useState('');
  const [visibleCount, setVisibleCount] = useState(10);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setIsLoading(true);
    communityApi.listPosts()
      .then(setPostList)
      .catch(() => setPostList([]))
      .finally(() => setIsLoading(false));
  }, []);

  const highlightText = (text: string, query: string) => {
    if (!query.trim()) return text;
    const parts = text.split(new RegExp(`(${query})`, 'gi'));
    return (
      <span>
        {parts.map((part, index) => 
          part.toLowerCase() === query.toLowerCase() ? (
            <mark key={index} style={{ backgroundColor: '#4CAF4F', color: '#fff', borderRadius: '2px', padding: '0 2px' }}>{part}</mark>
          ) : (part)
        )}
      </span>
    );
  };

  const filteredPosts = postList.filter(post => {
    const matchesTab =
      activeTab === '전체' ? true
      : activeTab === '인기글' ? post.likes >= POPULAR_MIN_LIKES
      : post.category === activeTab;
    const matchesSearch = post.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                          post.author.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesTab && matchesSearch;
  });

  const sortedPosts = [...filteredPosts].sort((a, b) => {
    // 인기글 탭은 정렬을 추천순으로 고정한다 — 탭 자체가 추천을 기준으로 모은 목록이다
    if (activeTab === '인기글') return b.likes - a.likes;
    if (activeFilter === '최신순') return new Date(b.date).getTime() - new Date(a.date).getTime();
    if (activeFilter === '조회순') return b.views - a.views;
    if (activeFilter === '추천순') return b.likes - a.likes;
    return 0;
  });

  const displayedPosts = sortedPosts.slice(0, visibleCount);

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '40px 120px', minHeight: '100vh', backgroundColor: '#f9fafb' }}>
      <div style={{ backgroundColor: '#fff', borderRadius: '16px', padding: '16px 24px', marginBottom: '24px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center' }}>
        <span style={{ marginRight: '12px', fontSize: '18px' }}>🔍</span>
        <input 
          type="text" placeholder="제목이나 작성자를 검색해보세요" value={searchTerm} 
          onChange={(e) => { setSearchTerm(e.target.value); setVisibleCount(10); }}
          style={{ flex: 1, border: 'none', outline: 'none', fontSize: '15px' }}
        />
      </div>

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', alignItems: 'center' }}>
        {['전체', '인기글', '질문', '뉴스'].map(tab => (
          <button key={tab} onClick={() => { setActiveTab(tab); setVisibleCount(10); }} style={{ padding: '8px 20px', borderRadius: '20px', border: activeTab === tab ? 'none' : '1px solid #ddd', backgroundColor: activeTab === tab ? '#4CAF4F' : '#fff', color: activeTab === tab ? '#fff' : '#555', cursor: 'pointer' }}>{tab}</button>
        ))}
        <div style={{ flex: 1 }} />
        {['최신순', '조회순', '추천순'].map(f => (
          <button key={f} onClick={() => setActiveFilter(f)} style={{ padding: '8px 16px', borderRadius: '20px', border: '1px solid #ddd', backgroundColor: activeFilter === f ? '#e8f5e9' : '#fff', color: activeFilter === f ? '#4CAF4F' : '#888', cursor: 'pointer', fontSize: '13px' }}>{f}</button>
        ))}
      </div>

      <div style={{ backgroundColor: '#fff', borderRadius: '16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 150px 70px 70px', padding: '12px 24px', backgroundColor: '#f5f5f5', fontSize: '13px', color: '#888' }}>
          <span>제목</span><span>작성자</span><span>작성일</span><span style={{textAlign:'center'}}>조회</span><span style={{textAlign:'center'}}>추천</span>
        </div>
        
        {isLoading ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#888' }}>데이터를 불러오는 중입니다...</div>
        ) : displayedPosts.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: '#888' }}>
            {activeTab === '인기글'
              ? `추천 ${POPULAR_MIN_LIKES}회 이상 받은 글이 아직 없습니다.`
              : '게시글이 없습니다. 첫 글을 작성해보세요!'}
          </div>
        ) : (
          displayedPosts.map((post) => (
            <div key={post.id} onClick={() => navigate(`/community/${post.id}`)} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 150px 70px 70px', padding: '16px 24px', borderBottom: '1px solid #f0f0f0', cursor: 'pointer', alignItems: 'center' }}>
              
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', overflow: 'hidden' }}>
                <span style={{ color: '#4CAF4F', fontSize: '12px', flexShrink: 0 }}>[{post.category}]</span>
                
                {post.imageUrl && (
                  <img 
                    src={imageSrc(post.imageUrl)}
                    alt="썸네일" 
                    style={{ width: '36px', height: '36px', objectFit: 'cover', borderRadius: '6px', border: '1px solid #eee', flexShrink: 0 }} 
                  />
                )}
                
                <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {highlightText(post.title, searchTerm)}
                </span>
              </div>

              <span style={{ color: '#888' }}>{highlightText(post.author, searchTerm)}</span>
              <span style={{ color: '#aaa', fontSize: '12px' }}>{formatDate(post.date)}</span>
              <span style={{ color: '#aaa', textAlign: 'center' }}>{post.views}</span>
              <span style={{ color: '#4CAF4F', textAlign: 'center' }}>{post.likes}</span>
            </div>
          ))
        )}
      </div>

      {sortedPosts.length > visibleCount && !isLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '24px' }}>
          <button onClick={() => setVisibleCount(prev => prev + 10)} style={{ padding: '12px 40px', borderRadius: '30px', border: '1px solid #ddd', backgroundColor: '#fff', cursor: 'pointer' }}>더보기 ({displayedPosts.length}/{sortedPosts.length})</button>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
        <button onClick={() => navigate('/community/write')} style={{ backgroundColor: '#4CAF4F', color: '#fff', padding: '10px 24px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer' }}>글쓰기</button>
      </div>
    </div>
  )
}
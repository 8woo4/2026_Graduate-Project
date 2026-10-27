import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { io, type Socket } from 'socket.io-client';
import { formatStockName } from '../utils/formatStockName';
import { pickSubscribeCodes } from '../utils/subscribeCodes';

import { API_BASE, SOCKET_URL } from '../utils/api'
import { isLoggedIn } from '../utils/session'

interface StockData {
  id: number;
  name: string;
  code: string;
  price: string | number;
  change: string | number;
  changeRate: string | number;
  volume: string | number;
  market?: string;
  type?: string; // KOSPI | KOSDAQ | ETF
}


const StockList: React.FC = () => {
  const navigate = useNavigate();
  const loggedIn = isLoggedIn()
  const [stocks, setStocks] = useState<StockData[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  const [selectedMarket, setSelectedMarket] = useState('전체');
  const [favorites, setFavorites] = useState<number[]>([]);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalSearchTerm, setModalSearchTerm] = useState('');
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());

  const fetchStocks = async () => {
    try {
      const response = await axios.get(`${API_BASE}/api/market/stock-prices/all`);
      if (response.data.success) {
        setStocks(response.data.data);
      }
    } catch (error) {
      console.error("데이터 로드 실패:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStocks();
    
    // 관심종목 불러오기 (로그인 시 서버, 비로그인 시 localStorage)
    if (loggedIn) {
      fetch(`${API_BASE}/api/user/favorites`, { credentials: 'include' })
        .then(r => r.json())
        .then(data => { if (Array.isArray(data.stock_ids)) setFavorites(data.stock_ids) })
        .catch(() => {
          const saved = localStorage.getItem('uptick_favs')
          if (saved) setFavorites(JSON.parse(saved))
        })
    } else {
      const saved = localStorage.getItem('uptick_favs')
      if (saved) setFavorites(JSON.parse(saved))
    }

    // 실시간 시세 구독
    const socket = io(SOCKET_URL);
    socketRef.current = socket;
    socket.on('stock:price', (data: {
      code: string; price: number; change: number; changeRate: number; volume: number;
    }) => {
      setStocks(prev => prev.map(stock =>
        stock.code === data.code
          ? { ...stock, price: data.price, change: data.change, changeRate: data.changeRate, volume: data.volume }
          : stock
      ));
    });

    // 재연결되면 서버의 구독 상태(소켓 단위 집합)가 비어 있으므로 다시 올린다.
    socket.on('connect', () => {
      subscribedRef.current.forEach(code => socket.emit('subscribe:stock', code));
    });

    return () => {
      socketRef.current = null;
      subscribedRef.current = new Set();
      // disconnect 하면 서버가 이 소켓의 구독을 전부 해제한다(refCount 감소) — 개별 unsubscribe 불필요
      socket.disconnect();
    };
  }, []);

  const toggleFavorite = (e: React.MouseEvent, id: number) => {
    e.stopPropagation()
    const isAdding = !favorites.includes(id)
    const newFavs = isAdding ? [...favorites, id] : favorites.filter(favId => favId !== id)
    setFavorites(newFavs)

    if (loggedIn) {
      if (isAdding) {
        fetch(`${API_BASE}/api/user/favorites`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stock_id: id }),
        }).catch(() => {})
      } else {
        fetch(`${API_BASE}/api/user/favorites/${id}`, {
          method: 'DELETE',
          credentials: 'include',
        }).catch(() => {})
      }
    } else {
      localStorage.setItem('uptick_favs', JSON.stringify(newFavs))
    }
  }

  // 분류는 서버가 내려주는 type 으로 한다. type 은 stocks.security_group 에서 파생되며
  // 값은 'KOSPI' | 'KOSDAQ' | 'ETF' | '펀드' 뿐이고, ETF·펀드는 시장 값이 아니라 그
  // 유형으로 내려오므로 코스피/코스닥 탭에 섞이지 않는다.
  //
  // 이전 구현은 이름에 KODEX·TIGER·KBSTAR·ACE 가 들어가는지로 ETF 를 추정했는데,
  // (1) 그 운용사 접두어가 없는 ETF 를 놓치고 (2) 코스피 탭에는 ETF 가 그대로 섞였고
  // (3) '펀드' 탭은 marketMap 에 없어 항상 빈 목록이었다.
  const filteredStocks = useMemo(() => {
    const TYPE_OF: Record<string, string> = {
      '코스피': 'KOSPI', '코스닥': 'KOSDAQ', 'ETF': 'ETF', '펀드': '펀드',
    };
    return stocks
      .filter(stock => {
        // 1. 검색어 필터
        const matchSearch = stock.name.toLowerCase().includes(searchTerm.toLowerCase()) || stock.code.includes(searchTerm);

        // 2. 카테고리 필터 — type 이 없는 구버전 응답은 market 으로 떨어진다
        const kind = stock.type ?? stock.market;
        const matchMarket = selectedMarket === '전체' || kind === TYPE_OF[selectedMarket];

        return matchSearch && matchMarket;
      })
      .sort((a, b) => Number(b.volume) - Number(a.volume));
  }, [stocks, searchTerm, selectedMarket]);

  const favoriteStocks = useMemo(() => {
    return favorites.map(id => stocks.find(s => s.id === id)).filter(Boolean) as StockData[];
  }, [stocks, favorites]);

  // ─── 화면에 보이는 종목만 실시간 구독 ──────────────────────
  // 전종목(약 4천)을 밀면 KIS 유량을 다 먹으므로, 증권사와 같은 방식으로 지금 눈에
  // 들어온 종목만 구독한다. 목록은 가상화 없이 전 행을 렌더하므로 '보이는 행'은
  // IntersectionObserver 로 판별한다. 관심종목 패널은 따로 렌더되므로 함께 포함한다.
  const visibleRef = useRef<Set<string>>(new Set());
  const [visibleCodes, setVisibleCodes] = useState<string[]>([]);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const flushRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 스크롤 중에는 교차 이벤트가 연달아 들어온다. 멈춘 뒤 한 번만 상태로 올려
  // 구독 교체와 리렌더가 요동치지 않게 한다.
  const scheduleFlush = () => {
    if (flushRef.current) clearTimeout(flushRef.current);
    flushRef.current = setTimeout(() => setVisibleCodes([...visibleRef.current]), 250);
  };

  const getObserver = () => {
    if (observerRef.current) return observerRef.current;
    if (typeof IntersectionObserver === 'undefined') return null;
    observerRef.current = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const e of entries) {
          const code = (e.target as HTMLElement).dataset.code;
          if (!code) continue;
          if (e.isIntersecting) {
            if (!visibleRef.current.has(code)) { visibleRef.current.add(code); changed = true; }
          } else if (visibleRef.current.delete(code)) {
            changed = true;
          }
        }
        if (changed) scheduleFlush();
      },
      // 화면 조금 밖까지 미리 구독해 스크롤 직후 값이 비어 보이는 구간을 줄인다
      { rootMargin: '240px 0px' },
    );
    return observerRef.current;
  };

  // 행 하나당 ref. 신원이 고정돼야 한다 — 시세가 갱신될 때마다 리렌더되는데,
  // ref 함수가 매번 새로 만들어지면 React 가 전 행의 ref 를 떼었다 붙여 관측이 요동친다.
  // 그래서 종목코드는 클로저가 아니라 data-code 속성에서 읽는다.
  const rowRef = useCallback((el: HTMLTableRowElement | null) => {
    if (!el) return;
    const obs = getObserver();
    if (!obs) return;
    obs.observe(el);
    // React 19 의 ref 정리 함수 — 필터 변경·언마운트로 행이 사라질 때 호출된다
    return () => {
      obs.unobserve(el);
      const code = el.dataset.code;
      if (code && visibleRef.current.delete(code)) scheduleFlush();
    };
  }, []);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (flushRef.current) clearTimeout(flushRef.current);
  }, []);

  const subscribeCodes = useMemo(
    () => pickSubscribeCodes(filteredStocks, visibleCodes, favoriteStocks),
    [visibleCodes, filteredStocks, favoriteStocks],
  );

  useEffect(() => {
    // 검색어를 타이핑하는 동안 구독 집합이 매 글자 바뀌어 subscribe/unsubscribe 가
    // 폭주하지 않도록 잠깐 기다린다.
    const t = setTimeout(() => {
      const socket = socketRef.current;
      if (!socket) return;

      const next = new Set(subscribeCodes);
      const prev = subscribedRef.current;

      for (const code of next) if (!prev.has(code)) socket.emit('subscribe:stock', code);
      for (const code of prev) if (!next.has(code)) socket.emit('unsubscribe:stock', code);

      subscribedRef.current = next;
    }, 400);

    return () => clearTimeout(t);
  }, [subscribeCodes]);

  const formatNum = (val: string | number) => Number(val).toLocaleString();

  const handleManageClick = () => {
    const isActuallyLoggedIn = isLoggedIn(); 
    
    if (!isActuallyLoggedIn) {
      alert("로그인이 필요한 서비스입니다. 로그인 후 나만의 포트폴리오를 관리해보세요!");
      return;
    }
    
    setIsModalOpen(true);
    setModalSearchTerm(''); 
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === dropIndex) return;
    
    const newFavs = [...favorites];
    const draggedItem = newFavs.splice(draggedIdx, 1)[0];
    newFavs.splice(dropIndex, 0, draggedItem);
    
    setFavorites(newFavs)
    setDraggedIdx(null)

    if (loggedIn) {
      fetch(`${API_BASE}/api/user/favorites/reorder`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock_ids: newFavs }),
      }).catch(() => {})
    } else {
      localStorage.setItem('uptick_favs', JSON.stringify(newFavs))
    }
  };

  if (loading) return <div className="flex justify-center items-center h-screen">로딩 중...</div>;

  return (
    <div className="flex gap-8 p-8 bg-gray-50 min-h-screen font-sans text-gray-900 relative">
      
      {/* 왼쪽 사이드바 */}
      <aside className="w-48 shrink-0">
        <h3 className="text-xl font-bold mb-6 text-gray-800">관심종목</h3>
        
        <div className="flex p-1 mb-6 bg-gray-200 rounded-xl">
          <div className="w-full py-1.5 text-center text-sm font-bold rounded-lg bg-[#2ecc71] text-white cursor-default">국내</div>
        </div>
        
        <ul className="space-y-4 font-semibold text-gray-400">
          {['전체', '코스피', '코스닥', 'ETF', '펀드'].map((menu) => (
            <li 
              key={menu}
              onClick={() => setSelectedMarket(menu)}
              className={`pl-3 cursor-pointer transition-all ${selectedMarket === menu ? 'text-gray-900 border-l-4 border-[#2ecc71]' : 'hover:text-gray-600'}`}
            >
              {menu}
            </li>
          ))}
        </ul>
      </aside>

      {/* 메인 콘텐츠 */}
      <main className="flex-1 bg-white p-8 rounded-[32px] shadow-sm border border-gray-100">
        <div className="flex justify-between items-center mb-8">
          <h2 className="text-2xl font-black">국내 종목 리스트</h2>
          <div className="flex items-center px-5 py-2.5 bg-gray-100 rounded-full">
            <input 
              type="text" 
              placeholder="종목명 / 코드 검색" 
              className="bg-transparent outline-none w-56 text-sm"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <span className="text-blue-500">🔍</span>
          </div>
        </div>

        <table className="w-full border-collapse">
          <thead>
            <tr className="text-gray-400 text-sm border-b border-gray-100 italic">
              <th className="pb-4 font-semibold text-left">종목명</th>
              <th className="pb-4 font-semibold text-left">종목코드</th>
              <th className="pb-4 font-semibold text-right">현재가</th>
              <th className="pb-4 font-semibold text-right">전일대비</th>
              <th className="pb-4 font-semibold text-right">등락률</th>
              <th className="pb-4 font-semibold text-right">거래량</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {filteredStocks.map((stock) => (
              <tr
                key={stock.id}
                ref={rowRef}
                data-code={stock.code}
                onClick={() => navigate(`/stock/${stock.id}`)}
                className="hover:bg-gray-50 transition-colors cursor-pointer"
              >
                <td className="py-5 font-bold flex items-center gap-2">
                  {loggedIn && (
                    <span
                      onClick={(e) => toggleFavorite(e, stock.id)}
                      className={`text-xl ${favorites.includes(stock.id) ? 'text-yellow-400' : 'text-gray-200'} hover:scale-125 transition-transform`}
                    >
                      ★
                    </span>
                  )}
                  {formatStockName(stock.name)}
                </td>
                <td className="py-5 text-gray-300 text-xs">{stock.code}</td>
                <td className="py-5 text-right font-black">₩{formatNum(stock.price)}</td>
                <td className={`py-5 text-right font-bold ${Number(stock.change) > 0 ? 'text-red-500' : 'text-blue-500'}`}>
                  {Number(stock.change) > 0 ? '▲' : '▼'} {formatNum(Math.abs(Number(stock.change)))}
                </td>
                <td className={`py-5 text-right font-bold ${Number(stock.change) > 0 ? 'text-red-500' : 'text-blue-500'}`}>
                  {Number(stock.change) > 0 ? '+' : ''}{Number(stock.changeRate).toFixed(2)}%
                </td>
                <td className="py-5 text-right text-gray-400 font-medium">{formatNum(stock.volume)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>

      {/* 오른쪽 사이드바: 즐겨찾기 실시간 반영 */}
      {loggedIn && <aside className="w-64 shrink-0">
        <div className="p-7 bg-white rounded-3xl border border-gray-100 shadow-sm sticky top-8">
          <h3 className="text-sm font-extrabold mb-6 text-gray-800 uppercase tracking-widest">즐겨찾는 나의 종목</h3>
          <div className="space-y-5">
            {favoriteStocks.length > 0 ? favoriteStocks.map(s => (
              <div key={s.id} onClick={() => navigate(`/stock/${s.id}`)} className="flex justify-between items-center text-sm cursor-pointer hover:bg-gray-50 p-1 rounded-lg">
                <span className="font-bold text-gray-700">{formatStockName(s.name)}</span>
                <span className={`font-bold ${Number(s.changeRate) > 0 ? 'text-red-500' : 'text-blue-500'}`}>
                  {Number(s.changeRate) > 0 ? '+' : ''}{Number(s.changeRate).toFixed(2)}%
                </span>
              </div>
            )) : (
              <p className="text-xs text-gray-400 py-4 text-center">별표를 눌러 종목을 추가하세요!</p>
            )}
          </div>
          <button 
            onClick={handleManageClick}
            className="w-full mt-8 py-3.5 bg-[#2ecc71] text-white font-black rounded-2xl hover:bg-[#27ae60] shadow-md shadow-green-100 transition-all"
          >
             종목 관리
          </button>
        </div>
      </aside>}

      {/* 종목 관리 모달 */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-white w-[480px] rounded-[32px] p-8 shadow-2xl relative flex flex-col max-h-[80vh]">
            <button
              onClick={() => setIsModalOpen(false)}
              className="absolute top-6 right-6 text-gray-400 hover:text-gray-800 text-2xl font-bold"
            >
              ×
            </button>

            <h2 className="text-2xl font-black mb-2">나의 종목 관리</h2>
            <p className="text-sm text-gray-500 mb-6">마우스로 드래그하여 순서를 변경하거나 종목을 관리하세요.</p>

            <div className="flex items-center px-4 py-3 bg-gray-100 rounded-xl mb-6">
              <span className="text-gray-400 mr-2">🔍</span>
              <input
                type="text"
                placeholder="추가할 종목 검색..."
                className="bg-transparent outline-none w-full text-sm font-medium"
                value={modalSearchTerm}
                onChange={(e) => setModalSearchTerm(e.target.value)}
              />
            </div>

            <div className="overflow-y-auto flex-1 pr-2 space-y-2">
              {modalSearchTerm ? (
                stocks
                  .filter(s => s.name.toLowerCase().includes(modalSearchTerm.toLowerCase()) || s.code.includes(modalSearchTerm))
                  .slice(0, 10)
                  .map(stock => (
                    <div key={`search-${stock.id}`} className="flex justify-between items-center p-3 bg-gray-50 rounded-xl border border-gray-100">
                      <span className="font-bold text-gray-700">{stock.name} <span className="text-xs text-gray-400 font-normal ml-1">{stock.code}</span></span>
                      <button onClick={(e) => toggleFavorite(e, stock.id)} className="text-xl hover:scale-110 transition-transform">
                        {favorites.includes(stock.id) ? '⭐' : '☆'}
                      </button>
                    </div>
                  ))
              ) : (
                favoriteStocks.length > 0 ? (
                  favoriteStocks.map((stock, index) => (
                    <div
                      key={`fav-${stock.id}`}
                      draggable
                      onDragStart={(e) => { setDraggedIdx(index); e.dataTransfer.effectAllowed = 'move'; }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => handleDrop(e, index)}
                      className={`flex justify-between items-center p-3 bg-white rounded-xl border border-gray-200 shadow-sm cursor-grab active:cursor-grabbing transition-all ${draggedIdx === index ? 'opacity-50 scale-95' : ''}`}
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-gray-300 cursor-grab">⣿</span>
                        <span className="font-bold text-gray-800">{stock.name}</span>
                      </div>
                      <button
                        onClick={(e) => toggleFavorite(e, stock.id)}
                        className="text-gray-400 hover:text-red-500 text-sm font-bold bg-gray-100 hover:bg-red-50 px-3 py-1.5 rounded-lg transition-colors"
                      >
                        삭제
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-10 text-gray-400 font-medium">
                    등록된 관심 종목이 없습니다.<br/>위 검색창에서 종목을 추가해 보세요!
                  </div>
                )
              )}
            </div>

            <button
              onClick={() => setIsModalOpen(false)}
              className="w-full mt-6 py-4 bg-gray-900 text-white font-bold rounded-2xl hover:bg-gray-800 transition-colors"
            >
              완료
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default StockList;
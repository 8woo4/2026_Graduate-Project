import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import Navbar from './components/Navbar'
import LandingPage from './pages/LandingPage'
import StockList from './pages/StockList'
import About from './pages/About'
import Community from './pages/Community'
import PostDetail from './pages/PostDetail'
import WritePost from './pages/WritePost'
import Support from './pages/Support'
import Events from './pages/Events'
import MyPage from './pages/MyPage'
import Register from './pages/Register'
import Login from './pages/Login'
import StockDetail from './pages/StockDetail'
import fpPromise from '@fingerprintjs/fingerprintjs'
// 💡 앞서 만든 설문 페이지 Import (경로가 다르면 수정해주세요)
import Survey from './pages/Survey' 
import AdminDashboard from './pages/AdminDashboard'
import { Toaster } from 'react-hot-toast'
import { API_BASE } from './utils/api'


const isLoggedIn = () => document.cookie.split(';').some(c => c.trim().startsWith('isLoggedIn=true'))

// 관리자 전용 화면 가드 — 화면 노출만 막는 1차 방어이고, 실제 권한 검증은
// 서버의 isAdmin 미들웨어가 담당한다(localStorage 는 사용자가 조작할 수 있음).
const isAdmin = () => {
  try {
    const user = JSON.parse(localStorage.getItem('upTick_user') || '{}')
    return user?.role === 'admin'
  } catch { return false }
}

// 로그인한 일반 계정이 관리자 화면에 들어오려 하면 서버에 한 번 알린 뒤 돌려보낸다.
// 화면 가드는 서버를 거치지 않아 그대로 두면 기록이 남지 않는다. 보고는 클라이언트가 보내므로
// 공격자가 끌 수 있는 관측 신호이고, role 을 조작해 대시보드를 띄운 경우는 서버 isAdmin 이 잡는다.
const AdminRouteDenied = () => {
  const location = useLocation()
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current) return
    sent.current = true
    fetch(`${API_BASE}/api/security/admin-route-denied`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: location.pathname }),
    }).catch(() => undefined)
  }, [])
  return <Navigate to="/" replace />
}

const AdminRoute = ({ children }: { children: React.ReactNode }) => {
  if (!isLoggedIn()) return <Navigate to="/" replace />
  if (!isAdmin()) return <AdminRouteDenied />
  return <>{children}</>
}

// 1. 기존 로그인 체크 가드
const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const [count, setCount] = useState(5)

  useEffect(() => {
    if (!isLoggedIn()) {
      const timer = setInterval(() => {
        setCount(prev => prev - 1)
      }, 1000)
      return () => clearInterval(timer)
    }
  }, [])

  if (!isLoggedIn()) {
    if (count <= 0) return <Navigate to="/login" replace />

    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'sans-serif',
        backgroundColor: '#f9fafb',
      }}>
        <div style={{
          backgroundColor: '#fff',
          borderRadius: '20px',
          padding: '48px 40px',
          textAlign: 'center',
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          width: '400px',
        }}>
          <p style={{ fontSize: '24px', marginBottom: '12px' }}>🔒</p>
          <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#1a1a1a', marginBottom: '12px' }}>
            로그인 후 이용 가능한 서비스입니다
          </h2>
          <p style={{ fontSize: '14px', color: '#888', marginBottom: '24px' }}>
            {count}초 후 로그인 페이지로 이동합니다
          </p>
          <a href="/login" style={{
            display: 'inline-block',
            padding: '12px 32px',
            backgroundColor: '#3CB371',
            color: '#fff',
            borderRadius: '10px',
            fontWeight: '600',
            textDecoration: 'none',
            fontSize: '15px',
          }}>
            지금 로그인하기
          </a>
        </div>
      </div>
    )
  }

  return <>{children}</>
}

// 2. 💡 추가된 설문 체크 가드 (로그인은 통과했으나 설문을 안 한 사람 튕겨내기)
const SurveyGuard = ({ children }: { children: React.ReactNode }) => {
  const userStr = localStorage.getItem('upTick_user')
  const user = userStr ? JSON.parse(userStr) : {}

  // 설문 미완료 + skip도 안 했으면 /survey 강제 이동
  if (!user.is_survey_completed && !user.survey_skipped) {
    return <Navigate to="/survey" replace />
  }

  return <>{children}</>
}

function App() {
  // 앱 실행 시 디바이스 핑거프린트 생성 및 저장
  useEffect(() => {
    const initFingerprint = async () => {
      try {
        const fp = await fpPromise.load()
        const result = await fp.get()
        localStorage.setItem('device_fingerprint', result.visitorId)
      } catch (error) {
        console.error('FingerprintJS 초기화 실패:', error)
      }
    }
    initFingerprint()
  }, [])

  return (
    <BrowserRouter>
      <Toaster />
      <Navbar />
      <Routes>
        {/* 비로그인 접근 가능 영역 */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/register" element={<Register />} />
        <Route path="/login" element={<Login />} />
        <Route path="/about" element={<About />} />
        <Route path="/stock" element={<StockList />} />
        <Route path="/stocks" element={<StockList />} />

        {/* 로그인 필요, 설문 완료 전에도 접근 가능 */}
        <Route path="/survey" element={<ProtectedRoute><Survey /></ProtectedRoute>} />

        {/* 로그인 AND 설문까지 모두 완료해야 접근 가능한 영역들 */}
        <Route path="/stock/:stockId" element={<ProtectedRoute><SurveyGuard><StockDetail /></SurveyGuard></ProtectedRoute>} />
        <Route path="/community" element={<ProtectedRoute><SurveyGuard><Community /></SurveyGuard></ProtectedRoute>} />
        <Route path="/community/:id" element={<ProtectedRoute><SurveyGuard><PostDetail /></SurveyGuard></ProtectedRoute>} />
        <Route path="/community/write" element={<ProtectedRoute><SurveyGuard><WritePost /></SurveyGuard></ProtectedRoute>} />
        <Route path="/support" element={<ProtectedRoute><SurveyGuard><Support /></SurveyGuard></ProtectedRoute>} />
        <Route path="/events" element={<ProtectedRoute><SurveyGuard><Events /></SurveyGuard></ProtectedRoute>} />
        <Route path="/mypage" element={<ProtectedRoute><SurveyGuard><MyPage /></SurveyGuard></ProtectedRoute>} />

        {/* 관리자 보안 대시보드 */}
        <Route path="/admin/security" element={<AdminRoute><AdminDashboard /></AdminRoute>} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
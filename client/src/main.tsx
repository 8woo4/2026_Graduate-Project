import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installTradeSigning } from './utils/tradeSigning'
import { installAuthRetry } from './utils/authRetry'

// 거래 요청 HMAC 자동 서명 인터셉터 등록
installTradeSigning()
// 액세스 토큰 만료(401) 시 1회 갱신 후 재시도. 서명 인터셉터보다 뒤에 등록해
// 재시도 요청도 새 서명을 받도록 한다.
installAuthRetry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

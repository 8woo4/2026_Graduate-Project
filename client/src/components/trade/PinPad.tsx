import { useState, useEffect, useRef } from 'react'
import { buildPadLayout, CLEAR_KEY, BACKSPACE_KEY } from '../../utils/pinKeypadLayout'

interface Props {
  title: string
  subtitle?: string
  onConfirm: (pin: string) => void
  onCancel: () => void
}

const PIN_LENGTH = 6

export default function PinPad({ title, subtitle, onConfirm, onCancel }: Props) {
  const [pin, setPin] = useState('')
  // 마운트마다 한 번 섞는다. 호출부가 오류·재시도 때 key 로 재마운트하므로 재입력마다 새 배열이 된다.
  const [layout] = useState(() => buildPadLayout())
  const submitted = useRef(false)

  const handleKey = (k: string) => {
    if (submitted.current) return
    if (k === BACKSPACE_KEY) {
      setPin(p => p.slice(0, -1))
      return
    }
    if (k === CLEAR_KEY) {
      setPin('')
      return
    }
    if (pin.length >= PIN_LENGTH) return

    const next = pin + k
    setPin(next)

    // 6자리가 채워지면 그 자리에서 제출한다.
    //
    // 예전에는 useEffect([pin]) 에서 제출했는데, effect 는 커밋 이후 비동기로 돌아
    // 부모가 PinPad 를 key 로 재마운트하는 타이밍과 겹쳤다. StrictMode 의 effect
    // 이중 실행까지 얹히면 제출이 두 번 불리거나 단계 전이가 어긋날 수 있다.
    // 입력 시점에 직접 부르면 그 경로가 통째로 사라진다.
    if (next.length === PIN_LENGTH) {
      submitted.current = true
      onConfirm(next)
    }
  }

  // 물리 키보드 숫자 입력은 받지 않는다(키 입력 기록에 PIN 이 남지 않게). ESC 닫기만 허용.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="pinpad-scrim" role="presentation">
      <div className="pinpad-card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="pinpad-head">
          <div style={{ minWidth: 0 }}>
            <div className="pinpad-title">{title}</div>
            {subtitle && <div className="pinpad-sub">{subtitle}</div>}
          </div>
          <button type="button" className="pinpad-close" onClick={onCancel} aria-label="닫기">✕</button>
        </div>

        <div className="pinpad-dots" aria-label={`${pin.length}자리 입력됨`}>
          {Array.from({ length: PIN_LENGTH }).map((_, i) => (
            <span key={i} className={i < pin.length ? 'pinpad-dot on' : 'pinpad-dot'} />
          ))}
        </div>

        <div className="pinpad-grid">
          {layout.map((k, i) => (
            <button
              key={i}
              type="button"
              className={k === CLEAR_KEY || k === BACKSPACE_KEY ? 'pinpad-key fn' : 'pinpad-key'}
              onClick={() => handleKey(k)}
              aria-label={k === CLEAR_KEY ? '전체 삭제' : k === BACKSPACE_KEY ? '지우기' : k}
            >
              {k === CLEAR_KEY ? '전체삭제' : k === BACKSPACE_KEY ? '⌫' : k}
            </button>
          ))}
        </div>

        <div className="pinpad-foot">🔒 보안 키패드 · 열 때마다 숫자 배열이 바뀝니다</div>
      </div>

      <style>{`
        .pinpad-scrim {
          position: fixed; inset: 0; z-index: 10000;
          background: rgba(15, 23, 42, 0.12);
          display: flex; align-items: flex-end; justify-content: flex-end;
          padding: 24px;
        }
        .pinpad-card {
          width: 272px; background: #fff; border-radius: 18px;
          padding: 16px 16px 12px;
          border: 1px solid #e5e7eb;
          box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16);
          animation: pinpad-in 0.18s ease-out;
        }
        .pinpad-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; margin-bottom: 14px; }
        .pinpad-title { font-size: 14px; font-weight: 800; color: #111; }
        .pinpad-sub { font-size: 11.5px; color: #6b7280; margin-top: 2px; line-height: 1.4; word-break: keep-all; }
        .pinpad-close {
          border: none; background: #f3f4f6; color: #6b7280; width: 26px; height: 26px; flex-shrink: 0;
          border-radius: 8px; font-size: 12px; cursor: pointer;
        }
        .pinpad-close:hover { background: #e5e7eb; color: #374151; }
        .pinpad-dots { display: flex; justify-content: center; gap: 10px; margin-bottom: 14px; }
        .pinpad-dot { width: 10px; height: 10px; border-radius: 50%; border: 2px solid #d1d5db; transition: all 0.12s; }
        .pinpad-dot.on { background: #111; border-color: #111; }
        .pinpad-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
        .pinpad-key {
          height: 44px; border: none; border-radius: 10px; background: #f9fafb;
          color: #111; font-size: 18px; font-weight: 600; cursor: pointer;
          user-select: none; -webkit-tap-highlight-color: transparent; transition: background 0.1s, transform 0.08s;
        }
        .pinpad-key:hover { background: #f0fdf4; }
        .pinpad-key:active { transform: scale(0.95); background: #dcfce7; }
        .pinpad-key.fn { background: #f3f4f6; color: #6b7280; font-size: 12px; font-weight: 600; }
        .pinpad-key.fn:hover { background: #e5e7eb; }
        .pinpad-key:focus-visible, .pinpad-close:focus-visible { outline: 2px solid #22c55e; outline-offset: 1px; }
        .pinpad-foot { text-align: center; font-size: 10.5px; color: #9ca3af; margin-top: 10px; }
        @media (max-width: 640px) {
          .pinpad-scrim { padding: 0; justify-content: center; }
          .pinpad-card {
            width: 100%; max-width: 420px; border-radius: 18px 18px 0 0;
            padding-bottom: calc(12px + env(safe-area-inset-bottom));
            animation: pinpad-up 0.2s ease-out;
          }
          .pinpad-key { height: 48px; }
        }
        @keyframes pinpad-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pinpad-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
      `}</style>
    </div>
  )
}

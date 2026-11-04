import { useEffect, useRef, useState } from 'react'
import { Stage, Layer, Line } from 'react-konva'

type Tool = 'pen' | 'eraser' | 'hand'
type Stroke = { id: number; points: number[]; color: string; width: number }
type Pt = { x: number; y: number }

const COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b']
const WIDTHS = [2, 5, 10]

function segDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1
  const l2 = dx * dx + dy * dy
  let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function hit(s: Stroke, p: Pt, r: number) {
  const a = s.points
  for (let i = 0; i < a.length; i += 2) {
    const x2 = i + 2 < a.length ? a[i + 2] : a[i]
    const y2 = i + 2 < a.length ? a[i + 3] : a[i + 1]
    if (segDist(p.x, p.y, a[i], a[i + 1], x2, y2) <= r + s.width / 2) return true
  }
  return false
}

const clampScale = (s: number) => Math.max(0.1, Math.min(8, s))

export default function App() {
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [undoStack, setUndoStack] = useState<Stroke[][]>([])
  const [redoStack, setRedoStack] = useState<Stroke[][]>([])
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(COLORS[0])
  const [width, setWidth] = useState(WIDTHS[1])
  const [view, setView] = useState({ x: 0, y: 0, s: 1 })
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })

  const strokesRef = useRef<Stroke[]>([])
  const viewRef = useRef(view)
  const pointers = useRef(new Map<number, Pt>())
  const gesture = useRef<{ d: number; cx: number; cy: number } | null>(null)
  const drawingId = useRef<number | null>(null)
  const erasing = useRef(false)
  const changed = useRef(false)
  const before = useRef<Stroke[]>([])
  const nextId = useRef(1)

  useEffect(() => {
    const f = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', f)
    return () => window.removeEventListener('resize', f)
  }, [])

  const update = (next: Stroke[]) => { strokesRef.current = next; setStrokes(next) }
  const setViewNow = (v: { x: number; y: number; s: number }) => { viewRef.current = v; setView(v) }
  const pushUndo = (snap: Stroke[]) => { setUndoStack(u => [...u, snap]); setRedoStack([]) }
  const toCanvas = (cx: number, cy: number): Pt => {
    const v = viewRef.current
    return { x: (cx - v.x) / v.s, y: (cy - v.y) / v.s }
  }

  const eraseAt = (p: Pt) => {
    const r = 14 / viewRef.current.s
    const cur = strokesRef.current
    const next = cur.filter(s => !hit(s, p, r))
    if (next.length !== cur.length) { update(next); changed.current = true }
  }

  const finishAction = () => {
    if (drawingId.current !== null) { pushUndo(before.current); drawingId.current = null }
    if (erasing.current) {
      if (changed.current) pushUndo(before.current)
      erasing.current = false
      changed.current = false
    }
  }

  const cancelDrawing = () => {
    if (drawingId.current !== null) {
      const id = drawingId.current
      update(strokesRef.current.filter(s => s.id !== id))
      drawingId.current = null
    }
    if (erasing.current) {
      if (changed.current) pushUndo(before.current)
      erasing.current = false
      changed.current = false
    }
  }

  const startGesture = () => {
    const [a, b] = [...pointers.current.values()]
    gesture.current = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
  }

  const doGesture = () => {
    const [a, b] = [...pointers.current.values()]
    const g = gesture.current
    if (!g || g.d === 0) return
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2
    const v = viewRef.current
    const s = clampScale(v.s * (d / g.d))
    const cp = { x: (g.cx - v.x) / v.s, y: (g.cy - v.y) / v.s }
    setViewNow({ s, x: cx - cp.x * s, y: cy - cp.y * s })
    gesture.current = { d, cx, cy }
  }

  const onDown = (e: React.PointerEvent) => {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) { cancelDrawing(); startGesture(); return }
    if (pointers.current.size > 2 || tool === 'hand') return
    const p = toCanvas(e.clientX, e.clientY)
    before.current = strokesRef.current
    if (tool === 'pen') {
      const s: Stroke = { id: nextId.current++, points: [p.x, p.y, p.x + 0.01, p.y], color, width }
      update([...strokesRef.current, s])
      drawingId.current = s.id
    } else {
      erasing.current = true
      eraseAt(p)
    }
  }

  const onMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) { doGesture(); return }
    if (pointers.current.size !== 1) return
    if (tool === 'hand') {
      const v = viewRef.current
      setViewNow({ ...v, x: v.x + (e.clientX - prev.x), y: v.y + (e.clientY - prev.y) })
      return
    }
    const p = toCanvas(e.clientX, e.clientY)
    if (drawingId.current !== null) {
      const id = drawingId.current
      update(strokesRef.current.map(s => (s.id === id ? { ...s, points: [...s.points, p.x, p.y] } : s)))
    } else if (erasing.current) {
      eraseAt(p)
    }
  }

  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) gesture.current = null
    finishAction()
  }

  const onWheel = (e: React.WheelEvent) => {
    const f = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const v = viewRef.current
    const s = clampScale(v.s * f)
    const k = s / v.s
    setViewNow({ s, x: e.clientX - (e.clientX - v.x) * k, y: e.clientY - (e.clientY - v.y) * k })
  }

  const undo = () => {
    if (!undoStack.length) return
    setRedoStack(r => [...r, strokesRef.current])
    update(undoStack[undoStack.length - 1])
    setUndoStack(u => u.slice(0, -1))
  }

  const redo = () => {
    if (!redoStack.length) return
    setUndoStack(u => [...u, strokesRef.current])
    update(redoStack[redoStack.length - 1])
    setRedoStack(r => r.slice(0, -1))
  }

  const clearAll = () => {
    if (!strokesRef.current.length) return
    if (!window.confirm('পুরো বোর্ড মুছে ফেলবে?')) return
    pushUndo(strokesRef.current)
    update([])
  }

  return (
    <>
      <div
        className="board"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onWheel={onWheel}
      >
        <Stage width={size.w} height={size.h} x={view.x} y={view.y} scaleX={view.s} scaleY={view.s} listening={false}>
          <Layer listening={false}>
            {strokes.map(s => (
              <Line key={s.id} points={s.points} stroke={s.color} strokeWidth={s.width}
                lineCap="round" lineJoin="round" tension={0.3} />
            ))}
          </Layer>
        </Stage>
      </div>

      <div className="bar">
        <button className={'btn' + (tool === 'pen' ? ' on' : '')} onClick={() => setTool('pen')}>✏️</button>
        <button className={'btn' + (tool === 'eraser' ? ' on' : '')} onClick={() => setTool('eraser')}>🧽</button>
        <button className={'btn' + (tool === 'hand' ? ' on' : '')} onClick={() => setTool('hand')}>✋</button>
        <div className="sep" />
        <button className="btn" onClick={undo} disabled={!undoStack.length}>↩️</button>
        <button className="btn" onClick={redo} disabled={!redoStack.length}>↪️</button>
        <div className="sep" />
        {COLORS.map(c => (
          <button key={c} className={'dot' + (color === c ? ' on' : '')} style={{ background: c }}
            onClick={() => { setColor(c); setTool('pen') }} />
        ))}
        <div className="sep" />
        {WIDTHS.map(w => (
          <button key={w} className={'btn' + (width === w ? ' on' : '')} onClick={() => { setWidth(w); setTool('pen') }}>
            <span style={{ width: w + 6, height: w + 6, borderRadius: '50%', background: '#111827', display: 'block' }} />
          </button>
        ))}
        <div className="sep" />
        <button className="btn" onClick={() => setViewNow({ x: 0, y: 0, s: 1 })}>🎯</button>
        <button className="btn" onClick={clearAll}>🗑️</button>
      </div>
    </>
  )
}

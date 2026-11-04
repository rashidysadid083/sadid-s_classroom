import { useEffect, useRef, useState } from 'react'
import Konva from 'konva'
import { Stage, Layer, Line, Rect, Ellipse, Arrow, Text, Circle } from 'react-konva'

type Tool = 'select' | 'pen' | 'eraser' | 'hand' | 'text' | 'rect' | 'ellipse' | 'triangle' | 'diamond' | 'line' | 'arrow' | 'connect'
type Kind = 'rect' | 'ellipse' | 'triangle' | 'diamond'
type Pt = { x: number; y: number }
type Box = { x: number; y: number; w: number; h: number }
type Base = { id: number; color: string }
type StrokeEl = Base & { type: 'stroke'; points: number[]; sw: number }
type ShapeEl = Base & { type: 'shape'; kind: Kind; x: number; y: number; w: number; h: number; sw: number; fill: string | null }
type LineEl = Base & {
  type: 'line'; arrow: boolean; x1: number; y1: number; x2: number; y2: number; sw: number
  conn?: boolean; a?: number; b?: number
}
type TextEl = Base & { type: 'text'; x: number; y: number; text: string; size: number }
type El = StrokeEl | ShapeEl | LineEl | TextEl

type Act =
  | { t: 'pan' }
  | { t: 'draw' }
  | { t: 'erase' }
  | { t: 'text'; p: Pt }
  | { t: 'create'; id: number; start: Pt }
  | { t: 'move'; id: number; orig: El; start: Pt; moved: boolean; wasSel: boolean }
  | { t: 'resize'; id: number; orig: El; ob: Box; anchor: Pt }
  | { t: 'end'; id: number; i: number }

const COLORS = ['#111827', '#dc2626', '#2563eb', '#16a34a', '#f59e0b']
const WIDTHS = [2, 5, 10]
const FONT = '"Noto Sans Bengali","Hind Siliguri",system-ui,sans-serif'
const clampScale = (s: number) => Math.max(0.1, Math.min(8, s))

function segDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1
  const l2 = dx * dx + dy * dy
  let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function measureText(text: string, size: number) {
  const k = new Konva.Text({ text, fontSize: size, fontFamily: FONT })
  return { w: k.width(), h: k.height() }
}

function shapePoly(el: ShapeEl): number[] {
  const { x, y, w, h } = el
  if (el.kind === 'rect') return [x, y, x + w, y, x + w, y + h, x, y + h]
  if (el.kind === 'triangle') return [x + w / 2, y, x + w, y + h, x, y + h]
  if (el.kind === 'diamond') return [x + w / 2, y, x + w, y + h / 2, x + w / 2, y + h, x, y + h / 2]
  const pts: number[] = []
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2
    pts.push(x + w / 2 + (Math.cos(a) * w) / 2, y + h / 2 + (Math.sin(a) * h) / 2)
  }
  return pts
}

function inPoly(p: Pt, poly: number[]) {
  let inside = false
  const n = poly.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1]
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function bbox(el: El): Box {
  if (el.type === 'shape') return { x: el.x, y: el.y, w: el.w, h: el.h }
  if (el.type === 'line') {
    return { x: Math.min(el.x1, el.x2), y: Math.min(el.y1, el.y2), w: Math.abs(el.x2 - el.x1), h: Math.abs(el.y2 - el.y1) }
  }
  if (el.type === 'text') {
    const m = measureText(el.text, el.size)
    return { x: el.x, y: el.y, w: m.w, h: m.h }
  }
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (let i = 0; i < el.points.length; i += 2) {
    x1 = Math.min(x1, el.points[i]); x2 = Math.max(x2, el.points[i])
    y1 = Math.min(y1, el.points[i + 1]); y2 = Math.max(y2, el.points[i + 1])
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

// ---- কানেকশন লজিক ----
function edgePoint(el: El, toward: Pt): Pt {
  const b = bbox(el)
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const dx = toward.x - c.x, dy = toward.y - c.y
  if (!dx && !dy) return c
  const hw = Math.max(b.w / 2, 1), hh = Math.max(b.h / 2, 1)
  let t: number
  if (el.type === 'shape' && el.kind === 'ellipse') t = 1 / Math.hypot(dx / hw, dy / hh)
  else if (el.type === 'shape' && el.kind === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
  else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity)
  t = Math.min(t, 1)
  return { x: c.x + dx * t, y: c.y + dy * t }
}

function resolveLine(l: LineEl, list: El[]): LineEl {
  if (l.a === undefined && l.b === undefined) return l
  const na = l.a !== undefined ? list.find(x => x.id === l.a && x.type !== 'line') : undefined
  const nb = l.b !== undefined ? list.find(x => x.id === l.b && x.type !== 'line') : undefined
  const ca = na ? bbox(na) : null
  const cb = nb ? bbox(nb) : null
  const sa: Pt = ca ? { x: ca.x + ca.w / 2, y: ca.y + ca.h / 2 } : { x: l.x1, y: l.y1 }
  const sb: Pt = cb ? { x: cb.x + cb.w / 2, y: cb.y + cb.h / 2 } : { x: l.x2, y: l.y2 }
  const p1 = na ? edgePoint(na, sb) : sa
  const p2 = nb ? edgePoint(nb, sa) : sb
  return { ...l, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }
}

function res(e: El, list: El[]): El {
  return e.type === 'line' ? resolveLine(e, list) : e
}

function removeNodes(list: El[], ids: number[]): El[] {
  const rest = list.filter(e => !ids.includes(e.id))
  return rest.map(e => {
    if (e.type !== 'line') return e
    const aGone = e.a !== undefined && ids.includes(e.a)
    const bGone = e.b !== undefined && ids.includes(e.b)
    if (!aGone && !bGone) return e
    const r = resolveLine(e, list)
    return { ...e, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, a: aGone ? undefined : e.a, b: bGone ? undefined : e.b }
  })
}

function hitEl(el: El, p: Pt, r: number): boolean {
  if (el.type === 'stroke') {
    const a = el.points
    for (let i = 0; i < a.length; i += 2) {
      const x2 = i + 2 < a.length ? a[i + 2] : a[i]
      const y2 = i + 2 < a.length ? a[i + 3] : a[i + 1]
      if (segDist(p.x, p.y, a[i], a[i + 1], x2, y2) <= r + el.sw / 2) return true
    }
    return false
  }
  if (el.type === 'line') return segDist(p.x, p.y, el.x1, el.y1, el.x2, el.y2) <= r + el.sw / 2
  if (el.type === 'text') {
    const b = bbox(el)
    return p.x >= b.x - r && p.x <= b.x + b.w + r && p.y >= b.y - r && p.y <= b.y + b.h + r
  }
  const poly = shapePoly(el)
  const n = poly.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    if (segDist(p.x, p.y, poly[i * 2], poly[i * 2 + 1], poly[j * 2], poly[j * 2 + 1]) <= r + el.sw / 2) return true
  }
  return !!el.fill && inPoly(p, poly)
}

function translate(el: El, dx: number, dy: number): El {
  if (el.type === 'stroke') return { ...el, points: el.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) }
  if (el.type === 'shape' || el.type === 'text') return { ...el, x: el.x + dx, y: el.y + dy }
  return { ...el, x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy }
}

function corners(b: Box): Pt[] {
  return [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ]
}

function handlePts(el: El): Pt[] {
  if (el.type === 'line') return [{ x: el.x1, y: el.y1 }, { x: el.x2, y: el.y2 }]
  return corners(bbox(el))
}

function applyBox(o: El, ob: Box, nb: Box, anchor: Pt, p: Pt): El {
  if (o.type === 'shape') return { ...o, x: nb.x, y: nb.y, w: nb.w, h: nb.h }
  if (o.type === 'stroke') {
    const sx = ob.w ? nb.w / ob.w : 1
    const sy = ob.h ? nb.h / ob.h : 1
    return { ...o, points: o.points.map((v, i) => (i % 2 === 0 ? nb.x + (v - ob.x) * sx : nb.y + (v - ob.y) * sy)) }
  }
  if (o.type === 'text') {
    const s = ob.w ? nb.w / ob.w : 1
    const size = Math.max(8, Math.min(400, o.size * s))
    const k = size / o.size
    const w = ob.w * k, h = ob.h * k
    return { ...o, size, x: p.x < anchor.x ? anchor.x - w : anchor.x, y: p.y < anchor.y ? anchor.y - h : anchor.y }
  }
  return o
}

function recolor(el: El, c: string): El {
  if (el.type === 'shape') return { ...el, color: c, fill: el.fill ? c + '33' : null }
  return { ...el, color: c }
}

export default function App() {
  const [els, setEls] = useState<El[]>([])
  const [undoStack, setUndoStack] = useState<El[][]>([])
  const [redoStack, setRedoStack] = useState<El[][]>([])
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(COLORS[0])
  const [width, setWidth] = useState(WIDTHS[1])
  const [fillOn, setFillOn] = useState(false)
  const [view, setView] = useState({ x: 0, y: 0, s: 1 })
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [hoverId, setHoverId] = useState<number | null>(null)
  const [edit, setEdit] = useState<{ id: number | null; x: number; y: number; value: string } | null>(null)

  const elsRef = useRef<El[]>([])
  const viewRef = useRef(view)
  const selectedRef = useRef<number | null>(null)
  const pointers = useRef(new Map<number, Pt>())
  const gesture = useRef<{ d: number; cx: number; cy: number } | null>(null)
  const act = useRef<Act | null>(null)
  const changed = useRef(false)
  const before = useRef<El[]>([])
  const down = useRef<Pt>({ x: 0, y: 0 })
  const nextId = useRef(1)

  useEffect(() => {
    const f = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', f)
    return () => window.removeEventListener('resize', f)
  }, [])

  const update = (next: El[]) => { elsRef.current = next; setEls(next) }
  const replace = (id: number, el: El) => update(elsRef.current.map(x => (x.id === id ? el : x)))
  const setViewNow = (v: { x: number; y: number; s: number }) => { viewRef.current = v; setView(v) }
  const pushUndo = (snap: El[]) => { setUndoStack(u => [...u, snap]); setRedoStack([]) }
  const select = (id: number | null) => { selectedRef.current = id; setSelectedId(id) }
  const toCanvas = (cx: number, cy: number): Pt => {
    const v = viewRef.current
    return { x: (cx - v.x) / v.s, y: (cy - v.y) / v.s }
  }
  const chooseTool = (t: Tool) => { setTool(t); if (t !== 'select') select(null) }

  const nodeAt = (p: Pt, exclude?: number): El | undefined => {
    const list = elsRef.current
    const r = 8 / viewRef.current.s
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]
      if ((e.type === 'shape' || e.type === 'text') && e.id !== exclude) {
        const b = bbox(e)
        if (p.x >= b.x - r && p.x <= b.x + b.w + r && p.y >= b.y - r && p.y <= b.y + b.h + r) return e
      }
    }
    return undefined
  }

  const eraseAt = (p: Pt) => {
    const r = 14 / viewRef.current.s
    const cur = elsRef.current
    const ids = cur.filter(e => hitEl(res(e, cur), p, r)).map(e => e.id)
    if (ids.length) { update(removeNodes(cur, ids)); changed.current = true }
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

  const cancelAct = () => {
    const a = act.current
    act.current = null
    setHoverId(null)
    if (!a) return
    if (a.t === 'erase') {
      if (changed.current) pushUndo(before.current)
      changed.current = false
    } else if (a.t !== 'pan' && a.t !== 'text') {
      update(before.current)
      if (a.t === 'create') select(null)
    }
  }

  const openEdit = (id: number | null, x: number, y: number, value: string) => setEdit({ id, x, y, value })

  const onDown = (e: React.PointerEvent) => {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) { cancelAct(); startGesture(); return }
    if (pointers.current.size > 2) return

    const p = toCanvas(e.clientX, e.clientY)
    const v = viewRef.current
    before.current = elsRef.current
    down.current = { x: e.clientX, y: e.clientY }

    if (tool === 'hand') { act.current = { t: 'pan' }; return }

    if (tool === 'pen') {
      const id = nextId.current++
      update([...elsRef.current, { id, type: 'stroke', points: [p.x, p.y, p.x + 0.01, p.y], color, sw: width }])
      act.current = { t: 'draw' }
      return
    }

    if (tool === 'eraser') { act.current = { t: 'erase' }; changed.current = false; eraseAt(p); return }

    if (tool === 'text') { act.current = { t: 'text', p }; return }

    if (tool === 'select') {
      const sel0 = elsRef.current.find(x => x.id === selectedRef.current)
      const sel = sel0 ? res(sel0, elsRef.current) : undefined
      if (sel) {
        const hp = handlePts(sel)
        for (let i = 0; i < hp.length; i++) {
          if (Math.hypot(p.x - hp[i].x, p.y - hp[i].y) <= 26 / v.s) {
            if (sel.type === 'line') act.current = { t: 'end', id: sel.id, i }
            else act.current = { t: 'resize', id: sel.id, orig: sel, ob: bbox(sel), anchor: hp[(i + 2) % 4] }
            return
          }
        }
      }
      const list = elsRef.current
      for (let i = list.length - 1; i >= 0; i--) {
        if (hitEl(res(list[i], list), p, 10 / v.s)) {
          const wasSel = list[i].id === selectedRef.current
          select(list[i].id)
          act.current = { t: 'move', id: list[i].id, orig: list[i], start: p, moved: false, wasSel }
          return
        }
      }
      select(null)
      act.current = { t: 'pan' }
      return
    }

    if (tool === 'connect') {
      const n = nodeAt(p)
      const id = nextId.current++
      const el: LineEl = { id, type: 'line', arrow: true, conn: true, a: n ? n.id : undefined, b: undefined, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, sw: width }
      update([...elsRef.current, el])
      act.current = { t: 'create', id, start: p }
      return
    }

    // শেপ / লাইন / তীর তৈরি
    const id = nextId.current++
    let el: El
    if (tool === 'line' || tool === 'arrow') {
      el = { id, type: 'line', arrow: tool === 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, color, sw: width }
    } else {
      el = { id, type: 'shape', kind: tool as Kind, x: p.x, y: p.y, w: 0, h: 0, color, sw: width, fill: fillOn ? color + '33' : null }
    }
    update([...elsRef.current, el])
    select(id)
    act.current = { t: 'create', id, start: p }
  }

  const onMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) { doGesture(); return }
    if (pointers.current.size !== 1) return
    const a = act.current
    if (!a) return
    const p = toCanvas(e.clientX, e.clientY)

    if (a.t === 'pan') {
      const v = viewRef.current
      setViewNow({ ...v, x: v.x + (e.clientX - prev.x), y: v.y + (e.clientY - prev.y) })
    } else if (a.t === 'draw') {
      const list = elsRef.current
      const last = list[list.length - 1]
      if (last && last.type === 'stroke') replace(last.id, { ...last, points: [...last.points, p.x, p.y] })
    } else if (a.t === 'erase') {
      eraseAt(p)
    } else if (a.t === 'move') {
      if (a.orig.type === 'line' && (a.orig.a !== undefined || a.orig.b !== undefined)) return
      if (!a.moved && Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) < 6) return
      a.moved = true
      replace(a.id, translate(a.orig, p.x - a.start.x, p.y - a.start.y))
    } else if (a.t === 'resize') {
      const w = Math.max(4, Math.abs(p.x - a.anchor.x))
      const h = Math.max(4, Math.abs(p.y - a.anchor.y))
      const nb = { x: p.x < a.anchor.x ? a.anchor.x - w : a.anchor.x, y: p.y < a.anchor.y ? a.anchor.y - h : a.anchor.y, w, h }
      replace(a.id, applyBox(a.orig, a.ob, nb, a.anchor, p))
    } else if (a.t === 'end') {
      const el = elsRef.current.find(x => x.id === a.id)
      if (el && el.type === 'line') {
        if (el.conn) {
          const other = a.i === 0 ? el.b : el.a
          const n = nodeAt(p, other)
          setHoverId(n ? n.id : null)
          replace(a.id, a.i === 0
            ? { ...el, x1: p.x, y1: p.y, a: n ? n.id : undefined }
            : { ...el, x2: p.x, y2: p.y, b: n ? n.id : undefined })
        } else {
          replace(a.id, a.i === 0 ? { ...el, x1: p.x, y1: p.y } : { ...el, x2: p.x, y2: p.y })
        }
      }
    } else if (a.t === 'create') {
      const el = elsRef.current.find(x => x.id === a.id)
      if (!el) return
      if (el.type === 'shape') {
        replace(a.id, { ...el, x: Math.min(a.start.x, p.x), y: Math.min(a.start.y, p.y), w: Math.abs(p.x - a.start.x), h: Math.abs(p.y - a.start.y) })
      } else if (el.type === 'line') {
        if (el.conn) {
          const n = nodeAt(p, el.a)
          setHoverId(n ? n.id : null)
          replace(a.id, { ...el, x2: p.x, y2: p.y, b: n ? n.id : undefined })
        } else {
          replace(a.id, { ...el, x2: p.x, y2: p.y })
        }
      }
    }
  }

  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) gesture.current = null
    const a = act.current
    if (!a) return
    act.current = null
    setHoverId(null)

    if (a.t === 'draw') pushUndo(before.current)
    else if (a.t === 'erase') { if (changed.current) pushUndo(before.current); changed.current = false }
    else if (a.t === 'move') {
      if (a.moved) pushUndo(before.current)
      else if (a.wasSel && a.orig.type === 'text') openEdit(a.orig.id, a.orig.x, a.orig.y, a.orig.text)
    } else if (a.t === 'resize' || a.t === 'end') {
      if (elsRef.current !== before.current) pushUndo(before.current)
    } else if (a.t === 'text') {
      openEdit(null, a.p.x, a.p.y, '')
    } else if (a.t === 'create') {
      const el = elsRef.current.find(x => x.id === a.id)
      if (!el) return
      if (el.type === 'line' && el.conn) {
        const len = Math.hypot(el.x2 - el.x1, el.y2 - el.y1)
        if (el.b === undefined && len < 6 / viewRef.current.s) update(before.current)
        else pushUndo(before.current)
        select(null)
      } else {
        let fixed: El = el
        if (el.type === 'shape' && el.w < 6 && el.h < 6) fixed = { ...el, x: el.x - 70, y: el.y - 45, w: 140, h: 90 }
        if (el.type === 'line' && Math.hypot(el.x2 - el.x1, el.y2 - el.y1) < 6) fixed = { ...el, x2: el.x1 + 140 }
        replace(a.id, fixed)
        pushUndo(before.current)
        setTool('select')
        select(a.id)
      }
    }
  }

  const onWheel = (e: React.WheelEvent) => {
    const f = e.deltaY < 0 ? 1.1 : 1 / 1.1
    const v = viewRef.current
    const s = clampScale(v.s * f)
    const k = s / v.s
    setViewNow({ s, x: e.clientX - (e.clientX - v.x) * k, y: e.clientY - (e.clientY - v.y) * k })
  }

  const dropSelectionIfGone = (next: El[]) => {
    if (selectedRef.current !== null && !next.some(x => x.id === selectedRef.current)) select(null)
  }

  const undo = () => {
    if (!undoStack.length) return
    const target = undoStack[undoStack.length - 1]
    setRedoStack(r => [...r, elsRef.current])
    setUndoStack(u => u.slice(0, -1))
    update(target)
    dropSelectionIfGone(target)
  }

  const redo = () => {
    if (!redoStack.length) return
    const target = redoStack[redoStack.length - 1]
    setUndoStack(u => [...u, elsRef.current])
    setRedoStack(r => r.slice(0, -1))
    update(target)
    dropSelectionIfGone(target)
  }

  const mutateSel = (fn: (el: El) => El) => {
    const id = selectedRef.current
    if (id === null) return
    const el = elsRef.current.find(x => x.id === id)
    if (!el) return
    const next = fn(el)
    if (next === el) return
    pushUndo(elsRef.current)
    replace(id, next)
  }

  const autoPen = () => {
    if (selectedRef.current === null && (tool === 'eraser' || tool === 'hand' || tool === 'select')) chooseTool('pen')
  }

  const applyColor = (c: string) => { setColor(c); mutateSel(el => recolor(el, c)); autoPen() }
  const applyWidth = (w: number) => { setWidth(w); mutateSel(el => (el.type === 'text' ? el : { ...el, sw: w })); autoPen() }
  const toggleFill = () => {
    const nf = !fillOn
    setFillOn(nf)
    mutateSel(el => (el.type === 'shape' ? { ...el, fill: nf ? el.color + '33' : null } : el))
  }
  const changeText = (k: number) =>
    mutateSel(el => (el.type === 'text' ? { ...el, size: Math.max(8, Math.min(400, el.size * k)) } : el))

  const deleteSel = () => {
    const id = selectedRef.current
    if (id === null) return
    pushUndo(elsRef.current)
    update(removeNodes(elsRef.current, [id]))
    select(null)
  }

  const duplicateSel = () => {
    const el = elsRef.current.find(x => x.id === selectedRef.current)
    if (!el) return
    const base = res(el, elsRef.current)
    const copy = { ...translate(base, 24, 24), id: nextId.current++ } as El
    if (copy.type === 'line') { copy.a = undefined; copy.b = undefined }
    pushUndo(elsRef.current)
    update([...elsRef.current, copy])
    select(copy.id)
  }

  const clearAll = () => {
    if (!elsRef.current.length) return
    if (!window.confirm('পুরো বোর্ড মুছে ফেলবে?')) return
    pushUndo(elsRef.current)
    update([])
    select(null)
  }

  const saveEdit = () => {
    if (!edit) return
    const v = edit.value
    if (edit.id !== null) {
      pushUndo(elsRef.current)
      if (v.trim() === '') {
        update(removeNodes(elsRef.current, [edit.id]))
        select(null)
      } else {
        update(elsRef.current.map(x => (x.id === edit.id && x.type === 'text' ? { ...x, text: v } : x)))
      }
    } else if (v.trim() !== '') {
      const id = nextId.current++
      pushUndo(elsRef.current)
      update([...elsRef.current, { id, type: 'text', x: edit.x, y: edit.y, text: v, size: 28, color }])
      setTool('select')
      select(id)
    }
    setEdit(null)
  }

  const renderEl = (el0: El) => {
    const el = res(el0, els)
    if (el.type === 'stroke')
      return <Line key={el.id} points={el.points} stroke={el.color} strokeWidth={el.sw} lineCap="round" lineJoin="round" tension={0.3} />
    if (el.type === 'line') {
      if (el.arrow)
        return (
          <Arrow key={el.id} points={[el.x1, el.y1, el.x2, el.y2]} stroke={el.color} fill={el.color} strokeWidth={el.sw}
            pointerLength={el.sw * 3 + 8} pointerWidth={el.sw * 3 + 8} lineCap="round" />
        )
      return <Line key={el.id} points={[el.x1, el.y1, el.x2, el.y2]} stroke={el.color} strokeWidth={el.sw} lineCap="round" />
    }
    if (el.type === 'text')
      return <Text key={el.id} x={el.x} y={el.y} text={el.text} fontSize={el.size} fontFamily={FONT} fill={el.color} />
    const fill = el.fill ?? undefined
    if (el.kind === 'rect')
      return <Rect key={el.id} x={el.x} y={el.y} width={el.w} height={el.h} stroke={el.color} strokeWidth={el.sw} fill={fill} />
    if (el.kind === 'ellipse')
      return <Ellipse key={el.id} x={el.x + el.w / 2} y={el.y + el.h / 2} radiusX={el.w / 2} radiusY={el.h / 2} stroke={el.color} strokeWidth={el.sw} fill={fill} />
    return <Line key={el.id} points={shapePoly(el)} closed stroke={el.color} strokeWidth={el.sw} fill={fill} lineJoin="round" />
  }

  const selRaw = els.find(x => x.id === selectedId)
  const selEl = selRaw ? res(selRaw, els) : undefined
  const selBox = selEl ? bbox(selEl) : null
  const hoverEl = els.find(x => x.id === hoverId)
  const hoverBox = hoverEl ? bbox(hoverEl) : null
  const hs = 16 / view.s

  const toolBtn = (t: Tool, label: string) => (
    <button className={'btn' + (tool === t ? ' on' : '')} onClick={() => chooseTool(t)}>{label}</button>
  )

  return (
    <>
      <div className="board" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}>
        <Stage width={size.w} height={size.h} x={view.x} y={view.y} scaleX={view.s} scaleY={view.s} listening={false}>
          <Layer listening={false}>
            {els.map(renderEl)}
            {hoverBox && (
              <Rect x={hoverBox.x - 6 / view.s} y={hoverBox.y - 6 / view.s} width={hoverBox.w + 12 / view.s} height={hoverBox.h + 12 / view.s}
                stroke="#16a34a" strokeWidth={2.5 / view.s} dash={[6 / view.s, 4 / view.s]} />
            )}
            {selEl && selBox && (
              <>
                {selEl.type !== 'line' && (
                  <Rect x={selBox.x} y={selBox.y} width={selBox.w} height={selBox.h} stroke="#2563eb"
                    strokeWidth={1.5 / view.s} dash={[6 / view.s, 4 / view.s]} />
                )}
                {handlePts(selEl).map((h, i) =>
                  selEl.type === 'line' ? (
                    <Circle key={i} x={h.x} y={h.y} radius={hs / 2 + 2 / view.s} fill="#fff" stroke="#2563eb" strokeWidth={2 / view.s} />
                  ) : (
                    <Rect key={i} x={h.x - hs / 2} y={h.y - hs / 2} width={hs} height={hs} fill="#fff" stroke="#2563eb" strokeWidth={2 / view.s} />
                  )
                )}
              </>
            )}
          </Layer>
        </Stage>
      </div>

      {edit && (
        <div className="editor">
          <textarea autoFocus rows={3} value={edit.value} placeholder="এখানে লেখো..."
            onChange={e => setEdit({ ...edit, value: e.target.value })} />
          <div className="row">
            <button className="btn" onClick={() => setEdit(null)}>বাতিল</button>
            <button className="btn on" onClick={saveEdit}>ঠিক আছে</button>
          </div>
        </div>
      )}

      <div className="bars">
        <div className="bar">
          {toolBtn('select', '👆')}
          {toolBtn('pen', '✏️')}
          {toolBtn('eraser', '🧽')}
          {toolBtn('hand', '✋')}
          <div className="sep" />
          {toolBtn('rect', '▭')}
          {toolBtn('ellipse', '◯')}
          {toolBtn('triangle', '△')}
          {toolBtn('diamond', '◇')}
          {toolBtn('line', '╱')}
          {toolBtn('arrow', '➜')}
          {toolBtn('connect', '🔗')}
          {toolBtn('text', 'T')}
          <div className="sep" />
          <button className="btn" onClick={undo} disabled={!undoStack.length}>↩️</button>
          <button className="btn" onClick={redo} disabled={!redoStack.length}>↪️</button>
        </div>
        <div className="bar">
          {COLORS.map(c => (
            <button key={c} className={'dot' + (color === c ? ' on' : '')} style={{ background: c }} onClick={() => applyColor(c)} />
          ))}
          <div className="sep" />
          {WIDTHS.map(w => (
            <button key={w} className={'btn' + (width === w ? ' on' : '')} onClick={() => applyWidth(w)}>
              <span style={{ width: w + 6, height: w + 6, borderRadius: '50%', background: '#111827', display: 'block' }} />
            </button>
          ))}
          <button className={'btn' + (fillOn ? ' on' : '')} onClick={toggleFill}>◼</button>
          <div className="sep" />
          <button className="btn" onClick={() => changeText(1 / 1.15)}>A−</button>
          <button className="btn" onClick={() => changeText(1.15)}>A+</button>
          <div className="sep" />
          <button className="btn" onClick={duplicateSel} disabled={selectedId === null}>📄</button>
          <button className="btn" onClick={deleteSel} disabled={selectedId === null}>🗑️</button>
          <button className="btn" onClick={clearAll}>🧹</button>
          <button className="btn" onClick={() => setViewNow({ x: 0, y: 0, s: 1 })}>🎯</button>
        </div>
      </div>
    </>
  )
    }

import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { exportToPng, normalizeShape } from './lib/shapes'

const MIN_SIZE = 8

const TOOLS = [
  { id: 'select', label: 'Выделение', key: 'v' },
  { id: 'frame', label: 'Фрейм', key: 'f' },
  { id: 'rect', label: 'Прямоугольник', key: 'r' },
  { id: 'ellipse', label: 'Эллипс', key: 'o' },
  { id: 'text', label: 'Текст', key: 't' },
  { id: 'pan', label: 'Рука', key: 'h' },
]

const TYPE_LABELS = { frame: 'Фрейм', rect: 'Прямоугольник', ellipse: 'Эллипс', text: 'Текст' }

const FONTS = [
  'Inter',
  'Roboto',
  'Montserrat',
  'Open Sans',
  'Lato',
  'Poppins',
  'Oswald',
  'Merriweather',
  'Playfair Display',
  'JetBrains Mono',
  'Caveat',
  'Comfortaa',
  'Nunito',
  'Raleway',
  'system-ui',
]

const CURSOR_COLORS = ['#ec4899', '#0abab5', '#f59e0b', '#8b5cf6', '#22c55e', '#3b82f6']

let seq = 0
const uid = () => `s${Date.now().toString(36)}-${(seq++).toString(36)}`
const clientId = `c${Math.random().toString(36).slice(2, 8)}`
const myName = `Гость-${Math.floor(Math.random() * 90) + 10}`
const myColor = CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)]

const makeShape = (type, pt, fill = '#ec4899') => {
  const s = {
    id: uid(),
    type,
    x: pt.x,
    y: pt.y,
    w: type === 'text' ? 220 : type === 'frame' ? 400 : 0,
    h: type === 'text' ? 45 : type === 'frame' ? 300 : MIN_SIZE,
    fill: type === 'frame' ? '#ffffff' : fill,
    opacity: 1,
    visible: true,
    parentId: null,
    name: `${TYPE_LABELS[type]} ${Math.floor(Math.random() * 90) + 10}`,
  }
  if (type === 'text') {
    s.text = 'Текст'
    s.fontSize = 32
    s.h = s.fontSize * 1.25
    s.font = 'Inter'
  }
  return s
}

const initialShapes = () => [
  { id: uid(), type: 'frame', x: 60, y: 60, w: 420, h: 260, fill: '#ffffff', opacity: 1, visible: true, parentId: null, name: 'Фрейм 01' },
  { id: uid(), type: 'rect', x: 100, y: 100, w: 160, h: 90, fill: '#ec4899', opacity: 1, visible: true, parentId: null, name: 'Плита' },
  { id: uid(), type: 'ellipse', x: 300, y: 120, w: 120, h: 120, fill: '#0abab5', opacity: 1, visible: true, parentId: null, name: 'Круг' },
  { id: uid(), type: 'text', x: 100, y: 380, w: 280, h: 45, fill: '#f3f4f6', opacity: 1, visible: true, text: 'mini-figma', fontSize: 36, font: 'Inter', parentId: null, name: 'Заголовок' },
]

/* ---------------- utils ---------------- */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

function safeHex(color) {
  if (typeof color !== 'string') return '#ec4899'
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (m) return color.trim().toLowerCase()
  const probe = document.createElement('canvas').getContext('2d')
  probe.fillStyle = color
  const resolved = probe.fillStyle
  const hex6 = /^#([0-9a-f]{6})$/i.exec(resolved)
  if (hex6) return resolved.toLowerCase()
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(resolved)
  if (rgb) {
    return '#' + [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
  }
  return '#ec4899'
}

function hexA(hex, a) {
  return `${safeHex(hex)}${Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0')}`
}

/* appximate width of a text shape for marquee-hit-test and export bounds */
function textWidthApprox(s) {
  const lines = String(s.text || '').split('\n')
  const size = s.fontSize || 32
  return Math.max(24, ...lines.map((l) => l.length * size * 0.55))
}

function shapeRect(s) {
  const w = s.type === 'text' ? textWidthApprox(s) : s.w
  const h = s.type === 'text' ? (s.fontSize || 32) * 1.25 * String(s.text || ' ').split('\n').length : s.h
  return { x: s.x, y: s.y, w, h }
}

function intersects(a, b) {
  return a && b && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h
}

/* collect a set consisting of ids plus all their descendants */
function withDescendants(shapes, ids) {
  const out = new Set(ids)
  let changed = true
  while (changed) {
    changed = false
    for (const s of shapes) {
      if (s.parentId && out.has(s.parentId) && !out.has(s.id)) {
        out.add(s.id)
        changed = true
      }
    }
  }
  return out
}

/* inject a Google Font stylesheet once per family */
const loadedFonts = new Set()
function ensureFont(family) {
  if (!family || family === 'system-ui' || loadedFonts.has(family)) return
  loadedFonts.add(family)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href =
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}` +
    `:wght@400;700&display=swap`
  document.head.appendChild(link)
}

export default function App() {
  const [shapes, setShapes] = useState(initialShapes)
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [tool, setTool] = useState('select')
  const [fill, setFill] = useState('#ec4899')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 60, y: 40 })
  const [draft, setDraft] = useState(null)
  const [marquee, setMarquee] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editingNameId, setEditingNameId] = useState(null)
  const [peers, setPeers] = useState({})

  const stageRef = useRef(null)
  const modeRef = useRef(null)
  const spaceRef = useRef(false)
  const lastPushRef = useRef(0)
  const lastCursorRef = useRef(0)
  const chanRef = useRef(null)
  const editingTextRef = useRef(null)

  const selected = shapes.find((s) => s.id === selectedIds[selectedIds.length - 1]) || null

  /* ---------------- collaboration (BroadcastChannel) ---------------- */

  useEffect(() => {
    const chan = new BroadcastChannel('mini-figma-collab')
    chanRef.current = chan
    chan.onmessage = (e) => {
      const msg = e.data
      if (!msg || msg.clientId === clientId || !msg.type) return

      if (msg.type === 'shapes') setShapes(msg.shapes)

      if (msg.type === 'cursor') {
        setPeers((p) => ({
          ...p,
          [msg.client]: { x: msg.x, y: msg.y, name: msg.name, color: msg.color, ts: Date.now() },
        }))
      }

      if (msg.type === 'bye') {
        setPeers((p) => {
          const q = { ...p }
          delete q[msg.client]
          return q
        })
      }
    }
    const bye = () => chan.postMessage({ type: 'bye', client: clientId })
    window.addEventListener('beforeunload', bye)
    return () => {
      bye()
      window.removeEventListener('beforeunload', bye)
      chan.close()
      chanRef.current = null
    }
  }, [])

  /* broadcast our whole state (last-write-wins) */
  useEffect(() => {
    const t = setTimeout(() => {
      chanRef.current?.postMessage({ type: 'shapes', shapes, client: clientId })
    }, 80)
    return () => clearTimeout(t)
  }, [shapes])

  /* keep remote Google Fonts loaded */
  useEffect(() => {
    for (const s of shapes) if (s.type === 'text' && s.font) ensureFont(s.font)
  }, [shapes])

  /* drop stale peer cursors */
  useEffect(() => {
    const t = setInterval(() => {
      setPeers((p) => {
        const out = {}
        let changed = false
        for (const [id, v] of Object.entries(p)) {
          if (Date.now() - v.ts < 4000) out[id] = v
          else changed = true
        }
        return changed ? out : p
      })
    }, 1500)
    return () => clearInterval(t)
  }, [])

  const broadcastCursor = (w) => {
    const now = performance.now()
    if (now - lastCursorRef.current < 50) return
    lastCursorRef.current = now
    chanRef.current?.postMessage({ type: 'cursor', client: clientId, x: w.x, y: w.y, name: myName, color: myColor })
  }

  const peerList = Object.entries(peers)

  /* ---------------- history ---------------- */

  const pushHistory = useCallback((snap) => {
    const now = performance.now()
    if (now - lastPushRef.current > 400) {
      lastPushRef.current = now
      setPast((p) => [...p, snap].slice(-60))
    }
    setFuture([])
  }, [])

  const undo = useCallback(() => {
    if (!past.length) return
    const prev = past[past.length - 1]
    setFuture((f) => [shapes, ...f].slice(0, 60))
    setPast(past.slice(0, -1))
    setShapes(prev)
    setEditingId(null)
  }, [past, shapes])

  const redo = useCallback(() => {
    if (!future.length) return
    const next = future[0]
    setPast((p) => [...p, shapes].slice(-60))
    setFuture(future.slice(1))
    setShapes(next)
    setEditingId(null)
  }, [future, shapes])

  /* ---------------- coordinates ---------------- */

  const toWorld = useCallback(
    (e) => {
      const r = stageRef.current.getBoundingClientRect()
      return { x: (e.clientX - r.left - pan.x) / zoom, y: (e.clientY - r.top - pan.y) / zoom }
    },
    [pan, zoom],
  )

  /* ---------------- pointer interactions ---------------- */

  const onStagePointerDown = (e) => {
    if (e.button === 1 || spaceRef.current || tool === 'pan') {
      e.preventDefault()
      modeRef.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, pan: { ...pan } }
      stageRef.current.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return

    const handleEl = e.target.closest('[data-handle]')

    if (handleEl && selectedIds.length === 1) {
      const s = selected
      if (s) {
        modeRef.current = {
          kind: 'resize',
          corner: handleEl.dataset.corner,
          orig: { ...s },
          snap: shapes,
          moved: false,
        }
        stageRef.current.setPointerCapture(e.pointerId)
        return
      }
    }

    if (editingId && e.target.closest(`[data-shape="${editingId}"]`)) {
      modeRef.current = null
      return
    }

    const shapeEl = e.target.closest('[data-shape]')
    if (shapeEl) {
      const id = shapeEl.dataset.shape
      const s = shapes.find((k) => k.id === id)
      if (s) {
        if (e.shiftKey) {
          /* shift+click toggles membership without dragging */
          setSelectedIds((ids) =>
            ids.includes(id) ? ids.filter((k) => k !== id) : [...ids, id],
          )
          return
        }
        if (!selectedIds.includes(id)) setSelectedIds([id])
        const ids = selectedIds.includes(id) ? [...selectedIds] : [id]
        modeRef.current = {
          kind: 'move',
          ids,
          base: new Map(
            shapes
              .filter((k) => withDescendants(shapes, ids).has(k.id))
              .map((k) => [k.id, { x: k.x, y: k.y }]),
          ),
          snapshotOfShapes: shapes,
          origin: toWorld(e),
          moved: false,
        }
        stageRef.current.setPointerCapture(e.pointerId)
        return
      }
    }

    if (tool === 'select') {
      /* start marquee multiselect */
      const w = toWorld(e)
      modeRef.current = {
        kind: 'marquee',
        origin: w,
        additive: e.shiftKey,
        wasSelected: selectedIds,
      }
      setMarquee({ x: w.x, y: w.y, w: 0, h: 0 })
      stageRef.current.setPointerCapture(e.pointerId)
      return
    }

    if (tool === 'text') {
      const sh = makeShape('text', toWorld(e), fill)
      pushHistory(shapes)
      setShapes([...shapes, sh])
      setSelectedIds([sh.id])
      setEditingId(sh.id)
      setTool('select')
      return
    }

    /* frame / rect / ellipse: drag to draw */
    const w = toWorld(e)
    modeRef.current = { kind: 'create', type: tool, x: w.x, y: w.y, snap: shapes }
    setDraft({ type: tool, x: w.x, y: w.y, w: 0, h: 0 })
    stageRef.current.setPointerCapture(e.pointerId)
  }

  const onStagePointerMove = (e) => {
    const w = toWorld(e)
    broadcastCursor(w)
    const m = modeRef.current
    if (!m) return

    if (m.kind === 'pan') {
      setPan({ x: m.pan.x + (e.clientX - m.sx), y: m.pan.y + (e.clientY - m.sy) })
      return
    }

    if (m.kind === 'marquee') {
      const x = Math.min(m.origin.x, w.x)
      const y = Math.min(m.origin.y, w.y)
      setMarquee({ x, y, w: Math.abs(w.x - m.origin.x), h: Math.abs(w.y - m.origin.y), raw: m })
      return
    }

    if (m.kind === 'move') {
      const dx = w.x - m.origin.x
      const dy = w.y - m.origin.y
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !m.moved) return
      if (!m.moved) {
        m.moved = true
        pushHistory(m.snapshotOfShapes)
      }
      setShapes((cur) =>
        cur.map((s) =>
          m.base.has(s.id) ? { ...s, x: m.base.get(s.id).x + dx, y: m.base.get(s.id).y + dy } : s,
        ),
      )
      return
    }

    if (m.kind === 'resize') {
      const o = m.orig
      const c = m.corner
      let { x, y, w: nw, h: nh } = o
      if (c.includes('w')) {
        const px = Math.min(w.x, o.x + o.w - MIN_SIZE)
        x = px
        nw = o.x + o.w - px
      }
      if (c.includes('n')) {
        const py = Math.min(w.y, o.y + o.h - MIN_SIZE)
        y = py
        nh = o.y + o.h - py
      }
      if (c.includes('e')) nw = Math.max(MIN_SIZE, w.x - o.x)
      if (c.includes('s')) nh = Math.max(MIN_SIZE, w.y - o.y)
      if (!m.moved) {
        m.moved = true
        pushHistory(m.snap)
      }
      setShapes((cur) => cur.map((s) => (s.id === o.id ? { ...s, x, y, w: nw, h: nh } : s)))
      return
    }

    if (m.kind === 'create') {
      setDraft({ type: m.type, x: m.x, y: m.y, w: w.x - m.x, h: w.y - m.y })
    }
  }

  const onStagePointerUp = () => {
    const m = modeRef.current
    modeRef.current = null

    if (m && m.kind === 'marquee') {
      if (marquee && (marquee.w > 3 || marquee.h > 3)) {
        const rect = { x: marquee.x, y: marquee.y, w: marquee.w, h: marquee.h }
        const hit = shapes
          .filter((s) => s.visible !== false)
          .map((s) => ({ s, r: shapeRect(s) }))
          .filter(({ r }) => intersects(r, rect))
          .map(({ s }) => s.id)
        setSelectedIds(hit.length ? (m.additive ? [...new Set([...selectedIds, ...hit])] : hit) : [])
      }
      setMarquee(null)
      return
    }

    if (m && m.kind === 'move' && m.moved) {
      /* auto-reparent into frames on drop */
      const ids = [...m.base.keys()].filter((id) => {
        const s = shapes.find((k) => k.id === id)
        return s && (!s.parentId || !m.base.has(s.parentId))
      })
      setShapes((cur) => {
        let changed = false
        const out = cur.map((s) => {
          if (!ids.includes(s.id) || s.type === 'frame') return s
          const r = shapeRect(s)
          const cx = r.x + r.w / 2
          const cy = r.y + r.h / 2
          let target = null
          for (const f of cur) {
            if (f.type !== 'frame' || m.base.has(f.id) || f.id === s.id) continue
            const fr = shapeRect(f)
            if (cx > fr.x && cx < fr.x + fr.w && cy > fr.y && cy < fr.y + fr.h) target = f.id
          }
          if ((s.parentId || null) !== (target || null)) {
            changed = true
            return { ...s, parentId: target }
          }
          return s
        })
        return changed ? out : cur
      })
    }

    if (m && m.kind === 'create') {
      const d = draft
      if (d) {
        const sh = normalizeShape({ ...makeShape(m.type, { x: d.x, y: d.y }, fill), w: d.w, h: d.h })
        if (sh.w >= MIN_SIZE && sh.h >= MIN_SIZE) {
          pushHistory(m.snap)
          /* auto-place into topmost frame containing the new shape */
          const cx = sh.x + sh.w / 2
          const cy = sh.y + sh.h / 2
          let parent = null
          for (const f of shapes) {
            if (f.type !== 'frame') continue
            const fr = shapeRect(f)
            if (cx > fr.x && cx < fr.x + fr.w && cy > fr.y && cy < fr.y + fr.h) parent = f.id
          }
          const withParent = { ...sh, parentId: parent }
          setShapes([...shapes, withParent])
          setSelectedIds([sh.id])
        }
      }
      setDraft(null)
      setTool('select')
    }
  }

  /* ---------------- zoom / pan via wheel ---------------- */

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const fn = (e) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const sx = e.clientX - r.left
      const sy = e.clientY - r.top
      if (e.ctrlKey || e.metaKey) {
        const nz = clampZoom(zoom * Math.exp(-e.deltaY * 0.0015))
        setPan({ x: sx - ((sx - pan.x) / zoom) * nz, y: sy - ((sy - pan.y) / zoom) * nz })
        setZoom(nz)
      } else {
        const k = e.deltaMode === 1 ? 16 : 1
        setPan({ x: pan.x - e.deltaX * k, y: pan.y - e.deltaY * k })
      }
    }
    el.addEventListener('wheel', fn, { passive: false })
    return () => el.removeEventListener('wheel', fn)
  }, [zoom, pan])

  const zoomBy = (factor) => setZoom((z) => clampZoom(z * factor))
  const fitView = () => {
    setZoom(1)
    setPan({ x: 60, y: 40 })
  }
  const clampZoom = (z) => Math.min(8, Math.max(0.1, z))

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onDown = (e) => {
      if (e.key === 'Escape') {
        const ce = document.activeElement
        if (ce && ce.isContentEditable) {
          ce.blur()
          return
        }
        setEditingId(null)
        setSelectedIds([])
        setTool('select')
        return
      }
      if (e.target.closest('input, textarea, [contenteditable="true"]')) {
        if (e.key === 'Enter' && e.target.isContentEditable) e.target.blur()
        return
      }

      if (e.code === 'Space' && !e.repeat) spaceRef.current = true

      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        redo()
      } else if (mod && e.key === '0') {
        e.preventDefault()
        fitView()
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        if (selectedIds.length) {
          pushHistory(shapes)
          const ids = [...withDescendants(shapes, selectedIds)]
          const clones = shapes
            .filter((s) => ids.includes(s.id))
            .map((s) => ({ ...s, id: uid(), x: s.x + 24, y: s.y + 24, parentId: ids.includes(s.parentId) ? s.id : s.parentId }))
          setShapes([...shapes, ...clones])
          setSelectedIds(clones.map((s) => s.id))
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.length && !editingId) {
        e.preventDefault()
        const ids = [...withDescendants(shapes, selectedIds)]
        pushHistory(shapes)
        setShapes(shapes.filter((s) => !ids.has(s.id)))
        setSelectedIds([])
      } else if (!mod) {
        const t = TOOLS.find((k) => k.key === e.key.toLowerCase())
        if (t) setTool(t.id)
      }
    }
    const onUp = (e) => {
      if (e.code === 'Space') spaceRef.current = false
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  })

  /* ---------------- shape ops ---------------- */

  const updateSelected = (patch) => {
    if (!selected) return
    pushHistory(shapes)
    setShapes(shapes.map((s) => (s.id === selected.id ? { ...s, ...patch } : s)))
  }

  const updateMany = (patch) => {
    if (!selectedIds.length) return
    pushHistory(shapes)
    setShapes(shapes.map((s) => (selectedIds.includes(s.id) ? { ...s, ...patch } : s)))
  }

  const toggleVisible = (id) => {
    pushHistory(shapes)
    setShapes(shapes.map((s) => (s.id === id ? { ...s, visible: s.visible === false } : s)))
  }

  const renameShape = (id, name) => {
    pushHistory(shapes)
    setShapes(shapes.map((s) => (s.id === id ? { ...s, name } : s)))
  }

  const deleteMany = (ids) => {
    const kill = withDescendants(shapes, ids)
    pushHistory(shapes)
    setShapes(shapes.filter((s) => !kill.has(s.id)))
    setSelectedIds([])
  }

  const commitTextEdit = (id, newText) => {
    const s = shapes.find((k) => k.id === id)
    setEditingId(null)
    if (!s || (s.text || '') === (newText || '')) return
    pushHistory(shapes)
    const lines = Math.max(1, String(newText).split('\n').length)
    setShapes(
      shapes.map((k) =>
        k.id === id
          ? { ...k, text: newText, h: (k.fontSize || 32) * 1.25 * lines, w: Math.max(k.w, textWidthApprox({ ...k, text: newText })) }
          : k,
      ),
    )
    editingTextRef.current = null
  }

  /* ---------------- render ---------------- */

  return (
    <div className="editor">
      <header className="topbar">
        <span className="top-title">
          <span className="logo-dot" /> mini-figma
        </span>
        <button className="top-btn" onClick={undo} disabled={!past.length} title="Отменить (Ctrl+Z)">
          ↶
        </button>
        <button className="top-btn" onClick={redo} disabled={!future.length} title="Повторить (Ctrl+Shift+Z)">
          ↷
        </button>
        <span className="top-sep" />
        <button className="top-btn" onClick={() => zoomBy(1 / 1.25)} title="Отдалить">−</button>
        <span className="top-zoom">{Math.round(zoom * 100)}%</span>
        <button className="top-btn" onClick={() => zoomBy(1.25)} title="Приблизить">+</button>
        <button className="top-btn" onClick={fitView} title="Сбросить вид (Ctrl+0)">Сброс</button>
        {selectedIds.length > 1 && (
          <button className="top-btn danger" onClick={() => deleteMany(selectedIds)} title="Удалить выбранное (Del)">
            Удалить ({selectedIds.length})
          </button>
        )}
        <span className="top-spacer" />
        <span className="top-hint" title="Совместная работа: откройте страницу в ещё одной вкладке — правки и курсоры синхронизируются">
          <span className="collab-dot" /> {peerList.length} соавтор(ов) онлайн
        </span>
        <button className="top-btn export" onClick={() => exportToPng(shapes)} title="Скачать холст как PNG">
          Экспорт PNG
        </button>
      </header>

      <nav className="rail">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`tool-btn${tool === t.id ? ' active' : ''}`}
            title={`${t.label} (${t.key.toUpperCase()})`}
            onClick={() => setTool(t.id)}
          >
            <span className={`glyph glyph-${t.id}`} aria-hidden="true">
              {t.id === 'select' ? '▶' :
                t.id === 'frame' ? '▢' :
                t.id === 'rect' ? '▭' :
                t.id === 'ellipse' ? '◯' :
                t.id === 'text' ? 'T' : '✋'}
            </span>
          </button>
        ))}
      </nav>

      <main
        ref={stageRef}
        className={`canvas tool-${tool}${modeRef.current?.kind === 'pan' ? ' panning' : ''}`}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        onDoubleClick={(e) => {
          const el = e.target.closest('[data-shape]')
          if (el) {
            const s = shapes.find((k) => k.id === el.dataset.shape)
            if (s && s.type === 'text') {
              editingTextRef.current = shapes
              setEditingId(s.id)
            }
            return
          }
          editingTextRef.current = shapes
          const sh = makeShape('text', toWorld(e), fill)
          pushHistory(shapes)
          setShapes([...shapes, sh])
          setSelectedIds([sh.id])
          setEditingId(sh.id)
        }}
      >
        <div
          className="world"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          {shapes.map((s) =>
            s.visible === false ? null : (
              <div
                key={s.id}
                data-shape={s.id}
                className={
                  `shape ${s.type}` +
                  (selectedIds.includes(s.id) ? ' selected' : '') +
                  (selectedIds.length > 1 && selectedIds.includes(s.id) ? ' multi' : '')
                }
                style={
                  s.type === 'text'
                    ? {
                        left: s.x,
                        top: s.y,
                        opacity: s.opacity,
                        fontFamily:
                          s.font && s.font !== 'system-ui'
                            ? `"${s.font}", system-ui, sans-serif`
                            : undefined,
                      }
                    : {
                        left: s.x,
                        top: s.y,
                        width: s.w,
                        height: s.h,
                        opacity: s.opacity,
                        background: s.fill,
                        borderRadius: s.type === 'ellipse' ? '50%' : 0,
                        boxShadow:
                          s.type === 'frame'
                            ? 'inset 0 0 0 1px rgba(0,0,0,.25), inset 8px 0 0 -7px rgba(0,0,0,.06)'
                            : undefined,
                      }
                }
              >
                {s.type === 'frame' && (
                  <div className="frame-label" style={{ transform: `translateY(${-16 / zoom}px)` }}>
                    {s.name}
                  </div>
                )}
                {s.type === 'text' &&
                  (editingId === s.id ? (
                    <div
                      className="text-edit"
                      contentEditable
                      ref={(el) => {
                        if (el && el.textContent !== (s.text || '')) el.textContent = s.text || ''
                      }}
                      onBlur={(e) => commitTextEdit(s.id, e.target.textContent)}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          e.target.blur()
                        }
                      }}
                    />
                  ) : (
                    <div className="shape-text" style={{ color: s.fill, fontSize: s.fontSize }}>
                      {s.text}
                    </div>
                  ))}

                {selectedIds.length === 1 && s.id === selectedIds[0] && !editingId && (
                  <>
                    {['nw', 'ne', 'sw', 'se'].map((corner) => (
                      <div
                        key={corner}
                        data-corner={corner}
                        className="handle"
                        style={{
                          width: 8 / zoom,
                          height: 8 / zoom,
                          left: corner.includes('w') ? 0 : '100%',
                          top: corner.includes('n') ? 0 : '100%',
                          transform: 'translate(-50%, -50%)',
                        }}
                      />
                    ))}
                  </>
                )}
              </div>
            ),
          )}

          {draft && (
            <div
              className={`shape draft preview-${draft.type}`}
              style={{
                left: draft.x,
                top: draft.y,
                width: Math.abs(draft.w),
                height: Math.abs(draft.h),
                background: fill,
                borderRadius: draft.type === 'ellipse' ? '50%' : 0,
              }}
            />
          )}

          {marquee && (
            <div
              className="marquee"
              style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
            />
          )}

          {peerList.map(([id, p]) => (
            <div key={id} className="peer-cursor" style={{ left: p.x, top: p.y }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill={p.color}>
                <path d="M1 1l11 6-5 1-2 5z" stroke="#fff" strokeWidth="1" />
              </svg>
              <span className="peer-tag" style={{ background: p.color }}>{p.name}</span>
            </div>
          ))}
        </div>
      </main>

      <aside className="sidebar">
        <div className="section">
          <h3>Свойства{selectedIds.length > 1 ? ` (${selectedIds.length})` : ''}</h3>
          {selected ? (
            <>
              <div className="prop-row">
                <label className="prop-label" htmlFor="fill-input">Заливка</label>
                <input
                  id="fill-input"
                  type="color"
                  value={safeHex(selected.fill)}
                  onChange={(e) =>
                    selectedIds.length > 1 ? updateMany({ fill: e.target.value }) : updateSelected({ fill: e.target.value })
                  }
                />
                <span className="dim mono">{safeHex(selected.fill)}</span>
              </div>
              <div className="prop-row">
                <label className="prop-label" htmlFor="opacity-input">Прозр.</label>
                <input
                  id="opacity-input"
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={selected.opacity}
                  onChange={(e) =>
                    selectedIds.length > 1
                      ? updateMany({ opacity: Number(e.target.value) })
                      : updateSelected({ opacity: Number(e.target.value) })
                  }
                />
                <span className="dim mono">{Math.round(selected.opacity * 100)}%</span>
              </div>
              {selected.type === 'text' && (
                <>
                  <div className="prop-row">
                    <label className="prop-label" htmlFor="font-input">Шрифт</label>
                    <input
                      id="font-input"
                      className="font-input"
                      list="font-options"
                      value={selected.font || 'Inter'}
                      onChange={(e) => {
                        const f = e.target.value.trim() || 'system-ui'
                        if (f !== 'system-ui') ensureFont(f)
                        updateSelected({ font: f })
                      }}
                    />
                    <datalist id="font-options">
                      {FONTS.map((f) => (
                        <option key={f} value={f} />
                      ))}
                    </datalist>
                  </div>
                  <div className="prop-row">
                    <label className="prop-label" htmlFor="font-size-input">Кегль</label>
                    <input
                      id="font-size-input"
                      className="number-input"
                      type="number"
                      min="8"
                      max="200"
                      value={selected.fontSize}
                      onChange={(e) => updateSelected({ fontSize: clamp(Number(e.target.value) || 32, 8, 200) })}
                    />
                  </div>
                </>
              )}
              <div className="prop-row">
                <label className="prop-label">Позиция</label>
                <span className="dim mono">{Math.round(selected.x)}, {Math.round(selected.y)}</span>
              </div>
              <div className="prop-row">
                <label className="prop-label">Размер</label>
                <span className="dim mono">{Math.round(selected.w)} × {Math.round(selected.h)}</span>
              </div>
            </>
          ) : (
            <p className="hint">Ничего не выбрано. Shift+клик — мультивыделение, рамка — тоже. Ctrl+D — дубликат.</p>
          )}
        </div>

        <div className="section layers-section">
          <h3>Слои</h3>
          <div className="layers-list">
            {layerTree(shapes).map((row) => (
              <div
                key={row.s.id}
                className={`layer${selectedIds.includes(row.s.id) ? ' active' : ''}`}
                style={{ paddingLeft: (row.depth || 0) * 14 + 7 }}
                onClick={() => {
                  setSelectedIds([row.s.id])
                  if (tool !== 'select') setTool('select')
                }}
              >
                <span className="layer-dot" style={{ background: row.s.fill }} />
                {editingNameId === row.s.id ? (
                  <input
                    className="rename-input"
                    autoFocus
                    defaultValue={row.s.name}
                    onBlur={(e) => {
                      renameShape(row.s.id, e.target.value.trim() || row.s.name)
                      setEditingNameId(null)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="layer-name"
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setEditingNameId(row.s.id)
                    }}
                  >
                    {row.s.name}
                  </span>
                )}
                <button
                  className="icon-btn"
                  title={row.s.visible === false ? 'Показать' : 'Скрыть'}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    toggleVisible(row.s.id)
                  }}
                >
                  {row.s.visible === false ? '◌' : '◉'}
                </button>
                {row.s.type === 'frame' && <span className="frame-badge">FR</span>}
                <button
                  className="icon-btn danger"
                  title="Удалить"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    deleteMany([row.s.id])
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            {!shapes.length && <p className="hint">Пусто — нарисуйте фигуру (R, O, F)</p>}
          </div>
        </div>
      </aside>
    </div>
  )
}

/* tree for the layers panel: roots first, children indented under their frame */
function layerTree(shapes) {
  const byParent = new Map()
  for (const s of shapes) {
    const p = s.parentId || null
    if (!byParent.has(p)) byParent.set(p, [])
    byParent.get(p).push(s)
  }
  const rows = []
  const walk = (parent, depth) => {
    for (const s of [...(byParent.get(parent) || [])].reverse()) {
      rows.push({ s, depth })
      if (byParent.has(s.id)) walk(s.id, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}

import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import { exportToPng, normalizeShape } from './lib/shapes'

const MIN_SIZE = 8

const TOOLS = [
  { id: 'select', label: 'Выделение', key: 'v' },
  { id: 'rect', label: 'Прямоугольник', key: 'r' },
  { id: 'ellipse', label: 'Эллипс', key: 'o' },
  { id: 'text', label: 'Текст', key: 't' },
  { id: 'pan', label: 'Рука', key: 'h' },
]

const TYPE_LABELS = { rect: 'Прямоугольник', ellipse: 'Эллипс', text: 'Текст' }

let seq = 0
const uid = () => `s${Date.now().toString(36)}-${(seq++).toString(36)}`

const makeShape = (type, pt, fill) => {
  const s = {
    id: uid(),
    type,
    x: pt.x,
    y: pt.y,
    w: type === 'text' ? 220 : 0,
    h: type === 'text' ? 40 : MIN_SIZE,
    fill,
    opacity: 1,
    visible: true,
    name: `${TYPE_LABELS[type]} ${Math.floor(Math.random() * 90) + 10}`,
  }
  if (type === 'text') {
    s.text = 'Текст'
    s.fontSize = 32
    s.h = s.fontSize * 1.25
  }
  return s
}

const initialShapes = () => [
  { id: uid(), type: 'rect', x: 100, y: 100, w: 220, h: 140, fill: '#ec4899', opacity: 1, visible: true, name: 'Плита' },
  { id: uid(), type: 'ellipse', x: 380, y: 170, w: 150, h: 150, fill: '#0abab5', opacity: 1, visible: true, name: 'Круг' },
  { id: uid(), type: 'text', x: 100, y: 340, w: 260, h: 45, fill: '#f3f4f6', opacity: 1, visible: true, text: 'mini-figma', fontSize: 36, name: 'Заголовок' },
]

const clampZoom = (z) => Math.min(8, Math.max(0.1, z))
const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

export default function App() {
  const [shapes, setShapes] = useState(initialShapes)
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [tool, setTool] = useState('select')
  const [fill, setFill] = useState('#ec4899')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 60, y: 40 })
  const [draft, setDraft] = useState(null)
  const [editingId, setEditingId] = useState(null)

  const stageRef = useRef(null)
  const modeRef = useRef(null)
  const spaceRef = useRef(false)
  const wheelFnRef = useRef(null)
  const lastPushRef = useRef(0)

  const selected = shapes.find((s) => s.id === selectedId) || null

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
      return {
        x: (e.clientX - r.left - pan.x) / zoom,
        y: (e.clientY - r.top - pan.y) / zoom,
      }
    },
    [pan, zoom],
  )

  /* ---------------- pointer interactions ---------------- */

  const onStagePointerDown = (e) => {
    // middle button / hand tool / Space -> pan
    if (e.button === 1 || spaceRef.current || tool === 'pan') {
      e.preventDefault()
      modeRef.current = {
        kind: 'pan',
        sx: e.clientX,
        sy: e.clientY,
        pan: { ...pan },
      }
      stageRef.current.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return

    const handleEl = e.target.closest('[data-handle]')

    if (handleEl) {
      if (!selected) return
      modeRef.current = {
        kind: 'resize',
        corner: handleEl.dataset.corner,
        orig: { ...selected },
        snap: shapes,
        moved: false,
      }
      stageRef.current.setPointerCapture(e.pointerId)
      return
    }

    if (editingId && e.target.closest(`[data-shape="${editingId}"]`)) {
      modeRef.current = null // editing text — don't drag/select
      return
    }

    const shapeEl = e.target.closest('[data-shape]')
    if (shapeEl) {
      const id = shapeEl.dataset.shape
      const s = shapes.find((k) => k.id === id)
      if (s) {
        setSelectedId(id)
        modeRef.current = {
          kind: 'move',
          id,
          off: { dx: toWorld(e).x - s.x, dy: toWorld(e).y - s.y },
          snap: shapes,
          moved: false,
        }
        stageRef.current.setPointerCapture(e.pointerId)
        return
      }
    }

    if (tool === 'select') {
      setSelectedId(null)
      setEditingId(null)
      return
    }

    if (tool === 'text') {
      const sh = makeShape('text', toWorld(e), fill)
      pushHistory(shapes)
      setShapes([...shapes, sh])
      setSelectedId(sh.id)
      setEditingId(sh.id)
      setTool('select')
      return
    }

    // rect / ellipse: drag to draw
    const w = toWorld(e)
    modeRef.current = {
      kind: 'create',
      type: tool,
      x: w.x,
      y: w.y,
      snap: shapes,
    }
    setDraft({ type: tool, x: w.x, y: w.y, w: 0, h: 0 })
    stageRef.current.setPointerCapture(e.pointerId)
  }

  const onStagePointerMove = (e) => {
    const m = modeRef.current
    if (!m) return

    if (m.kind === 'pan') {
      setPan({
        x: m.pan.x + (e.clientX - m.sx),
        y: m.pan.y + (e.clientY - m.sy),
      })
      return
    }

    if (m.kind === 'move') {
      const w = toWorld(e)
      if (!m.moved) {
        m.moved = true
        pushHistory(m.snap)
      }
      setShapes((cur) =>
        cur.map((s) => (s.id === m.id ? { ...s, x: w.x - m.off.dx, y: w.y - m.off.dy } : s)),
      )
      return
    }

    if (m.kind === 'resize') {
      const w = toWorld(e)
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
      setShapes((cur) =>
        cur.map((s) => (s.id === o.id ? { ...s, x, y, w: nw, h: nh } : s)),
      )
      return
    }

    if (m.kind === 'create') {
      const w = toWorld(e)
      setDraft({ type: m.type, x: m.x, y: m.y, w: w.x - m.x, h: w.y - m.y })
    }
  }

  const onStagePointerUp = () => {
    const m = modeRef.current
    modeRef.current = null

    if (m && m.kind === 'create') {
      const d = draft
      if (d) {
        const sh = normalizeShape({
          ...makeShape(m.type, { x: d.x, y: d.y }, fill),
          w: d.w,
          h: d.h,
        })
        if (sh.w >= MIN_SIZE && sh.h >= MIN_SIZE) {
          pushHistory(m.snap)
          setShapes((cur) => [...cur, sh])
          setSelectedId(sh.id)
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
    wheelFnRef.current = fn
    el.addEventListener('wheel', fn, { passive: false })
    return () => el.removeEventListener('wheel', fn)
  }, [zoom, pan])

  const zoomBy = (factor) => setZoom((z) => clampZoom(z * factor))
  const fitView = () => {
    setZoom(1)
    setPan({ x: 60, y: 40 })
  }

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
        setSelectedId(null)
        setTool('select')
        return
      }
      if (e.target.closest('input, textarea, [contenteditable="true"]')) return

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
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !editingId) {
        e.preventDefault()
        pushHistory(shapes)
        setShapes(shapes.filter((s) => s.id !== selectedId))
        setSelectedId(null)
      } else if (!mod) {
        const t = TOOLS.find((k) => k.key === e.key.toLowerCase())
        if (t) setTool(t.id)
      }
    }
    const onUp = (e) => {
      if (e.key === 'Space') spaceRef.current = false
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

  const toggleVisible = (id) => {
    pushHistory(shapes)
    setShapes(shapes.map((s) => (s.id === id ? { ...s, visible: s.visible === false ? true : false } : s)))
  }

  const deleteShape = (id) => {
    pushHistory(shapes)
    setShapes(shapes.filter((s) => s.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  const commitTextEdit = (id, newText) => {
    const s = shapes.find((k) => k.id === id)
    setEditingId(null)
    if (!s || (s.text ?? '') === (newText ?? '')) return
    pushHistory(shapes)
    setShapes(shapes.map((k) => (k.id === id ? { ...k, text: newText, h: (k.fontSize || 32) * 1.25 * Math.max(1, String(newText).split('\n').length) } : k)))
  }

  /* ---------------- icons ---------------- */

  const ICONS = {
    select: 'M5 2l7 7-4 .8L10 14l-2 .7-1.8-4.2L4 12z',
    rect: 'M3 3h10v10H3z',
    ellipse: 'M3 8a5 5 0 1 0 10 0a5 5 0 1 0 -10 0',
    text: 'M4 3h8M8 3v10',
    pan: 'M3 8h10M8 3v10',
    undo: 'M6 3L3 6l3 3M3 6h7a3 3 0 0 1 0 6H8',
    redo: 'M10 3l3 3-3 3M13 6H9a3 3 0 0 0 0 6h1',
    download: 'M8 3v7M5 7l3 3 3-3M3 13h10',
    eye: 'M2 8s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4zM8 6.5A1.5 1.5 0 1 0 8 9.5a1.5 1.5 0 0 0 0-3z',
    eyeOff: 'M4 4l8 8M2 8s2-4 6-4c1 0 1.9.2 2.7.6M14 8s-2 4-6 4c-1 0-1.9-.2-2.7-.6',
  }

  return (
    <div className="editor">
      <header className="topbar">
        <span className="top-title">
          <span className="logo-dot" /> mini-figma
        </span>
        <button className="top-btn" onClick={undo} disabled={!past.length} title="Отменить (Ctrl+Z)">
          <IconWrap d={ICONS.undo} />
        </button>
        <button className="top-btn" onClick={redo} disabled={!future.length} title="Повторить (Ctrl+Shift+Z)">
          <IconWrap d={ICONS.redo} />
        </button>
        <span className="top-sep" />
        <button className="top-btn" onClick={() => zoomBy(1 / 1.25)} title="Отдалить">−</button>
        <span className="top-zoom">{Math.round(zoom * 100)}%</span>
        <button className="top-btn" onClick={() => zoomBy(1.25)} title="Приблизить">+</button>
        <button className="top-btn" onClick={fitView} title="Сбросить вид (Ctrl+0)">Сброс</button>
        <span className="top-spacer" />
        <button className="top-btn export" onClick={() => exportToPng(shapes)} title="Скачать холст как PNG">
          <IconWrap d={ICONS.download} /> Экспорт PNG
        </button>
      </header>

      <nav className="rail">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`tool-btn ${tool === t.id ? 'active' : ''}`}
            title={`${t.label} (${t.key.toUpperCase()})`}
            onClick={() => setTool(t.id)}
          >
            <IconWrap d={ICONS[t.id]} />
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
            if (s && s.type === 'text') setEditingId(s.id)
            return
          }
          const sh = makeShape('text', toWorld(e), fill)
          pushHistory(shapes)
          setShapes([...shapes, sh])
          setSelectedId(sh.id)
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
                className={`shape ${s.type}${s.id === selectedId ? ' selected' : ''}`}
                style={
                  s.type === 'text'
                    ? {
                        left: s.x,
                        top: s.y,
                        opacity: s.opacity,
                      }
                    : {
                        left: s.x,
                        top: s.y,
                        width: s.w,
                        height: s.h,
                        opacity: s.opacity,
                        background: s.type === 'ellipse' ? hexA(s.fill, 1) : s.fill,
                        borderRadius: s.type === 'ellipse' ? '50%' : 0,
                      }
                }
              >
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

                {s.id === selectedId && !editingId && (
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
        </div>
      </main>

      <aside className="sidebar">
        <div className="section">
          <h3>Свойства</h3>
          {selected ? (
            <>
              <div className="prop-row">
                <label className="prop-label" htmlFor="fill-input">Заливка</label>
                <input
                  id="fill-input"
                  type="color"
                  value={safeHex(selected.fill)}
                  onChange={(e) => updateSelected({ fill: e.target.value })}
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
                  onChange={(e) => updateSelected({ opacity: Number(e.target.value) })}
                />
                <span className="dim mono">{Math.round(selected.opacity * 100)}%</span>
              </div>
              {selected.type === 'text' && (
                <div className="prop-row">
                  <label className="prop-label" htmlFor="font-input">Кегль</label>
                  <input
                    id="font-input"
                    className="number-input"
                    type="number"
                    min="8"
                    max="200"
                    value={selected.fontSize}
                    onChange={(e) => updateSelected({ fontSize: clamp(Number(e.target.value) || 32, 8, 200) })}
                  />
                </div>
              )}
              <div className="prop-row">
                <label className="prop-label">Позиция</label>
                <span className="dim mono">{Math.round(selected.x)}, {Math.round(selected.y)}</span>
              </div>
              <div className="prop-row">
                <label className="prop-label">Размер</label>
                <span className="dim mono">
                  {Math.round(selected.w)} × {Math.round(selected.type === 'text' ? selected.h : selected.h)}
                </span>
              </div>
            </>
          ) : (
            <p className="hint">
              Ничего не выбрано. Перетащите фигуру, дважды кликните для текста, колесо + Ctrl — зум.
            </p>
          )}
        </div>

        <div className="section layers-section">
          <h3>Слои</h3>
          <div className="layers-list">
            {[...shapes].reverse().map((s) => (
              <div
                key={s.id}
                className={`layer${s.id === selectedId ? ' active' : ''}`}
                onClick={() => {
                  setSelectedId(s.id)
                  if (tool !== 'select') setTool('select')
                }}
              >
                <span className="layer-dot" style={{ background: s.fill }} />
                <span className="layer-name">{s.name}</span>
                <button
                  className="icon-btn"
                  title={s.visible === false ? 'Показать' : 'Скрыть'}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    toggleVisible(s.id)
                  }}
                >
                  <IconWrap d={s.visible === false ? ICONS.eyeOff : ICONS.eye} />
                </button>
                <button
                  className="icon-btn danger"
                  title="Удалить"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    deleteShape(s.id)
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            {!shapes.length && <p className="hint">Пусто — нарисуйте фигуру</p>}
          </div>
        </div>
      </aside>
    </div>
  )
}

function IconWrap({ d }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function safeHex(color) {
  if (typeof color !== 'string') return '#ec4899'
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (m) return color.trim().toLowerCase()
  const probe = document.createElement('canvas').getContext('2d')
  probe.fillStyle = color
  const resolved = probe.fillStyle
  const m2 = /^#([0-9a-f]{6})$/i.exec(resolved)
  if (m2) return resolved.toLowerCase()
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(resolved)
  if (rgb)
    return '#' + [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
  return '#ec4899'
}

function hexA(hex, a) {
  return `${hex}${Math.round(a * 255).toString(16).padStart(2, '0')}`
}

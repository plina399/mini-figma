import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  LINE_HEIGHT,
  MIN_SIZE,
  TYPE_LABELS,
  exportToPng,
  normalizeShape,
  sanitizeShapes,
  shapeRect,
  textWidthApprox,
  uid,
  withTextMetrics,
} from './lib/shapes'

const TOOLS = [
  { id: 'select', label: 'Выделение', key: 'v' },
  { id: 'frame', label: 'Фрейм', key: 'f' },
  { id: 'rect', label: 'Прямоугольник', key: 'r' },
  { id: 'ellipse', label: 'Эллипс', key: 'o' },
  { id: 'text', label: 'Текст', key: 't' },
  { id: 'pan', label: 'Рука', key: 'h' },
]

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

const NEW_SHAPE_FILL = '#ec4899'

const clampZoom = (z) => Math.min(8, Math.max(0.1, z))

let clipboard = []
const clientId = `c${Math.random().toString(36).slice(2, 8)}`
const myName = `Гость-${Math.floor(Math.random() * 90) + 10}`
const myColor = CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)]

const makeShape = (type, pt, fill = NEW_SHAPE_FILL) => {
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
    s.h = s.fontSize * LINE_HEIGHT
    s.font = 'Inter'
  }
  return s
}

const initialShapes = () => {
  const frameId = uid()
  return [
    { id: frameId, type: 'frame', x: 60, y: 60, w: 420, h: 260, fill: '#ffffff', opacity: 1, visible: true, parentId: null, name: 'Фрейм 01' },
    /* лежат внутри фрейма — значит должны быть его потомками, иначе
       «на задний план» прячет их под непрозрачной заливкой фрейма */
    { id: uid(), type: 'rect', x: 100, y: 100, w: 160, h: 90, fill: '#ec4899', opacity: 1, visible: true, parentId: frameId, name: 'Плита' },
    { id: uid(), type: 'ellipse', x: 300, y: 120, w: 120, h: 120, fill: '#0abab5', opacity: 1, visible: true, parentId: frameId, name: 'Круг' },
    { id: uid(), type: 'text', x: 100, y: 380, w: 280, h: 45, fill: '#f3f4f6', opacity: 1, visible: true, text: 'mini-figma', fontSize: 36, font: 'Inter', parentId: null, name: 'Заголовок' },
  ]
}

/* ---------------- utils ---------------- */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

/* ---------------- persistence ---------------- */

const STORAGE_KEY = 'mini-figma:doc:v1'

/* Достаёт сохранённый документ. Любой мусор в хранилище (другой формат,
   битый JSON, подделанные значения) не должен ронять редактор: проверяем
   тем же sanitizeShapes, что и сообщения соседних вкладок. */
function loadStoredShapes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const clean = sanitizeShapes(JSON.parse(raw))
    return clean && clean.length ? clean : null
  } catch {
    return null
  }
}

function storeShapes(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* приватный режим или переполнение квоты — молча продолжаем работать */
  }
}

/* Контекст для разбора именованных цветов создаётся один раз:
   safeHex дергается несколько раз за рендер. */
let probeCtx = null

function safeHex(color) {
  if (typeof color !== 'string') return NEW_SHAPE_FILL
  const trimmed = color.trim()
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(trimmed)) return trimmed.toLowerCase()
  if (!probeCtx) probeCtx = document.createElement('canvas').getContext('2d')
  probeCtx.fillStyle = trimmed
  const resolved = probeCtx.fillStyle
  if (/^#([0-9a-f]{6})$/i.test(resolved)) return resolved.toLowerCase()
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(resolved)
  if (rgb) {
    return '#' + [rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')
  }
  return NEW_SHAPE_FILL
}

function intersects(a, b) {
  return Boolean(a) && Boolean(b) && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h
}

/* Множество фигур, которые не видно на холсте: сами скрытые и всё, что
   лежит внутри скрытого родителя. Фигуры рисуются плоским списком, а не
   вложенно в фрейм, поэтому одного own-флага у потомка недостаточно. */
function hiddenShapeIds(shapes) {
  const childrenOf = new Map()
  for (const s of shapes) {
    if (!s.parentId) continue
    if (!childrenOf.has(s.parentId)) childrenOf.set(s.parentId, [])
    childrenOf.get(s.parentId).push(s.id)
  }
  const hidden = new Set()
  const stack = []
  for (const s of shapes) if (s.visible === false) stack.push(s.id)
  /* обход в ширину по дереву: каждый id попадает в стек один раз */
  while (stack.length) {
    const id = stack.pop()
    if (hidden.has(id)) continue
    hidden.add(id)
    for (const childId of childrenOf.get(id) || []) stack.push(childId)
  }
  return hidden
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

/* Ставит каретку в конец содержимого contentEditable */
function placeCaretEnd(el) {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

/* Ставит родителя раньше потомка, сохраняя относительный порядок остальных */
function parentsFirst(list) {
  const out = [...list]
  for (let pass = 0; pass < out.length; pass++) {
    let swapped = false
    for (let i = 0; i < out.length; i++) {
      const pid = out[i].parentId
      if (!pid) continue
      const pi = out.findIndex((s) => s.id === pid)
      if (pi > i) {
        const [p] = out.splice(pi, 1)
        out.splice(i, 0, p)
        swapped = true
      }
    }
    if (!swapped) break
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
  /* Сохранённый документ важнее исходного: без этого перезагрузка
     возвращала редактор в демонстрационное состояние и работа терялась. */
  const [shapes, setShapes] = useState(() => loadStoredShapes() || initialShapes())
  const [past, setPast] = useState([])
  const [future, setFuture] = useState([])
  const [selectedIds, setSelectedIds] = useState([])
  const [tool, setTool] = useState('select')
  /* цвет новых фигур: отдельного переключателя в UI нет, поэтому константа,
     а не состояние с неиспользуемым сеттером */
  const fill = NEW_SHAPE_FILL
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 60, y: 40 })
  const [draft, setDraft] = useState(null)
  const [marquee, setMarquee] = useState(null)
  const [panning, setPanning] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editingNameId, setEditingNameId] = useState(null)
  const [showHelp, setShowHelp] = useState(false)
  const [ctxMenu, setCtxMenu] = useState(null)
  /* Панель поверх холста на узких экранах */
  const [sideOpen, setSideOpen] = useState(false)
  const [peers, setPeers] = useState({})

  const stageRef = useRef(null)
  const modeRef = useRef(null)
  const spaceRef = useRef(false)
  const lastPushRef = useRef(0)
  const lastCursorRef = useRef(0)
  const lastArrowRef = useRef(0)
  const chanRef = useRef(null)
  const shapesRef = useRef(shapes)
  const dirtyRef = useRef(false)
  const lastRemoteRef = useRef(null)
  const textEditRef = useRef(null)
  /* Значение, которое последний раз записали в поле правки. По нему решаем,
     обновлять ли DOM: пользовательский набор с s.text расходится намеренно. */
  const writtenTextRef = useRef(null)
  /* Nonce нашего запроса документа. Пока он не погашен, берём ответ только
     от одной вкладки: иначе новая вкладка применяла документы в порядке
     доставки, и итог зависел от того, кто ответил быстрее. */
  const helloNonceRef = useRef(uid())

  useEffect(() => {
    shapesRef.current = shapes
  }, [shapes])

  const selected = shapes.find((s) => s.id === selectedIds[selectedIds.length - 1]) || null

  const hiddenIds = useMemo(() => hiddenShapeIds(shapes), [shapes])

  /* Пишем с дебаунсом: перетаскивание фигуры даёт десятки обновлений в
     секунду, а в хранилище полезно складывать только устоявшееся. */
  useEffect(() => {
    const t = setTimeout(() => storeShapes(shapes), 400)
    return () => clearTimeout(t)
  }, [shapes])

  /* ---------------- collaboration (BroadcastChannel) ---------------- */

  useEffect(() => {
    const chan = new BroadcastChannel('mini-figma-collab')
    chanRef.current = chan
    chan.onmessage = (e) => {
      const msg = e.data
      if (!msg || typeof msg !== 'object' || msg.clientId === clientId || !msg.type) return

      if (msg.type === 'shapes') {
        const clean = sanitizeShapes(msg.shapes)
        if (!clean) return
        /* Ответ на наш запрос документа: берём первый и гасим nonce,
           чтобы приход остальных ответов уже ничего не менял. */
        if (typeof msg.to === 'string') {
          if (msg.to !== helloNonceRef.current) return
          helloNonceRef.current = null
          /* Документ подменён целиком — история и выделение к прежнему
             документу не относятся, откатывать их бессмысленно. */
          setPast([])
          setFuture([])
          setSelectedIds([])
        }
        lastRemoteRef.current = clean
        setShapes(clean)
        return
      }

      if (msg.type === 'hello') {
        /* новая вкладка просит актуальный документ — отдаём свой,
           помечав ответ, чтобы запросивший взял именно его */
        if (typeof msg.nonce !== 'string' || !msg.nonce) return
        chan.postMessage({
          type: 'shapes',
          shapes: shapesRef.current,
          clientId: clientId,
          to: msg.nonce,
        })
        return
      }

      if (msg.type === 'cursor') {
        if (typeof msg.client !== 'string') return
        if (!Number.isFinite(msg.x) || !Number.isFinite(msg.y)) return
        setPeers((p) => ({
          ...p,
          [msg.client]: {
            x: msg.x,
            y: msg.y,
            name: String(msg.name ?? '').slice(0, 24),
            color: /^#[0-9a-f]{3,8}$/i.test(msg.color) ? msg.color : '#8b5cf6',
            ts: Date.now(),
          },
        }))
        return
      }

      if (msg.type === 'bye') {
        if (typeof msg.client !== 'string') return
        setPeers((p) => {
          const q = { ...p }
          delete q[msg.client]
          return q
        })
      }
    }
    /* спросим у уже открытых вкладок их документ, прежде чем брать дефолтный */
    const nonce = helloNonceRef.current
    chan.postMessage({ type: 'hello', clientId: clientId, nonce: nonce })
    const bye = () => chan.postMessage({ type: 'bye', client: clientId })
    window.addEventListener('beforeunload', bye)
    return () => {
      bye()
      window.removeEventListener('beforeunload', bye)
      chan.close()
      chanRef.current = null
    }
  }, [])

  /* Рассылаем документ только после локальной правки: иначе свежая вкладка
     затирает работу тех, кто уже редактировал. Присланное обратно не
     ретранслируем — иначе три вкладки зацикливают рассылку. */
  useEffect(() => {
    if (shapes === lastRemoteRef.current) return
    if (!dirtyRef.current) return
    const t = setTimeout(() => {
      chanRef.current?.postMessage({ type: 'shapes', shapes, clientId: clientId })
    }, 80)
    return () => clearTimeout(t)
  }, [shapes])

  /* keep remote Google Fonts loaded */
  useEffect(() => {
    for (const s of shapes) if (s.type === 'text' && s.font) ensureFont(s.font)
  }, [shapes])

  /* ---------------- text editing ---------------- */

  /* Фигура, которую сейчас правят: та же самая ссылка, пока документ
     не изменился. Благодаря этому эффект ниже не перезапускается на
     каждой перерисовке холста. */
  const editingShape = shapes.find((s) => s.id === editingId && s.type === 'text') || null

  /* При открытии редактора поле пустое — считаем, что писать нужно заново. */
  useEffect(() => {
    writtenTextRef.current = null
  }, [editingId])

  /* Синхронизируем поле правки с текстом фигуры, но только когда s.text
     действительно изменился (правка пришла из другой вкладки). Раньше здесь
     стоял ref-колбэк, который пересоздавался на каждом рендере и возвращал
     поле к последнему сохранённому тексту — набранный текст пропадал. */
  useEffect(() => {
    const el = textEditRef.current
    if (!editingShape || !el) return
    if (writtenTextRef.current !== editingShape.text) {
      writtenTextRef.current = editingShape.text
      if (el.textContent !== editingShape.text) el.textContent = editingShape.text
    }
    /* contentEditable не получает фокус сам — ставим его и каретку,
       иначе печатать нельзя без лишнего клика */
    if (document.activeElement !== el) {
      el.focus()
      placeCaretEnd(el)
    }
  }, [editingShape])

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

  /* Быстрые правки подряд (слайдер, серия нажатий) склеиваем в одну запись:
     вместо выбрасывания снимка заменяем последний — иначе undo перескакивал
     через промежуточные состояния. */
  const pushHistory = useCallback((snap) => {
    /* любая локальная правка — документ теперь наш, можно рассылать */
    dirtyRef.current = true
    const now = performance.now()
    if (now - lastPushRef.current > 400) {
      lastPushRef.current = now
      setPast((p) => [...p, snap].slice(-60))
    } else if (snap !== shapesRef.current) {
      setPast((p) => (p.length ? [...p.slice(0, -1), snap] : [snap]).slice(-60))
    }
    setFuture([])
  }, [])

  const undo = useCallback(() => {
    if (!past.length) return
    const prev = past[past.length - 1]
    dirtyRef.current = true
    setFuture((f) => [shapes, ...f].slice(0, 60))
    setPast(past.slice(0, -1))
    setShapes(prev)
    setEditingId(null)
  }, [past, shapes])

  const redo = useCallback(() => {
    if (!future.length) return
    const next = future[0]
    dirtyRef.current = true
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
      setPanning(true)
      stageRef.current.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return

    const handleEl = e.target.closest('[data-handle]')

    if (handleEl && selectedIds.length === 1) {
      const s = selected
      if (s) {
        /* У текста ширина не хранится, а получается из содержимого, поэтому
           для масштаба кегля берём реально отрисованную ширину: оценка
           textWidthApprox расходится с ней, и ресайз «уезжал». */
        let textW = 0
        if (s.type === 'text') {
          const el = handleEl.closest('[data-shape]')
          const r = el ? el.getBoundingClientRect() : null
          if (r && r.width > 0) textW = r.width / zoom
        }
        modeRef.current = {
          kind: 'resize',
          corner: handleEl.dataset.corner,
          orig: { ...s },
          snap: shapes,
          textW,
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
        /* withDescendants считаем один раз, а не на каждый элемент фильтра */
        const group = withDescendants(shapes, ids)
        modeRef.current = {
          kind: 'move',
          ids,
          base: new Map(
            shapes.filter((k) => group.has(k.id)).map((k) => [k.id, { x: k.x, y: k.y }]),
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
      /* без preventDefault браузер после mousedown уводит фокус с поля правки
         на холст, и текст тут же коммитится пустым */
      e.preventDefault()
      const sh = makeShape('text', toWorld(e), fill)
      pushHistory(shapes)
      setShapes((cur) => [...cur, sh])
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
      setMarquee({ x, y, w: Math.abs(w.x - m.origin.x), h: Math.abs(w.y - m.origin.y) })
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
      if (o.type === 'text') {
        /* У текста размер задаётся кеглем: тянем углы — меняем шрифт.
           База — ширина, реально отрисованная в момент захвата (m.textW),
           иначе каждый ресайз считал масштаб от завышенной оценки. */
        const base = m.textW > 1 ? m.textW : textWidthApprox(o)
        const fs = clamp(Math.round((o.fontSize || 32) * (nw / base)), 8, 200)
        setShapes((cur) =>
          cur.map((s) => (s.id === o.id ? withTextMetrics({ ...s, fontSize: fs }) : s)),
        )
        return
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
    setPanning(false)

    if (m && m.kind === 'marquee') {
      if (marquee && (marquee.w > 3 || marquee.h > 3)) {
        const rect = { x: marquee.x, y: marquee.y, w: marquee.w, h: marquee.h }
        const hit = shapes
          .filter((s) => !hiddenIds.has(s.id))
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
          setShapes((cur) => [...cur, withParent])
          setSelectedIds([sh.id])
        }
      }
      setDraft(null)
      setTool('select')
    }
  }

  /* Указатель мог быть отнят системой (отмена жеста, потеря фокуса окна) —
     иначе modeRef «залипает» и редактор остаётся в режиме перетаскивания. */
  const onStagePointerLost = () => {
    if (!modeRef.current) return
    modeRef.current = null
    setPanning(false)
    setMarquee(null)
    setDraft(null)
  }

  /* ---------------- zoom / pan via wheel ---------------- */

  /* Слушатель колеса подписан один раз: актуальные zoom/pan берём из ref,
     иначе эффект переподписывался бы на каждом тике колеса. */
  const viewRef = useRef({ zoom, pan })
  useEffect(() => {
    viewRef.current = { zoom, pan }
  }, [zoom, pan])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const fn = (e) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const sx = e.clientX - r.left
      const sy = e.clientY - r.top
      const { zoom: z0, pan: p0 } = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        const nz = clampZoom(z0 * Math.exp(-e.deltaY * 0.0015))
        viewRef.current = { zoom: nz, pan: { x: sx - ((sx - p0.x) / z0) * nz, y: sy - ((sy - p0.y) / z0) * nz } }
        setZoom(nz)
        setPan(viewRef.current.pan)
      } else {
        const k = e.deltaMode === 1 ? 16 : 1
        const next = { x: p0.x - e.deltaX * k, y: p0.y - e.deltaY * k }
        viewRef.current = { zoom: z0, pan: next }
        setPan(next)
      }
    }
    el.addEventListener('wheel', fn, { passive: false })
    return () => el.removeEventListener('wheel', fn)
  }, [])

  const zoomBy = (factor) => setZoom((z) => clampZoom(z * factor))
  const fitView = () => {
    viewRef.current = { zoom: 1, pan: { x: 60, y: 40 } }
    setZoom(1)
    setPan({ x: 60, y: 40 })
  }

  /* ---------------- shared actions (keyboard + context menu) ---------------- */

  const rootIds = shapes
    .filter((s) => selectedIds.includes(s.id) && !(s.parentId && selectedIds.includes(s.parentId)))
    .map((s) => s.id)

  const copySel = () => {
    if (!selectedIds.length) return
    clipboard = shapes.filter((s) => withDescendants(shapes, selectedIds).has(s.id))
  }

  const cutSel = () => {
    if (!selectedIds.length || editingId) return
    copySel()
    deleteSel()
  }

  const pasteClip = () => {
    if (!clipboard.length) return
    pushHistory(shapes)
    const idMap = new Map(clipboard.map((s) => [s.id, uid()]))
    const clones = clipboard.map((s) => ({
      ...s,
      id: idMap.get(s.id),
      x: s.x + 24,
      y: s.y + 24,
      parentId: idMap.has(s.parentId) ? idMap.get(s.parentId) : s.parentId,
    }))
    const originals = new Map(clipboard.map((s) => [idMap.get(s.id), s]))
    const clipSet = new Set(clipboard.map((s) => s.id))
    const rootOfClip = (s) => !(s.parentId && clipSet.has(s.parentId))
    setShapes((cur) => [...cur, ...clones])
    setSelectedIds(clones.filter((c) => rootOfClip(originals.get(c.id))).map((c) => c.id))
  }

  const duplicateSel = () => {
    if (!selectedIds.length || editingId) return
    pushHistory(shapes)
    const ids = withDescendants(shapes, selectedIds)
    const idMap = new Map(shapes.filter((s) => ids.has(s.id)).map((s) => [s.id, uid()]))
    const clones = shapes
      .filter((s) => ids.has(s.id))
      .map((s) => ({
        ...s,
        id: idMap.get(s.id),
        x: s.x + 24,
        y: s.y + 24,
        parentId: idMap.has(s.parentId) ? idMap.get(s.parentId) : s.parentId,
      }))
    /* Выделяем копии корней выделения. rootIds содержит исходные id, а у
       клонов id новые — раньше сравнение всегда давало пустой результат,
       и выделялось всё поддерево вместе с потомками. */
    const rootDups = rootIds.map((oldId) => idMap.get(oldId)).filter(Boolean)
    setShapes((cur) => [...cur, ...clones])
    setSelectedIds(rootDups.length ? rootDups : clones.map((c) => c.id))
  }

  const deleteSel = () => {
    if (!selectedIds.length || editingId) return
    deleteMany(selectedIds)
  }

  const selectAll = () => {
    setSelectedIds(
      shapes
        .filter((s) => !hiddenIds.has(s.id) && !(s.parentId && shapes.some((k) => k.id === s.parentId)))
        .map((s) => s.id),
    )
  }

  /* Порядок в массиве = порядок отрисовки. Потомка нельзя ставить раньше
     родителя, иначе непрозрачный фрейм накроет его и фигура «исчезнет». */
  const reorderSel = (front) => {
    if (!selectedIds.length) return
    pushHistory(shapes)
    const set = withDescendants(shapes, selectedIds)
    const moved = shapes.filter((s) => set.has(s.id))
    const rest = shapes.filter((s) => !set.has(s.id))
    setShapes(parentsFirst(front ? [...rest, ...moved] : [...moved, ...rest]))
  }

  const nudge = (dx, dy) => {
    if (!selectedIds.length) return
    /* burst collapsing: одна запись истории на серию нажатий (до паузы 700мс) */
    const now = performance.now()
    if (now - lastArrowRef.current > 700) pushHistory(shapes)
    lastArrowRef.current = now
    const ids = withDescendants(shapes, selectedIds)
    setShapes((cur) =>
      cur.map((s) => (ids.has(s.id) ? { ...s, x: s.x + dx, y: s.y + dy } : s)),
    )
  }

  /* align / distribute по мультивыделению (корни;
     потомки следуют за своим корнем) */
  const alignSel = (mode) => {
    const roots = shapes.filter((s) => rootIds.includes(s.id))
    if (!roots.length) return
    const rects = roots.map((s) => ({ s, r: shapeRect(s) }))
    const minX = Math.min(...rects.map(({ r }) => r.x))
    const maxX = Math.max(...rects.map(({ r }) => r.x + r.w))
    const minY = Math.min(...rects.map(({ r }) => r.y))
    const maxY = Math.max(...rects.map(({ r }) => r.y + r.h))

    const deltas = new Map()
    const setDelta = (s, dx, dy) => {
      for (const id of withDescendants(shapes, [s.id])) deltas.set(id, { dx, dy })
    }

    if (mode === 'dist-x' || mode === 'dist-y') {
      if (roots.length < 3) return
      const vert = mode === 'dist-y'
      const sorted = [...rects].sort((a, b) =>
        vert ? a.r.y - b.r.y : a.r.x - b.r.x,
      )
      const centers = sorted.map(({ r }) => (vert ? r.y + r.h / 2 : r.x + r.w / 2))
      const c0 = centers[0]
      const cLast = centers[centers.length - 1]
      sorted.forEach(({ s, r }, i) => {
        const target = c0 + ((cLast - c0) * i) / (sorted.length - 1)
        const cur = vert ? r.y + r.h / 2 : r.x + r.w / 2
        setDelta(s, vert ? 0 : target - cur, vert ? target - cur : 0)
      })
    } else {
      const cxT = (minX + maxX) / 2
      const cyT = (minY + maxY) / 2
      for (const { s, r } of rects) {
        if (mode === 'left') setDelta(s, minX - r.x, 0)
        else if (mode === 'right') setDelta(s, maxX - (r.x + r.w), 0)
        else if (mode === 'center-x') setDelta(s, cxT - (r.x + r.w / 2), 0)
        else if (mode === 'top') setDelta(s, 0, minY - r.y)
        else if (mode === 'bottom') setDelta(s, 0, maxY - (r.y + r.h))
        else if (mode === 'center-y') setDelta(s, 0, cyT - (r.y + r.h / 2))
      }
    }

    if (!deltas.size) return
    pushHistory(shapes)
    setShapes((cur) =>
      cur.map((s) => {
        const d = deltas.get(s.id)
        return d ? { ...s, x: s.x + d.dx, y: s.y + d.dy } : s
      }),
    )
  }

  /* figure out target items for the context menu */
  const openContextMenu = (e) => {
    e.preventDefault()
    const el = e.target.closest('[data-shape]')
    if (el && !selectedIds.includes(el.dataset.shape)) {
      setSelectedIds([el.dataset.shape])
      if (tool !== 'select') setTool('select')
    }
    /* держим меню в пределах окна с обеих сторон */
    const bw = 236
    const bh = 330
    setCtxMenu({
      x: clamp(e.clientX, 8, Math.max(8, window.innerWidth - bw - 8)),
      y: clamp(e.clientY, 8, Math.max(8, window.innerHeight - bh - 8)),
      onShape: !!(el && shapes.find((k) => k.id === el.dataset.shape)),
    })
  }

  /* ---------------- keyboard ---------------- */

  /* Обработчики клавиатуры читают актуальное состояние через kbRef и
     подписаны один раз: так список не пересоздаётся на каждом рендере
     (иначе событие может пропасть между remove/add во время drag'а). */
  const kbRef = useRef(null)
  useEffect(() => {
    kbRef.current = {
      undo, redo, zoomBy, fitView, selectAll, copySel, cutSel,
      pasteClip, duplicateSel, deleteSel, nudge, reorderSel,
      shapes, selectedIds, editingId,
    }
  })

  useEffect(() => {
    const onDown = (e) => {
      const k = kbRef.current
      if (!k) return
      if (e.key === 'Escape') {
        const ce = document.activeElement
        if (ce && ce.isContentEditable) {
          ce.blur()
          return
        }
        setShowHelp(false)
        setCtxMenu(null)
        setEditingId(null)
        setSideOpen(false)
        setSelectedIds([])
        setTool('select')
        return
      }
      /* e.target — не всегда элемент (окно/документ): closest есть не у всех */
      const target = e.target instanceof Element ? e.target : null
      if (target && target.closest('input, textarea, [contenteditable="true"]')) {
        if (e.key === 'Enter' && e.target.isContentEditable) e.target.blur()
        return
      }

      if (e.code === 'Space' && !e.repeat) spaceRef.current = true

      /* physical key codes — работают в любой раскладке */
      const code = e.code
      const letter = code.startsWith('Key') ? code.slice(3).toLowerCase() : null
      const mod = e.ctrlKey || e.metaKey

      if (mod && letter === 'z') {
        e.preventDefault()
        if (e.shiftKey) k.redo()
        else k.undo()
      } else if (mod && letter === 'y') {
        e.preventDefault()
        k.redo()
      } else if (mod && code === 'Digit0') {
        e.preventDefault()
        k.fitView()
      } else if (mod && letter === 'a') {
        e.preventDefault()
        if (!k.editingId) k.selectAll()
      } else if (mod && letter === 'd') {
        e.preventDefault()
        k.duplicateSel()
      } else if ((code === 'Delete' || code === 'Backspace') && k.selectedIds.length && !k.editingId) {
        e.preventDefault()
        k.deleteSel()
      } else if (mod && (letter === 'c' || letter === 'x')) {
        e.preventDefault()
        if (letter === 'x') k.cutSel()
        else k.copySel()
      } else if (mod && letter === 'v') {
        e.preventDefault()
        k.pasteClip()
      } else if (e.key === '?' || (e.shiftKey && code === 'Slash')) {
        e.preventDefault()
        setShowHelp((v) => !v)
      } else if (e.key === 'Enter' && k.selectedIds.length === 1 && !k.editingId) {
        const s = k.shapes.find((x) => x.id === k.selectedIds[0])
        if (s && s.type === 'text') setEditingId(s.id)
        else if (s) setEditingNameId(s.id)
      } else if (k.selectedIds.length && code.startsWith('Arrow')) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = code === 'ArrowLeft' ? -step : code === 'ArrowRight' ? step : 0
        const dy = code === 'ArrowUp' ? -step : code === 'ArrowDown' ? step : 0
        k.nudge(dx, dy)
      } else if (code === 'BracketRight' && k.selectedIds.length) {
        k.reorderSel(true)
      } else if (code === 'BracketLeft' && k.selectedIds.length) {
        k.reorderSel(false)
      } else if (code === 'F2' && k.selectedIds.length === 1) {
        e.preventDefault()
        setEditingNameId(k.selectedIds[0])
      } else if (code === 'Equal' || code === 'NumpadAdd') {
        k.zoomBy(1.25)
      } else if (code === 'Minus' || code === 'NumpadSubtract') {
        k.zoomBy(1 / 1.25)
      } else if (!mod && letter) {
        const t = TOOLS.find((k) => k.key === letter)
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
  }, [])

  /* ---------------- shape ops ---------------- */

  /* Функциональная форма setShapes: правки из соседних обработчиков
     в одном тике React не должны затирать друг друга. */
  const updateSelected = (patch) => {
    if (!selected) return
    const id = selected.id
    pushHistory(shapes)
    /* смена кегля меняет и габариты текста — пересчитываем их вместе */
    setShapes((cur) => cur.map((s) => (s.id === id ? withTextMetrics({ ...s, ...patch }) : s)))
  }

  const updateMany = (patch) => {
    if (!selectedIds.length) return
    const ids = new Set(selectedIds)
    pushHistory(shapes)
    setShapes((cur) => cur.map((s) => (ids.has(s.id) ? { ...s, ...patch } : s)))
  }

  const toggleVisible = (id) => {
    pushHistory(shapes)
    setShapes((cur) => cur.map((s) => (s.id === id ? { ...s, visible: s.visible === false } : s)))
  }

  const renameShape = (id, name) => {
    pushHistory(shapes)
    setShapes((cur) => cur.map((s) => (s.id === id ? { ...s, name } : s)))
  }

  const deleteMany = (ids) => {
    const kill = withDescendants(shapes, ids)
    pushHistory(shapes)
    setShapes((cur) => cur.filter((s) => !kill.has(s.id)))
    setSelectedIds([])
  }

  const commitTextEdit = (id, newText) => {
    setEditingId(null)
    const s = shapes.find((k) => k.id === id)
    if (!s || (s.text || '') === (newText || '')) return
    pushHistory(shapes)
    /* функциональная форма: не затираем правки, случившиеся в этом же тике */
    setShapes((cur) =>
      cur.map((k) => (k.id === id ? withTextMetrics({ ...k, text: newText }) : k)),
    )
  }

  /* ---------------- render ---------------- */

  return (
    <div className={`editor${sideOpen ? ' side-open' : ''}`}>
      <header className="topbar">
        <span className="top-title">
          <span className="logo-dot" /> mini-figma
        </span>
        <button
          className="top-btn side-toggle"
          onClick={() => setSideOpen((v) => !v)}
          title="Свойства и слои"
          aria-expanded={sideOpen}
        >
          ☰
        </button>
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
        <button className="top-btn" onClick={() => setShowHelp(true)} title="Горячие клавиши (?)">⌨ Шорткаты</button>
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
        className={`canvas tool-${tool}${panning ? ' panning' : ''}`}
        /* тап по холсту убирает выезжающую панель — на узком экране иначе
           она закрывала бы половину холста */
        onPointerDown={(e) => {
          setSideOpen(false)
          onStagePointerDown(e)
        }}
        onPointerMove={onStagePointerMove}
        onPointerUp={onStagePointerUp}
        onPointerCancel={onStagePointerLost}
        onLostPointerCapture={onStagePointerLost}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        onContextMenu={openContextMenu}
        onDoubleClick={(e) => {
          const el = e.target.closest('[data-shape]')
          if (el) {
            const s = shapes.find((k) => k.id === el.dataset.shape)
            if (s && s.type === 'text') setEditingId(s.id)
            return
          }
          const sh = makeShape('text', toWorld(e), fill)
          pushHistory(shapes)
          setShapes((cur) => [...cur, sh])
          setSelectedIds([sh.id])
          setEditingId(sh.id)
        }}
      >
        <div
          className="world"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          {shapes.map((s) =>
            hiddenIds.has(s.id) ? null : (
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
                        /* задаём всегда, включая system-ui: иначе шрифт
                           текста зависел бы от того, указан ли он явно */
                        fontFamily:
                          s.font && s.font !== 'system-ui'
                            ? `"${s.font}", system-ui, sans-serif`
                            : 'system-ui, "Segoe UI", sans-serif',
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
                      ref={textEditRef}
                      style={{ color: s.fill, fontSize: s.fontSize }}
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
                        data-handle=""
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
              {/* шрифт и кегль — только при одиночном выборе: иначе правили бы
                  только последний объект, в отличие от заливки и прозрачности */}
              {selected.type === 'text' && selectedIds.length === 1 && (
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
                      onChange={(e) => {
                      const size = clamp(Number(e.target.value) || 32, 8, 200)
                      updateSelected({ fontSize: size })
                    }}
                    />
                  </div>
                </>
              )}
              <div className="prop-row">
                <label className="prop-label">Позиция</label>
                <span className="dim mono">{Math.round(selected.x)}, {Math.round(selected.y)}</span>
              </div>
              {selectedIds.length > 1 && (
                <>
                  <div className="prop-row align-row">
                    <label className="prop-label">Выровнять</label>
                    <div className="align-grid">
                      <button title="По левому краю" onClick={() => alignSel('left')}>⇤</button>
                      <button title="По центру (гориз.)" onClick={() => alignSel('center-x')}>⇤⇥</button>
                      <button title="По правому краю" onClick={() => alignSel('right')}>⇥</button>
                      <button title="По верхнему краю" onClick={() => alignSel('top')}>⇧</button>
                      <button title="По центру (верт.)" onClick={() => alignSel('center-y')}>⇅</button>
                      <button title="По нижнему краю" onClick={() => alignSel('bottom')}>⇩</button>
                    </div>
                  </div>
                  <div className="prop-row">
                    <label className="prop-label">Распределить</label>
                    <div className="align-grid two">
                      <button disabled={rootIds.length < 3} title="Равномерно по горизонтали" onClick={() => alignSel('dist-x')}>⇤⇥</button>
                      <button disabled={rootIds.length < 3} title="Равномерно по вертикали" onClick={() => alignSel('dist-y')}>⇧⇩</button>
                    </div>
                  </div>
                </>
              )}
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

      {showHelp && (
        <div className="help-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-modal" role="dialog" aria-modal="true" aria-label="Горячие клавиши" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>Горячие клавиши</h2>
              <button className="icon-btn" aria-label="Закрыть" onClick={() => setShowHelp(false)}>✕</button>
            </header>
            <div className="help-cols">
              <div>
                <h4>Инструменты</h4>
                {[
                  ['V', 'Выделение'],
                  ['F', 'Фрейм'],
                  ['R', 'Прямоугольник'],
                  ['O', 'Эллипс'],
                  ['T', 'Текст'],
                  ['H', 'Рука'],
                  ['Space (зажать)', 'Временный пан'],
                ].map(([k, v]) => (
                  <div className="help-row" key={k}>
                    <span>{v}</span>
                    <kbd>{k}</kbd>
                  </div>
                ))}
                <h4>Вид</h4>
                <div className="help-row"><span>Приблизить</span><kbd>+ / =</kbd></div>
                <div className="help-row"><span>Отдалить</span><kbd>−</kbd></div>
                <div className="help-row"><span>Сброс вида</span><kbd>Ctrl+0</kbd></div>
                <div className="help-row"><span>Зум к курсору</span><kbd>Ctrl+Колесо</kbd></div>
              </div>
              <div>
                <h4>Редактирование</h4>
                <div className="help-row"><span>Отменить / Повторить</span><kbd>Ctrl+Z / Shift+Z</kbd></div>
                <div className="help-row"><span>Копировать</span><kbd>Ctrl+C</kbd></div>
                <div className="help-row"><span>Вырезать</span><kbd>Ctrl+X</kbd></div>
                <div className="help-row"><span>Вставить</span><kbd>Ctrl+V</kbd></div>
                <div className="help-row"><span>Выделить всё</span><kbd>Ctrl+A</kbd></div>
                <div className="help-row"><span>Контекстное меню</span><kbd>ПКМ</kbd></div>
                <div className="help-row"><span>Дубликат</span><kbd>Ctrl+D</kbd></div>
                <div className="help-row"><span>Удалить</span><kbd>Del</kbd></div>
                <div className="help-row"><span>Сдвиг (Shift — на 10px)</span><kbd>Стрелки</kbd></div>
                <div className="help-row"><span>Правка текста</span><kbd>Enter</kbd></div>
                <h4>Слои</h4>
                <div className="help-row"><span>Мультивыделение</span><kbd>Shift+Клик / рамка</kbd></div>
                <div className="help-row"><span>На передний план</span><kbd>]</kbd></div>
                <div className="help-row"><span>На задний план</span><kbd>[</kbd></div>
                <div className="help-row"><span>Переименовать</span><kbd>F2</kbd></div>
              </div>
            </div>
            <p className="help-note">Нажмите Esc или кликните вне окна, чтобы закрыть.</p>
          </div>
        </div>
      )}

      {ctxMenu && (
        <>
          <div
            className="ctx-scrim"
            onClick={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setCtxMenu(null)
            }}
          />
          <div className="ctx-menu" role="menu" aria-label="Контекстное меню" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            {ctxMenu.onShape ? (
              <>
                {selected?.type === 'text' && !editingId && (
                  <CtxItem
                    label="Редактировать текст"
                    hint="Enter"
                    onClick={() => {
                      setEditingId(selected.id)
                      setCtxMenu(null)
                    }}
                  />
                )}
                <CtxItem label="Копировать" hint="Ctrl+C" onClick={() => { copySel(); setCtxMenu(null) }} />
                <CtxItem label="Вырезать" hint="Ctrl+X" onClick={() => { cutSel(); setCtxMenu(null) }} />
                <CtxItem label="Дубликат" hint="Ctrl+D" onClick={() => { duplicateSel(); setCtxMenu(null) }} />
                <CtxItem label="На передний план" hint="]" onClick={() => { reorderSel(true); setCtxMenu(null) }} />
                <CtxItem label="На задний план" hint="[" onClick={() => { reorderSel(false); setCtxMenu(null) }} />
                <div className="ctx-sep" />
                <CtxItem label="Удалить" hint="Del" danger onClick={() => { deleteSel(); setCtxMenu(null) }} />
              </>
            ) : (
              <>
                <CtxItem
                  label="Вставить"
                  hint="Ctrl+V"
                  disabled={!clipboard.length}
                  onClick={() => { pasteClip(); setCtxMenu(null) }}
                />
                <CtxItem label="Выделить всё" hint="Ctrl+A" onClick={() => { selectAll(); setCtxMenu(null) }} />
                <div className="ctx-sep" />
                <CtxItem label="Сброс вида" hint="Ctrl+0" onClick={() => { fitView(); setCtxMenu(null) }} />
                <CtxItem label="Горячие клавиши" hint="?" onClick={() => { setShowHelp(true); setCtxMenu(null) }} />
              </>
            )}
          </div>
        </>
      )}
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
  const seen = new Set()
  const walk = (parent, depth) => {
    for (const s of [...(byParent.get(parent) || [])].reverse()) {
      /* данные приходят из сети: защищаемся от зацикливания parentId */
      if (seen.has(s.id)) continue
      seen.add(s.id)
      rows.push({ s, depth })
      if (byParent.has(s.id)) walk(s.id, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}

function CtxItem({ label, hint, onClick, disabled, danger }) {
  return (
    <button
      className={danger ? 'ctx-item danger' : 'ctx-item'}
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
      {hint && <kbd>{hint}</kbd>}
    </button>
  )
}

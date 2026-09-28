// Geometry helpers, shape validation and PNG export for the mini-figma editor.

export const MIN_SIZE = 8

export const TYPE_LABELS = { frame: 'Фрейм', rect: 'Прямоугольник', ellipse: 'Эллипс', text: 'Текст' }

const TYPES = new Set(Object.keys(TYPE_LABELS))

let seq = 0
export const uid = () => `s${Date.now().toString(36)}-${(seq++).toString(36)}`

/* Пределы на присланные данные. Данные приходят из BroadcastChannel, то есть
   доступны любому скрипту на этом же origin: без ограничений огромный текст
   или тысячи фигур роняли рендер (RangeError в Math.max по spread). */
export const LIMITS = {
  shapes: 2000,
  textChars: 8000,
  nameChars: 120,
  fontChars: 80,
  idChars: 64,
  coord: 1e6,
}

/* Приводит присланный по сети список фигур к безопасному виду: выкидывает
   мусор, чинит числовые поля и гарантирует уникальные строковые id.
   Возвращает null, если это не массив. */
export function sanitizeShapes(list) {
  if (!Array.isArray(list)) return null

  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
  const coord = (v) => Math.min(LIMITS.coord, Math.max(-LIMITS.coord, num(v, 0)))
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  const seen = new Set()
  const out = []

  for (const raw of list) {
    if (out.length >= LIMITS.shapes) break
    if (!raw || typeof raw !== 'object' || !TYPES.has(raw.type)) continue
    if (typeof raw.id !== 'string' || !raw.id || raw.id.length > LIMITS.idChars) continue
    if (seen.has(raw.id)) continue

    const min = raw.type === 'text' ? 1 : MIN_SIZE
    const s = {
      id: raw.id,
      type: raw.type,
      x: coord(raw.x),
      y: coord(raw.y),
      w: Math.max(min, Math.min(LIMITS.coord, num(raw.w, min))),
      h: Math.max(min, Math.min(LIMITS.coord, num(raw.h, min))),
      fill: str(raw.fill, 64) || '#ec4899',
      opacity: Math.min(1, Math.max(0, num(raw.opacity, 1))),
      visible: raw.visible !== false,
      parentId: typeof raw.parentId === 'string' ? raw.parentId : null,
      name: str(raw.name, LIMITS.nameChars) || TYPE_LABELS[raw.type],
    }

    if (raw.type === 'text') {
      s.text = str(raw.text, LIMITS.textChars)
      s.fontSize = Math.min(200, Math.max(8, num(raw.fontSize, 32)))
      s.font = str(raw.font, LIMITS.fontChars) || 'Inter'
      /* w/h текста — производные от содержимого, принятые извне значения
         игнорируем: иначе ресайз считал бы масштаб от чужой ширины. */
      Object.assign(s, withTextMetrics(s))
    }

    seen.add(s.id)
    out.push(s)
  }

  return out
}

export function normalizeShape(s) {
  return {
    ...s,
    x: s.w < 0 ? s.x + s.w : s.x,
    y: s.h < 0 ? s.y + s.h : s.y,
    w: Math.max(s.type === 'text' ? 1 : MIN_SIZE, Math.abs(s.w)),
    h: Math.max(s.type === 'text' ? 1 : MIN_SIZE, Math.abs(s.h)),
  }
}

/* Единая метрика текста: используется и холстом, и попаданием рамки,
   и экспортом — иначе границы расходились и текст обрезался. */
export const LINE_HEIGHT = 1.25

export function textLines(s) {
  return String(s.text ?? '').split('\n')
}

export function textHeight(s) {
  return (s.fontSize || 32) * LINE_HEIGHT * Math.max(1, textLines(s).length)
}

/* приблизительная ширина строки: 0.55 кегля на символ.
   Считаем циклом, а не Math.max(...spread): текст с десятками тысяч строк
   разворачивал аргументы и ронял рендер с RangeError. */
export function textWidthApprox(s) {
  const size = s.fontSize || 32
  let max = 0
  for (const line of textLines(s)) {
    const w = line.length * size * 0.55
    if (w > max) max = w
  }
  return Math.max(24, max)
}

/* У текста размеры выводятся из содержимого и кегля, поэтому держим w/h
   в актуальном состоянии. Пока они расходились с вёрсткой, ресайз считал
   коэффициент от устаревшей ширины и кегль «уезжал» от раза к разу. */
export function withTextMetrics(s) {
  if (s.type !== 'text') return s
  return { ...s, w: textWidthApprox(s), h: textHeight(s) }
}

export function shapeRect(s) {
  if (s.type !== 'text') return { x: s.x, y: s.y, w: s.w, h: s.h }
  return { x: s.x, y: s.y, w: textWidthApprox(s), h: textHeight(s) }
}

/* Фигуры, которые видны на холсте: без скрытых и без содержимого скрытых
   родителей. Отрисовка плоская, поэтому own-флаг у потомка не учитывает
   скрытый фрейм, в который он вложен. */
export function visibleShapes(shapes) {
  const hidden = new Set()
  for (const s of shapes) {
    if (s.visible !== false) continue
    hidden.add(s.id)
    for (const other of shapes) {
      if (other.parentId === s.id) hidden.add(other.id)
    }
  }
  /* закрываем цепочки произвольной глубины: ребёнок скрытого внука */
  let changed = true
  while (changed) {
    changed = false
    for (const s of shapes) {
      if (s.parentId && hidden.has(s.parentId) && !hidden.has(s.id)) {
        hidden.add(s.id)
        changed = true
      }
    }
  }
  return shapes.filter((s) => !hidden.has(s.id))
}

export function getBounds(shapes) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const s of shapes) {
    const r = shapeRect(s)
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function exportToPng(shapes) {
  const visible = visibleShapes(shapes)
  if (!visible.length) return

  const b = getBounds(visible)
  const pad = 32
  const scale = 2

  /* Браузер не может отдать canvas шире ~32k px: габариты уменьшаем
     пропорционально, иначе toDataURL вернёт пустую картинку. */
  const MAX_SIDE = 16384
  const longest = Math.max(b.w + pad * 2, b.h + pad * 2)
  const fit = longest > MAX_SIDE ? MAX_SIDE / longest : 1

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil((b.w + pad * 2) * scale * fit))
  canvas.height = Math.max(1, Math.ceil((b.h + pad * 2) * scale * fit))

  const ctx = canvas.getContext('2d')
  ctx.scale(scale * fit, scale * fit)
  ctx.translate(pad - b.x, pad - b.y)

  for (const s of visible) {
    ctx.globalAlpha = s.opacity ?? 1
    ctx.fillStyle = s.fill

    if (s.type === 'rect' || s.type === 'frame') {
      ctx.fillRect(s.x, s.y, s.w, s.h)
    } else if (s.type === 'ellipse') {
      ctx.beginPath()
      ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, s.h / 2, 0, 0, Math.PI * 2)
      ctx.fill()
    } else if (s.type === 'text') {
      /* шрифт берём тот же, что на холсте, иначе экспорт не совпадёт с видом */
      const family = s.font && s.font !== 'system-ui' ? `"${s.font}", system-ui, sans-serif` : 'system-ui, sans-serif'
      ctx.font = `${s.fontSize || 32}px ${family}`
      ctx.textBaseline = 'top'
      const lineH = (s.fontSize || 32) * LINE_HEIGHT
      let lineY = s.y
      for (const line of textLines(s)) {
        ctx.fillText(line, s.x, lineY)
        lineY += lineH
      }
    }
  }

  const link = document.createElement('a')
  link.download = 'mini-figma.png'
  link.href = canvas.toDataURL('image/png')
  link.click()
}

// Geometry helpers and PNG export for the mini-figma editor.

const MIN_SIZE = 8

export function normalizeShape(s) {
  return {
    ...s,
    x: s.w < 0 ? s.x + s.w : s.x,
    y: s.h < 0 ? s.y + s.h : s.y,
    w: Math.max(s.type === 'text' ? 1 : MIN_SIZE, Math.abs(s.w)),
    h: Math.max(s.type === 'text' ? 1 : MIN_SIZE, Math.abs(s.h)),
  }
}

export function getBounds(shapes) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const s of shapes) {
    minX = Math.min(minX, s.x)
    minY = Math.min(minY, s.y)
    maxX = Math.max(maxX, s.x + s.w)
    maxY = Math.max(maxY, s.y + (s.type === 'text' ? (s.fontSize || 32) * 1.25 : s.h))
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function exportToPng(shapes) {
  const visible = shapes.filter((s) => s.visible !== false)
  if (!visible.length) return

  const b = getBounds(visible)
  const pad = 32
  const scale = 2

  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil((b.w + pad * 2) * scale)
  canvas.height = Math.ceil((b.h + pad * 2) * scale)

  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.translate(pad - b.x, pad - b.y)

  for (const s of visible) {
    ctx.globalAlpha = s.opacity ?? 1
    ctx.fillStyle = s.fill

    if (s.type === 'rect') {
      ctx.fillRect(s.x, s.y, s.w, s.h)
    } else if (s.type === 'ellipse') {
      ctx.beginPath()
      ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, s.h / 2, 0, 0, Math.PI * 2)
      ctx.fill()
    } else if (s.type === 'text') {
      ctx.font = `${s.fontSize || 32}px system-ui, sans-serif`
      ctx.textBaseline = 'top'
      const lineH = (s.fontSize || 32) * 1.25
      let lineY = s.y
      for (const line of String(s.text || '').split('\n')) {
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

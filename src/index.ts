import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager } from './browser/session.js'
import { WebSocketHandler } from './ws/server.js'
import { MJPEG_BOUNDARY } from './stream/mjpeg.js'
import { globalBlacklist } from './browser/blacklist.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = new Hono()

// Initialize Browser Manager
const browserManager = new BrowserManager()
await browserManager.initialize()

// Helper to extract session ID from request
const getSessionId = (c: any): string => {
  return c.req.query('sessionId') || c.req.header('x-session-id') || 'default'
}

// Serve Client Web Application SPA
app.get('/', (c) => {
  let htmlPath = join(__dirname, 'public', 'index.html')
  if (!existsSync(htmlPath)) {
    htmlPath = join(process.cwd(), 'src', 'public', 'index.html')
  }
  if (existsSync(htmlPath)) {
    const htmlContent = readFileSync(htmlPath, 'utf-8')
    return c.html(htmlContent)
  }
  return c.text('Index page not found', 404)
})

app.get('/favicon.svg', (c) => {
  let iconPath = join(__dirname, 'public', 'favicon.svg')
  if (!existsSync(iconPath)) {
    iconPath = join(process.cwd(), 'src', 'public', 'favicon.svg')
  }
  if (existsSync(iconPath)) {
    const iconContent = readFileSync(iconPath, 'utf-8')
    return c.text(iconContent, 200, { 'Content-Type': 'image/svg+xml' })
  }
  return c.text('Favicon not found', 404)
})

// MJPEG HTTP Streaming Endpoint using Web Standard Hono stream() helper
app.get('/api/stream', async (c) => {
  const sessionId = getSessionId(c)
  const session = await browserManager.getOrCreateSession(sessionId, 'about:blank', { userAgent: c.req.header('user-agent') })

  c.header('Content-Type', `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`)
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0, s-maxage=0')
  c.header('Connection', 'keep-alive')
  c.header('Pragma', 'no-cache')
  c.header('X-Accel-Buffering', 'no')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Access-Control-Allow-Origin', '*')

  return stream(c, async (streamState) => {
    const unbind = session.streamManager.addStreamClient((chunk) => {
      streamState.write(chunk).catch(() => {})
    })

    streamState.onAbort(() => {
      unbind()
    })

    await new Promise<void>((resolve) => {
      streamState.onAbort(() => resolve())
    })
  })
})

// REST API Endpoints
app.get('/api/session', async (c) => {
  const sessionId = getSessionId(c)
  const session = await browserManager.getOrCreateSession(sessionId, 'about:blank', { userAgent: c.req.header('user-agent') })
  const tabs = await session.getTabs()
  const activeTabId = session.getActiveTabId()
  const viewport = session.getViewport()
  const config = session.getConfig()
  return c.json({ sessionId: session.id, tabs, activeTabId, viewport, config })
})

app.get('/api/tabs', async (c) => {
  const sessionId = getSessionId(c)
  const session = await browserManager.getOrCreateSession(sessionId, 'about:blank', { userAgent: c.req.header('user-agent') })
  const tabs = await session.getTabs()
  return c.json({ tabs, activeTabId: session.getActiveTabId() })
})

app.post('/api/tabs', async (c) => {
  const sessionId = getSessionId(c)
  const session = await browserManager.getOrCreateSession(sessionId, 'about:blank', { userAgent: c.req.header('user-agent') })
  const body = await c.req.json().catch(() => ({}))
  const tab = await session.createTab(body.url || 'about:blank')
  return c.json({ tab })
})

app.delete('/api/tabs/:id', async (c) => {
  const sessionId = getSessionId(c)
  const session = await browserManager.getOrCreateSession(sessionId, 'about:blank', { userAgent: c.req.header('user-agent') })
  const tabId = c.req.param('id')
  await session.closeTab(tabId)
  return c.json({ success: true })
})

app.post('/api/navigate', async (c) => {
  const sessionId = getSessionId(c)
  const session = await browserManager.getOrCreateSession(sessionId, 'about:blank', { userAgent: c.req.header('user-agent') })
  const body = await c.req.json().catch(() => ({}))
  if (body.url) {
    await session.navigate(body.url)
    return c.json({ success: true, url: body.url })
  }
  return c.json({ error: 'URL is required' }, 400)
})

app.get('/api/stats', async (c) => {
  const sessionId = getSessionId(c)
  const session = await browserManager.getOrCreateSession(sessionId, 'about:blank', { userAgent: c.req.header('user-agent') })
  const metrics = session.getMetrics()
  return c.json(metrics)
})

app.get('/api/blacklist', (c) => {
  return c.json({ blacklistedDomains: globalBlacklist.getDomains() })
})

app.post('/api/blacklist', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (body.domain) {
    globalBlacklist.addDomain(body.domain)
    return c.json({ success: true, blacklistedDomains: globalBlacklist.getDomains() })
  }
  return c.json({ error: 'Domain is required' }, 400)
})

app.delete('/api/blacklist', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  if (body.domain) {
    globalBlacklist.removeDomain(body.domain)
    return c.json({ success: true, blacklistedDomains: globalBlacklist.getDomains() })
  }
  return c.json({ error: 'Domain is required' }, 400)
})

// Start Node Server
const port = 3000
const server = serve({
  fetch: app.fetch,
  port
}, (info) => {
  console.log(`====================================================`)
  console.log(`🚀 browser.babel.town VM Server Running!`)
  console.log(`🌐 Web UI:  http://localhost:${info.port}`)
  console.log(`🎥 Stream:  http://localhost:${info.port}/api/stream`)
  console.log(`⚡ WebSocket: ws://localhost:${info.port}/ws`)
  console.log(`====================================================`)
})

// Attach WebSocket Handler to HTTP Server
const wsHandler = new WebSocketHandler(browserManager)
wsHandler.attach(server as any)

// Graceful Shutdown
const shutdown = async () => {
  console.log('\n[Server] Shutting down browser VM...')
  await browserManager.destroy()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

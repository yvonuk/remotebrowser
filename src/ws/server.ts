import { WebSocketServer, WebSocket } from 'ws'
import type { Server, IncomingMessage } from 'node:http'
import type { BrowserManager, UserSession } from '../browser/session.js'
import type { WSClientMessage, WSServerMessage } from '../browser/types.js'

export class WebSocketHandler {
  private wss: WebSocketServer | null = null
  private browserManager: BrowserManager
  private sessionWsMap: Map<string, Set<WebSocket>> = new Map()
  private wsSessionMap: Map<WebSocket, { sessionId: string; session: UserSession }> = new Map()
  private cleanupTimers: Map<string, NodeJS.Timeout> = new Map()

  constructor(browserManager: BrowserManager) {
    this.browserManager = browserManager
  }

  public attach(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' })

    this.wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
      const urlObj = new URL(req.url || '', 'http://localhost')
      let sessionId = urlObj.searchParams.get('sessionId')
      if (!sessionId || sessionId.trim() === '') {
        sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
      } else {
        sessionId = sessionId.trim()
      }

      // Cancel any pending destruction timer if client reconnected
      if (this.cleanupTimers.has(sessionId)) {
        clearTimeout(this.cleanupTimers.get(sessionId)!)
        this.cleanupTimers.delete(sessionId)
      }

      console.log(`[WebSocket] Client connected to session: ${sessionId}`)

      const reqUa = req.headers['user-agent']
      const userSession = await this.browserManager.getOrCreateSession(sessionId, 'about:blank', { userAgent: reqUa })

      if (!this.sessionWsMap.has(sessionId)) {
        this.sessionWsMap.set(sessionId, new Set())
      }
      this.sessionWsMap.get(sessionId)!.add(ws)
      this.wsSessionMap.set(ws, { sessionId, session: userSession })

      // Setup session callbacks for this UserSession
      this.setupSessionCallbacks(userSession, sessionId)

      // Send init state to client
      const tabs = await userSession.getTabs()
      const activeTabId = userSession.getActiveTabId() || ''
      const viewport = userSession.getViewport()
      const config = userSession.getConfig()

      const initMsg: WSServerMessage = {
        type: 'init',
        sessionId,
        viewport,
        tabs,
        activeTabId,
        config
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(initMsg))
      }

      ws.on('message', async (data: Buffer | string) => {
        try {
          const message: WSClientMessage = JSON.parse(data.toString())
          await this.handleClientMessage(ws, userSession, message)
        } catch (e) {
          console.error(`[WebSocket:${sessionId}] Error handling message:`, e)
        }
      })

      ws.on('close', () => {
        console.log(`[WebSocket] Client disconnected from session: ${sessionId}`)
        this.handleDisconnect(ws, sessionId)
      })

      ws.on('error', (err) => {
        console.error(`[WebSocket:${sessionId}] Socket error:`, err)
        this.handleDisconnect(ws, sessionId)
      })
    })

    // Setup periodic metrics broadcast per session (1s interval)
    setInterval(() => {
      for (const [sessionId, wsSet] of this.sessionWsMap.entries()) {
        if (wsSet.size === 0) continue
        const userSession = this.browserManager.getSession(sessionId)
        if (!userSession) continue

        const metrics = userSession.getMetrics()
        const msg: WSServerMessage = {
          type: 'metrics',
          fps: metrics.fps,
          frameCount: metrics.frameCount,
          clientsCount: wsSet.size
        }
        this.broadcastToSession(sessionId, msg)
      }
    }, 1000)
  }

  private setupSessionCallbacks(userSession: UserSession, sessionId: string): void {
    userSession.setCallbacks({
      onStateChange: ({ tabs, activeTabId }) => {
        const msg: WSServerMessage = {
          type: 'tabs',
          tabs,
          activeTabId
        }
        this.broadcastToSession(sessionId, msg)
      },

      onCursorChange: ({ style }) => {
        const msg: WSServerMessage = {
          type: 'cursor',
          style
        }
        this.broadcastToSession(sessionId, msg)
      },

      onFrame: (frameBase64, timestamp) => {
        const config = userSession.getConfig()
        if (config.mode === 'websocket') {
          const msg: WSServerMessage = {
            type: 'frame',
            data: frameBase64,
            timestamp
          }
          this.broadcastToSession(sessionId, msg)
        }
      }
    })
  }

  private async handleDisconnect(ws: WebSocket, sessionId: string): Promise<void> {
    this.wsSessionMap.delete(ws)
    const wsSet = this.sessionWsMap.get(sessionId)
    if (wsSet) {
      wsSet.delete(ws)
      if (wsSet.size === 0) {
        this.sessionWsMap.delete(sessionId)
        if (this.cleanupTimers.has(sessionId)) {
          clearTimeout(this.cleanupTimers.get(sessionId)!)
          this.cleanupTimers.delete(sessionId)
        }
        console.log(`[WebSocket] Client disconnected. Clearing session immediately: ${sessionId}`)
        await this.browserManager.destroySession(sessionId)
      }
    }
  }

  private async handleClientMessage(ws: WebSocket, userSession: UserSession, message: WSClientMessage): Promise<void> {
    switch (message.type) {
      case 'mouse':
        await userSession.handleMouseInput(message)
        break

      case 'key':
        await userSession.handleKeyboardInput(message)
        break

      case 'navigate':
        await userSession.navigate(message.url)
        break

      case 'nav_action':
        await userSession.performNavAction(message.action)
        break

      case 'tab_action':
        if (message.action === 'create') {
          await userSession.createTab(message.url || 'about:blank')
        } else if (message.action === 'close' && message.tabId) {
          await userSession.closeTab(message.tabId)
        } else if (message.action === 'switch' && message.tabId) {
          await userSession.switchTab(message.tabId)
        }
        break

      case 'viewport':
        await userSession.resizeViewport(message.width, message.height)
        break

      case 'stream_config':
        userSession.updateConfig(message)
        break

      case 'ping':
        const pongMsg: WSServerMessage = {
          type: 'pong',
          timestamp: message.timestamp,
          serverTime: Date.now()
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(pongMsg))
        }
        break
    }
  }

  private broadcastToSession(sessionId: string, msg: WSServerMessage): void {
    const wsSet = this.sessionWsMap.get(sessionId)
    if (!wsSet || wsSet.size === 0) return
    const payload = JSON.stringify(msg)
    for (const ws of wsSet) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload)
      }
    }
  }
}

import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright'
import type { CursorState, KeyboardInputPayload, MouseInputPayload, StreamConfig, TabInfo, ViewportSize } from './types.js'
import { dispatchCdpKeyEvent, dispatchCdpMouseEvent } from './cdp.js'
import { MJPEGStreamManager } from '../stream/mjpeg.js'
import { globalBlacklist } from './blacklist.js'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = join(process.cwd(), 'logs')
const LOG_FILE = join(LOG_DIR, 'visited_sites.log')

function logVisit(sessionId: string, url: string): void {
  if (!url || url.startsWith('about:') || url === 'chrome://newtab/') return
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const timestamp = new Date().toISOString()
    const line = `${timestamp}\t${sessionId}\t${url}\n`
    appendFileSync(LOG_FILE, line, 'utf-8')
    console.log(`[Visit] ${timestamp} | session=${sessionId} | ${url}`)
  } catch (e) {
    console.warn('[Visit] Failed to write visit log:', e)
  }
}

const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 browser.babel.town/1.0'
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.230803.041) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36'

export function isMobileUserAgent(ua?: string): boolean {
  if (!ua) return false
  return /Android.*Mobile|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)
}

export class UserSession {
  public id: string
  private context: BrowserContext
  private pages: Map<string, Page> = new Map()
  private cdpSessions: Map<string, CDPSession> = new Map()
  private activeTabId: string | null = null

  private viewport: ViewportSize = { width: 1280, height: 720, deviceScaleFactor: 1 }
  private config: StreamConfig = {
    fps: 25,
    quality: 75,
    width: 1280,
    height: 720,
    mode: 'mjpeg'
  }

  public streamManager: MJPEGStreamManager = new MJPEGStreamManager()

  private onStateChangeCallback?: (state: { tabs: TabInfo[]; activeTabId: string }) => void
  private onCursorChangeCallback?: (cursor: CursorState) => void
  private onFrameCallback?: (frameBase64: string, timestamp: number) => void

  private currentCursor = 'default'
  private isScreencasting = false
  private currentScreencastListener: ((params: any) => Promise<void>) | null = null
  private captureIntervalTimer: NodeJS.Timeout | null = null
  private fpsTrackerTimer: NodeJS.Timeout | null = null

  // Performance metrics
  private frameCounter = 0
  private lastFpsCheckTime = Date.now()
  private currentFps = 0

  constructor(id: string, context: BrowserContext, initialViewport?: { width: number; height: number }) {
    this.id = id
    this.context = context
    const width = initialViewport?.width ?? 1280
    const height = initialViewport?.height ?? 720
    const isMobile = height > width
    this.viewport = { width, height, deviceScaleFactor: isMobile ? 2 : 1 }
    this.config = {
      fps: 25,
      quality: 75,
      width,
      height,
      mode: 'mjpeg'
    }
    this.startFpsTracker()
  }

  public async initialize(defaultUrl = 'about:blank'): Promise<void> {
    // Intercept network requests to enforce domain blacklist
    await this.context.route('**/*', async (route, request) => {
      const requestUrl = request.url()
      if (globalBlacklist.isBlacklisted(requestUrl)) {
        if (request.isNavigationRequest()) {
          await route.fulfill({
            status: 403,
            contentType: 'text/html',
            body: globalBlacklist.getBlockedHtml(requestUrl)
          }).catch(() => {})
        } else {
          await route.abort('blockedbyclient').catch(() => {})
        }
      } else {
        await route.continue().catch(() => {})
      }
    }).catch(() => {})

    await this.createTab(defaultUrl)
  }

  public setCallbacks(callbacks: {
    onStateChange?: (state: { tabs: TabInfo[]; activeTabId: string }) => void
    onCursorChange?: (cursor: CursorState) => void
    onFrame?: (frameBase64: string, timestamp: number) => void
  }) {
    this.onStateChangeCallback = callbacks.onStateChange
    this.onCursorChangeCallback = callbacks.onCursorChange
    this.onFrameCallback = callbacks.onFrame
  }

  public static readonly MAX_TABS = 5

  public async createTab(url = 'about:blank'): Promise<TabInfo> {
    if (!this.context) throw new Error('Session context not initialized')
    if (this.pages.size >= UserSession.MAX_TABS) {
      throw new Error(`Tab limit reached: maximum ${UserSession.MAX_TABS} tabs allowed`)
    }

    const page = await this.context.newPage()
    const tabId = `tab_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`

    this.pages.set(tabId, page)

    // Setup CDP Session
    const cdp = await page.context().newCDPSession(page)
    this.cdpSessions.set(tabId, cdp)

    // Apply viewport emulation (mobile vs desktop) before initial page load
    await this.applyEmulationToTab(tabId, this.viewport.width, this.viewport.height)

    // Listen to page events
    page.on('load', () => {
      this.notifyStateChange()
      this.captureFrameNow().catch(() => {})
    })
    page.on('domcontentloaded', () => {
      this.notifyStateChange()
      this.captureFrameNow().catch(() => {})
    })
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        logVisit(this.id, frame.url())
      }
      this.notifyStateChange()
      this.captureFrameNow().catch(() => {})
    })
    page.on('close', () => this.handlePageClose(tabId))

    // Block file upload pickers and file downloads
    page.on('filechooser', () => {
      console.warn(`[UserSession:${this.id}] Blocked file chooser request`)
    })
    page.on('download', (d) => {
      d.cancel().catch(() => {})
      console.warn(`[UserSession:${this.id}] Blocked file download request`)
    })

    // Set active tab
    await this.switchTab(tabId)

    // Navigate to URL
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
    } catch (e) {
      console.warn(`[UserSession:${this.id}] Initial nav warning:`, e)
    }

    this.notifyStateChange()
    return (await this.getTabs()).find((t) => t.id === tabId)!
  }

  public async switchTab(tabId: string): Promise<void> {
    if (!this.pages.has(tabId)) return
    if (this.activeTabId === tabId) return

    // Stop screencast on previous tab
    await this.stopScreencast()

    this.activeTabId = tabId
    const page = this.pages.get(tabId)!
    await page.bringToFront().catch(() => {})

    // Start screencast on newly active tab
    await this.startScreencast()
    this.notifyStateChange()
  }

  public async closeTab(tabId: string): Promise<void> {
    const page = this.pages.get(tabId)
    if (!page) return

    const cdp = this.cdpSessions.get(tabId)
    if (cdp) {
      await cdp.detach().catch(() => {})
      this.cdpSessions.delete(tabId)
    }

    this.pages.delete(tabId)
    await page.close().catch(() => {})

    if (this.activeTabId === tabId) {
      this.activeTabId = null
      const remainingTabs = Array.from(this.pages.keys())
      if (remainingTabs.length > 0) {
        await this.switchTab(remainingTabs[0])
      } else {
        await this.destroy()
      }
    } else {
      this.notifyStateChange()
    }
  }

  private handlePageClose(tabId: string) {
    if (this.pages.has(tabId)) {
      this.pages.delete(tabId)
      this.cdpSessions.delete(tabId)
      if (this.activeTabId === tabId) {
        this.activeTabId = Array.from(this.pages.keys())[0] || null
      }
      this.notifyStateChange()
    }
  }

  public async captureFrameNow(): Promise<void> {
    if (!this.activeTabId) return
    const page = this.pages.get(this.activeTabId)
    if (!page || page.isClosed()) return

    try {
      const screenshotBuf = await page.screenshot({
        type: 'jpeg',
        quality: this.config.quality,
        scale: 'css',
        timeout: 3000
      })

      this.streamManager.broadcastFrame(screenshotBuf)
      if (this.onFrameCallback) {
        this.onFrameCallback(screenshotBuf.toString('base64'), Date.now())
      }
      this.frameCounter++
    } catch {}
  }

  private lastFrameTime = 0

  private async startScreencast(): Promise<void> {
    if (!this.activeTabId) return
    const cdp = this.cdpSessions.get(this.activeTabId)
    const page = this.pages.get(this.activeTabId)
    if (!cdp || !page) return

    try {
      if (this.currentScreencastListener) {
        cdp.off('Page.screencastFrame', this.currentScreencastListener)
        this.currentScreencastListener = null
      }

      this.isScreencasting = true

      const listener = async (params: { data: string; metadata: any; sessionId: number }) => {
        if (!this.isScreencasting) return

        this.lastFrameTime = Date.now()
        const buffer = Buffer.from(params.data, 'base64')
        const timestamp = Date.now()

        // Broadcast frame to MJPEG subscribers
        this.streamManager.broadcastFrame(buffer)

        // Broadcast frame to WS subscribers if requested
        if (this.onFrameCallback) {
          this.onFrameCallback(params.data, timestamp)
        }

        this.frameCounter++

        // Acknowledge screencast frame to Chromium
        try {
          await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId })
        } catch {}
      }

      this.currentScreencastListener = listener
      cdp.on('Page.screencastFrame', listener)

      // Start CDP screencast
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.config.quality,
        maxWidth: this.viewport.width,
        maxHeight: this.viewport.height,
        everyNthFrame: 1
      })

      // Fallback continuous capture loop in case page is static and CDP screencast stops emitting frames
      this.startCaptureFallbackLoop()

      // Take immediate frame capture to populate stream manager
      this.captureFrameNow().catch(() => {})
    } catch (e) {
      console.error(`[UserSession:${this.id}] Screencast start error:`, e)
      this.startCaptureFallbackLoop()
    }
  }

  private async stopScreencast(): Promise<void> {
    this.isScreencasting = false
    if (this.captureIntervalTimer) {
      clearInterval(this.captureIntervalTimer)
      this.captureIntervalTimer = null
    }

    if (this.activeTabId) {
      const cdp = this.cdpSessions.get(this.activeTabId)
      if (cdp) {
        try {
          if (this.currentScreencastListener) {
            cdp.off('Page.screencastFrame', this.currentScreencastListener)
            this.currentScreencastListener = null
          }
          await cdp.send('Page.stopScreencast')
        } catch {}
      }
    }
  }

  private startCaptureFallbackLoop(): void {
    if (this.captureIntervalTimer) clearInterval(this.captureIntervalTimer)

    const intervalMs = Math.floor(1000 / (this.config.fps || 25))
    this.captureIntervalTimer = setInterval(async () => {
      // Only capture via screenshot fallback if no screencast frame has arrived in the last 1000ms
      if (Date.now() - this.lastFrameTime < 1000) return
      if (!this.activeTabId) return
      const page = this.pages.get(this.activeTabId)
      if (!page || page.isClosed()) return

      try {
        const screenshotBuf = await page.screenshot({
          type: 'jpeg',
          quality: this.config.quality,
          scale: 'css',
          timeout: 2000
        })

        this.streamManager.broadcastFrame(screenshotBuf)
        if (this.onFrameCallback) {
          this.onFrameCallback(screenshotBuf.toString('base64'), Date.now())
        }
        this.frameCounter++
      } catch {}
    }, intervalMs)
  }

  public async handleMouseInput(mouse: MouseInputPayload): Promise<void> {
    if (!this.activeTabId) return
    const cdp = this.cdpSessions.get(this.activeTabId)
    if (!cdp) return

    await dispatchCdpMouseEvent(cdp, mouse)

    // Check hover element cursor style on mouse move
    if (mouse.event === 'move' && Math.random() < 0.2) {
      this.updateCursorState(mouse.x, mouse.y)
    }
  }

  public async handleKeyboardInput(keyMsg: KeyboardInputPayload): Promise<void> {
    if (!this.activeTabId) return
    const page = this.pages.get(this.activeTabId)
    const cdp = this.cdpSessions.get(this.activeTabId)
    if (!page || !cdp) return

    await dispatchCdpKeyEvent(page, cdp, keyMsg)
  }

  public async navigate(rawUrl: string): Promise<void> {
    if (!this.activeTabId) return
    const page = this.pages.get(this.activeTabId)
    if (!page) return

    let formattedUrl = rawUrl.trim()
    if (!formattedUrl.startsWith('http://') && !formattedUrl.startsWith('https://') && !formattedUrl.startsWith('about:')) {
      if (formattedUrl.includes('.') && !formattedUrl.includes(' ')) {
        formattedUrl = `https://${formattedUrl}`
      } else {
        formattedUrl = `https://www.google.com/search?q=${encodeURIComponent(formattedUrl)}`
      }
    }

    try {
      this.notifyStateChange()
      await page.goto(formattedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    } catch (e) {
      console.warn(`[UserSession:${this.id}] Navigation error for ${formattedUrl}:`, e)
    } finally {
      this.notifyStateChange()
      await this.captureFrameNow().catch(() => {})
    }
  }

  public async performNavAction(action: 'back' | 'forward' | 'reload' | 'stop' | 'home'): Promise<void> {
    if (!this.activeTabId) return
    const page = this.pages.get(this.activeTabId)
    if (!page) return

    try {
      switch (action) {
        case 'back':
          await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {})
          break
        case 'forward':
          await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {})
          break
        case 'reload':
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
          break
        case 'stop':
          // Stop page loading via CDP
          const cdp = this.cdpSessions.get(this.activeTabId)
          if (cdp) await cdp.send('Page.stopLoading').catch(() => {})
          break
        case 'home':
          await page.goto('about:blank', { waitUntil: 'domcontentloaded' })
          break
      }
    } finally {
      this.notifyStateChange()
      await this.captureFrameNow().catch(() => {})
    }
  }

  private async applyEmulationToTab(tabId: string, width: number, height: number): Promise<void> {
    const cdp = this.cdpSessions.get(tabId)
    const page = this.pages.get(tabId)
    if (!cdp || !page) return

    const isMobile = height > width

    try {
      // Set User-Agent & Client Hints Metadata
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: isMobile ? MOBILE_UA : DESKTOP_UA,
        acceptLanguage: 'en-US,en;q=0.9',
        platform: isMobile ? 'Linux armv8l' : 'Linux x86_64',
        userAgentMetadata: isMobile ? {
          brands: [
            { brand: 'Chromium', version: '128' },
            { brand: 'Not;A=Brand', version: '24' }
          ],
          fullVersion: '128.0.0.0',
          platform: 'Android',
          platformVersion: '14.0.0',
          architecture: '',
          model: 'Pixel 8',
          mobile: true
        } : {
          brands: [
            { brand: 'Chromium', version: '128' },
            { brand: 'Not;A=Brand', version: '24' }
          ],
          fullVersion: '128.0.0.0',
          platform: 'Linux',
          platformVersion: '',
          architecture: 'x86',
          model: '',
          mobile: false
        }
      }).catch(() => {})

      // Set Device Metrics Override (Viewport, scale factor, mobile mode)
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: width,
        height: height,
        deviceScaleFactor: isMobile ? 2 : 1,
        mobile: isMobile,
        screenWidth: width,
        screenHeight: height,
        dontSetVisibleSize: false
      }).catch(() => {})

      // Touch emulation for mobile viewports
      await cdp.send('Emulation.setTouchEmulationEnabled', {
        enabled: isMobile,
        maxTouchPoints: isMobile ? 5 : 1
      }).catch(() => {})

      await cdp.send('Emulation.setEmitTouchEventsForMouse', {
        enabled: isMobile,
        configuration: isMobile ? 'mobile' : 'desktop'
      }).catch(() => {})

      // Update Playwright page viewport
      await page.setViewportSize({ width, height }).catch(() => {})
    } catch (e) {
      console.warn(`[UserSession:${this.id}] Emulation error for tab ${tabId}:`, e)
    }
  }

  public async resizeViewport(width: number, height: number): Promise<void> {
    if (width <= 0 || height <= 0) return
    const wasMobile = this.viewport.height > this.viewport.width
    const isMobile = height > width

    this.viewport = { width, height, deviceScaleFactor: isMobile ? 2 : 1 }
    this.config.width = width
    this.config.height = height

    // Apply emulation overrides to all open tabs
    for (const tabId of this.pages.keys()) {
      await this.applyEmulationToTab(tabId, width, height)
    }

    // If mobile mode changed, reload active page so server-side rendered or UA-dependent sites re-render in mobile layout
    if (this.activeTabId && wasMobile !== isMobile) {
      const activePage = this.pages.get(this.activeTabId)
      if (activePage && !activePage.isClosed() && activePage.url() && !activePage.url().startsWith('about:')) {
        await activePage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
      }
    }

    // Restart screencast with new viewport bounds
    await this.stopScreencast()
    await this.startScreencast()
    this.notifyStateChange()
  }

  public updateConfig(newConfig: Partial<StreamConfig>): void {
    if (newConfig.fps && newConfig.fps > 0) this.config.fps = Math.min(60, Math.max(1, newConfig.fps))
    if (newConfig.quality && newConfig.quality > 0) this.config.quality = Math.min(100, Math.max(10, newConfig.quality))
    if (newConfig.mode) this.config.mode = newConfig.mode

    // Restart fallback timer interval if running
    if (this.captureIntervalTimer) {
      this.startCaptureFallbackLoop()
    }
  }

  private async updateCursorState(x: number, y: number): Promise<void> {
    if (!this.activeTabId) return
    const page = this.pages.get(this.activeTabId)
    if (!page || page.isClosed()) return

    try {
      const cursorStyle = await page.evaluate(({ px, py }) => {
        const el = document.elementFromPoint(px, py)
        if (!el) return 'default'
        return window.getComputedStyle(el).cursor || 'default'
      }, { px: x, py: y }).catch(() => 'default')

      if (cursorStyle && cursorStyle !== this.currentCursor) {
        this.currentCursor = cursorStyle
        if (this.onCursorChangeCallback) {
          this.onCursorChangeCallback({ style: cursorStyle, x, y })
        }
      }
    } catch {}
  }

  public async getTabs(): Promise<TabInfo[]> {
    const tabInfos: TabInfo[] = []

    for (const [id, page] of this.pages.entries()) {
      if (page.isClosed()) continue

      let title = 'New Tab'
      let url = 'about:blank'
      let isLoading = false
      let favicon: string | undefined

      try {
        title = (await page.title()) || 'Untitled'
        url = page.url() || 'about:blank'
      } catch {}

      // Resolve favicon only for real web pages
      if (url && !url.startsWith('about:') && !url.startsWith('chrome://')) {
        try {
          const faviconUrl = await page.evaluate(() => {
            const selectors = [
              'link[rel="icon"][href]',
              'link[rel="shortcut icon"][href]',
              'link[rel~="icon"][href]',
            ]
            for (const sel of selectors) {
              const el = document.querySelector(sel) as HTMLLinkElement | null
              if (el?.href) return el.href
            }
            return null
          })
          favicon = faviconUrl ?? `${new URL(url).origin}/favicon.ico`
        } catch {
          try { favicon = `${new URL(url).origin}/favicon.ico` } catch {}
        }
      }

      tabInfos.push({
        id,
        title,
        url,
        favicon,
        isLoading,
        canGoBack: true,
        canGoForward: true,
        isActive: id === this.activeTabId
      })
    }

    return tabInfos
  }

  public getActiveTabId(): string | null {
    return this.activeTabId
  }

  public getViewport(): ViewportSize {
    return this.viewport
  }

  public getConfig(): StreamConfig {
    return this.config
  }

  public getMetrics() {
    return {
      fps: this.currentFps,
      frameCount: this.frameCounter,
      clientsCount: this.streamManager.getClientCount(),
      activeTabId: this.activeTabId,
      totalTabs: this.pages.size
    }
  }

  private notifyStateChange(): void {
    if (!this.onStateChangeCallback) return
    this.getTabs().then((tabs) => {
      if (this.onStateChangeCallback && this.activeTabId) {
        this.onStateChangeCallback({ tabs, activeTabId: this.activeTabId })
      }
    })
  }

  private startFpsTracker(): void {
    this.fpsTrackerTimer = setInterval(() => {
      const now = Date.now()
      const elapsed = (now - this.lastFpsCheckTime) / 1000
      this.currentFps = Math.round(this.frameCounter / elapsed)
      this.frameCounter = 0
      this.lastFpsCheckTime = now
    }, 1000)
  }

  public async destroy(): Promise<void> {
    await this.stopScreencast()
    if (this.fpsTrackerTimer) {
      clearInterval(this.fpsTrackerTimer)
      this.fpsTrackerTimer = null
    }
    for (const cdp of this.cdpSessions.values()) {
      await cdp.detach().catch(() => {})
    }
    this.cdpSessions.clear()
    for (const page of this.pages.values()) {
      await page.close().catch(() => {})
    }
    this.pages.clear()
    await this.context.close().catch(() => {})
  }
}

export class BrowserManager {
  private browser: Browser | null = null
  private sessions: Map<string, UserSession> = new Map()
  private sessionPromises: Map<string, Promise<UserSession>> = new Map()

  public async initialize(): Promise<void> {
    console.log('[BrowserManager] Launching Chromium instance...')
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-local-file-access',
        '--disable-file-system'
      ]
    })
  }

  public async getOrCreateSession(
    sessionId?: string,
    defaultUrl = 'about:blank',
    options?: { width?: number; height?: number; userAgent?: string }
  ): Promise<UserSession> {
    const id = (sessionId && sessionId.trim()) ? sessionId.trim() : 'default'

    const existingSession = this.sessions.get(id)
    if (existingSession) return existingSession

    const pendingPromise = this.sessionPromises.get(id)
    if (pendingPromise) return pendingPromise

    const sessionPromise = (async () => {
      try {
        if (!this.browser) throw new Error('Browser not initialized')

        let width = options?.width
        let height = options?.height

        if (!width || !height) {
          const isMobile = isMobileUserAgent(options?.userAgent)
          width = isMobile ? 720 : 1280
          height = isMobile ? 1280 : 720
        }

        const isMobile = height > width
        const context = await this.browser.newContext({
          viewport: { width, height },
          deviceScaleFactor: isMobile ? 2 : 1,
          userAgent: isMobile ? MOBILE_UA : DESKTOP_UA
        })
        const session = new UserSession(id, context, { width, height })
        await session.initialize(defaultUrl)
        this.sessions.set(id, session)
        console.log(`[BrowserManager] Created isolated UserSession: ${id} (${width}x${height})`)
        return session
      } finally {
        this.sessionPromises.delete(id)
      }
    })()

    this.sessionPromises.set(id, sessionPromise)
    return sessionPromise
  }

  public getSession(sessionId: string): UserSession | undefined {
    return this.sessions.get(sessionId)
  }

  public async destroySession(sessionId: string): Promise<void> {
    this.sessionPromises.delete(sessionId)
    const session = this.sessions.get(sessionId)
    if (session) {
      console.log(`[BrowserManager] Destroying UserSession: ${sessionId}`)
      await session.destroy().catch(() => {})
      this.sessions.delete(sessionId)
    }
  }

  public async destroy(): Promise<void> {
    this.sessionPromises.clear()
    for (const [id, session] of this.sessions.entries()) {
      await session.destroy().catch(() => {})
    }
    this.sessions.clear()
    if (this.browser) {
      await this.browser.close().catch(() => {})
    }
  }
}

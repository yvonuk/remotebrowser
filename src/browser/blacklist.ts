export const INITIAL_BLACKLIST: string[] = [
  'chatgpt.com',
  'openai.com',
  'claude.ai',
  'claude.com',
  'grok.com',
  'x.ai',
  'babel.town'
]

export class DomainBlacklist {
  private domains: Set<string> = new Set()

  constructor(initialDomains: string[] = INITIAL_BLACKLIST) {
    for (const d of initialDomains) {
      this.addDomain(d)
    }
  }

  public addDomain(domain: string): void {
    const clean = domain.trim().toLowerCase()
    if (clean) this.domains.add(clean)
  }

  public removeDomain(domain: string): void {
    const clean = domain.trim().toLowerCase()
    this.domains.delete(clean)
  }

  public getDomains(): string[] {
    return Array.from(this.domains)
  }

  public isBlacklisted(urlStr: string): boolean {
    if (!urlStr) return false
    const trimmed = urlStr.trim().toLowerCase()

    // Block local file system protocols and browser internal schemes
    if (
      trimmed.startsWith('file:') ||
      trimmed.startsWith('view-source:') ||
      trimmed.startsWith('chrome:') ||
      trimmed.startsWith('chrome-extension:')
    ) {
      return true
    }

    try {
      let hostname = trimmed
      if (hostname.includes('://')) {
        const parsed = new URL(hostname)
        // Block non-http/https/about protocols (e.g., file:, ftp:)
        if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) {
          return true
        }
        hostname = parsed.hostname
      } else if (hostname.includes('/')) {
        hostname = hostname.split('/')[0]
      }

      // Strip port if present in raw hostname
      if (hostname.includes(':') && !hostname.startsWith('[')) {
        hostname = hostname.split(':')[0]
      }

      // Block Localhost, Loopback, and Cloud Metadata endpoints
      if (
        hostname === 'localhost' ||
        hostname.endsWith('.localhost') ||
        hostname === '127.0.0.1' ||
        hostname === '0.0.0.0' ||
        hostname === '::1' ||
        hostname === '[::1]' ||
        hostname === '169.254.169.254'
      ) {
        return true
      }

      // Check IPv4 Private Ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x)
      const ipParts = hostname.split('.').map(Number)
      if (ipParts.length === 4 && ipParts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
        const [a, b] = ipParts
        if (a === 127) return true // Loopback
        if (a === 10) return true // 10.0.0.0/8 Private
        if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 Private
        if (a === 192 && b === 168) return true // 192.168.0.0/16 Private
        if (a === 169 && b === 254) return true // 169.254.0.0/16 Link-Local / Cloud Metadata
        if (a === 0) return true // 0.0.0.0/8
      }

      // Check custom domain blacklist
      for (const domain of this.domains) {
        if (hostname === domain || hostname.endsWith(`.${domain}`)) {
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }

  public getBlockedHtml(urlStr: string): string {
    let hostname = urlStr
    try {
      if (urlStr.startsWith('file:')) {
        hostname = 'Local File System'
      } else {
        hostname = new URL(urlStr).hostname || urlStr
      }
    } catch {}

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Access Restricted</title>
  <style>
    :root {
      --bg-base: #090d16;
      --bg-surface: #111827;
      --border-color: rgba(239, 68, 68, 0.3);
      --text-primary: #f3f4f6;
      --text-secondary: #9ca3af;
      --accent-red: #ef4444;
    }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background-color: var(--bg-base);
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      padding: 16px;
      box-sizing: border-box;
    }
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 32px;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5);
    }
    .icon {
      font-size: 48px;
      margin-bottom: 12px;
    }
    h1 {
      color: var(--accent-red);
      margin: 0 0 12px 0;
      font-size: 22px;
      font-weight: 700;
    }
    p {
      color: var(--text-secondary);
      font-size: 14px;
      line-height: 1.6;
      margin: 0 0 16px 0;
    }
    .domain-tag {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      padding: 3px 8px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 13px;
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🚫</div>
    <h1>Access Restricted</h1>
    <p>Access to <span class="domain-tag">${hostname}</span> is blocked by security policy.</p>
  </div>
</body>
</html>`
  }
}

export const globalBlacklist = new DomainBlacklist()

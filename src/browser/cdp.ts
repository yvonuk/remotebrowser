import type { CDPSession, Page } from 'playwright'
import type { MouseInputPayload, KeyboardInputPayload } from './types.js'

export function computeModifiersBitmask(modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }): number {
  if (!modifiers) return 0
  let bitmask = 0
  if (modifiers.alt) bitmask |= 1
  if (modifiers.ctrl) bitmask |= 2
  if (modifiers.meta) bitmask |= 4
  if (modifiers.shift) bitmask |= 8
  return bitmask
}

export async function dispatchCdpMouseEvent(cdp: CDPSession, mouse: MouseInputPayload): Promise<void> {
  const modifiers = computeModifiersBitmask(mouse.modifiers)
  const x = Math.max(0, Math.round(mouse.x))
  const y = Math.max(0, Math.round(mouse.y))

  const buttonMap: Record<string, string> = {
    left: 'left',
    right: 'right',
    middle: 'middle',
    none: 'none'
  }

  const button = mouse.button ? (buttonMap[mouse.button] || 'left') : 'none'
  const buttons = mouse.buttons ?? (mouse.event === 'down' ? (button === 'right' ? 2 : button === 'middle' ? 4 : 1) : 0)

  switch (mouse.event) {
    case 'move':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: button as any,
        buttons,
        modifiers
      })
      break

    case 'down':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: (button === 'none' ? 'left' : button) as any,
        buttons: buttons || 1,
        clickCount: mouse.clickCount || 1,
        modifiers
      })
      break

    case 'up':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: (button === 'none' ? 'left' : button) as any,
        buttons: 0,
        clickCount: mouse.clickCount || 1,
        modifiers
      })
      break

    case 'click':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: (button === 'none' ? 'left' : button) as any,
        buttons: 1,
        clickCount: 1,
        modifiers
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: (button === 'none' ? 'left' : button) as any,
        buttons: 0,
        clickCount: 1,
        modifiers
      })
      break

    case 'dblclick':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 2,
        modifiers
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 2,
        modifiers
      })
      break

    case 'contextmenu':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'right',
        buttons: 2,
        clickCount: 1,
        modifiers
      })
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'right',
        buttons: 0,
        clickCount: 1,
        modifiers
      })
      break

    case 'wheel':
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: mouse.deltaX || 0,
        deltaY: mouse.deltaY || 0,
        modifiers
      })
      break
  }
}

export async function dispatchCdpKeyEvent(page: Page, cdp: CDPSession, keyMsg: KeyboardInputPayload): Promise<void> {
  const modifiers = computeModifiersBitmask(keyMsg.modifiers)

  if (keyMsg.event === 'text' && keyMsg.text) {
    await cdp.send('Input.insertText', { text: keyMsg.text })
    return
  }

  // Use Playwright page keyboard if available for high reliability on special keys
  try {
    if (keyMsg.event === 'down' || keyMsg.event === 'press') {
      if (keyMsg.key.length === 1 && !keyMsg.modifiers?.ctrl && !keyMsg.modifiers?.meta && !keyMsg.modifiers?.alt) {
        await page.keyboard.type(keyMsg.key)
      } else {
        await page.keyboard.press(keyMsg.key)
      }
      return
    }
  } catch {
    // Fallback to direct CDP dispatch if Playwright page.keyboard fails
  }

  const type = keyMsg.event === 'down' ? 'keyDown' : 'keyUp'
  await cdp.send('Input.dispatchKeyEvent', {
    type,
    key: keyMsg.key,
    code: keyMsg.code || '',
    text: keyMsg.text || (keyMsg.key.length === 1 ? keyMsg.key : ''),
    modifiers
  })
}

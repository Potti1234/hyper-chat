import { chromium } from 'playwright'

/* Overlay check: every popover, picker and menu must open fully on screen,
   at its full width (not squeezed against an edge).

   On each page and at each window size, it hovers the messages nearest the
   top and bottom of the message list and of the thread pane, and opens every
   trigger the hover reveals (anything with aria-haspopup: the emoji picker,
   the message menu, the add-reaction button). The panel that opens must lie
   inside the window.

   Usage: node scripts/check-overlays.mjs   (URL=… for another server; needs
   the demo content, as npm run check:fresh provides) */

const base = process.env.URL ?? 'http://localhost:4300'
const TIMEOUT = 4000
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 640 },
]
const OVERLAY = '#emoji-picker, [role="menu"]'

const failures = []
let opened = 0

/** Records whether the panel matching `selector` lies inside the window at its full width. */
const measure = async (page, selector, label) => {
  await page.waitForTimeout(100)
  const box = await page.evaluate(selector => {
    const panel = document.querySelector(selector)
    const rect = panel.getBoundingClientRect()
    // Anchored panels get an inline max-width; their natural width is measured without it.
    const limit = panel.style.maxWidth
    if (limit !== '') panel.style.maxWidth = 'none'
    const natural = panel.getBoundingClientRect().width
    panel.style.maxWidth = limit
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight, panelWidth: rect.width, natural }
  }, selector)
  opened += 1
  const outside = [
    box.left < 0 && `${Math.round(-box.left)}px past the left edge`,
    box.top < 0 && `${Math.round(-box.top)}px past the top`,
    box.right > box.width && `${Math.round(box.right - box.width)}px past the right edge`,
    box.bottom > box.height && `${Math.round(box.bottom - box.height)}px past the bottom`,
    box.panelWidth < box.natural - 1 && `squeezed to ${Math.round(box.panelWidth)} of ${Math.round(box.natural)}px wide`,
  ].filter(Boolean)
  if (outside.length > 0) failures.push(`${label} → ${outside.join(', ')}`)
}

const live = async (page, go) => {
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await go()
  await stream
  await page.waitForFunction(() => document.querySelector('#hyper-keys') !== null)
  await page.waitForTimeout(200)
}

const browser = await chromium.launch()
try {
  for (const size of SIZES) {
    const context = await browser.newContext({ viewport: size })
    const page = await context.newPage()
    await page.goto(`${base}/client/ch_general`)
    await page.getByLabel('Email').fill('afinch@hyperchat.example')
    await page.getByLabel('Password').fill('avery')
    await live(page, () => page.getByRole('button', { name: 'Sign in' }).click())
    // A thread to open: the first summary's.
    await page.locator('button[aria-label*="open thread"]').first().click()
    await page.waitForURL(/\/thread\//, { timeout: TIMEOUT })
    const threadPath = new URL(page.url()).pathname

    for (const path of ['/client/ch_general', '/client/ch_random', threadPath]) {
      await live(page, () => page.goto(`${base}${path}`))
      for (const scope of ['#message-list', '#thread']) {
        // The visible messages nearest the top and the bottom of the panel.
        const rows = await page.evaluate(scope => {
          const panel = document.querySelector(scope)
          if (panel === null) return []
          const bounds = panel.getBoundingClientRect()
          const visible = [...panel.querySelectorAll('li[data-author]')].filter(row => {
            const rect = row.getBoundingClientRect()
            return rect.height > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom
          })
          return [...new Set([visible[0], visible.at(-1)].filter(Boolean))].map(row => row.id)
        }, scope)
        for (const id of rows) {
          const row = page.locator(`[id="${id}"]`)
          await row.hover()
          const triggers = await row.locator('[aria-haspopup]').evaluateAll(elements =>
            elements.filter(element => element.getBoundingClientRect().width > 0).map(element => element.getAttribute('aria-label') ?? element.id),
          )
          for (const name of triggers) {
            const label = `${size.width}×${size.height} ${path} ${scope} ${id}: ${name}`
            await row.hover()
            await row.locator(`[aria-haspopup][aria-label="${name}"], [aria-haspopup][id="${name}"]`).first().click()
            if (!(await page.waitForSelector(OVERLAY, { state: 'visible', timeout: TIMEOUT }).then(() => true, () => false))) {
              failures.push(`${label} opened nothing`)
              continue
            }
            await measure(page, OVERLAY, label)
            await page.keyboard.press('Escape')
            await page.waitForSelector(OVERLAY, { state: 'hidden', timeout: TIMEOUT }).catch(() => failures.push(`${label}: Escape left it open`))
            await page.waitForTimeout(100)
          }
        }
      }
    }
    // The To field's people suggestions, in the DMs tab.
    await live(page, () => page.goto(`${base}/dms`))
    await page.click('#to-input')
    await page.keyboard.type('a')
    if (await page.waitForSelector('#people-picker', { state: 'visible', timeout: TIMEOUT }).then(() => true, () => false)) await measure(page, '#people-picker', `${size.width}×${size.height} /dms: people suggestions`)
    else failures.push(`${size.width}×${size.height} /dms: no people suggestions`)
    // The quick switcher (Ctrl+K).
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+k')
    if (await page.waitForSelector('#switcher-input', { state: 'visible', timeout: TIMEOUT }).then(() => true, () => false)) {
      await page.keyboard.type('a')
      await page.waitForTimeout(200)
      await measure(page, '#switcher-panel', `${size.width}×${size.height} /dms: quick switcher`)
    } else failures.push(`${size.width}×${size.height} /dms: Ctrl+K opened nothing`)
    // The status and profile dialogs on your profile.
    await page.goto(`${base}/people/mem_avery`)
    for (const [opener, panel, label] of [['#set-status-button', '#set-status-panel', 'set a status'], ['#edit-profile-button', '#edit-profile-panel', 'edit profile']]) {
      await page.waitForSelector(opener, { state: 'visible', timeout: TIMEOUT }).catch(() => {})
      await page.click(opener).catch(() => {})
      if (await page.waitForSelector(panel, { state: 'visible', timeout: TIMEOUT }).then(() => true, () => false)) await measure(page, panel, `${size.width}×${size.height} /people: ${label}`)
      else failures.push(`${size.width}×${size.height} /people: ${label} opened nothing`)
      await page.keyboard.press('Escape')
      await page.waitForSelector(panel, { state: 'hidden', timeout: TIMEOUT }).catch(() => {})
    }
    await context.close()
  }
} finally {
  await browser.close()
}

for (const failure of failures) console.log(`FAIL ${failure}`)
console.log(`\n${opened} overlays opened, ${failures.length} off screen or missing`)
process.exit(failures.length === 0 && opened > 0 ? 0 : 1)

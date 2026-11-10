/* Keeps the scroll position of panels marked data-keep-scroll="<name>" (the
   sidebar, the doc page tree) when following a link to another page. Links
   between pages load a new page, which would start every panel at the top.

   - The position is saved per tab (sessionStorage), under the panel's name,
     when the page is left and while the user scrolls.
   - On the new page it is applied again after every morph for a few
     seconds, until the user scrolls or clicks. The first update from the
     server replaces the page, and a panel briefly emptied jumps back to the
     top. Positions saved during that time would be wrong, so they are not
     saved then.
   - A message named by the URL's #message-… (a permalink) is scrolled to
     the middle of its panel instead.
   - If the page's current item (aria-current="page") ends up out of view,
     it is scrolled into view.

   Loaded on every page (main.ts). It is plain browser code with no
   expressions, so the Content-Security-Policy allows it as 'self'. */

const PREFIX = 'hyperchat:scroll:'
const RESTORE_FOR = 3000
const started = performance.now()
let isUserDriven = false
/** The position to restore per panel name, read once per page. */
const targets = new Map()
const checkedCurrent = new Set()

const nameOf = panel => panel.getAttribute('data-keep-scroll') ?? ''

const read = name => {
  try {
    const top = Number(sessionStorage.getItem(PREFIX + name) ?? '')
    return Number.isFinite(top) ? top : 0
  } catch {
    return 0
  }
}

const save = panel => {
  try {
    sessionStorage.setItem(PREFIX + nameOf(panel), String(Math.round(panel.scrollTop)))
  } catch {
    // Storage blocked (private mode, policy): panels start at the top.
  }
}

/** The message the URL's #message-… / #thread-message-… names, if this
 *  panel holds it. */
const linkedIn = panel => {
  const id = decodeURIComponent(location.hash.slice(1))
  if (!/^(thread-)?message-/.test(id)) return null
  const item = document.getElementById(id)
  return item !== null && panel.contains(item) ? item : null
}

const isRestoring = () => !isUserDriven && performance.now() - started < RESTORE_FOR

const restore = () => {
  if (!isRestoring()) return
  for (const panel of document.querySelectorAll('[data-keep-scroll]')) {
    const name = nameOf(panel)
    if (!targets.has(name)) targets.set(name, read(name))
    const linked = linkedIn(panel)
    if (linked !== null) {
      // A message permalink (/archives/…): centre the message instead.
      const box = panel.getBoundingClientRect()
      const item = linked.getBoundingClientRect()
      const offset = item.top - box.top - (box.height - item.height) / 2
      if (Math.abs(offset) > 1) panel.scrollTop += offset
      continue
    }
    const top = targets.get(name)
    if (top > 0 && Math.abs(panel.scrollTop - top) > 1) panel.scrollTop = top
    // A virtual panel may have been scrolled before its event bindings were
    // ready. Replay the position until the server's rendered window covers
    // it; native scroll alone will not fire again at an unchanged position.
    const stride = Number(panel.getAttribute('data-virtual-stride'))
    if (stride > 0 && panel.scrollTop > 0) {
      const window = panel.querySelector('[data-window-first][data-window-end]')
      const firstVisible = Math.floor(panel.scrollTop / stride)
      if (window !== null && (firstVisible < Number(window.getAttribute('data-window-first')) || firstVisible >= Number(window.getAttribute('data-window-end')))) {
        panel.dispatchEvent(new Event('scroll'))
      }
    }
    if (checkedCurrent.has(name)) continue
    checkedCurrent.add(name)
    const current = panel.querySelector('[aria-current="page"]')
    if (current === null) continue
    const box = panel.getBoundingClientRect()
    const item = current.getBoundingClientRect()
    if (item.bottom > box.top && item.top < box.bottom) continue
    current.scrollIntoView({ block: 'nearest' })
    targets.set(name, panel.scrollTop)
  }
}

// The user takes over: stop restoring, save what they scroll to.
for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
  window.addEventListener(type, () => (isUserDriven = true), { capture: true, passive: true })
}
document.addEventListener(
  'scroll',
  event => {
    const target = event.target
    if (target instanceof Element && target.hasAttribute('data-keep-scroll') && !isRestoring()) save(target)
  },
  { capture: true, passive: true },
)
const saveAll = () => {
  if (!isRestoring()) document.querySelectorAll('[data-keep-scroll]').forEach(save)
}
window.addEventListener('pagehide', saveAll)
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveAll())

restore()
const observer = new MutationObserver(restore)
observer.observe(document.documentElement, { childList: true, subtree: true })
const restoration = setInterval(restore, 150)
setTimeout(() => { observer.disconnect(); clearInterval(restoration) }, RESTORE_FOR)

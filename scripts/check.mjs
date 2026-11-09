import { chromium } from 'playwright'

/* Browser check: two people (Avery and Blake) in Chromium against a running
   server with the demo content (npm run check:fresh provides both). It walks
   the flows built so far: the Slack frame, live messages, editing with
   ArrowUp, reactions and the emoji picker, deleting, threads (summary, pane,
   "also send to channel", a thread URL) and unread channels.

   Usage: node scripts/check.mjs   (URL=… for another server) */

const base = process.env.URL ?? 'http://localhost:4300'
const TIMEOUT = Number(process.env.CHECK_TIMEOUT ?? 6000)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}
const until = (page, predicate, arg) =>
  page.waitForFunction(predicate, arg, { timeout: TIMEOUT }).then(() => true, () => false)
const settle = page => page.waitForTimeout(150)

const browser = await chromium.launch()
const people = []
/** Demo accounts (npm run demo:seed): the password is the first name, lower case. */
const DEMO = { Avery: 'afinch@hyperchat.example', Blake: 'bokafor@hyperchat.example' }

const live = async (page, go) => {
  const stream = page.waitForRequest(request => request.url().includes('/stream'))
  await go()
  await stream
  await page.waitForFunction(() => document.querySelector('#hyper-keys') !== null)
  await settle(page)
}
const signIn = async (name, path) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(`${name}: ${error}`))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`${name}: ${message.text()}`)
  })
  await page.goto(`${base}${path}`)
  await page.getByLabel('Email').fill(DEMO[name])
  await page.getByLabel('Password').fill(name.toLowerCase())
  await live(page, () => page.getByRole('button', { name: 'Sign in' }).click())
  people.push({ page, errors })
  return page
}
const visit = (page, path) => live(page, () => page.goto(`${base}${path}`))
const lastText = (page, scope = '#message-list') => page.locator(`${scope} [data-message-text]`).last().innerText().catch(() => '')
const sees = (page, text, scope = '#message-list') =>
  until(page, ([scope, text]) => [...document.querySelectorAll(`${scope} [data-message-text]`)].some(node => node.textContent.includes(text)), [scope, text])
const gone = (page, text, scope = '#message-list') =>
  until(page, ([scope, text]) => ![...document.querySelectorAll(`${scope} [data-message-text]`)].some(node => node.textContent.includes(text)), [scope, text])
const mine = (page, scope = '#message-list') => page.locator(`${scope} li[data-author=mem_avery]`).last()

try {
  const avery = await signIn('Avery', '/client/ch_random')
  const blake = await signIn('Blake', '/client/ch_random')

  // The frame
  check('the frame shows the rail, sidebar, header and composer', await avery.locator('#rail').isVisible() && await avery.locator('#sidebar').isVisible() && await avery.locator('#conversation-header').isVisible() && await avery.locator('#composer').isVisible())
  check('the sidebar lists the channels', (await avery.locator('#sidebar').innerText()).includes('general'))
  check('demo messages render', (await avery.locator('#message-list [data-message-text]').count()) > 3)

  // Sending, live to the other person
  const stamp = `Check ${Date.now()}`
  await avery.click('#composer')
  await avery.keyboard.type(`${stamp} typo`)
  await avery.keyboard.press('Enter')
  check('Enter sends a message', await sees(avery, `${stamp} typo`))
  check('the message reaches Blake live', await sees(blake, `${stamp} typo`))
  check('the composer clears after sending', (await avery.locator('#composer').inputValue()) === '')

  // Editing
  await avery.keyboard.press('ArrowUp')
  check('ArrowUp in an empty composer edits the last own message', await until(avery, () => document.activeElement?.id === 'edit-composer'))
  await avery.fill('#edit-composer', `${stamp} fixed`)
  await avery.keyboard.press('Enter')
  check('the edit reaches Blake', await sees(blake, `${stamp} fixed`))
  check('an edited message is marked', (await mine(blake).innerText()).includes('(edited)'))

  // Reactions
  const row = mine(blake)
  await row.hover()
  await row.getByRole('button', { name: 'Find another reaction' }).click()
  check('the emoji picker opens', await until(blake, () => document.querySelector('#emoji-picker') !== null))
  await blake.fill('#emoji-search', 'tada')
  check('the picker searches by name', await until(blake, () => document.querySelector('[data-emoji=tada]') !== null))
  await blake.locator('[data-emoji=tada]').click()
  check('picking closes the picker', await until(blake, () => document.querySelector('#emoji-picker') === null))
  check('the reaction reaches Avery', await until(avery, () => [...document.querySelectorAll('#message-list li[data-author=mem_avery]')].at(-1)?.querySelector('[data-reaction]') !== null))
  await row.hover()
  await row.getByRole('button', { name: 'React with :eyes:' }).click()
  check('a quick reaction adds a second reaction', await until(avery, () => [...document.querySelectorAll('#message-list li[data-author=mem_avery]')].at(-1)?.querySelectorAll('[data-reaction]').length === 2))
  await mine(avery).locator('[data-reaction]').first().click()
  check('clicking a reaction pill toggles your own', await until(avery, () => [...document.querySelectorAll('#message-list li[data-author=mem_avery]')].at(-1)?.querySelector('[data-reaction][aria-pressed=true]') !== null))

  // Deleting
  await mine(avery).hover()
  await mine(avery).getByRole('button', { name: 'More actions' }).click()
  check('the message menu opens', await until(avery, () => document.querySelector('#message-menu') !== null))
  await avery.click('#menu-delete')
  check('deleting asks first', await until(avery, () => document.querySelector('#confirm-delete-button') !== null))
  await avery.click('#confirm-delete-button')
  check('the delete reaches Blake', await gone(blake, `${stamp} fixed`))

  // Threads
  await visit(avery, '/client/ch_general')
  await visit(blake, '/client/ch_general')
  const summary = avery.locator('button[aria-label*="open thread"]').first()
  check('roots with replies show a summary', (await summary.innerText()).includes('replies'))
  await summary.click()
  check('the summary opens the thread pane', await until(avery, () => document.querySelectorAll('#thread li').length > 1))
  check('the thread composer takes focus', await until(avery, () => document.activeElement?.id === 'thread-composer'))
  check('the URL names the thread', /\/client\/ch_general\/thread\//.test(avery.url()))
  const threadUrl = new URL(avery.url()).pathname
  await visit(blake, threadUrl)
  check('a thread URL opens the pane', await until(blake, () => document.querySelectorAll('#thread li').length > 1))
  const reply = `Reply ${Date.now()}`
  await avery.keyboard.type(reply)
  await avery.keyboard.press('Enter')
  check('a reply reaches Blake in the pane', await sees(blake, reply, '#thread'))
  check('a plain reply stays out of the channel', !(await blake.locator('#message-list').innerText()).includes(reply))
  await avery.click('#also-send')
  check('"Also send to #general" toggles', await until(avery, () => document.querySelector('#also-send')?.getAttribute('aria-checked') === 'true'))
  await avery.click('#thread-composer')
  await avery.keyboard.type(`${reply} loud`)
  await avery.keyboard.press('Enter')
  check('an also-sent reply shows in the channel', await sees(blake, `${reply} loud`))
  check('it says it replied to a thread', (await blake.locator('#message-list li').last().innerText()).includes('replied to a thread'))
  const own = mine(avery, '#thread')
  await own.hover()
  await own.getByRole('button', { name: 'More actions' }).click()
  await avery.click('#menu-delete')
  await avery.click('#confirm-delete-button')
  check('a reply can be deleted from the pane', await gone(blake, `${reply} loud`, '#thread'))
  await avery.click('#close-thread')
  check('the close button closes the pane', await until(avery, () => document.querySelectorAll('#thread li').length === 0))

  // The Threads view
  await visit(avery, '/threads')
  check('the sidebar links the Threads view', (await avery.locator('#sidebar a[href="/threads"]').count()) === 1)
  check('the Threads view lists threads you are in', (await avery.locator('#threads-list article').count()) > 0)
  check('the newest answered thread is first', (await avery.locator('#threads-list article').first().innerText()).includes(reply))
  const card = avery.locator('#threads-list article').first()
  const more = card.getByRole('button', { name: /^Show \d+ more/ })
  if ((await more.count()) > 0) {
    const before = await card.locator('li[data-author]').count()
    await more.click()
    check('"Show more replies" shows the rest', await until(avery, before => document.querySelector('#threads-list article')?.querySelectorAll('li[data-author]').length > before, before))
  }
  await card.locator('textarea').click()
  await avery.keyboard.type(`${reply} from Threads`)
  await avery.keyboard.press('Enter')
  check('a reply from the Threads view reaches the thread', await sees(blake, `${reply} from Threads`, '#thread'))
  check('it shows on the card', await sees(avery, `${reply} from Threads`, '#threads-list'))

  // Unreads
  await visit(blake, '/client/ch_random')
  await visit(avery, '/client/ch_general')
  await avery.click('#composer')
  await avery.keyboard.type(`Unread ${Date.now()}`)
  await avery.keyboard.press('Enter')
  check('a new message bolds the channel for someone elsewhere', await until(blake, () => [...document.querySelectorAll('#sidebar a')].some(link => link.textContent.includes('general') && getComputedStyle(link).fontWeight >= 700)))

  for (const { errors } of people) for (const error of errors) check('no browser errors', false, error)
} finally {
  await browser.close()
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)

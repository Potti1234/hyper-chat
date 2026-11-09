import { chromium } from 'playwright'

/* Browser check: two people (Avery and Blake) in Chromium against a running
   server with the demo content (npm run check:fresh provides both). It walks
   the flows built so far: the Slack frame, live messages, editing with
   ArrowUp, reactions and the emoji picker, deleting, threads (summary, pane,
   "also send to channel", a thread URL), unread channels, the Threads view,
   DMs and channel management (browse, create, join, topic, members, leave).

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
  // Pages with key bindings are live once those are in; the others once the stream answered.
  if (!page.url().includes('/channels')) await page.waitForFunction(() => document.querySelector('#hyper-keys') !== null)
  else await page.waitForTimeout(300)
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

  // Direct messages
  await visit(blake, '/dms')
  await visit(avery, '/dms')
  check('the DMs tab lists your direct messages', (await avery.locator('#dm-list nav a').count()) >= 3)
  check('the To field takes focus', await until(avery, () => document.activeElement?.id === 'to-input'))
  await avery.keyboard.type('bla')
  check('typing suggests people', await until(avery, () => document.querySelector('#people-picker')?.textContent.includes('Blake Okafor')))
  await avery.keyboard.press('Enter')
  check('Enter picks the suggestion', await until(avery, () => document.querySelector('#recipient-field [data-person="mem_blake"]') !== null))
  check('it knows the conversation you already have', await until(avery, () => document.querySelector('#new-message-body')?.textContent.includes('You already have a conversation')))
  await avery.keyboard.type('fra')
  await until(avery, () => document.querySelector('#people-picker')?.textContent.includes('Frankie'))
  await avery.locator('#people-picker [role=option]').first().click()
  check('a click picks someone too', await until(avery, () => document.querySelector('#recipient-field [data-person="mem_frankie"]') !== null))
  const group = `Group ${Date.now()}`
  await avery.click('#dm-draft')
  await avery.keyboard.type(group)
  await avery.keyboard.press('Enter')
  await avery.waitForURL(/\/client\/dm_/, { timeout: 5000 }).catch(() => {})
  check('sending opens the group conversation', /\/client\/dm_/.test(avery.url()))
  check('the message is in it', await sees(avery, group))
  check('it reaches the others in their DMs list', await until(blake, group => document.querySelector('#dm-list nav a')?.textContent.includes(group), group))
  await visit(avery, '/dms')
  await avery.fill('#dm-filter', 'casey')
  check('"Find a DM" filters the list', await until(avery, () => [...document.querySelectorAll('#dm-list nav a')].every(link => link.textContent.includes('Casey'))))

  // Channels: browse, create, join, topic, members, private, leave.
  await visit(blake, '/channels')
  await visit(avery, '/channels')
  check('the channel browser lists public channels', await until(avery, () => document.querySelector('#channel-rows [data-channel="engineering"]') !== null))
  check('it lists the private channels you are in', (await avery.locator('#channel-rows [data-channel="leadership"]').count()) === 1)
  const channel = `check-${Date.now()}`
  await avery.click('#open-create-channel')
  await until(avery, () => document.querySelector('#channel-name') !== null)
  await avery.click('#channel-name')
  await avery.keyboard.type(channel.replace('-', ' '))
  check('the name is shown as a channel name', await until(avery, channel => document.querySelector('#create-channel-form')?.textContent.includes(`#${channel}`), channel))
  await avery.click('#create-channel-button')
  await avery.waitForURL(/\/client\/ch_/, { timeout: 5000 }).catch(() => {})
  check('creating opens the new channel', /\/client\/ch_/.test(avery.url()) && (await avery.locator('#channel-title').innerText()).includes(channel))
  check('it is in your sidebar', await until(avery, channel => document.querySelector('#sidebar')?.textContent.includes(channel), channel))
  check('it reaches the browser of others', await until(blake, channel => document.querySelector(`#channel-rows [data-channel="${channel}"]`) !== null, channel))
  await blake.click(`button[aria-label="Join #${channel}"]`)
  check('Join adds you', await until(blake, channel => document.querySelector(`#channel-rows [data-channel="${channel}"]`)?.textContent.includes('Joined'), channel))
  check('the members count updates live', await until(avery, () => document.querySelector('#channel-members')?.textContent.trim().endsWith('2')))
  await avery.click('#add-topic')
  check('"Add a topic" opens the details editor', await until(avery, () => document.activeElement?.id === 'detail-field'))
  await avery.keyboard.type('Checked by the browser')
  await avery.keyboard.press('Enter')
  check('the topic shows in the header', await until(avery, () => document.querySelector('#channel-topic')?.textContent.includes('Checked by the browser')))
  await avery.click('#details button:has-text("Members")')
  await avery.fill('#people-query', 'casey')
  await avery.click('button[aria-label="Add Casey Lindqvist"]')
  check('members add people', await until(avery, () => document.querySelector('#channel-members')?.textContent.trim().endsWith('3')))
  await avery.click('#details button:has-text("About")')
  await avery.click('#leave-channel')
  await avery.waitForURL(url => !url.pathname.includes('ch_') || url.pathname.endsWith('ch_general'), { timeout: 5000 }).catch(() => {})
  check('leaving takes you home', await until(avery, channel => !document.querySelector('#sidebar')?.textContent.includes(channel), channel))
  await visit(avery, '/channels?new')
  check('/channels?new opens the create dialog', await until(avery, () => document.querySelector('#channel-name') !== null))
  const secret = `secret-${Date.now()}`
  await avery.click('#channel-name')
  await avery.keyboard.type(secret)
  await avery.click('#channel-private')
  await avery.click('#create-channel-button')
  await avery.waitForURL(/\/client\/ch_/, { timeout: 5000 }).catch(() => {})
  check('a private channel shows its lock', (await avery.locator('#channel-title svg').first().innerHTML()).includes('rect'))
  await visit(blake, '/channels')
  check('outsiders cannot find private channels', (await blake.locator(`#channel-rows [data-channel="${secret}"]`).count()) === 0)
  await visit(blake, '/client/ch_eng')
  check('visitors see Join channel', await until(blake, () => document.querySelector('#join-channel') !== null || document.querySelector('#composer') !== null))

  for (const { errors } of people) for (const error of errors) check('no browser errors', false, error)
} finally {
  await browser.close()
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)

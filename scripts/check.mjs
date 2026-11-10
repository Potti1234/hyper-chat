import { chromium } from 'playwright'

/* Browser check: two people (Avery and Blake) in Chromium against a running
   server with the demo content (npm run check:fresh provides both). It walks
   the flows built so far: the Slack frame, live messages, editing with
   ArrowUp, reactions and the emoji picker, deleting, threads (summary, pane,
   "also send to channel", a thread URL), unread channels, the Threads view,
   DMs, channel management (browse, create, join, topic, members, leave),
   Activity (mentions, filters, opening an item), Mark unread, Saved for
   later (the Later page), pins, search and the
   Ctrl+K quick switcher, People: profiles, custom status and pausing
   notifications, Preferences, formatting and files.

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
  if (!/\/(channels|activity|later|search|people|preferences)/.test(page.url())) await page.waitForFunction(() => document.querySelector('#hyper-keys') !== null)
  else await page.waitForTimeout(300)
  await settle(page)
}
const signIn = async (name, path) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(`${name}: ${error}`))
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`${name}: ${message.text()} after ${results.at(-1)?.name} ${page.url()}`)
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

  // Formatting: the bar and shortcuts write mrkdwn; messages render it.
  check('the composer has a formatting bar', (await avery.locator('#composer-area [role=toolbar] [data-mrkdwn-format]').count()) === 9)
  const fmt = `Fmt${Date.now()}`
  await avery.click('#composer')
  await avery.keyboard.type(fmt)
  await avery.keyboard.press('Shift+Home')
  await avery.click('#composer-area [data-mrkdwn-format=bold]')
  check('Bold wraps the selection', await until(avery, fmt => document.querySelector('#composer')?.value === `*${fmt}*`, fmt))
  await avery.keyboard.press('End')
  await avery.keyboard.type(' and ')
  await avery.keyboard.press('Control+I')
  await avery.keyboard.type('slanted')
  check('Ctrl+I starts italic at the caret', await until(avery, fmt => document.querySelector('#composer')?.value === `*${fmt}* and _slanted_`, fmt))
  await avery.keyboard.press('End')
  for (const line of ['', '> quoted', '- one', '- two', '`inline` and [docs](https://example.com) :tada:']) {
    if (line !== '') await avery.keyboard.type(line)
    await avery.keyboard.press('Shift+Enter')
  }
  await avery.keyboard.type('```const x = *y*```')
  await avery.keyboard.press('Enter')
  check('bold and italic render for Blake', await until(blake, fmt => [...document.querySelectorAll('#message-list li')].find(item => item.querySelector('strong')?.textContent === fmt)?.querySelector('em')?.textContent === 'slanted', fmt))
  const shape = await blake.evaluate(fmt => {
    const item = [...document.querySelectorAll('#message-list li')].find(row => row.querySelector('strong')?.textContent === fmt)
    const link = item?.querySelector('a[href="https://example.com"]')
    return {
      quote: item?.querySelector('blockquote')?.textContent,
      bullets: item?.querySelectorAll('ul li').length,
      code: item?.querySelector('code')?.textContent,
      pre: item?.querySelector('pre')?.textContent,
      link: link?.textContent === 'docs' && link.target === '_blank' && link.rel.includes('noopener'),
      emoji: item?.querySelector('[data-emoji-name=tada]') !== null,
    }
  }, fmt)
  check('a quote renders', shape.quote === 'quoted', JSON.stringify(shape))
  check('a list renders', shape.bullets === 2)
  check('inline code and code blocks render as typed', shape.code === 'inline' && shape.pre === 'const x = *y*')
  check('links open in a new tab', shape.link === true)
  check('emoji names render as emoji', shape.emoji === true)

  // Files: the attach button stores uploads for the next message; images show inline.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  await avery.setInputFiles('#attach', [
    { name: 'diagram.png', mimeType: 'image/png', buffer: png },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Remember the milk') },
  ])
  check('chosen files wait in the composer', await until(avery, () => document.querySelectorAll('#composer-area [data-upload]').length === 2))
  await avery.getByRole('button', { name: 'Remove notes.txt' }).click()
  check('a waiting file can be removed', await until(avery, () => document.querySelectorAll('#composer-area [data-upload]').length === 1))
  const caption = `Diagram${Date.now()}`
  await avery.click('#composer')
  await avery.keyboard.type(caption)
  await avery.keyboard.press('Enter')
  check('an image reaches Blake inline', await until(blake, caption => {
    const item = [...document.querySelectorAll('#message-list li')].find(row => row.textContent.includes(caption))
    const image = item?.querySelector('[data-attachment] img')
    return image?.complete === true && image.naturalWidth === 1
  }, caption))
  check('the composer is empty after sending files', await until(avery, () => document.querySelectorAll('#composer-area [data-upload]').length === 0))
  const fileUrl = await blake.evaluate(caption => [...document.querySelectorAll('#message-list li')].find(row => row.textContent.includes(caption))?.querySelector('[data-attachment] img')?.getAttribute('src'), caption)
  const served = await blake.request.get(`${base}${fileUrl}`)
  check('files are served with nosniff and no scripts', served.status() === 200 && served.headers()['x-content-type-options'] === 'nosniff' && served.headers()['content-security-policy']?.includes('sandbox') === true)
  const outsider = await browser.newContext()
  check('signed-out requests get no file', (await outsider.request.get(`${base}${fileUrl}`)).status() === 403)
  await outsider.close()
  await avery.setInputFiles('#attach', { name: 'page.html', mimeType: 'text/html', buffer: Buffer.from('<script>alert(1)</script>') })
  check('any file can be attached', await until(avery, () => document.querySelectorAll('#composer-area [data-upload]').length === 1))
  await avery.click('#send')
  check('a file-only message reaches Blake as a download', await until(blake, () => [...document.querySelectorAll('#message-list [data-attachment][download]')].some(link => link.getAttribute('download') === 'page.html')))
  const download = await blake.evaluate(() => [...document.querySelectorAll('#message-list [data-attachment][download]')].find(link => link.getAttribute('download') === 'page.html')?.getAttribute('href'))
  const html = await blake.request.get(`${base}${download}`)
  check('a non-image downloads as bytes, never as a page', html.headers()['content-type'] === 'application/octet-stream' && html.headers()['content-disposition']?.startsWith('attachment') === true)

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
  await sees(avery, `${reply} loud`, '#thread')
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

  // Activity
  const activityCount = page => page.locator('#rail a[href="/activity"] [data-slot=badge]').innerText().then(Number, () => 0)
  await visit(avery, '/client/ch_random')
  await visit(blake, '/client/ch_general')
  const ping = `Ping ${Date.now()}`
  const before = await activityCount(avery)
  await blake.click('#composer')
  await blake.keyboard.type(`@avery ${ping}`)
  await blake.keyboard.press('Enter')
  check('a mention raises the Activity count live', await until(avery, before => Number(document.querySelector('#rail a[href="/activity"] [data-slot=badge]')?.textContent ?? 0) > before, before))
  await visit(avery, '/activity')
  check('Activity lists the mention first', (await avery.locator('#activity-items a').first().innerText()).includes(ping))
  check('new items are marked unread', (await avery.locator('#activity-items a').first().locator('[aria-label=Unread]').count()) === 1)
  check('the rail count clears on the Activity page', (await activityCount(avery)) === 0)
  await avery.click('[data-tab=reaction]')
  check('the Reactions filter shows only reactions', await until(avery, () => [...document.querySelectorAll('#activity-items a')].every(link => link.dataset.activity.startsWith('reaction:'))))
  await avery.click('[data-tab=mention]')
  check('the Mentions filter shows the mention', await until(avery, ping => [...document.querySelectorAll('#activity-items a')].some(link => link.dataset.activity.startsWith('mention:') && link.textContent.includes(ping)), ping))
  await live(avery, () => avery.locator('#activity-items a').first().click())
  check('picking an item previews its message', (await avery.locator('#activity-preview').innerText()).includes(ping))
  check('the filter survives picking', new URL(avery.url()).searchParams.get('tab') === 'mention')
  await live(avery, () => avery.click('#open-item'))
  check('"Open in channel" opens the conversation', new URL(avery.url()).pathname === '/client/ch_general')
  check('the seen mention does not come back', (await activityCount(avery)) === 0)

  // Mark unread
  const theirs = avery.locator('#message-list li[data-author=mem_blake]').last()
  await theirs.hover()
  await theirs.getByRole('button', { name: 'More actions' }).click()
  check('others\' messages offer Mark unread', await until(avery, () => document.querySelector('#menu-unread') !== null && document.querySelector('#menu-edit') === null))
  await avery.click('#menu-unread')
  check('the menu closes', await until(avery, () => document.querySelector('#message-menu') === null))
  check('the new-messages line moves there', await until(avery, () => document.querySelector('#new-divider') !== null))
  await visit(avery, '/client/ch_random')
  check('the conversation stays unread', await until(avery, () => [...document.querySelectorAll('#sidebar a')].some(link => link.textContent.includes('general') && getComputedStyle(link).fontWeight >= 700)))
  await visit(avery, '/client/ch_general')

  // Saved for later and pins
  const keep = `Keep ${Date.now()}`
  await blake.click('#composer')
  await blake.keyboard.type(keep)
  await blake.keyboard.press('Enter')
  check('the message to save arrives', await sees(avery, keep))
  const kept = avery.locator('#message-list li[data-author=mem_blake]').last()
  await kept.hover()
  await kept.getByRole('button', { name: 'Save for later' }).click()
  check('saving labels the message', await until(avery, () => document.querySelector('#message-list li:last-child [data-saved-label]') !== null))
  await kept.hover()
  await kept.getByRole('button', { name: 'More actions' }).click()
  await avery.click('#menu-pin')
  check('pinning labels it for everyone', await until(blake, () => document.querySelector('#message-list li:last-child [data-pinned-label]')?.textContent.includes('Avery')))
  check('the header shows the pins tab', await until(blake, () => document.querySelector('#open-pins') !== null))
  await blake.click('#open-pins')
  check('the pins tab lists the message', await until(blake, keep => document.querySelector('#pinned-messages')?.textContent.includes(keep), keep))
  await blake.locator('#pinned-messages li').filter({ hasText: keep }).getByRole('button', { name: 'Un-pin' }).click()
  check('un-pinning removes the label', await until(avery, () => document.querySelector('#message-list li:last-child [data-pinned-label]') === null))
  await blake.keyboard.press('Escape')
  await visit(avery, '/later')
  check('Later lists the saved message first', (await avery.locator('#later-items li').first().innerText()).includes(keep))
  await avery.locator('#later-items li').first().getByRole('button', { name: 'Mark complete' }).click()
  check('completing moves it out of In progress', await until(avery, keep => !document.querySelector('#later-items')?.textContent.includes(keep), keep))
  await avery.click('[data-tab=done]')
  check('it is under Completed', await until(avery, keep => document.querySelector('#later-items')?.textContent.includes(keep), keep))
  await avery.locator('#later-items li').filter({ hasText: keep }).getByRole('button', { name: 'Remove from Later' }).click()
  check('removing takes it off Later', await until(avery, keep => !document.querySelector('#later-items')?.textContent.includes(keep), keep))
  await avery.click('[data-tab=saved]')
  await live(avery, () => avery.locator('#later-items li').first().getByRole('link', { name: 'Open' }).click())
  check('Open goes to the conversation', /^\/client\//.test(new URL(avery.url()).pathname))
  await visit(avery, '/client/ch_general')

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

  // Search: the top bar, results as you type, filters, live results.
  await visit(avery, '/client/ch_general')
  await live(avery, () => avery.click('#open-search'))
  check('the top bar opens search', /\/search/.test(avery.url()))
  check('the search field takes focus', await until(avery, () => document.activeElement?.id === 'search-input'))
  await avery.keyboard.type('launch')
  check('results come as you type', await until(avery, () => document.querySelectorAll('#search-hits [data-hit]').length > 0 && [...document.querySelectorAll('#search-hits [data-message-text]')].every(text => text.textContent.toLowerCase().includes('launch'))))
  check('the address keeps the query', await until(avery, () => location.search === '?q=launch'))
  await avery.click('[data-tab=channels]')
  check('the Channels tab lists matching channels', await until(avery, () => document.querySelector('#search-hits [data-channel-hit=ch_launch]')?.textContent.includes('product-launch')))
  await avery.click('[data-tab=messages]')
  await avery.click('#from-me')
  check('"From me" adds a from: filter', await until(avery, () => document.querySelector('#search-input')?.value === 'launch from:@avery' && document.querySelector('#clear-from') !== null))
  await avery.click('#clear-from')
  check('the chip clears it', await until(avery, () => document.querySelector('#search-input')?.value === 'launch'))
  const needle = `needle${Date.now()}`
  await avery.fill('#search-input', needle)
  check('no results says so', await until(avery, () => document.querySelector('#search-hits')?.textContent.includes('No results')))
  await visit(blake, '/client/ch_general')
  await blake.click('#composer')
  await blake.keyboard.type(`Found the ${needle}`)
  await blake.keyboard.press('Enter')
  check('new messages show up in results live', await until(avery, needle => document.querySelector('#search-hits')?.textContent.includes(`Found the ${needle}`), needle))
  await avery.click('#search-hits a:has-text("View in channel")')
  await avery.waitForURL(/\/client\/ch_general/, { timeout: 5000 }).catch(() => {})
  check('a result opens its conversation', await sees(avery, `Found the ${needle}`))

  // The quick switcher (Ctrl+K) on any page
  await visit(avery, '/later')
  await avery.keyboard.press('Control+k')
  check('Ctrl+K opens the quick switcher', await until(avery, () => document.activeElement?.id === 'switcher-input'))
  await avery.keyboard.type('prod')
  check('it lists matching conversations and a search row', await until(avery, () => document.querySelector('#switcher-items [data-active=true]')?.textContent.includes('product-launch') && document.querySelector('#switch-search') !== null))
  await avery.keyboard.press('ArrowDown')
  check('arrows move the selection', await until(avery, () => document.querySelector('#switch-search')?.dataset.active === 'true'))
  await avery.keyboard.press('ArrowUp')
  await avery.keyboard.press('Enter')
  await avery.waitForURL(/\/client\/ch_launch/, { timeout: 5000 }).catch(() => {})
  check('Enter jumps to the conversation', /\/client\/ch_launch/.test(avery.url()))
  await live(avery, () => avery.reload())
  await avery.keyboard.press('Control+k')
  await until(avery, () => document.activeElement?.id === 'switcher-input')
  await avery.keyboard.press('Escape')
  check('Escape closes it', await until(avery, () => document.querySelector('#switcher-input') === null || document.querySelector('#switcher-input').offsetParent === null))
  await avery.keyboard.press('Control+k')
  await until(avery, () => document.activeElement?.id === 'switcher-input')
  await avery.keyboard.type('casey')
  await until(avery, () => document.querySelector('#switcher-items [role=option]')?.textContent.includes('Casey'))
  await avery.locator('#switcher-items [role=option]').first().click()
  await avery.waitForURL(/\/client\/dm_/, { timeout: 5000 }).catch(() => {})
  check('a click opens the DM', /\/client\/dm_/.test(avery.url()))

  // People, profiles, custom status and pausing notifications
  await visit(avery, '/client/ch_general')
  await live(avery, () => avery.click('#my-profile'))
  check('your avatar opens your profile', /\/people\/mem_avery/.test(avery.url()) && await until(avery, () => document.querySelector('#profile-name')?.textContent.includes('Avery')))
  await avery.click('#set-status-button')
  await until(avery, () => document.querySelector('#preset-1') !== null && document.querySelector('#preset-1').offsetParent !== null)
  await avery.click('#preset-1')
  await until(avery, () => document.querySelector('#status-text')?.value === 'Commuting')
  await avery.click('#save-status-button')
  check('a preset sets your status', await until(avery, () => document.querySelector('#profile [data-profile-status]')?.textContent.includes('Commuting')))
  await visit(blake, '/client/ch_general')
  check('others see the status emoji next to your name', await until(blake, () => document.querySelector('[data-author=mem_avery] + [data-status-emoji]')?.getAttribute('title') === 'Commuting'))
  await avery.click('[data-pause="30"]')
  check('pausing notifications shows on your avatar', await until(avery, () => document.querySelector('#my-profile [data-paused]') !== null && document.querySelector('#resume-button') !== null))
  await avery.click('#resume-button')
  check('and resuming clears it', await until(avery, () => document.querySelector('#my-profile [data-paused]') === null))
  await avery.click('#edit-profile-button')
  await until(avery, () => document.querySelector('#profile-pronouns-input')?.offsetParent != null)
  await avery.fill('#profile-pronouns-input', 'she/her')
  await avery.click('#zone-America-New_York')
  await avery.click('#save-profile-button')
  check('editing your profile saves pronouns and time zone', await until(avery, () => document.querySelector('#profile-name')?.textContent.includes('she/her') && document.querySelector('#profile')?.textContent.includes('New York')))
  await avery.click('#clear-status-button')
  check('Clear status removes it', await until(avery, () => document.querySelector('#profile [data-profile-status]') === null))
  await visit(blake, '/people')
  await blake.fill('#people-filter', 'designer')
  check('the directory filters by title', await until(blake, () => document.querySelectorAll('#people-list [data-person]').length === 1 && document.querySelector('#people-list [data-person=mem_casey]') !== null))
  await blake.fill('#people-filter', '')
  await until(blake, () => document.querySelector('#people-list [data-person=mem_avery]') !== null)
  await live(blake, () => blake.click('#people-list [data-person=mem_avery]'))
  check('a card opens their profile with local time', await until(blake, () => document.querySelector('#profile')?.textContent.includes('she/her') && document.querySelector('#profile')?.textContent.includes('Local time') && document.querySelector('#edit-profile-button') === null))
  await live(blake, () => blake.click('#message-person'))
  check('Message opens a DM with them', /\/(client\/dm_|dms\?to=mem_avery)/.test(blake.url()))
  await visit(avery, '/people/mem_avery')
  await avery.click('#edit-profile-button')
  await until(avery, () => document.querySelector('#profile-pronouns-input')?.offsetParent != null)
  await avery.fill('#profile-pronouns-input', '')
  await avery.click('#zone-Europe-Berlin')
  await avery.click('#save-profile-button')
  await until(avery, () => !document.querySelector('#profile-name')?.textContent.includes('she/her'))

  // Presence: active while a page is connected, away otherwise
  await visit(blake, '/client/ch_general')
  await visit(avery, '/people/mem_blake')
  check('someone with a page open is Active', await until(avery, () => document.querySelector('#profile-presence')?.textContent.includes('Active') && document.querySelector('[data-person=mem_blake] [data-presence=active]') !== null))
  check('someone without one is Away', await until(avery, () => document.querySelector('[data-person=mem_devon] [data-presence=away]') !== null))
  await visit(avery, '/client/ch_general')
  check('a DM row shows its partner as Active', await until(avery, () => document.querySelector('a[href="/client/dm_avery_blake"] [data-presence=active]') !== null))
  await blake.goto('about:blank')
  check('closing their page makes them Away', await until(avery, () => document.querySelector('a[href="/client/dm_avery_blake"] [data-presence=away]') !== null))

  // Preferences: colour mode, sidebar theme, preset, compact display, clock.
  await live(avery, () => avery.locator('#open-preferences').click())
  check('the rail opens Preferences', avery.url().endsWith('/preferences') && (await avery.locator('#appearance').count()) === 1)
  const root = (page, name) => until(page, name => document.querySelector('#app')?.classList.contains(name), name)
  const rootNot = (page, name) => until(page, name => !document.querySelector('#app')?.classList.contains(name), name)
  await avery.locator('#mode-dark').click()
  check('Dark switches the page to dark', await root(avery, 'dark') && (await avery.locator('#mode-dark').getAttribute('aria-pressed')) === 'true')
  await avery.locator('#mode-light').click()
  check('Light switches it back', await rootNot(avery, 'dark'))
  await avery.locator('#sidebar-jade').click()
  check('a sidebar theme recolours the frame', await root(avery, 'sidebar-jade') && (await avery.locator('#sidebar-jade').getAttribute('aria-pressed')) === 'true')
  await avery.locator('#preset-nord').click()
  check('a creaseui preset themes the app', await root(avery, 'theme-nord'))
  await avery.locator('#display-compact').click()
  check('Compact is chosen', await root(avery, 'density-compact'))
  await avery.locator('#clock-24').click()
  check('the clock sample reads 24-hour', await until(avery, () => /\d{2}:\d{2}/.test(document.querySelector('#clock-24')?.textContent ?? '') && !/AM|PM/.test(document.querySelector('#clock-24')?.textContent ?? '')))
  await visit(avery, '/client/ch_general')
  check('choices stay after a reload', await root(avery, 'sidebar-jade') && await root(avery, 'theme-nord') && await root(avery, 'density-compact'))
  check('compact leaves out pictures next to messages', await until(avery, () => document.querySelector('#message-list li[data-author]') !== null && document.querySelector('#message-list .message-gutter [data-slot=avatar]') === null))
  check('times next to messages are 24-hour', await until(avery, () => [...document.querySelectorAll('#message-list li[data-author] .text-muted-foreground')].some(node => /^\d{1,2}:\d{2}$/.test(node.textContent.trim())) && ![...document.querySelectorAll('#message-list li[data-author]')].some(node => /\d (AM|PM)\b/.test(node.textContent))))
  await visit(avery, '/preferences')
  for (const id of ['#preset-default', '#sidebar-default', '#display-clean', '#clock-12']) await avery.locator(id).click()
  check('defaults come back', await rootNot(avery, 'theme-nord') && await rootNot(avery, 'sidebar-jade') && await rootNot(avery, 'density-compact'))

  for (const { errors } of people) for (const error of errors) check('no browser errors', false, error)
} finally {
  await browser.close()
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)

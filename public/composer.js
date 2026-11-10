// Slack's formatting in the composers (src/app/view/composer.ts): the
// formatting bar and its shortcuts wrap the selection in mrkdwn
// (src/app/mrkdwn.ts), or start lines as a quote or list. The edit is sent
// to the page as an input event, like typing. Menu rows marked
// data-copy-link copy that link to the clipboard.
;(() => {
  const WRAP = {
    bold: ['*', '*'],
    italic: ['_', '_'],
    strike: ['~', '~'],
    code: ['`', '`'],
    'code-block': ['```\n', '\n```'],
  }
  const LINE = { quote: /^> ?/, bullets: /^[-*•] /, numbers: /^\d+[.)] / }

  const commit = (area, value, start, end) => {
    area.value = value
    area.setSelectionRange(start, end)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  }

  const wrap = (area, kind) => {
    const { value, selectionStart: start, selectionEnd: end } = area
    const selected = value.slice(start, end)
    if (kind === 'link') {
      const label = selected === '' ? 'text' : selected
      const url = 'https://'
      const before = value.slice(0, start) + `[${label}](`
      commit(area, before + url + ')' + value.slice(end), before.length, before.length + url.length)
      return
    }
    const [open, close] = WRAP[kind]
    // Pressing it again on a wrapped selection takes the markers off.
    if (value.slice(start - open.length, start) === open && value.slice(end, end + close.length) === close) {
      commit(area, value.slice(0, start - open.length) + selected + value.slice(end + close.length), start - open.length, end - open.length)
      return
    }
    commit(area, value.slice(0, start) + open + selected + close + value.slice(end), start + open.length, end + open.length)
  }

  const lines = (area, kind) => {
    const { value, selectionStart, selectionEnd } = area
    const start = value.lastIndexOf('\n', selectionStart - 1) + 1
    const after = value.indexOf('\n', selectionEnd)
    const end = after === -1 ? value.length : after
    const rows = value.slice(start, end).split('\n')
    const marker = LINE[kind]
    const isOn = rows.every(row => marker.test(row))
    const next = rows
      .map(row => row.replace(LINE.quote, '').replace(LINE.bullets, '').replace(LINE.numbers, ''))
      .map((row, index) => (isOn ? row : kind === 'quote' ? `> ${row}` : kind === 'bullets' ? `- ${row}` : `${index + 1}. ${row}`))
      .join('\n')
    commit(area, value.slice(0, start) + next + value.slice(end), start + next.length, start + next.length)
  }

  const format = (area, kind) => {
    area.focus()
    if (kind in LINE) lines(area, kind)
    else wrap(area, kind)
  }

  const composerOf = target => target.closest('form')?.querySelector('textarea') ?? null

  // Keep the selection in the textarea while a button is pressed.
  document.addEventListener('mousedown', event => {
    if (event.target instanceof Element && event.target.closest('[data-mrkdwn-format]')) event.preventDefault()
  })
  document.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('[data-mrkdwn-format]') : null
    const area = button === null ? null : composerOf(button)
    if (button === null || area === null) return
    event.preventDefault()
    format(area, button.getAttribute('data-mrkdwn-format'))
  })

  // Copy link (the message menu): the full URL of the row's path.
  document.addEventListener('click', event => {
    const row = event.target instanceof Element ? event.target.closest('[data-copy-link]') : null
    const path = row?.getAttribute('data-copy-link') ?? ''
    if (path.startsWith('/')) navigator.clipboard?.writeText(location.origin + path).catch(() => {})
  })

  const SHORTCUTS = {
    b: [false, 'bold'],
    i: [false, 'italic'],
    x: [true, 'strike'],
    u: [true, 'link'],
    c: [true, 'code'],
    7: [true, 'numbers'],
    8: [true, 'bullets'],
    9: [true, 'quote'],
  }
  document.addEventListener('keydown', event => {
    const area = event.target
    if (!(area instanceof HTMLTextAreaElement) || area.closest('form') === null) return
    if (!(event.ctrlKey || event.metaKey)) return
    // Digits by their key code: Shift+7 types "&" or "/" on some layouts.
    const key = event.code.startsWith('Digit') ? event.code.slice(5) : event.key.toLowerCase()
    const shortcut = SHORTCUTS[key]
    if (shortcut === undefined || shortcut[0] !== event.shiftKey) return
    event.preventDefault()
    format(area, key === 'c' && event.altKey ? 'code-block' : shortcut[1])
  })
})()

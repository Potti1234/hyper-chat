import type { Html, HtmlBuilder } from 'foldkit/html'
import * as Icon from '@/lib/icon'
import { button } from '@/ui/button'
import { box } from './design'

/* Slack's formatting bar above a composer. The buttons carry no server
   message: public/composer.js wraps the selection of the composer's textarea
   in mrkdwn (src/app/mrkdwn.ts) and the edit reaches the page as ordinary
   typing through the textarea's input handler. The same script binds the
   shortcuts shown in the titles. */

type Format = Readonly<{ kind: string; label: string; keys: string; icon: Icon.IconName }>

const GROUPS: ReadonlyArray<ReadonlyArray<Format>> = [
  [
    { kind: 'bold', label: 'Bold', keys: 'Ctrl+B', icon: 'bold' },
    { kind: 'italic', label: 'Italic', keys: 'Ctrl+I', icon: 'italic' },
    { kind: 'strike', label: 'Strikethrough', keys: 'Ctrl+Shift+X', icon: 'strikethrough' },
  ],
  [{ kind: 'link', label: 'Link', keys: 'Ctrl+Shift+U', icon: 'link' }],
  [
    { kind: 'numbers', label: 'Ordered list', keys: 'Ctrl+Shift+7', icon: 'list-ordered' },
    { kind: 'bullets', label: 'Bulleted list', keys: 'Ctrl+Shift+8', icon: 'list' },
  ],
  [{ kind: 'quote', label: 'Blockquote', keys: 'Ctrl+Shift+9', icon: 'text-quote' }],
  [
    { kind: 'code', label: 'Code', keys: 'Ctrl+Shift+C', icon: 'code' },
    { kind: 'code-block', label: 'Code block', keys: 'Ctrl+Alt+Shift+C', icon: 'square-code' },
  ],
]

export const formatBar = <Msg>(h: HtmlBuilder<Msg>): Html =>
  box({ class: 'flex flex-wrap items-center gap-0.5 px-1.5 pt-1.5', attributes: [h.Role('toolbar'), h.AriaLabel('Formatting')], children: GROUPS.flatMap((group, index) => [
      ...(index === 0 ? [] : [box({ as: 'span', class: 'mx-1 h-5 w-px bg-border', attributes: [h.AriaHidden(true)] }, h)]),
      ...group.map(format => button({ type: 'button', variant: 'toolbar', size: 'icon-md', ariaLabel: format.label, title: `${format.label} (${format.keys})`, marker: ['mrkdwn-format', format.kind], children: [Icon.icon(format.icon, {}, h)] }, h)),
    ]) }, h)

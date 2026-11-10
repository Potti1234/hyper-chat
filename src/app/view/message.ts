import type { Html, HtmlBuilder } from 'foldkit/html'

import * as Icon from '@/lib/icon'
import { button } from '@/ui/button'

import { type Attachment, type Member, handleOf, isImage } from '../domain'
import { type Block, type Inline, parse } from '../mrkdwn'
import { statusOf } from '../profile'
import { box, slack } from './design'

/* Message text as Slack shows it: mrkdwn (src/app/mrkdwn.ts) with bold,
   italic, strike, code, code blocks, quotes and lists, links that open in a
   new tab, :emoji: names and @mentions of people (and @here/@channel)
   highlighted. */

const inline = <Msg>(nodes: ReadonlyArray<Inline>, members: ReadonlyArray<Member>, h: HtmlBuilder<Msg>): ReadonlyArray<Html | string> =>
  nodes.map(node => {
    switch (node.kind) {
      case 'text':
        return node.text
      case 'break':
        return box({ as: 'br' }, h)
      case 'code':
        return box({ as: 'code', class: slack.mdCode, children: [node.text] }, h)
      case 'bold':
        return box({ as: 'strong', class: 'font-bold', children: inline(node.children, members, h) }, h)
      case 'italic':
        return box({ as: 'em', children: inline(node.children, members, h) }, h)
      case 'strike':
        return box({ as: 's', children: inline(node.children, members, h) }, h)
      case 'link':
        return box({ as: 'a', attributes: [h.Href(node.url), h.Target('_blank'), h.Rel('noopener noreferrer')], children: inline(node.children, members, h) }, h)
      case 'emoji':
        return box({ as: 'span', attributes: [h.Title(`:${node.name}:`), h.DataAttribute('emoji-name', node.name)], children: [node.glyph] }, h)
      case 'channel':
        return box({ as: 'a', class: slack.mention, attributes: [h.Href(`/channel/${encodeURIComponent(node.name)}`), h.DataAttribute('channel-link', node.name)], children: [`#${node.name}`] }, h)
      case 'mention': {
        const member = members.find(candidate => handleOf(candidate) === node.handle)
        if (member !== undefined) return box({ as: 'span', class: slack.mention, attributes: [h.DataAttribute('mention', member.id)], children: [`@${member.name}`] }, h)
        return node.handle === 'here' || node.handle === 'channel' || node.handle === 'everyone' ? box({ as: 'span', class: slack.mention, children: [`@${node.handle}`] }, h) : `@${node.handle}`
      }
    }
  })

const block = <Msg>(node: Block, members: ReadonlyArray<Member>, h: HtmlBuilder<Msg>): Html => {
  switch (node.kind) {
    case 'paragraph':
      return box({ as: 'p', class: slack.mdParagraph, children: inline(node.children, members, h) }, h)
    case 'quote':
      return box({ as: 'blockquote', class: slack.mdQuote, children: inline(node.children, members, h) }, h)
    case 'code':
      return box({ as: 'pre', class: slack.mdCodeBlock, children: [node.text] }, h)
    case 'bullets':
    case 'numbers':
      return box({
        as: node.kind === 'bullets' ? 'ul' : 'ol',
        class: node.kind === 'bullets' ? slack.mdBullets : slack.mdNumbers,
        attributes: node.kind === 'numbers' && node.start !== 1 ? [h.Attribute('start', String(node.start))] : [],
        children: node.items.map(item => box({ as: 'li', children: inline(item, members, h) }, h)),
      }, h)
  }
}

export const messageText = <Msg>(text: string, members: ReadonlyArray<Member>, h: HtmlBuilder<Msg>): ReadonlyArray<Html | string> => parse(text).map(node => block(node, members, h))

/** The author line's name: a link to their profile, then their status emoji. */
export const authorName = <Msg>(author: Member | undefined, now: number, h: HtmlBuilder<Msg>, size = 'text-[15px]'): Html => {
  if (author === undefined) return box({ as: 'strong', class: `${size} font-bold`, children: ['Former member'] }, h)
  const status = statusOf(author, now)
  return box({ as: 'span', class: 'inline-flex min-w-0 items-baseline gap-1', children: [
      box({ as: 'a', class: `${size} font-bold hover:underline`, attributes: [h.Href(`/people/${author.id}`), h.DataAttribute('author', author.id)], children: [author.name] }, h),
      ...(status === undefined ? [] : [box({ as: 'span', class: 'text-[13px] leading-none', attributes: [h.Title(status.text), h.AriaLabel(`Status: ${status.text}`), h.DataAttribute('status-emoji', '')], children: [status.emoji] }, h)]),
    ] }, h)
}

/** A byte count as Slack shows it ("12 KB", "3.4 MB"). */
export const formatSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

const fileUrl = (file: Attachment) => `/files/${encodeURIComponent(file.id)}`

const kindOf = (file: Attachment) => {
  if (isImage(file)) return file.type.replace('image/', '').toUpperCase()
  const extension = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]
  return extension === undefined ? 'File' : extension.toUpperCase()
}

/** The files shared in a message: images as previews that open full size,
 *  anything else as a card that downloads. */
export const attachmentList = <Msg>(files: ReadonlyArray<Attachment> | undefined, h: HtmlBuilder<Msg>): ReadonlyArray<Html> =>
  files === undefined || files.length === 0
    ? []
    : [box({ class: slack.attachments, attributes: [h.AriaLabel('Files'), h.DataAttribute('attachments', '')], children: files.map(file =>
        isImage(file)
          ? box({ as: 'a', class: slack.attachmentImage, attributes: [h.Href(fileUrl(file)), h.Target('_blank'), h.Rel('noopener noreferrer'), h.Title(file.name), h.DataAttribute('attachment', file.id)], children: [
              box({ as: 'img', attributes: [h.Src(fileUrl(file)), h.Alt(file.name), h.Attribute('loading', 'lazy')] }, h),
            ] }, h)
          : box({ as: 'a', class: slack.attachmentFile, attributes: [h.Href(fileUrl(file)), h.Attribute('download', file.name), h.Title(`Download ${file.name}`), h.DataAttribute('attachment', file.id)], children: [
              box({ as: 'span', class: 'flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground', children: [Icon.icon('file', { class: 'size-5' }, h)] }, h),
              box({ class: 'min-w-0 flex-1', children: [
                  box({ class: 'truncate text-[15px] font-bold', children: [file.name] }, h),
                  box({ class: 'text-[13px] text-muted-foreground', children: [`${kindOf(file)} · ${formatSize(file.size)}`] }, h),
                ] }, h),
              Icon.icon('download', { class: 'size-4 text-muted-foreground' }, h),
            ] }, h)) }, h)]

/** The composer's files waiting to be sent, each removable, and how many are
 *  still uploading. */
export const uploadChips = <Msg>(
  props: Readonly<{ uploads: ReadonlyArray<Attachment>; uploading: number; onRemove: (id: string) => Msg }>,
  h: HtmlBuilder<Msg>,
): ReadonlyArray<Html> =>
  props.uploads.length === 0 && props.uploading === 0
    ? []
    : [box({ class: 'flex flex-wrap gap-2 px-3 pb-1', attributes: [h.AriaLabel('Files to send'), h.DataAttribute('uploads', '')], children: [
        ...props.uploads.map(file =>
          box({ class: slack.uploadChip, attributes: [h.DataAttribute('upload', file.id)], children: [
              isImage(file)
                ? box({ as: 'img', class: 'size-10 shrink-0 rounded-md object-cover', attributes: [h.Src(fileUrl(file)), h.Alt('')] }, h)
                : box({ as: 'span', class: 'flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground', children: [Icon.icon('file', { class: 'size-5' }, h)] }, h),
              box({ class: 'min-w-0 flex-1', children: [
                  box({ class: 'min-w-0 truncate text-[13px] font-bold', children: [file.name] }, h),
                  box({ class: 'text-[12px] text-muted-foreground', children: [`${kindOf(file)} · ${formatSize(file.size)}`] }, h),
                ] }, h),
              button({ variant: 'ghost', size: 'icon-xs', ariaLabel: `Remove ${file.name}`, title: 'Remove', onClick: props.onRemove(file.id), children: [Icon.icon('x', {}, h)] }, h),
            ] }, h)),
        ...(props.uploading === 0 ? [] : [box({ class: 'flex items-center gap-2 px-1 text-[13px] text-muted-foreground', attributes: [h.Role('status'), h.DataAttribute('uploading', '')], children: [`Uploading ${props.uploading} ${props.uploading === 1 ? 'file' : 'files'}…`] }, h)]),
      ] }, h)]

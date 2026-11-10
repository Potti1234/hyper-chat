import type { Html, HtmlBuilder } from 'foldkit/html'

import { cn } from '@/lib/utils'
import { type ButtonVariants, buttonVariants } from './button'

/* A button that opens the file chooser: a label drawn as a crease button
   around a visually hidden file input. Chosen files are uploaded by
   hyper-effect (`h.OnFileChange`) and reach update as web `File`s. crease's
   own file-input opens the chooser from a browser Command, which a page
   rendered on the server cannot run; this keeps the native input's own
   click instead. Use it for an attach button; drops go through
   `h.OnDropFiles` on the area they land in. */

export type FileButtonProps<Msg> = Readonly<{
  id: string
  ariaLabel: string
  title?: string
  onFiles: (files: ReadonlyArray<File>) => Msg
  isMultiple?: boolean
  isDisabled?: boolean
  accept?: string
  variant?: ButtonVariants['variant']
  size?: ButtonVariants['size']
  children: ReadonlyArray<Html | string>
}>

export const fileButton = <Msg>(props: FileButtonProps<Msg>, h: HtmlBuilder<Msg>): Html =>
  h.label(
    [
      h.DataAttribute('slot', 'file-button'),
      h.Title(props.title ?? props.ariaLabel),
      h.Class(cn(buttonVariants({ variant: props.variant ?? 'ghost', size: props.size ?? 'icon' }), 'cursor-pointer focus-within:ring-3 focus-within:ring-ring/50', props.isDisabled === true && 'pointer-events-none opacity-50')),
    ],
    [
      h.input([
        h.Id(props.id),
        // native-control: the file chooser itself, hidden behind the button.
        h.Type('file'),
        h.Class('sr-only'),
        h.AriaLabel(props.ariaLabel),
        ...(props.isMultiple === true ? [h.Multiple(true)] : []),
        ...(props.accept === undefined ? [] : [h.Accept(props.accept)]),
        ...(props.isDisabled === true ? [h.Disabled(true)] : []),
        h.OnFileChange(props.onFiles),
      ]),
      ...props.children,
    ],
  )

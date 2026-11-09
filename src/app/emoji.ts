/* eslint-disable crease/no-native-glyphs -- emoji are what people react and write with: content, not interface icons */

/** The emoji people react with: Slack's picker, cut to the common ones.
 *  Each has the short name Slack shows (`:thumbsup:`) and words to search by. */
export type Emoji = Readonly<{ glyph: string; name: string; keywords: string; group: EmojiGroup }>
export type EmojiGroup = 'Smileys & People' | 'Nature' | 'Food & Drink' | 'Activities' | 'Objects' | 'Symbols'

const list = (group: EmojiGroup, entries: ReadonlyArray<readonly [string, string, string?]>): ReadonlyArray<Emoji> =>
  entries.map(([glyph, name, keywords = '']) => ({ glyph, name, keywords, group }))

export const EMOJI: ReadonlyArray<Emoji> = [
  ...list('Smileys & People', [
    ['😀', 'grinning', 'smile happy'],
    ['😄', 'smile', 'happy joy'],
    ['😂', 'joy', 'laugh tears lol'],
    ['🙂', 'slightly_smiling_face', 'smile'],
    ['😉', 'wink'],
    ['😍', 'heart_eyes', 'love'],
    ['🤔', 'thinking_face', 'hmm think'],
    ['😅', 'sweat_smile', 'phew'],
    ['😎', 'sunglasses', 'cool'],
    ['🥳', 'partying_face', 'party celebrate'],
    ['😮', 'open_mouth', 'wow surprised'],
    ['😢', 'cry', 'sad'],
    ['😬', 'grimacing', 'awkward'],
    ['🙃', 'upside_down_face'],
    ['🤯', 'exploding_head', 'mind blown'],
    ['😴', 'sleeping', 'tired'],
    ['👍', 'thumbsup', '+1 yes like agree'],
    ['👎', 'thumbsdown', '-1 no dislike'],
    ['👏', 'clap', 'applause bravo'],
    ['🙌', 'raised_hands', 'hooray yay'],
    ['🙏', 'pray', 'thanks please'],
    ['👀', 'eyes', 'look watching'],
    ['💪', 'muscle', 'strong'],
    ['👋', 'wave', 'hello hi bye'],
    ['🤝', 'handshake', 'deal'],
    ['✌️', 'v', 'peace victory'],
    ['👌', 'ok_hand', 'okay perfect'],
    ['🫡', 'saluting_face', 'salute'],
  ]),
  ...list('Nature', [
    ['🔥', 'fire', 'lit hot'],
    ['⭐', 'star'],
    ['🌟', 'star2', 'glow'],
    ['☀️', 'sunny', 'sun'],
    ['🌈', 'rainbow'],
    ['🌱', 'seedling', 'grow'],
    ['🐛', 'bug', 'insect'],
    ['🦄', 'unicorn'],
  ]),
  ...list('Food & Drink', [
    ['☕', 'coffee'],
    ['🍕', 'pizza'],
    ['🍰', 'cake'],
    ['🍻', 'beers', 'cheers'],
    ['🌮', 'taco'],
  ]),
  ...list('Activities', [
    ['🎉', 'tada', 'party congrats'],
    ['🎊', 'confetti_ball'],
    ['🏆', 'trophy', 'win'],
    ['🎲', 'game_die', 'dice board game'],
    ['🎯', 'dart', 'target bullseye'],
    ['🎨', 'art', 'design'],
  ]),
  ...list('Objects', [
    ['📈', 'chart_with_upwards_trend', 'growth metrics up'],
    ['🚀', 'rocket', 'ship launch'],
    ['💡', 'bulb', 'idea'],
    ['📌', 'pushpin', 'pin'],
    ['📎', 'paperclip'],
    ['📝', 'memo', 'note'],
    ['📅', 'date', 'calendar'],
    ['🔒', 'lock'],
    ['🛠️', 'hammer_and_wrench', 'tools fix'],
  ]),
  ...list('Symbols', [
    ['✅', 'white_check_mark', 'done yes check'],
    ['❌', 'x', 'no wrong'],
    ['❤️', 'heart', 'love'],
    ['💯', '100', 'hundred perfect'],
    ['⚠️', 'warning'],
    ['❓', 'question'],
    ['➕', 'heavy_plus_sign', 'plus add'],
    ['💬', 'speech_balloon', 'comment'],
  ]),
]

const BY_GLYPH = new Map(EMOJI.map(emoji => [emoji.glyph, emoji]))

export const isEmoji = (glyph: string): boolean => BY_GLYPH.has(glyph)

export const emojiName = (glyph: string): string => BY_GLYPH.get(glyph)?.name ?? glyph

/** Slack's one-click reactions on a message's hover toolbar. */
export const QUICK_REACTIONS: ReadonlyArray<string> = ['✅', '👀', '🙌']

export const searchEmoji = (query: string): ReadonlyArray<Emoji> => {
  const words = query.trim().toLowerCase().replace(/:/g, '').split(/\s+/).filter(word => word !== '')
  if (words.length === 0) return EMOJI
  return EMOJI.filter(emoji => words.every(word => `${emoji.name} ${emoji.keywords}`.includes(word)))
}

/** Speech helpers: turn a written reply into natural spoken phrases. */

export type Phrase = { text: string; rate: number; pitch: number; pauseAfter: number };

/** Removes markdown, links, code, emoji and symbols so they are never read aloud. */
export function cleanForSpeech(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*+•]|\d+[.)])\s+(.*)$/gm, (_m, _b, item: string) => `${item.trim().replace(/[.!?…:;,]$/, '')}.`)
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(\S.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/\|/g, ', ')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '')
    .replace(/[*#_~^=<>{}[\]\\]/g, ' ')
    .replace(/\s*—\s*/g, ', ')
    .replace(/\.{3}/g, '…')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}

/** Splits text into phrases with intonation (pitch/rate) and pauses in ms. */
export function planPhrases(input: string, baseRate = 1): Phrase[] {
  const text = cleanForSpeech(input);
  if (!text) return [];
  const phrases: Phrase[] = [];
  const paragraphs = text.split(/\n{2,}/);
  paragraphs.forEach((para, pi) => {
    const sentences = para.replace(/\n/g, ' ').match(/[^.!?…]+[.!?…]+["»)]*|[^.!?…]+$/g) ?? [];
    sentences.forEach((raw, si) => {
      const s = raw.trim();
      if (!s) return;
      const end = s.replace(/["»)]+$/, '').slice(-1);
      let rate = baseRate, pitch = 1, pause = 220;
      if (end === '?') { pitch = 1.12; pause = 380; }
      else if (end === '!') { pitch = 1.08; rate = baseRate * 1.05; pause = 320; }
      else if (end === '…') { pitch = 0.96; rate = baseRate * 0.92; pause = 650; }
      if (/^(ха|хах|ого|ух|вау|ну|смотри|подожди|короче)\b/i.test(s)) pitch += 0.04;
      if (s.length > 140) rate *= 0.96;
      if (s.length < 25) rate *= 1.03;
      const lastInPara = si === sentences.length - 1;
      if (lastInPara && pi < paragraphs.length - 1) pause = Math.max(pause, 750);
      phrases.push({ text: s, rate: clamp(rate, 0.6, 1.6), pitch: clamp(pitch, 0.8, 1.3), pauseAfter: pause });
    });
  });
  if (phrases.length) phrases[phrases.length - 1]!.pauseAfter = 0;
  return phrases;
}

function clamp(v: number, min: number, max: number) { return Math.round(Math.min(max, Math.max(min, v)) * 100) / 100; }

export type VoiceGender = 'male' | 'female' | 'unknown';

/** Voice names that usually mean the speaker is male. */
const MALE_NAMES = [
  'dmitry', 'dmitri', 'dmitrij', 'dmitriy', 'yuri', 'yury', 'artemiy', 'artiy', 'maxim', 'maksim',
  'ruslan', 'pavel', 'nikolai', 'nikolas', 'igor', 'oleg', 'sergey', 'sergei', 'konstantin',
  'vladimir', 'aleksey', 'alexey', 'roman', 'fedor', 'gleb', 'matvey', 'timur', 'marat', 'bogdan',
  'grozov', 'rustam', 'malevich', 'мужской', 'male',
];

/** Voice names that usually mean the speaker is female. */
const FEMALE_NAMES = [
  'milena', 'svetlana', 'tatyana', 'tatiana', 'irina', 'katya', 'katusha', 'alena',
  'marina', 'polina', 'elena', 'olga', 'natalia', 'natalya', 'daria', 'darya', 'anastasia',
  'ekaterina', 'alsu', 'kristina', 'jana', 'vera', 'amira', 'milana', 'sofya', 'maria', 'masha',
  'zhensky', 'женский', 'female',
];

/** Best guess about the speaker's gender: browser hint first, then the voice name. */
export function voiceGender(voice: SpeechSynthesisVoice): VoiceGender {
  const hint = (voice as SpeechSynthesisVoice & { gender?: string }).gender;
  if (typeof hint === 'string') {
    if (/female|женск/i.test(hint)) return 'female';
    if (/^male$|мужск/i.test(hint)) return 'male';
  }
  const name = voice.name.toLowerCase();
  if (FEMALE_NAMES.some((n) => name.includes(n))) return 'female';
  if (MALE_NAMES.some((n) => name.includes(n))) return 'male';
  return 'unknown';
}

/** Picks a male Russian voice, preferring the most natural-sounding one available. */
export function pickRussianVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const ru = voices.filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith('ru'));
  if (!ru.length) return null;
  const score = (v: SpeechSynthesisVoice) =>
    (voiceGender(v) === 'male' ? 12 : voiceGender(v) === 'female' ? -12 : 0) +
    (/natural|neural|online|premium|enhanced/i.test(v.name) ? 4 : 0) +
    (/google/i.test(v.name) ? 3 : 0) + (v.lang.toLowerCase() === 'ru-ru' ? 1 : 0);
  return [...ru].sort((a, b) => score(b) - score(a))[0]!;
}

import { describe, expect, it } from 'vitest';
import { cleanForSpeech, planPhrases, pickRussianVoice, voiceGender } from '@/lib/speech';

const voice = (name: string, lang = 'ru-RU') => ({ name, lang }) as unknown as SpeechSynthesisVoice;

describe('speech', () => {
  it('does not read markdown symbols aloud', () => {
    const out = cleanForSpeech('## План\n- **Первое**\n- `код`\n[ссылка](https://x.ru) 🙂');
    expect(out).not.toMatch(/[#*`\[\]()🙂]|https/);
    expect(out).toContain('Первое');
    expect(out).toContain('ссылка');
  });
  it('raises pitch for questions and pauses longer between paragraphs', () => {
    const p = planPhrases('Серьёзно? Да.\n\nНовая мысль.');
    expect(p[0]!.pitch).toBeGreaterThan(1);
    expect(p[1]!.pauseAfter).toBeGreaterThanOrEqual(750);
    expect(p[p.length - 1]!.pauseAfter).toBe(0);
  });
  it('prefers a male Russian voice when one is available', () => {
    const picked = pickRussianVoice([
      voice('Microsoft Milena (Natural)'),
      voice('Google русский'),
      voice('Microsoft Dmitry (Natural)'),
    ]);
    expect(picked?.name).toContain('Dmitry');
  });
  it('still speaks when the device has only a female Russian voice', () => {
    const picked = pickRussianVoice([voice('Milena'), voice('Svetlana')]);
    expect(picked?.name).toBe('Milena');
    expect(voiceGender(picked!)).toBe('female');
  });
  it('reads gender from the voice name', () => {
    expect(voiceGender(voice('Microsoft Dmitry (Natural)'))).toBe('male');
    expect(voiceGender(voice('Microsoft Irina Online (Natural)'))).toBe('female');
    expect(voiceGender(voice('Google русский'))).toBe('unknown');
  });
});

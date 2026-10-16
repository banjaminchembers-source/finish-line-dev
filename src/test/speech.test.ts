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
});

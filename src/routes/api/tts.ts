import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// ElevenLabs Adam is the intended Dima voice. Allow deployment-specific override.
const VOICE_ID = process.env["ELEVENLABS_VOICE_ID"] || "pNInz6obpgDQGcFmaJgB"; // Adam

type RuntimeContext = { env?: { ELEVENLABS_API_KEY?: string } };
function getElevenLabsApiKey(context: unknown): string | undefined {
  const runtime = context as RuntimeContext | undefined;
  return runtime?.env?.ELEVENLABS_API_KEY ?? process.env["ELEVENLABS_API_KEY"];
}
const Body = z.object({ text: z.string().min(1).max(4500), speed: z.number().min(0.5).max(2).optional() });

export const Route = createFileRoute("/api/tts")({
  server: {
    handlers: {
      POST: async ({ request, context }) => {
        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: "Неверный текст для озвучки." }, { status: 400 });
        const key = getElevenLabsApiKey(context);
        if (!key) return Response.json({ error: "ElevenLabs не подключён." }, { status: 503 });
        const speed = Math.min(1.2, Math.max(0.7, parsed.data.speed ?? 1));
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
          {
            method: "POST",
            headers: { "xi-api-key": key, "Content-Type": "application/json" },
            body: JSON.stringify({
              text: parsed.data.text,
              model_id: "eleven_multilingual_v2",
              voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true, speed },
            }),
          },
        );
        if (!res.ok) {
          const err = await res.text();
          console.error(`ElevenLabs TTS failed [${res.status}]: ${err}`);
          return Response.json({ error: `ElevenLabs [${res.status}]: ${err.slice(0, 300)}` }, { status: res.status });
        }
        return new Response(res.body, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
      },
    },
  },
});

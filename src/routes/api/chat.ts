import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const MODEL = "openai/gpt-6-astra";
const SYSTEM = `Ты — BRAIN, дружелюбный личный ИИ-ассистент. Всегда отвечай на русском языке, ясно и по делу, без лишней воды. Ответы часто озвучиваются вслух, поэтому избегай таблиц и сложной разметки; используй простые абзацы и короткие списки. Ты работаешь в браузере и не можешь открывать приложения, управлять устройством или искать в интернете — честно говори об этом, если просят.`;

const Body = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(20000) }))
    .min(1)
    .max(40),
});

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      GET: async () => {
        const configured = Boolean(process.env.LOVABLE_API_KEY);
        return Response.json({
          configured,
          provider: configured ? "Lovable AI" : null,
          model: configured ? MODEL : null,
          message: configured ? "Подключение к ИИ настроено." : "Ключ доступа к ИИ не найден на сервере.",
        });
      },
      POST: async ({ request }) => {
        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: "Сообщение пустое или имеет неверный формат." }, { status: 400 });
        const key = process.env.LOVABLE_API_KEY;
        if (!key) return Response.json({ error: "ИИ не настроен." }, { status: 503 });

        const upstream = await fetch("https://ai.gateway.lovable.dev/v1/responses", {
          method: "POST",
          signal: request.signal,
          headers: {
            "Content-Type": "application/json",
            "Lovable-API-Key": key,
            "X-Lovable-AIG-SDK": "fetch",
          },
          body: JSON.stringify({
            model: MODEL,
            instructions: SYSTEM,
            input: parsed.data.messages.map((m) => ({ role: m.role, content: m.content })),
            reasoning: { effort: "low" },
            store: false,
            stream: true,
          }),
        });

        if (!upstream.ok || !upstream.body) {
          const s = upstream.status;
          const error =
            s === 429 ? "Слишком много запросов. Попробуйте чуть позже."
            : s === 402 ? "Закончились кредиты ИИ. Пополните баланс в настройках рабочего пространства."
            : `Сервис ИИ вернул ошибку (HTTP ${s}).`;
          return Response.json({ error }, { status: s === 429 || s === 402 ? s : 502 });
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            let buf = "";
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = buf.indexOf("\n")) >= 0) {
                  const line = buf.slice(0, idx).trim();
                  buf = buf.slice(idx + 1);
                  if (!line.startsWith("data:")) continue;
                  const payload = line.slice(5).trim();
                  if (!payload || payload === "[DONE]") continue;
                  try {
                    const ev = JSON.parse(payload);
                    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string")
                      controller.enqueue(encoder.encode(ev.delta));
                    else if (ev.type === "error" || ev.type === "response.failed")
                      controller.enqueue(encoder.encode("\u0000ERROR:Сервис ИИ не смог сформировать ответ."));
                  } catch { /* partial line */ }
                }
              }
            } catch {
              controller.enqueue(encoder.encode("\u0000ERROR:Соединение с ИИ прервалось."));
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" } });
      },
    },
  },
});

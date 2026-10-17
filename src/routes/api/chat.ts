import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

// Use the official OpenAI API directly. Override OPENAI_MODEL in the server environment if needed.
const MODEL = process.env["OPENAI_MODEL"] || "gpt-6-astra";
const SYSTEM = `Ты — Dima, дружелюбный личный ИИ-ассистент. Всегда отвечай на русском языке, ясно и по делу, без лишней воды. Ответы часто озвучиваются вслух, поэтому избегай таблиц и сложной разметки; используй простые абзацы и короткие списки. Ты работаешь внутри приложения и не можешь самовольно управлять телефоном или запускать приложения, если для этого не подключены специальные разрешения и инструменты. Не утверждай, что выполнил действие на устройстве или поиск в интернете, если фактически этого не сделал.`;

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
        const configured = Boolean(process.env["OPENAI_API_KEY"]);
        return Response.json({
          configured,
          provider: configured ? "OpenAI API" : null,
          model: configured ? MODEL : null,
          message: configured
            ? "Подключение к OpenAI API настроено."
            : "На сервере не задан OPENAI_API_KEY. Добавьте ключ в секреты окружения сервера.",
        });
      },
      POST: async ({ request }) => {
        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return Response.json({ error: "Сообщение пустое или имеет неверный формат." }, { status: 400 });
        }

        const key = process.env["OPENAI_API_KEY"];
        if (!key) {
          return Response.json(
            { error: "OpenAI API не настроен: на сервере отсутствует OPENAI_API_KEY." },
            { status: 503 },
          );
        }

        let upstream: Response;
        try {
          upstream = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            signal: request.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify({
              model: MODEL,
              instructions: SYSTEM,
              input: parsed.data.messages.map((message) => ({
                role: message.role,
                content: message.content,
              })),
              reasoning: { effort: "low" },
              store: false,
              stream: true,
            }),
          });
        } catch {
          return Response.json({ error: "Не удалось соединиться с OpenAI API. Проверьте сервер и подключение." }, { status: 502 });
        }

        if (!upstream.ok || !upstream.body) {
          const status = upstream.status;
          const details = await upstream.text().catch(() => "");
          let apiMessage = "";
          try {
            const parsedError = JSON.parse(details) as { error?: { message?: string; code?: string } };
            apiMessage = parsedError.error?.message ?? "";
          } catch {
            // Ignore non-JSON error bodies.
          }

          const error =
            status === 401 || status === 403
              ? "OpenAI API отклонил ключ. Проверьте OPENAI_API_KEY в секретах сервера."
              : status === 429
                ? "OpenAI API вернул лимит или недостаточно средств. Проверьте квоты и биллинг API-аккаунта."
                : status === 400
                  ? `OpenAI API отклонил запрос. Проверьте модель и параметры. ${apiMessage}`.trim()
                  : `OpenAI API вернул ошибку (HTTP ${status}). ${apiMessage}`.trim();

          console.error("OpenAI Responses API error", status, apiMessage);
          return Response.json({ error }, { status: status === 429 ? 429 : status === 401 || status === 403 ? 502 : 502 });
        }

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            let buffer = "";
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let newlineIndex: number;
                while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
                  const line = buffer.slice(0, newlineIndex).trim();
                  buffer = buffer.slice(newlineIndex + 1);
                  if (!line.startsWith("data:")) continue;
                  const payload = line.slice(5).trim();
                  if (!payload || payload === "[DONE]") continue;
                  try {
                    const event = JSON.parse(payload);
                    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                      controller.enqueue(encoder.encode(event.delta));
                    } else if (event.type === "error" || event.type === "response.failed") {
                      controller.enqueue(encoder.encode("\u0000ERROR:OpenAI API не смог сформировать ответ. Проверьте квоты, ключ и доступность модели."));
                    }
                  } catch {
                    // Ignore incomplete or non-JSON SSE events.
                  }
                }
              }
              buffer += decoder.decode();
              // Process a final SSE line if the upstream closed without a trailing newline.
              if (buffer.trim().startsWith("data:")) {
                const payload = buffer.trim().slice(5).trim();
                if (payload && payload !== "[DONE]") {
                  try {
                    const event = JSON.parse(payload);
                    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                      controller.enqueue(encoder.encode(event.delta));
                    } else if (event.type === "error" || event.type === "response.failed") {
                      controller.enqueue(encoder.encode("\u0000ERROR:OpenAI API не смог сформировать ответ. Проверьте квоты, ключ и доступность модели."));
                    }
                  } catch {
                    // Ignore incomplete final events.
                  }
                }
              }
            } catch {
              controller.enqueue(encoder.encode("\u0000ERROR:Соединение с OpenAI API прервалось."));
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
    },
  },
});

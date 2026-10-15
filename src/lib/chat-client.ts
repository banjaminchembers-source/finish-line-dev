import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

type ChatStatus = { configured: boolean; provider: string | null; model: string | null; message: string };
type SendInput = { data: { messages: { role: "user" | "assistant"; content: string }[] } };

export function useChatStatus() {
  return useQuery<ChatStatus>({
    queryKey: ["chat-status"],
    queryFn: async () => {
      const res = await fetch("/api/chat");
      if (!res.ok) throw new Error("status failed");
      return res.json();
    },
    refetchOnWindowFocus: true,
  });
}

export function useSendChatMessage() {
  const [isPending, setPending] = useState(false);
  const mutateAsync = async ({ data }: SendInput) => {
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw Object.assign(new Error(body.error ?? "request failed"), { data: body });
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      if (text.includes("\u0000ERROR:")) throw new Error(text.split("\u0000ERROR:")[1]);
      return { message: { role: "assistant" as const, content: text.trim() } };
    } finally {
      setPending(false);
    }
  };
  return { isPending, mutateAsync };
}

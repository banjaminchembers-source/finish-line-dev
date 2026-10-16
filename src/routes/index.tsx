import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { BrainApp } from "@/components/BrainApp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dima — личный ИИ-ассистент" },
      { name: "description", content: "Русскоязычный ИИ-ассистент с голосовым вводом, озвучиванием ответов и локальной историей разговоров." },
      { property: "og:title", content: "Dima — личный ИИ-ассистент" },
      { property: "og:description", content: "Голосовой ИИ-ассистент на русском языке с историей разговоров на вашем устройстве." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <ClientOnly fallback={<div className="app-shell" />}>
      <BrainApp />
    </ClientOnly>
  );
}

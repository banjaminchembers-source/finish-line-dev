<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
# AGENTS
- Dima chat UI lives in src/components/BrainApp.tsx, rendered client-only (localStorage state).
- AI replies go through src/routes/api/chat.ts (Lovable AI Gateway, streamed); key stays server-side.
- Signed-in users' conversations sync to the `conversations` table via src/lib/cloud-sync.ts (browser client + RLS); localStorage remains the offline cache.

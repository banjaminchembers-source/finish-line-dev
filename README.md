# Finish Line Dev

Изучи внимательно то, что есть в этом файле. Ты поймёшь, что это незавершённая программа. Доделай эту программу, это приложение до конца.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://finish-line-dev.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/c80156c0-56fd-4d34-be4c-5e344ff34361).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## OpenAI API setup

The chat endpoint uses the official OpenAI Responses API with web search. Configure these secrets in the deployment environment (for the published Lovable app, use the project's environment/secrets settings):

- `OPENAI_API_KEY` — required. Create/manage it in your OpenAI API account. Never put this key in client-side code, commit it to Git, or share it in chat.
- `OPENAI_MODEL` — optional; defaults to `gpt-6-astra`.

After saving the server secret, redeploy/restart the app and open Settings in Dima. The connection status should show `OpenAI API` when the server can read the key. ChatGPT subscriptions and OpenAI API billing are separate; API calls are billed to the API account.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

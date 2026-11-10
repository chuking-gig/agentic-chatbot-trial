# Refine

A small React chatbot backed by the Gemini API. Quick test mode uses one model call; full mode drafts, reviews, and can refine an answer up to twice. The API key stays on the server.

For a walkthrough of the request flow and a record of implementation decisions, see [PROJECT_LOG.md](./PROJECT_LOG.md).

## Run locally

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and add your Gemini API key.
3. Run `npm install`.
4. Start the API in one terminal with `npm run server`.
5. Start the UI in another terminal with `npm run dev`, then open the local URL Vite prints.

Choose Gemma 4 26B, Gemini 3.5 Flash-Lite, or Gemini 3.8 Flash from the in-app model dropdown. Your selection is saved in this browser. Quick test mode is enabled by default; turn it off to run the draft, review, and refine loop. While the assistant works, expand “What the agent is doing” to see live progress. The default model is `gemma-4-26b-a4b-it` (Gemma 4 26B A4B IT). The conversation is not restored after a reload, but each turn is saved in a local log file.

Each chat turn is also appended to `logs/chat-activity.jsonl` on this computer. Entries include the user message, final answer (if available), each model step's instruction, input, streamed output, model, mode, duration, and outcome. The app also shows these step details live and keeps them under the completed answer. API keys are redacted, and the `logs/` directory is excluded from Git. Because the log contains chat text and model prompts, keep it private and delete it when you no longer need it.

# Refine project log

This file is the durable context for future questions about how Refine works. It records the app's behavior and implementation decisions, not individual chat content. Never put API keys or user prompts in this file.

## Current behavior

- The UI is a React app served by Vite. The Node server provides `/api/chat` and proxies the Gemini API request so the API key stays in the server's `.env` file.
- The model dropdown offers Gemma 4 26B A4B IT (`gemma-4-26b-a4b-it`), Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`), and Gemini 3.8 Flash (`gemini-3.8-flash`). The selection is saved in browser `localStorage` and included with every chat request. The server only accepts these model IDs.
- Quick test mode is on by default. It sends one generation request and skips review/refinement. Its setting is saved in browser `localStorage`.
- With Quick test off, the server gets a draft, asks the model to review it, then refines when the reviewer suggests a concrete improvement. It allows at most two review/refinement rounds. This takes two to five sequential Gemini requests.
- The server streams progress events (`drafting`, `reviewing`, `refining`) to the browser using Server-Sent Events. The UI shows the current phase and a collapsible activity list while waiting.
- If generation or review fails, the UI shows the provider error in an alert banner. If refinement fails, the server returns the best answer produced so far and an inline warning rather than discarding that answer.
- Conversations are held in browser memory and sent with each turn; they are not saved to a database or restored after reload. The server includes at most the last 12 messages in a model request and truncates each message to 6,000 characters.
- The server terminal logs provider error messages, not chat prompts. Each accepted turn is persisted separately in the local JSONL activity log.
- Every accepted chat turn is appended to `logs/chat-activity.jsonl` with its user message, answer/error, each model call's instruction/input/output, model, mode, progress steps, and timing. API-key patterns are redacted, and `logs/` is Git-ignored. This file contains user chat text and model prompts and should be treated as private.

## Request flow

1. `src/App.jsx` sends the messages, selected model, and Quick test setting to `POST /api/chat`.
2. `server.js` validates the model and request, maps assistant messages to Gemini's `model` role, and keeps the Gemini API key on the server.
3. The server emits progress events and streams each model step's output as it runs. Each step trace records its action label, model, instruction, input, output, and status.
4. `askModel()` calls Gemini's `generateContent` endpoint. In full mode the same model is used for the draft, review, and refinement calls.
5. The browser reads each progress event, updates the collapsible activity list, and displays the result or an error.

## Important files

- `src/App.jsx` — chat UI, model picker, Quick test setting, SSE progress reader, and error display.
- `src/style.css` — layout and visual styles, including activity and error panels.
- `server.js` — local API server, Gemini request handling, agent loop, and progress stream.
- `logs/chat-activity.jsonl` — append-only runtime history, created automatically after the first chat request.
- `.env` — local API key, default model, and server port. This file is ignored by Git; do not copy its secret into documentation or chat.
- `.env.example` — safe configuration template.

## Change history

### 2026-10-27

- Added the initial chatbot with Gemini support and a draft/review/refine agent loop.
- Added an in-app model selector and saved its choice in the browser.
- Added Quick test mode to make one model call while trying the app; full refinement remains available by turning it off.
- Added server-sent progress events and a collapsible activity list.
- Added fallback behavior for refinement errors so the best available answer is still returned with a warning.
- Added a local JSONL runtime log for each accepted user turn, with prompt/answer, per-call instructions/inputs/outputs, model, mode, phase events, outcome, and duration. API keys are redacted and log files are Git-ignored.
- Kept conversations out of a database and out of terminal logs; per-turn prompts and answers are stored only in the local Git-ignored activity log.

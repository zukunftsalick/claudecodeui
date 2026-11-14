# Handoff: project chat and threads (work in progress)

Branch `feat/project-threads`. Delete this file before merging.

## Goal (Pedro's words, summarized)

Make CloudCLI work like the Claude desktop app's projects:

- A **project chat** (coordinator) that talks with Pedro and starts **threads**. Threads are parallel Claude sessions that do the work.
- Threads and the project chat **message each other**.
- A **threads pane** where Pedro sees each thread's status: Working, Waiting for you, Idle, Done, or Failed. Clicking a card opens that thread's chat, and he can answer it there.
- Claude can **reach any folder Pedro allows**, even outside the current project. Example: the whole `~/projects` folder.
- Billing stays on the subscription. RAM is 4 GB, so at most about 3 threads should run at once (`maxRunningThreads`).

## Design

- **Session runtime extras hook** (`server/modules/providers/services/session-runtime-extras.service.ts`, exported from the providers barrel). Feature modules register a contributor. On every turn, the Claude runtime (`claude-runtime.provider.ts`, right after `loadMcpConfig`) collects four things from the contributors:
  - extra `mcpServers` (in-process SDK servers)
  - `allowedTools`
  - `additionalDirectories`
  - `waitForApprovalIndefinitely`, which threads use so permission prompts wait for Pedro instead of timing out after 55 s
- **DB tables** (schema.ts plus migrations.ts):
  - `agent_threads` has one row per coordinator or thread. It stores status (idle, waiting, done, failed), last_reply and run_options.
  - `agent_thread_messages` is the inbox. Messages wait there until the receiving session is free.
  - `project_folder_grants` holds the extra folders.
  - The repository is `server/modules/database/repositories/agent-threads.db.ts` (`agentThreadsDb`).
- **`server/modules/threads/threads.service.ts`** (done, typechecks) is `createThreadsService(deps)`.
  - `startThread` creates an app session in the chosen folder, records the row, and queues a brief as the thread's first message.
  - `sendMessage` and `flush` deliver queued messages as one detached turn via `runDetachedChatTurn`. A message waits while the target is busy, has background work, or the running-thread cap is reached.
  - `handleRunSettled` should be called from `onRunSettled`. It stores the last reply, marks failures, and relays to the coordinator when a thread is done, waiting or failed, or when it finished a turn that came from delivered messages. It then calls `flushAll`.
  - `noteTurnStarted` saves the run options and resets the status to idle.
  - It also has the overview for the pane, the folder grants, a rate limit of 60 messages per hour per session, and the live status. Working comes from `chatRunRegistry`, and Waiting comes from pending approvals.

## Still to do

1. `server/modules/threads/threads.tools.ts` builds an in-process MCP server named `cloudcli` per turn, using `createSdkMcpServer` and `tool` from `@anthropic-ai/claude-agent-sdk` with zod 4. zod is already installed through the SDK; add `"zod": "^4.3.6"` to package.json, and when updating package-lock.json add only the root dependency entry.
   - Chats that are not in any thread yet, and coordinators, get these tools:
     - `start_thread {title, instructions, folder?}`
     - `list_threads`
     - `read_thread {thread_id}` (status plus last reply)
     - `message_thread {thread_id, text}`
     - `close_thread {thread_id}` (marks it done)
   - Threads get these tools: `message_coordinator {text}`, `message_thread` (siblings), `list_threads`, and `set_status {status: waiting|done, note}`.
   - Everyone gets `allow_folder {path}` and `list_folders`.
   - Put every tool in `allowedTools` except `allow_folder`, so Pedro approves each folder grant.
   - Server `instructions` should tell the coordinator to use threads for independent work, and that thread messages arrive by themselves, so it must not poll.
2. `server/modules/threads/index.ts` wires the real dependencies:
   - `runDetachedChatTurn` with `providerRuntimeService` as the runtime
   - `chatRunRegistry` (`isProcessing`, `getRun(id)?.events`, `listRunningRuns`)
   - `providerRuntimeService.hasBackgroundWork` and `getPendingApprovalsForSession`
   - `sessionsService.createAppSession('claude', folder, title)` followed by `renameSessionById`
   - `sessionsDb.getSessionById(id).project_path`
   - `notifyUserIfEnabled` plus `createNotificationEvent` (kind `action_required`, code `agent.notification`)

   It also registers the extras contributor:
   - call `noteTurnStarted`
   - tools by role
   - `additionalDirectories` from the folder grants of `projectPathFor(sessionId, projectPath)`
   - `waitForApprovalIndefinitely` for threads

   Finally it subscribes `onRunSettled` to `handleRunSettled`, and adds a 30 s `flushAll` timer as a safety net after restarts.
3. `threads.routes.ts`, mounted at `/api/threads` in server/index.ts:
   - `GET /?projectPath=` returns the overview
   - `POST /project-chat {projectPath}`
   - `PATCH /:sessionId {status?, title?}`
   - `POST /folders` and `DELETE /folders`, both with `{projectPath, folder}`
4. Frontend module `src/modules/threads`, following `.agents/skills/frontend-module-standards`:
   - Add a "Threads" header button next to DevPreviewMenu, with a badge for the number waiting. It opens a ThreadsPanel in the right-hand EditorSidebar, the same way DevPreviewPanel is shown there.
   - The panel shows the project chat card and the thread cards (title, status chip, note, last reply excerpt, time ago), a "New project chat" button, and the allowed folders with a remove button. It polls every 4 s like `useDevServers`.
   - Clicking a card navigates to that session. Add types to `src/shared/types.ts`, an `api.threads` client and i18n strings.
5. Tests:
   - `server/modules/threads/tests/` should cover the service with an isolated DB (see `server/modules/database/tests/sessions.db.integration.test.ts`) and fake deps.
   - Add a test for the extras service.
   - Add vitest tests for the panel helpers.
   - Run `npm run typecheck`, `npx vitest run`, `npm test`, `npm run lint` and `npm run build`.

   Two server tests already fail on main in the cloud sandbox (project-clone "credential helper", and provider.routes "conversation search streams title matches"). Check whether they fail on the VPS too before blaming the change.
6. Try it in the test copy (see ~/.claude/CLAUDE.md, `devserver start cloudcli-dev ...`), merge to main, then run `cloudcli-deploy`.

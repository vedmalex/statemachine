export const meta = {
  name: 'regions-entry-bugfix-execute',
  description: 'Execute the v2 standards-first DAG (T0..T16): implement each task, checkpoint + commit, resumable via progress.jsonl. T17 docs / T18 llm-wiki are MAIN-SESSION and run after this.',
  phases: [
    { title: 'Setup', detail: 'ensure feature branch + read tracker state' },
    { title: 'Implement', detail: 'T0..T16 in topological order, each checkpoint-gated and committed' },
  ],
}

const PLAN_DIR = '/Users/vedmalex/work/statemachine/.plan/regions-entry-bugfix'
const REPO = '/Users/vedmalex/work/statemachine'
const BRANCH = 'fix/regions-ancestor-entry-and-final-join'

// Topological order for the 17 executor tasks (T17 docs + T18 llm-wiki are MAIN-SESSION, excluded here).
// Strictly sequential: T2/T3/T5/T6 etc. all mutate state_machine.ts, so parallel edits would conflict.
const ORDER = ['T0', 'T1', 'T2', 'T5', 'T6', 'T7', 'T3', 'T4', 'T9', 'T8', 'T10', 'T11', 'T13', 'T12', 'T14', 'T15', 'T16']

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['taskId', 'status', 'checkpointGreen', 'commit', 'summary'],
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['done', 'skipped', 'failed', 'blocked'] },
    checkpointGreen: { type: 'boolean' },
    commit: { type: 'string', description: 'commit hash, or empty string if none' },
    summary: { type: 'string', maxLength: 600 },
    blockers: { type: 'array', items: { type: 'string', maxLength: 300 } },
  },
}

const PROTOCOL = `
You execute ONE task of the "regions-entry-bugfix" v2 plan and must be fully idempotent & crash-safe.

DESIGN PRINCIPLE (non-negotiable): standards-first SCXML/UML correctness. The library has NO external consumers — backward-compat is NOT a constraint. Rewrite non-standard existing tests to match the spec; do NOT add opt-out flags to preserve old behavior.

Authoritative files (read them first):
- ${PLAN_DIR}/PLAN.md       — locked design decisions D1..D12 + the task spec (find the exact T-id section + its acceptance/checkpoint)
- ${PLAN_DIR}/progress.jsonl — per-task tracker (one JSON object per line; source of truth for completion)
- ${PLAN_DIR}/state.json    — run-level pointers (branch, completed count, config surface, baseline)
- ${PLAN_DIR}/findings.md   — verified blast radius / file:line evidence

Repo: ${REPO}. Feature branch: ${BRANCH} (NEVER commit to main).

Procedure for your task <TID>:
1. Read progress.jsonl. If <TID>.status == "done", DO NOTHING and return {status:"skipped", checkpointGreen:true, commit:"", summary:"already done"}.
2. Verify every task in <TID>.dependsOn has status "done". If not, return {status:"blocked", blockers:[...]}.
3. Set <TID>.status to "in_progress" in progress.jsonl (rewrite that line) before editing code.
4. Implement <TID> EXACTLY per its PLAN.md section — honor the locked decisions D1..D12 and the file:line targets in findings.md. Watch the reviewer-found hazards: compute newState/enter/exit sets ONCE as immutable consts (~sm.ts:1585) and wrap the early updateState so a validateCompositeState throw aborts cleanly; gate done.state emission on this.events.has(...) (never unconditional — Invalid-event crash); exclude engine done.state.* from the '*' wildcard; detect all-final by atomic-leaf scan over the static regions tree (never configMap.get). Follow surrounding code style.
5. Run the task's Checkpoint command from PLAN.md (vitest/npm based — DO NOT use bun). Capture the tail as evidence.
6. If GREEN (acceptance met; the single pre-existing ServerAdapter failure is EXPECTED and NOT a regression; '|' asserts are order-insensitive):
   a. Update progress.jsonl: <TID>.status="done", commit=<hash>, evidence=<short checkpoint tail>, updatedAt=<output of \`date -u +%FT%TZ\`>.
   b. Update state.json: increment "completed", set updatedAt.
   c. git add the changed source/test/tracker files and commit on ${BRANCH}. Subject: "fix(regions): <TID> <short title>". End the message with exactly:
      Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   d. Return {status:"done", checkpointGreen:true, commit:<hash>, summary:<what changed>}.
7. If RED and not fixable with a small in-scope change: revert your uncommitted source edits, set <TID>.status="blocked", and return {status:"failed", checkpointGreen:false, commit:"", summary:<why>, blockers:[...]}. Do NOT proceed or fake green.

Return ONLY the structured status object.
`

phase('Setup')
const setup = await agent(`${PROTOCOL}

SETUP TASK (not a T-id): In ${REPO}, ensure the current git branch is ${BRANCH} (create from main if missing: \`git switch -c ${BRANCH}\`; never commit to main). Leave unrelated dirty files untouched. Do NOT edit source. Read state.json + progress.jsonl and report how many tasks are already "done". Return {taskId:"setup", status:"done", checkpointGreen:true, commit:"", summary:"branch ready; <N> done"}.`,
  { label: 'setup:branch', phase: 'Setup', schema: STATUS_SCHEMA })

if (!setup || setup.status === 'failed') {
  log('Setup failed — aborting.')
  return { aborted: true, at: 'setup', setup }
}

phase('Implement')
const results = [setup]
let stop = false
for (const tid of ORDER) {
  if (stop) { log(`Skipping ${tid} — halted by earlier failure.`); continue }
  const r = await agent(`${PROTOCOL.replace(/<TID>/g, tid)}

YOUR TASK ID: ${tid}. Execute it now per the procedure above.`,
    { label: `exec:${tid}`, phase: 'Implement', schema: STATUS_SCHEMA })
  results.push(r)
  if (!r) { log(`${tid}: agent returned null — halting.`); stop = true; continue }
  if (r.status === 'failed' || r.status === 'blocked') {
    log(`${tid}: ${r.status} — halting. ${r.summary || ''}`)
    stop = true
  } else {
    log(`${tid}: ${r.status}${r.commit ? ' @ ' + r.commit : ''}`)
  }
}

const done = results.filter((r) => r && r.status === 'done').length
const skipped = results.filter((r) => r && r.status === 'skipped').length
return {
  completed: done,
  skipped,
  halted: stop,
  nextStep: stop ? 'fix the halted task, then resume' : 'executor done T0..T16 — run T17 (docs) + T18 (llm-wiki) in MAIN SESSION',
  lastTask: results[results.length - 1],
  results,
}

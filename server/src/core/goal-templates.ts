import type { GoalTemplate } from '../types.js';

/**
 * The curated goal starter library — the "/goal" half of cowork's goal+loop
 * idiom (ADR-010), and the single source of truth the dashboard, the REST API
 * (`GET /api/goals/templates`), and CLI/agents all read.
 *
 * Two families, because goals fail in different ways:
 *
 *   SHIPPING goals are DELIVERABLE-bound: the criterion flips true the moment a
 *   concrete artifact EXISTS ("is the tool live?", "is the product for sale?").
 *   Short, cheap, self-terminating — the default budget is fine.
 *
 *   OUTCOME goals are METRIC-open ("$10k/month", "10k visits") — the shape that
 *   once stalled the real "$500k revenue" goal. The Achiever cannot force a
 *   market number, so the naive version spins evaluations until the step budget
 *   runs out. Every outcome starter below carries the four things that make one
 *   viable; copy the set if you write your own:
 *     1. EVIDENCE-BOUND criterion. Not "is MRR $10k?" (unanswerable from inside)
 *        but "does a dated snapshot in artifacts SHOW $10k?" — binary, auditable,
 *        and impossible to satisfy by assertion (the verifier rejects fabrication).
 *     2. A LOOP of phases (measure → research → ship → wait → review), so every
 *        turn has real work to emit — a turn that neither plans nor emits counts
 *        as no progress, and enough in a row blocks the goal (recoverably).
 *     3. SCHEDULED CHECKPOINTS. The measure phase emits its task with a future
 *        `scheduledAt`; `scheduled` is an OPEN status, so the goal goes
 *        quiescent-waiting and spends NO turns and NO budget while real time
 *        passes — what makes a months-long goal survivable at all.
 *     4. A budget sized for the horizon — these run for months, not an afternoon.
 *
 * The `loop` field on each template is the paired "/loop" driver contract: in
 * cowork the loop is the dispatcher's autonomous Achiever↔Judger drive, so these
 * prompts document (and make copy-pasteable) exactly what one turn does and the
 * single condition that ends the loop — never a timer, only the criterion.
 */
export const GOAL_TEMPLATES: GoalTemplate[] = [
  // ── Shipping goals (deliverable-bound, self-terminating) ───────────────────
  {
    key: 'web-tool', label: '🚀 Ship a web tool', family: 'shipping',
    title: 'Ship a new single-page web tool',
    description: 'Build and deploy a new client-side tool (vanilla HTML/CSS/JS, no build step) live on GitHub Pages, following the workspace static-tool template.',
    successCriteria: 'Is the tool live on GitHub Pages with a working index.html, og.png, and README?',
    reportBrief: 'what shipped this phase + the live/preview URL',
    phases: [
      'Scope the tool and check competitors',
      'Build the single-page tool',
      'Add og.png, README, and the branding footer',
      'Deploy to GitHub Pages and verify it loads'
    ],
    loop: {
      cadence: 'event-driven — the Achiever takes its next turn the moment the previous phase is audited',
      prompt: 'Drive this goal one move at a time: emit the current phase\'s real build work, let the Judger audit it, then plan or emit the next phase. Do not stop while any phase is unaudited.',
      stopWhen: 'the tool is live on GitHub Pages with a working index.html, og.png, and README (evaluate → met:true)'
    }
  },
  {
    key: 'api', label: '🔌 Ship a v1 API', family: 'shipping',
    title: 'Launch the v1 public API',
    description: 'Design, build, document and deploy a first public version of the API.',
    successCriteria: 'Is the v1 API deployed to production and publicly documented?',
    reportBrief: 'endpoints delivered + how they were verified',
    phases: [
      'Design the API contract',
      'Implement the endpoints',
      'Write docs and runnable examples',
      'Deploy to production and smoke-test the live endpoints'
    ],
    loop: {
      cadence: 'event-driven — one phase emitted, audited, then the next',
      prompt: 'Drive the API from contract to live: emit each phase\'s work, audit it, and only declare success once the deployed endpoints answer a real smoke test. Re-plan a phase if its results disappoint; never repeat completed work.',
      stopWhen: 'the v1 API is deployed to production and publicly documented (evaluate → met:true)'
    }
  },
  {
    key: 'automation', label: '⚙️ Automate a recurring task', family: 'shipping',
    title: 'Automate a recurring task on a schedule',
    description: 'Turn a manual chore into a scheduled GitHub Actions workflow that produces its output unattended.',
    successCriteria: 'Does one real scheduled run finish green and produce its expected output file?',
    reportBrief: 'what the run produced + the Actions run link',
    phases: [
      'Define the trigger and the expected output',
      'Write the script that produces it',
      'Add the workflow YAML and cron schedule',
      'Verify one real scheduled run succeeds'
    ],
    loop: {
      cadence: 'event-driven, then a scheduled wait for the first real cron run to fire',
      prompt: 'Build the automation, then emit the verification task with a future scheduledAt aligned to the cron so the goal sleeps until the run actually fires — do not re-evaluate before then. Read the real Actions run, not an assumption.',
      stopWhen: 'one real scheduled run finished green and produced its expected output file (evaluate → met:true)'
    }
  },
  {
    key: 'article', label: '📝 Write & publish an article', family: 'shipping',
    title: 'Publish an article to its live URL',
    description: 'Take an article from research to a published, publicly reachable page.',
    successCriteria: 'Is the article published and reachable at its public URL?',
    reportBrief: 'draft state + the published URL',
    phases: [
      'Research the topic and outline it',
      'Write the full draft',
      'Edit and add visuals',
      'Publish and confirm the live URL'
    ],
    loop: {
      cadence: 'event-driven — research, draft, edit, publish, each audited in turn',
      prompt: 'Move the article forward one phase per turn; the final phase must confirm the live URL actually loads, not merely that a draft exists.',
      stopWhen: 'the article is published and reachable at its public URL (evaluate → met:true)'
    }
  },
  {
    key: 'product', label: '📦 Launch a digital product', family: 'shipping',
    title: 'Launch a digital product for sale',
    description: 'Package a deliverable and put it on sale with a working sales page (e.g. Gumroad).',
    successCriteria: 'Is the product live for sale with a sales page and at least one delivery file?',
    reportBrief: 'what is ready to sell + the product URL',
    phases: [
      'Define the product, audience, and price',
      'Create the deliverable',
      'Build the sales page and set up delivery',
      'Publish the listing and confirm it can be bought'
    ],
    loop: {
      cadence: 'event-driven — each phase emitted then audited before the next',
      prompt: 'Drive the product to a buyable state: the closing phase must confirm the listing is live and a delivery file is attached, from the real platform.',
      stopWhen: 'the product is live for sale with a sales page and at least one delivery file (evaluate → met:true)'
    }
  },

  // ── Outcome goals (long-horizon, checkpoint-driven) ────────────────────────
  {
    key: 'revenue', label: '💰 Grow to $10k/month', family: 'outcome',
    title: 'Grow {project} to $10,000/month',
    description: [
      'Replace {project} with the real project before activating.',
      '',
      'Operating doctrine for this goal:',
      '• Work the loop: measure → research → ship one lever → wait → review. Never skip measurement; the criterion is settled by evidence, not opinion.',
      '• Research deeply before shipping. Name the specific lever (pricing, a new offer, a traffic channel, conversion on an existing page), what you expect it to be worth per month, and why — a lever with no number attached is a guess.',
      '• Waiting is a move. Revenue needs weeks to show. Emit the measurement task with a future scheduledAt (typically 30 days) instead of re-evaluating; the goal sleeps and spends nothing until it fires.',
      '• Every revenue snapshot is a real dated file in artifacts, read from the actual source (Gumroad, Stripe, Ko-fi, platform dashboards). Never estimate a number you did not read, and never report a quota/rate-limit notice as the result.',
      '• When a lever underperforms, say so in the phase result and pick a DIFFERENT one next phase. Read the Judger minutes first — repeating a flat lever is the main way this goal wastes budget.'
    ].join('\n'),
    successCriteria: 'Does a dated revenue snapshot in this goal\'s artifacts show at least $10,000 collected in the trailing 30 days?',
    reportBrief: 'revenue this checkpoint vs. last, which lever moved it, and the next lever with its expected monthly value',
    budget: 200,
    phases: [
      'Baseline current revenue and inventory every asset that already earns',
      'Research and rank the highest-leverage revenue levers with expected monthly value',
      'Ship the top-ranked lever end to end',
      'Schedule a 30-day checkpoint and record the dated revenue snapshot',
      'Review what moved the number and choose the next lever'
    ],
    loop: {
      cadence: 'checkpoint-driven — one measure→ship→wait→review cycle per ~30 days, sleeping between checkpoints',
      prompt: 'Each cycle: read the real revenue into a dated artifact, pick the single highest-leverage lever with an expected monthly value, ship it, then emit the next measurement with a scheduledAt ~30 days out and let the goal sleep. If a lever was flat last checkpoint, change the lever — never ship the same thing harder.',
      stopWhen: 'a dated artifact snapshot shows ≥ $10,000 collected in the trailing 30 days (evaluate → met:true). A missed number is a re-plan signal, never a stop.'
    }
  },
  {
    key: 'traffic', label: '📈 Grow organic traffic', family: 'outcome',
    title: 'Grow {project} to 10,000 organic visits/month',
    description: [
      'Replace {project} with the real site before activating.',
      '',
      'Operating doctrine for this goal:',
      '• Search compounds on a delay — pages published now show their traffic in 4–8 weeks. Always emit the measurement task with a future scheduledAt rather than re-checking early.',
      '• Every checkpoint reads real numbers from the actual analytics source into a dated file in artifacts. An unsourced number is not evidence.',
      '• Research before writing: name the query, its intent, and who currently ranks. Publishing without that is how this goal burns budget on pages nobody searches for.',
      '• Review each checkpoint for which pages actually earned impressions, and double down there instead of starting fresh topics every phase.'
    ].join('\n'),
    successCriteria: 'Does a dated analytics snapshot in this goal\'s artifacts show at least 10,000 organic visits in the trailing 30 days?',
    reportBrief: 'visits this checkpoint vs. last, which pages earned them, and the next content bet',
    budget: 150,
    phases: [
      'Baseline current organic traffic and index coverage',
      'Research target queries and rank them by intent and realistic difficulty',
      'Ship the highest-value pages and fix technical SEO blockers',
      'Schedule a 45-day checkpoint and record the dated analytics snapshot',
      'Review which pages earned impressions and pick the next content bet'
    ],
    loop: {
      cadence: 'checkpoint-driven — one research→ship→wait→review cycle per ~45 days, sleeping between checkpoints',
      prompt: 'Each cycle: read real analytics into a dated artifact, research and rank target queries by intent and difficulty, ship the highest-value pages, then emit the next measurement with a scheduledAt ~45 days out. Double down on pages that already earn impressions; do not start fresh topics every cycle.',
      stopWhen: 'a dated analytics snapshot shows ≥ 10,000 organic visits in the trailing 30 days (evaluate → met:true)'
    }
  },
  {
    key: 'customers', label: '🧲 Reach 100 paying customers', family: 'outcome',
    title: 'Reach 100 paying customers for {project}',
    description: [
      'Replace {project} with the real offer before activating.',
      '',
      'Operating doctrine for this goal:',
      '• The unit of progress is a paying customer, not a feature. Before building anything, state how the change is supposed to convert someone.',
      '• Talk to the market before rebuilding the product. Rejected offers, pricing objections, and refund reasons are the highest-value research available, and they are cheap.',
      '• Emit the count task on a scheduled checkpoint after each change has had time to convert; do not re-evaluate the same week you shipped.',
      '• Record the customer count from the real billing source into a dated file in artifacts every checkpoint, including when it did not move.',
      '• A flat checkpoint means change the offer, price, or channel — not ship the same thing harder.'
    ].join('\n'),
    successCriteria: 'Does a dated snapshot in this goal\'s artifacts show at least 100 distinct paying customers on the billing platform?',
    reportBrief: 'customer count this checkpoint vs. last, what converted them, and the next acquisition or offer change',
    budget: 200,
    phases: [
      'Baseline the current customer count and where they came from',
      'Research why prospects do and do not buy, and rank the fixes',
      'Ship the top fix to the offer, pricing, or acquisition channel',
      'Schedule a 30-day checkpoint and record the dated customer count',
      'Review what converted and choose the next change'
    ],
    loop: {
      cadence: 'checkpoint-driven — one research→ship→wait→review cycle per ~30 days, sleeping between checkpoints',
      prompt: 'Each cycle: read the real customer count into a dated artifact, research why prospects do and do not buy, ship the top fix to the offer/price/channel, then emit the next count task with a scheduledAt ~30 days out. A flat checkpoint means change the offer, price, or channel — not ship the same thing harder.',
      stopWhen: 'a dated artifact snapshot shows ≥ 100 distinct paying customers on the billing platform (evaluate → met:true)'
    }
  }
];

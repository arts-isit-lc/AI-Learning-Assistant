# The Learning Chatbot — Explained Simply

This document explains how AILA's learning chatbot actually teaches a student through a conversation. It's written for anyone — no programming background required.

> Want the technical version with function names, thresholds, and data stores? See [Chatbot V2: Structured Learning Flow](./chatbot-v2-flow.md).

---

## What makes this different from a normal chatbot

A normal chatbot waits for a question and answers it. AILA's chatbot behaves more like a **patient tutor running a lesson**. It doesn't just answer — it asks questions, listens to the student's reply, figures out what they understood, decides whether to nudge them, hint, explain, or move on, and keeps going until the student has genuinely engaged with the topic.

The most important idea to understand:

> **The app is the teacher. The AI is the voice.**

All the teaching decisions — what to ask next, whether to give a hint, whether the student is done — are made by ordinary, predictable program logic. The AI model is only used to turn those decisions into friendly, natural sentences (and to read the student's answer). This keeps the tutor consistent and prevents the AI from "going rogue" or skipping ahead.

---

## The big picture

```
   Student types a message
            │
            ▼
┌───────────────────────────────────────────────────────────────┐
│                     THE TUTOR'S THOUGHT PROCESS                 │
│                                                                 │
│   1. "Where were we?"        Load this student's progress       │
│   2. "How good was that      Grade the student's last answer    │
│       answer?"                                                  │
│   3. "What have they learned  Update the running scorecard      │
│       so far?"                                                  │
│   4. "Are they done with      Check the finish line             │
│       this module?"                                            │
│   5. "What should I do next?" Pick a move: greet / ask / hint / │
│                                explain / advance / congratulate │
│   6. "What do the course      Look up the relevant material     │
│       materials say?"                                          │
│   7. "Say it nicely."          AI writes the actual reply        │
│   8. "Remember all this."      Save progress for next time      │
│                                                                 │
└───────────────────────────────────────────────────────────────┘
            │
            ▼
   Reply streams back word-by-word to the student's screen
```

Every single message from the student goes through this same loop.

---

## Step 1: "Where were we?" — Remembering the student

The chatbot keeps a **scorecard** for every learning session. Think of it as the tutor's notepad. It remembers things like:

- How many back-and-forth exchanges have happened
- Which topics the student has been introduced to, talked about, and clearly understood
- How many answers were right, partly right, or wrong
- Whether the student is on a winning streak or struggling
- How many hints have been given
- An overall **engagement score** (a 0-to-1 measure of meaningful participation)

This notepad is saved between messages, so the tutor always picks up exactly where it left off — even if the student closes the tab and comes back tomorrow.

The list of topics for a module isn't made up on the fly. It comes from the course material itself (the topics that were generated when the instructor's files were processed). That fixed list keeps the tutor honest — it can only track topics that are actually part of the module.

---

## Step 2: "How good was that answer?" — Grading

When the student replies, a **fast, low-cost AI model** reads their answer and grades it, a bit like a teaching assistant glancing at a response. It decides:

- Was it **correct**, **partly correct**, or **incorrect**?
- Which specific topics did the student clearly understand?
- Which topics did they seem confused about?

```
┌────────────────────────────────────────────────────────────┐
│  Question asked:  "What happens to the largest number       │
│                    after one pass of bubble sort?"          │
│  Student said:    "It moves toward the end."                │
│                                                             │
│  Grader's verdict:                                          │
│     ✓ correct                                               │
│     understood:  [ bubble sort, passes ]                    │
│     confused about: [ ]                                     │
└────────────────────────────────────────────────────────────┘
```

Two safeguards worth knowing:

- The grader can **only name topics that belong to the module**. It can't invent a topic the course never covered.
- If the grader ever hiccups (times out, returns nonsense), the system assumes a gentle "partly correct" rather than punishing the student. A technical glitch never counts against the learner.

The very first message (the greeting) skips grading — there's no answer to grade yet.

---

## Step 3: "What have they learned?" — The topic journey

The tutor tracks each topic through four stages, like a plant growing:

```
INTRODUCED  ────▶  DISCUSSED  ────▶  DEMONSTRATED  ────▶  MASTERED
                                                                
"The tutor      "The student      "The student       "The student
 mentioned it"   talked about it   answered correctly  keeps getting
                 too"              about it"           it right"
```

- **Introduced** — the tutor brought the topic up.
- **Discussed** — the student engaged with it too (it showed up in both sides of the conversation).
- **Demonstrated** — the student answered something correctly about it.
- **Mastered** — the student has reliably shown they get it.

A topic only ever moves *forward* along this path. And importantly, **being confused about something is never held against the student** — it just means "keep working on this," not "lose points."

---

## Step 4: "Are they done?" — The completion check

This is one of the most important — and most deliberately designed — parts of the system.

**A module is complete when the student has genuinely participated. It is NOT about being a genius.** Three things must all be true:

```
┌──────────────────────────────────────────────────────────────┐
│                     THE FINISH LINE                            │
│                                                                │
│   ✓  Enough back-and-forth      (at least 5 exchanges)         │
│                                                                │
│   ✓  Enough of the topics       (talked about at least half   │
│      covered                     the module's topics)         │
│                                                                │
│   ✓  Good engagement            (engagement score of 0.5+)    │
│                                                                │
│   ── ALL three required ──                                     │
└──────────────────────────────────────────────────────────────┘
```

Notice what is **deliberately NOT on this list**:

- ❌ Reaching a particular difficulty level
- ❌ Getting a certain number of answers perfectly right
- ❌ "Mastering" every topic

**Why?** The goal is to reward genuine effort and engagement, not to gate students behind a perfect score. A student who thoughtfully works through a topic — even while getting some things wrong — completes the module. A student who types "idk" five times does not, because their engagement score stays too low.

The "engagement score" nudges up a little every time the student gets something right (a bigger bump) or shows partial understanding (a smaller bump). Wrong answers simply don't move it — they never subtract.

> One subtle detail: if a module somehow had *no* topics listed, it can never be marked complete. This is a safety net so a misconfigured module doesn't hand out free completions.

When a student crosses the finish line, the tutor congratulates them **once**, summarizes what they covered, and suggests other modules to try next. After that, the conversation stays open for more questions — it just won't keep re-congratulating them.

---

## Step 5: "What should I do next?" — Picking a move

Based on the scorecard and the grade, the tutor picks exactly one "move" for its next reply. It works down a priority list and takes the first one that fits:

| The situation | The tutor's move |
|---|---|
| Brand new session | **Greet** and ask an opening question |
| Answer was correct, ready for more depth | **Advance** to the next idea |
| Answer was correct | **Ask** another question |
| Answer was partly right (first time) | **Nudge** — a gentle hint |
| Answer was partly right (again) | **Scaffold** — break it into smaller steps |
| Several wrong answers in a row | **Explain** it directly, then check understanding |
| Finished the module | **Congratulate** and suggest what's next |
| Already finished earlier | **Chat freely** about the topic |

The tutor never decides its *own* strategy — it's handed one of these moves and simply phrases it well.

---

## The Hint System — how help escalates

The chatbot is careful **not** to hand over answers. Instead, help gets gradually stronger the more a student struggles. There are actually **two** hint systems, for two kinds of learning.

### 1. Hints during normal discussion

For regular topics, hints escalate like a good tutor who reveals a little more each time:

```
Student is partly right...
        │
        ▼
   ┌─────────────┐   still stuck?   ┌────────────────┐   still stuck   ┌──────────────┐
   │  NUDGE      │ ───────────────▶ │  SCAFFOLD       │ ─────────────▶ │  EXPLAIN     │
   │             │                  │                 │  (3 misses)    │              │
   │ "You're on  │                  │ "Let's break    │                │ "Here's how  │
   │  the right  │                  │  this into      │                │  it works..."│
   │  track —    │                  │  smaller        │                │  then asks a │
   │  think      │                  │  steps. First,  │                │  follow-up   │
   │  about..."  │                  │  what about..." │                │  question    │
   └─────────────┘                  └────────────────┘                └──────────────┘
   gentlest                                                            most direct
```

- First slip → a **gentle nudge** (no answer given).
- Still struggling → **scaffolding** (the topic is broken into smaller, easier sub-steps).
- Several misses in a row → the tutor stops hinting and just **explains it clearly**, then checks the student got it.

And here's a nice touch: whenever the student levels up to a harder stage, the hint meter **resets to gentle**. A new challenge always starts with a light touch rather than assuming the student is still stuck.

### 2. Hints while solving a math problem

When a student wants to work through an actual math problem step-by-step (like finding eigenvalues or a derivative), a special **step-by-step math tutor** takes over. Its hints work differently — they're precise and predictable rather than AI-improvised:

```
The tutor presents Step 1 and asks the student to try it.
        │
        ▼
   Student's attempt
        │
        ├─ "hint" / "I'm stuck"  →  Give the hint written for THIS step
        │                            (never the answer). Ask them to try again.
        │
        ├─ "just tell me"        →  Reveal the full worked solution.
        │
        ├─ Correct               →  "Nice!" → move to the next step.
        │
        └─ Wrong                 →  Give a hint and let them retry.
                                     Wrong twice on the same step?
                                     → Gently reveal the answer and move on,
                                       so they're never stuck forever.
```

The key difference: for math, the numbers and steps are **computed by a reliable math engine first, then verified**, before the tutor ever presents them. The AI is told to reproduce the verified numbers *exactly* and not to recalculate — so the tutor never teaches a wrong calculation. If the math engine can't verify an answer, the tutor explains the *method* instead of stating a possibly-wrong result.

---

## Step 6: "What do the materials say?" — Staying grounded

Before writing a reply, the tutor looks up the **relevant course material** for the topic at hand — the instructor's slides, PDFs, diagrams, tables, and formulas. (This lookup is handled by a separate search system, explained in [Multimodal RAG V2 — Explained Simply](./multimodal-rag-v2-explained.md).)

This matters because:

- The tutor answers from **the actual course**, not from generic internet knowledge.
- If a diagram, table, or formula is relevant, it can be **shown right in the chat** alongside the explanation.
- The tutor is specifically instructed that it only sees *part* of the course at a time — so it never claims "that isn't in your course." It only ever says "I couldn't find that in the material I retrieved."

The tutor also makes sure the words it writes actually match any picture or table it's about to show, so the student never sees an explanation that contradicts the diagram next to it.

---

## Step 7: "Say it nicely" — Writing the reply

Now the more capable AI model writes the actual reply. It's given a tight brief:

```
┌───────────────────────────────────────────────────────────┐
│  You are a course instructor.                              │
│  + Only use the course material provided.                  │
│  + No emojis, plain language.                              │
│  + Your move this turn is: [nudge toward "time complexity"]│
│  + Topic: Sorting Algorithms                               │
│  + Here's the relevant course material: ...                │
│  + Safety boundaries: ...                                  │
└───────────────────────────────────────────────────────────┘
```

The reply is **streamed** to the student's screen word-by-word (like watching someone type) rather than appearing all at once, so it feels responsive even for longer answers.

### A safety net around every reply

Every message — both what the student sends and what the AI writes — passes through **safety guardrails**. If someone tries to steer the conversation somewhere inappropriate or off-topic, the tutor gently redirects back to the course material instead of engaging. If the safety system itself has a problem, the tutor errs on the side of caution rather than sending an unchecked reply.

---

## Step 8: "Remember all this" — Saving progress

Finally, the tutor saves everything so the next message picks up seamlessly:

- The **conversation** is saved (this is the reliable master copy).
- A **display copy** is saved for the history you see in the app, including any diagrams or tables that were shown.
- The **scorecard** (progress, scores, hint level) is updated.
- The student's **engagement is logged** for instructor dashboards.

The system is careful about ordering here so that, even if one save is briefly delayed, no message is ever lost and the chat history always appears in the right order.

---

## A short example conversation

```
Tutor:   Welcome! Let's explore sorting algorithms. What do you already
         know about how a computer puts a list of numbers in order?
                                                        [move: greet]

Student: Bubble sort compares two numbers next to each other.

Tutor:   Exactly right. After one full pass through the list, what
         happens to the largest number?
                             [graded: correct → move: ask another]

Student: It moves somewhere in the middle?

Tutor:   You're close — you've got the "it moves" part. Think about
         which direction the biggest value keeps getting pushed...
                             [graded: partly right → move: nudge]

Student: Oh! It ends up at the very end of the list.

Tutor:   That's it — it "bubbles" to the end. Now that you've got that,
         let's think about how fast this is for a big list...
                    [graded: correct → leveled up → move: advance]

   ... a few more exchanges ...

Tutor:   Great work! You've really engaged with sorting — bubble sort,
         passes, and time complexity. You might enjoy "Graph Algorithms"
         next.                              [finish line reached → congratulate]
```

---

## The guiding principles, in plain terms

| Principle | What it means for the student |
|---|---|
| **The app teaches, the AI speaks** | The lesson stays consistent and on-track; the AI can't skip ahead or freelance |
| **Finishing = engaging, not acing** | Genuine effort completes a module; you don't need a perfect score |
| **Hints, not answers** | Help gets stronger gradually, so you get the chance to figure it out yourself |
| **Grounded in your course** | Answers come from your instructor's materials, not the open internet |
| **Verified math** | Step-by-step math is computed and double-checked, so you're never taught a wrong number |
| **Nothing breaks loudly** | If a piece of the system stumbles, the conversation degrades gracefully instead of failing |
| **Safe by default** | Guardrails keep the conversation appropriate and on-topic |

---

## Related Documentation

- [Chatbot V2: Structured Learning Flow](./chatbot-v2-flow.md) — the full technical version of this document
- [Multimodal RAG V2 — Explained Simply](./multimodal-rag-v2-explained.md) — how the system understands and searches course materials
- [Architecture Overview](./architecture-overview.md) — how all the pieces fit together

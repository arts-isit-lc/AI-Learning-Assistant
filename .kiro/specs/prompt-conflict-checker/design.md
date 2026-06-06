# Technical Design: Prompt Conflict Checker

## Overview

The Prompt Conflict Checker validates instructor-written prompts (course-level and module-level) against the fixed system-level instructions and each other, detecting semantic contradictions before they cause degraded chatbot behavior. It uses a fast LLM (Claude Haiku via Amazon Bedrock) to analyze prompt hierarchies and returns structured conflict reports with highlighted conflicting text, explanations, and confidence scores.

This feature integrates into the existing `instructorFunction` Lambda as a new route (`POST /instructor/validate_prompt`), reusing the established API Gateway → Lambda pattern. The frontend (PromptSettings.jsx) gains a "Check for Conflicts" workflow using shadcn/ui components with Tailwind styling — no new infrastructure beyond adding Bedrock invoke permissions to the existing role.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              FRONTEND (React SPA)                                │
│                                                                                 │
│  PromptSettings.jsx / InstructorNewModule.jsx / InstructorEditCourse.jsx         │
│       │                                                                         │
│       │ POST /instructor/validate_prompt                                        │
│       │ { prompt, scope, module_id? }                                           │
└───────┼─────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────┐
│   API Gateway     │
│  (REST, WAF)      │
└───────┬───────────┘
        │
        ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│               instructorFunction (Node.js 22, zip Lambda)                      │
│                                                                               │
│  ┌──────────────────────────┐    ┌────────────────────────────────────────┐   │
│  │ Route: POST              │    │ constants/systemPrompt.js              │   │
│  │ /instructor/validate_prompt│   │ (System-Level Prompt - JS copy)       │   │
│  └──────────┬───────────────┘    └────────────────────────────────────────┘   │
│             │                                                                 │
│             │  1. Load system_level_prompt from constant                       │
│             │  2. Fetch course_prompt / module_prompts from DB                 │
│             │  3. Build validation LLM prompt                                  │
│             │  4. Call Bedrock (Claude Haiku, temp 0)                          │
│             │  5. Parse & validate JSON response                               │
│             │  6. Return Conflict_Report                                       │
│             │                                                                 │
│             ▼                                                                 │
│  ┌──────────────────────┐         ┌──────────────────────────────────┐        │
│  │  PostgreSQL (RDS     │         │  Amazon Bedrock                  │        │
│  │  Proxy)              │         │  (Claude Haiku - Validation)     │        │
│  │                      │         │  Temperature: 0                  │        │
│  │  - Courses table     │         │  Max tokens: 4096                │        │
│  │  - Course_Modules    │         └──────────────────────────────────┘        │
│  │  - Course_Concepts   │                                                     │
│  └──────────────────────┘                                                     │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Data flow for course-level validation:**
1. Frontend sends `POST /instructor/validate_prompt` with `scope: "course"` and the edited prompt text
2. instructorFunction loads the system_level_prompt from the local constant file
3. Fetches all module_prompts for the course via SQL JOIN through Course_Concepts → Course_Modules
4. Constructs the validation prompt and calls Bedrock
5. Parses the structured JSON response, validates schema conformance
6. Returns `Conflict_Report` to frontend

**Data flow for module-level validation:**
1. Frontend sends `POST /instructor/validate_prompt` with `scope: "module"` and `module_id`
2. instructorFunction loads system_level_prompt, fetches the parent course_prompt from Courses table
3. Constructs the validation prompt comparing module prompt against both
4. Calls Bedrock and returns `Conflict_Report`

---

## Components and Interfaces

### Endpoint: `POST /instructor/validate_prompt`

**Query Parameters:**
| Parameter | Type | Required | Description |
|---|---|---|---|
| `course_id` | string (UUID) | Yes | The course being validated |
| `instructor_email` | string | Yes | Instructor's email (for auth check) |

**Request Body:**
```json
{
  "prompt": "Your edited prompt text here...",
  "scope": "course",
  "module_id": "uuid-optional-for-module-scope"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | Yes | The prompt text being validated (max 1000 chars) |
| `scope` | `"course"` \| `"module"` | Yes | Whether validating a course-level or module-level prompt |
| `module_id` | string (UUID) | Only if scope=module | The module whose prompt is being validated |

**Response (200 OK):**
```json
{
  "validation_status": "conflicts_found",
  "conflicts": [
    {
      "type": "HARD_CONTRADICTION",
      "confidence": 0.92,
      "prompt_a_source": "system_level_prompt",
      "prompt_b_source": "course_prompt",
      "prompt_a_text": "Do not summarize readings if asked.",
      "prompt_b_text": "Always provide a brief summary of the reading before asking questions.",
      "dominant_source": "system_level_prompt",
      "explanation": "The course prompt instructs summarization, which directly contradicts the system instruction to never summarize readings."
    }
  ],
  "summary": "1 conflict found: course prompt contradicts system-level instruction about summarization.",
  "has_conflicts": true,
  "validated_at": "2024-01-15T10:30:00.000Z",
  "validation_scope": "course",
  "model_version": "anthropic.claude-3-haiku-20240307-v1:0"
}
```

**Response (200 OK — partial results for batch):**
```json
{
  "validation_status": "partial_results",
  "conflicts": [],
  "unvalidated_modules": [
    { "module_name": "Module 11", "reason": "Batch timeout exceeded 10s" }
  ],
  "summary": "Validated 10 of 12 modules. 2 modules could not be validated due to timeout.",
  "has_conflicts": false,
  "validated_at": "2024-01-15T10:30:00.000Z",
  "validation_scope": "course",
  "model_version": "anthropic.claude-3-haiku-20240307-v1:0"
}
```

**Response (200 OK — validation failed):**
```json
{
  "validation_status": "validation_failed",
  "conflicts": [],
  "summary": "Validation is temporarily unavailable. You may save your prompt without validation.",
  "has_conflicts": false,
  "validated_at": "2024-01-15T10:30:00.000Z",
  "validation_scope": "course",
  "model_version": "anthropic.claude-3-haiku-20240307-v1:0"
}
```

**Error Responses:**
- `400` — Missing required parameters or invalid scope
- `401` — Email mismatch (existing auth check in instructorFunction)
- `500` — Unrecoverable server error

---

## 4. System-Level Prompt as Shared Constant

### Problem

The system-level prompt is currently hardcoded inline in `cdk/text_generation/src/helpers/chat.py` within the `get_response_streaming` function. The validation logic runs in the Node.js `instructorFunction` and needs access to the same prompt text.

### Design

Create two parallel constant files that contain identical system-level prompt text:

**Node.js (used by instructorFunction):**
`cdk/lambda/lib/constants/systemPrompt.js`

```javascript
/**
 * System-Level Prompt — the fixed, immutable instructions that define core
 * chatbot behavior. This is the single source of truth for the Node.js Lambda.
 *
 * MAINTENANCE CONSTRAINT: This text MUST stay in sync with the Python version at:
 *   cdk/text_generation/src/constants/system_prompt.py
 *
 * Any change to either file requires updating the other. Add a check to the
 * PR review checklist.
 */
const SYSTEM_LEVEL_PROMPT = `You are an instructor for a course. Your job is to help the student understand the concepts in the course reading.
Do not summarize readings if asked. Ask questions, guide reasoning, connected to the readings.
Keep discussion focused on the assigned readings or course topics. If the student goes off-topic, politely redirect to the reading.
Continue this process until students have completed at least 5 interactions and written 300 words.
Once students have achieved this, include 'Thank you for chatting with me about this topic, you are ready to go discuss this with your class.' in your response and do not ask any further questions about the topic.
Use three sentences maximum and keep the answer concise. End each answer with a question that encourages the student to think critically about the topic.`;

module.exports = { SYSTEM_LEVEL_PROMPT };
```

**Python (existing location, extracted to a constant):**
`cdk/text_generation/src/constants/system_prompt.py`

```python
"""
System-Level Prompt — the fixed, immutable instructions that define core
chatbot behavior. This is the single source of truth for the Python Lambda.

MAINTENANCE CONSTRAINT: This text MUST stay in sync with the Node.js version at:
    cdk/lambda/lib/constants/systemPrompt.js

Any change to either file requires updating the other. Add a check to the
PR review checklist.
"""

SYSTEM_LEVEL_PROMPT = """You are an instructor for a course. Your job is to help the student understand the concepts in the course reading.
Do not summarize readings if asked. Ask questions, guide reasoning, connected to the readings.
Keep discussion focused on the assigned readings or course topics. If the student goes off-topic, politely redirect to the reading.
Continue this process until students have completed at least 5 interactions and written 300 words.
Once students have achieved this, include 'Thank you for chatting with me about this topic, you are ready to go discuss this with your class.' in your response and do not ask any further questions about the topic.
Use three sentences maximum and keep the answer concise. End each answer with a question that encourages the student to think critically about the topic."""
```

### Maintenance Constraint

Both files contain a header comment pointing to the other file. The PR review checklist must include: "If either `systemPrompt.js` or `system_prompt.py` changed, verify the other file matches." A future improvement could extract this to a shared JSON file with a build-time sync script, but that adds complexity beyond the scope of this feature.

---

## 5. Validation LLM Prompt Template

The following prompt is sent to Claude Haiku at temperature 0 for deterministic conflict detection:

```text
You are a prompt conflict analyzer for an educational AI system. Your job is to identify semantic contradictions between prompts in a strict hierarchy.

## Prompt Hierarchy (highest to lowest precedence):
1. SYSTEM_LEVEL_PROMPT — immutable, always dominant
2. COURSE_PROMPT — set by instructor for the entire course
3. MODULE_PROMPT(s) — set by instructor per module

A conflict exists ONLY when one prompt negates, prohibits, or makes simultaneously impossible an instruction from another prompt. Complementary instructions (adding constraints, topics, or behaviors that don't contradict) are NOT conflicts.

## Conflict Types:
- HARD_CONTRADICTION: Direct logical negation. One uses "must"/"always"/"never" and the other uses the opposite directive on the same behavior.
- BEHAVIORAL_INCOMPATIBILITY: Two prompts enforce incompatible interaction modes that cannot both be dominant.
- CONSTRAINT_COLLISION: Output rules from two prompts cannot be satisfied simultaneously.
- HIERARCHY_VIOLATION: A lower-level prompt explicitly overrides a higher-level prompt's rules.

## Confidence Score Guidelines:
- HIGH (>0.8): Clear imperative language with direct opposition on the same behavior
- MEDIUM (0.5–0.8): Implicit tension or likely-but-not-certain contradiction
- LOW (<0.5): Possible tension but ambiguous; could be complementary

## Inputs:

### SYSTEM_LEVEL_PROMPT:
{system_level_prompt}

### COURSE_PROMPT:
{course_prompt}

### MODULE_PROMPTS (if applicable):
{module_prompts_section}

## Task:
Analyze the {validation_scope} prompt against all higher-level prompts (and lower-level prompts if scope is "course"). For each genuine conflict found, extract the specific conflicting text from each prompt (max 500 chars each).

## Output Format:
Respond with ONLY valid JSON matching this exact schema — no markdown, no explanation outside the JSON:

{
  "conflicts": [
    {
      "type": "HARD_CONTRADICTION | BEHAVIORAL_INCOMPATIBILITY | CONSTRAINT_COLLISION | HIERARCHY_VIOLATION",
      "confidence": 0.0 to 1.0,
      "prompt_a_source": "system_level_prompt | course_prompt | module_prompt:{module_name}",
      "prompt_b_source": "system_level_prompt | course_prompt | module_prompt:{module_name}",
      "prompt_a_text": "exact conflicting excerpt from prompt A (max 500 chars)",
      "prompt_b_text": "exact conflicting excerpt from prompt B (max 500 chars)",
      "dominant_source": "system_level_prompt | course_prompt",
      "explanation": "plain-language explanation of why these conflict (max 300 chars)"
    }
  ],
  "summary": "brief overall summary (max 300 chars)"
}

If no conflicts exist, return: {"conflicts": [], "summary": "No conflicts detected. All prompts are consistent with the hierarchy."}
```

### Template Variables

| Variable | Source | Description |
|---|---|---|
| `{system_level_prompt}` | `constants/systemPrompt.js` | The fixed system-level instructions |
| `{course_prompt}` | DB: `Courses.system_prompt` | The instructor's course-level prompt |
| `{module_prompts_section}` | DB: `Course_Modules.module_prompt` | Formatted list of module prompts (for course-scope validation) or the single module prompt (for module-scope) |
| `{validation_scope}` | Request body | `"course"` or `"module"` |

### Module Prompts Section Formatting

For course-scope validation with multiple modules:
```
Module 1 (module_name: "Introduction to Ethics"):
{module_prompt_text}

Module 2 (module_name: "Utilitarianism"):
{module_prompt_text}
```

For module-scope validation:
```
MODULE_PROMPT (module_name: "{module_name}"):
{module_prompt_text}
```

---

## Data Models

Add a `conflict_metadata` JSONB column to store the last Conflict_Report for persistent warning display:

```sql
ALTER TABLE "Courses" ADD COLUMN conflict_metadata jsonb DEFAULT NULL;
ALTER TABLE "Course_Modules" ADD COLUMN conflict_metadata jsonb DEFAULT NULL;
```

**Column semantics:**
- `NULL` — no validation has been performed, or prompt was saved clean
- Contains a `Conflict_Report` JSON — prompt was saved with override (conflicts acknowledged)

**Stored JSON structure** (subset of the full Conflict_Report):
```json
{
  "validation_status": "conflicts_found",
  "conflicts": [
    {
      "type": "HARD_CONTRADICTION",
      "confidence": 0.92,
      "prompt_a_source": "system_level_prompt",
      "prompt_b_source": "course_prompt",
      "prompt_a_text": "Do not summarize readings if asked.",
      "prompt_b_text": "Always provide a brief summary of the reading before asking questions.",
      "dominant_source": "system_level_prompt",
      "explanation": "Course prompt contradicts system instruction about summarization."
    }
  ],
  "has_conflicts": true,
  "validated_at": "2024-01-15T10:30:00.000Z",
  "conflict_count": 1,
  "conflict_types": ["HARD_CONTRADICTION"]
}
```

**When cleared:** When an instructor re-validates and saves with `validation_status: "clean"`, the column is set back to `NULL`.

**Migration:** Add this to the DBFlowStack initializer Lambda's schema migration sequence.

---

## 7. Backend Implementation (instructorFunction.js)

### New Route Handler: `POST /instructor/validate_prompt`

```javascript
case "POST /instructor/validate_prompt":
  if (
    event.queryStringParameters?.course_id &&
    event.queryStringParameters?.instructor_email &&
    event.body
  ) {
    const { course_id, instructor_email } = event.queryStringParameters;
    const { prompt, scope, module_id } = JSON.parse(event.body);

    // Input validation
    if (!prompt || !prompt.trim()) {
      response.body = JSON.stringify({
        validation_status: "validation_skipped",
        conflicts: [],
        summary: "No validation performed: prompt is empty.",
        has_conflicts: false,
        validated_at: new Date().toISOString(),
        validation_scope: scope || "course",
        model_version: VALIDATION_MODEL_ID,
      });
      break;
    }

    if (!scope || !["course", "module"].includes(scope)) {
      response.statusCode = 400;
      response.body = JSON.stringify({ error: "scope must be 'course' or 'module'" });
      break;
    }

    if (scope === "module" && !module_id) {
      response.statusCode = 400;
      response.body = JSON.stringify({ error: "module_id required for module scope" });
      break;
    }

    try {
      const conflictReport = await validatePrompt({
        prompt, scope, course_id, module_id, sqlConnection
      });
      response.body = JSON.stringify(conflictReport);
    } catch (err) {
      console.error("Validation error:", err);
      response.body = JSON.stringify({
        validation_status: "validation_failed",
        conflicts: [],
        summary: "Validation is temporarily unavailable. You may save your prompt without validation.",
        has_conflicts: false,
        validated_at: new Date().toISOString(),
        validation_scope: scope,
        model_version: VALIDATION_MODEL_ID,
      });
    }
  } else {
    response.statusCode = 400;
    response.body = JSON.stringify({
      error: "course_id, instructor_email, and request body are required"
    });
  }
  break;
```

### Core Validation Function

Located in a new file: `cdk/lambda/lib/validatePrompt.js`

```javascript
const { SYSTEM_LEVEL_PROMPT } = require("./constants/systemPrompt.js");
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

const VALIDATION_MODEL_ID = process.env.VALIDATION_MODEL_ID
  || "anthropic.claude-3-haiku-20240307-v1:0";
const BEDROCK_TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 2000;
const BATCH_SIZE = 10;

async function validatePrompt({ prompt, scope, course_id, module_id, sqlConnection }) {
  // 1. Fetch related prompts from DB
  let coursePrompt = "";
  let modulePrompts = [];

  if (scope === "course") {
    // Fetch all module prompts for this course
    modulePrompts = await fetchModulePrompts(course_id, sqlConnection);
  } else {
    // scope === "module": fetch the course prompt
    coursePrompt = await fetchCoursePrompt(course_id, sqlConnection);
  }

  // 2. Build and execute validation
  if (scope === "course") {
    return await validateCoursePrompt(prompt, modulePrompts);
  } else {
    return await validateModulePrompt(prompt, coursePrompt);
  }
}

async function fetchModulePrompts(course_id, sqlConnection) {
  const rows = await sqlConnection`
    SELECT cm.module_name, cm.module_prompt, cm.module_number
    FROM "Course_Modules" cm
    JOIN "Course_Concepts" cc ON cm.concept_id = cc.concept_id
    WHERE cc.course_id = ${course_id}
      AND cm.module_prompt IS NOT NULL
      AND cm.module_prompt != ''
    ORDER BY cc.concept_number ASC, cm.module_number ASC;
  `;
  return rows;
}

async function fetchCoursePrompt(course_id, sqlConnection) {
  const rows = await sqlConnection`
    SELECT system_prompt FROM "Courses" WHERE course_id = ${course_id};
  `;
  return rows[0]?.system_prompt || "";
}
```

### Modify Existing `PUT /instructor/prompt`

Add optional `conflict_metadata` storage when saving with override:

```javascript
// Inside the existing PUT /instructor/prompt case:
const { prompt, llm_model_id, conflict_metadata } = JSON.parse(event.body);

// Update query includes conflict_metadata
const updatedCourse = await sqlConnection`
  UPDATE "Courses"
  SET system_prompt = ${prompt},
      llm_model_id = ${llm_model_id},
      conflict_metadata = ${conflict_metadata || null}
  WHERE course_id = ${course_id}
  RETURNING *;
`;

// If override with conflicts, log the event
if (conflict_metadata && conflict_metadata.has_conflicts) {
  console.log(JSON.stringify({
    level: "INFO",
    service: "instructor-function",
    event: "validation_override",
    instructor_email,
    course_id,
    conflict_count: conflict_metadata.conflicts?.length || 0,
    conflict_types: conflict_metadata.conflicts?.map(c => c.type) || [],
    timestamp: new Date().toISOString(),
  }));
}
```

---

## 8. Batch Validation Logic

For courses with more than 10 modules, the validation splits into batches:

```javascript
async function validateCoursePrompt(coursePrompt, modulePrompts) {
  const results = { conflicts: [], unvalidated_modules: [] };

  // Always validate course prompt against system prompt first
  try {
    const systemResult = await callBedrockValidation(
      coursePrompt, "", [], "course"
    );
    if (systemResult.conflicts) {
      results.conflicts.push(...systemResult.conflicts);
    }
  } catch (err) {
    // System prompt validation failure is critical
    return buildFailedReport("course", "System prompt validation failed");
  }

  // If no module prompts, return early
  if (modulePrompts.length === 0) {
    return {
      validation_status: results.conflicts.length > 0 ? "conflicts_found" : "clean",
      conflicts: results.conflicts,
      summary: results.conflicts.length > 0
        ? `${results.conflicts.length} conflict(s) found with the system-level prompt.`
        : "No conflicts detected. All prompts are consistent with the hierarchy.",
      has_conflicts: results.conflicts.length > 0,
      validated_at: new Date().toISOString(),
      validation_scope: "course",
      model_version: VALIDATION_MODEL_ID,
    };
  }

  // Chunk modules into batches of BATCH_SIZE (10)
  const batches = [];
  for (let i = 0; i < modulePrompts.length; i += BATCH_SIZE) {
    batches.push(modulePrompts.slice(i, i + BATCH_SIZE));
  }

  // Process batches sequentially (avoid Bedrock throttling)
  for (const batch of batches) {
    try {
      const batchResult = await callBedrockValidation(
        coursePrompt, "", batch, "course"
      );
      if (batchResult.conflicts) {
        results.conflicts.push(...batchResult.conflicts);
      }
    } catch (err) {
      // Mark failed batch modules as unvalidated, continue
      for (const mod of batch) {
        results.unvalidated_modules.push({
          module_name: mod.module_name,
          reason: err.message || "Batch validation timeout",
        });
      }
    }
  }

  // Determine final status
  const hasUnvalidated = results.unvalidated_modules.length > 0;
  const hasConflicts = results.conflicts.length > 0;

  let status = "clean";
  if (hasConflicts && hasUnvalidated) status = "partial_results";
  else if (hasConflicts) status = "conflicts_found";
  else if (hasUnvalidated) status = "partial_results";

  return {
    validation_status: status,
    conflicts: results.conflicts.sort((a, b) => {
      // Sort by module number for deterministic ordering
      const aNum = extractModuleNumber(a.prompt_b_source);
      const bNum = extractModuleNumber(b.prompt_b_source);
      return aNum - bNum;
    }),
    unvalidated_modules: hasUnvalidated ? results.unvalidated_modules : undefined,
    summary: buildSummary(results.conflicts, results.unvalidated_modules),
    has_conflicts: hasConflicts,
    validated_at: new Date().toISOString(),
    validation_scope: "course",
    model_version: VALIDATION_MODEL_ID,
  };
}
```

### Bedrock Call with Retry

```javascript
async function callBedrockValidation(editedPrompt, coursePrompt, modulePrompts, scope) {
  const llmPrompt = buildLLMPrompt(editedPrompt, coursePrompt, modulePrompts, scope);

  const invokeWithTimeout = async () => {
    const client = new BedrockRuntimeClient({ region: process.env.REGION });
    const command = new InvokeModelCommand({
      modelId: VALIDATION_MODEL_ID,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: "user", content: llmPrompt }],
      }),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BEDROCK_TIMEOUT_MS);

    try {
      const response = await client.send(command, { abortSignal: controller.signal });
      clearTimeout(timeout);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      const content = responseBody.content[0].text;
      return JSON.parse(content);
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  };

  // First attempt
  try {
    const result = await invokeWithTimeout();
    validateSchema(result);
    return result;
  } catch (firstErr) {
    // Retry once after 2s delay
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      const result = await invokeWithTimeout();
      validateSchema(result);
      return result;
    } catch (secondErr) {
      throw new Error(`Validation failed after retry: ${secondErr.message}`);
    }
  }
}

function validateSchema(result) {
  if (!result || typeof result !== "object") {
    throw new Error("Response is not a valid JSON object");
  }
  if (!Array.isArray(result.conflicts)) {
    throw new Error("Response missing 'conflicts' array");
  }
  for (const conflict of result.conflicts) {
    const requiredFields = [
      "type", "confidence", "prompt_a_source", "prompt_b_source",
      "prompt_a_text", "prompt_b_text", "dominant_source", "explanation"
    ];
    for (const field of requiredFields) {
      if (!(field in conflict)) {
        throw new Error(`Conflict missing required field: ${field}`);
      }
    }
    const validTypes = [
      "HARD_CONTRADICTION", "BEHAVIORAL_INCOMPATIBILITY",
      "CONSTRAINT_COLLISION", "HIERARCHY_VIOLATION"
    ];
    if (!validTypes.includes(conflict.type)) {
      throw new Error(`Invalid conflict type: ${conflict.type}`);
    }
    if (typeof conflict.confidence !== "number" || conflict.confidence < 0 || conflict.confidence > 1) {
      throw new Error(`Invalid confidence score: ${conflict.confidence}`);
    }
  }
}
```

---

## 9. Frontend Design

### Overview

The PromptSettings page (and module editing pages) gains conflict checking capabilities using MUI components, matching the existing patterns in the codebase. All new UI uses `@mui/material` components (Alert, Paper, Typography, TextField, Button, Dialog, Tooltip, Chip, CircularProgress, Accordion).

### Component Structure

```
PromptSettings (page — existing, extended)
├── Paper (LLM Model Selection — existing)
│   └── Select (model dropdown — existing)
├── Paper (Course Prompt Editor — existing, extended)
│   ├── TextField multiline (editable prompt — existing)
│   ├── ConflictHighlightBox (read-only Box with highlighted spans, shown after validation)
│   └── Alert severity="warning" (warning banner when conflicts exist)
├── Paper (Module Prompt Conflicts — new section)
│   ├── Accordion (per-module, expandable)
│   │   ├── AccordionSummary (module name + Chip for conflict type)
│   │   └── AccordionDetails (highlighted excerpts + explanation)
│   └── Typography (empty state message when no module conflicts)
├── Paper (Previous Prompts carousel — existing)
└── Box (Button group)
    ├── Button "Check for Conflicts" variant="outlined"
    ├── Button "Save" variant="contained" (always enabled)
    └── Dialog (override confirmation when saving with conflicts)
```

### Key UI Behaviors

**"Check for Conflicts" Button:**
- Positioned next to the Save button in a `Box` with `display: "flex"` and `gap: 2`
- MUI `Button` with `variant="outlined"` and `color="primary"`
- Disabled while validation is in-progress (shows `CircularProgress` size={20} inside button)
- Re-enabled after prompt text changes following a validation

**Conflict Highlighting:**
- Since MUI `TextField` (textarea) does not support inline highlighting, render a read-only `Box` with the prompt text containing highlighted `<span>` elements when conflicts are detected
- Highlighted spans use `sx={{ backgroundColor: 'error.light', opacity: 0.3, borderRadius: 1, px: 0.5 }}`
- Show this highlighted view below the editable TextField, inside the same Paper
- Each highlighted span is wrapped in a MUI `Tooltip` showing the conflicting counterpart text and explanation

**Warning Banner:**
- MUI `Alert` with `severity="warning"` and `variant="filled"`
- Shows: "⚠ {N} conflict(s) detected. Your prompt may cause degraded chatbot behavior."
- Non-dismissible while conflicts exist (no close icon)
- Persistent on page load if `conflict_metadata` is stored in DB

**Module Prompt Conflicts Section:**
- New `Paper` section below the course prompt editor with `Typography variant="h6"` header: "Module Prompt Conflicts"
- Each conflicting module rendered as a MUI `Accordion`:
  - `AccordionSummary`: module name (`Typography variant="subtitle1"`) + `Chip` showing conflict type (color: `error` for HARD_CONTRADICTION, `warning` for others)
  - `AccordionDetails`: two `Box` elements side-by-side showing the conflicting text excerpts (highlighted with `backgroundColor: 'error.light'`), plus `Typography variant="body2" color="text.secondary"` for the explanation
- Ordered by `module_number` ascending
- Hidden when no module conflicts exist

**Override Flow:**
- When conflicts are present, clicking "Save" opens a MUI `Dialog`
- `DialogTitle`: "Save with Conflicts?"
- `DialogContent` / `DialogContentText`: "You have {N} unresolved conflict(s). Saving may cause degraded chatbot behavior. Are you sure you want to proceed?"
- `DialogActions`: Button "Go Back" `variant="outlined"` + Button "Save Anyway" `variant="contained" color="error"`

**Loading State:**
- During validation: `CircularProgress` inside the "Check for Conflicts" button
- Conflict section shows `Typography variant="body2" color="text.secondary"`: "Validating prompts..."
- Save button remains enabled (per Req 6.6 — never block saving)

**Validation Unavailable:**
- When `validation_status === "validation_failed"`: show MUI `Alert` with `severity="info"`
- Text: "Conflict validation is temporarily unavailable. You can still save your prompt."
- No conflict highlights shown

**Confidence Filtering:**
- By default, only HIGH and MEDIUM confidence conflicts are shown
- A small `Button` with `size="small"` and `variant="text"` below the conflict list: "Show low-confidence conflicts ({N})"
- Clicking expands to include LOW confidence items displayed with reduced opacity (`sx={{ opacity: 0.7 }}`)

### State Management

```javascript
const [conflictReport, setConflictReport] = useState(null);     // Full Conflict_Report
const [isValidating, setIsValidating] = useState(false);         // Loading state
const [showLowConfidence, setShowLowConfidence] = useState(false); // Filter toggle
const [storedConflicts, setStoredConflicts] = useState(null);    // From DB on load
```

On page load, fetch `conflict_metadata` alongside the prompt (extend the existing `GET /instructor/get_prompt` response to include `conflict_metadata`). If non-null, display the persistent warning banner immediately.

---

## Error Handling

| Scenario | Behavior | Response |
|---|---|---|
| Bedrock timeout (>10s) | Retry once after 2s delay | If retry fails: `validation_failed` |
| Bedrock returns malformed JSON | Retry once after 2s | If retry fails: `validation_failed` |
| Bedrock returns valid JSON but wrong schema | Retry once | If retry fails: `validation_failed` |
| DB connection failure (fetching prompts) | No retry | Return `validation_failed`, allow save |
| Prompt is empty/whitespace | No Bedrock call | Return `validation_skipped` |
| Prompt exceeds 1000 chars | Allow up to 30s timeout | If timeout: `validation_failed` with length message |
| Single batch fails (multi-module) | Mark modules as unvalidated | Continue remaining batches, return `partial_results` |
| All batches fail | — | Return `validation_failed` |

### Logging

All errors use structured logging consistent with the project's Powertools-style pattern (Node.js zip Lambdas use `console.log` with structured JSON):

```javascript
console.log(JSON.stringify({
  level: "ERROR",
  service: "instructor-function",
  event: "validation_bedrock_timeout",
  course_id,
  scope,
  attempt: 2,
  duration_ms: 10000,
  error: err.message,
  timestamp: new Date().toISOString(),
}));
```

Override events are logged at INFO level:

```javascript
console.log(JSON.stringify({
  level: "INFO",
  service: "instructor-function",
  event: "validation_override",
  instructor_email,
  course_id,
  module_id: module_id || null,
  conflict_count: conflicts.length,
  conflict_types: conflicts.map(c => c.type),
  confidence_scores: conflicts.map(c => c.confidence),
  timestamp: new Date().toISOString(),
}));
```

Validation bypass events (saving without triggering validation):

```javascript
console.log(JSON.stringify({
  level: "INFO",
  service: "instructor-function",
  event: "validation_bypassed",
  instructor_email,
  course_id,
  timestamp: new Date().toISOString(),
}));
```

---

## Correctness Properties

### Property 1: Validation Never Blocks Save
The instructor can always save their prompt regardless of validation state (in-progress, failed, conflicts detected). The save control is never disabled due to validation.

### Property 2: Deterministic Conflict Detection
Given identical inputs (same system prompt, course prompt, module prompts) and the same model version, the Conflict_Checker produces structurally equivalent Conflict_Reports across repeated invocations (temperature 0 ensures this).

### Property 3: Hierarchy Immutability
The System_Level_Prompt is never modified by the validation process. Conflicts always identify the instructor's prompt as the offender when compared against the system prompt.

### Property 4: Graceful Degradation
If Bedrock is unavailable, the system degrades to allowing saves without validation (validation_status = "validation_failed"), never throwing unhandled errors or blocking the UI.

### Property 5: Conflict Metadata Consistency
Stored conflict_metadata is cleared (set to NULL) only when a validation returns clean AND the instructor saves. Stale metadata persists until explicitly cleared by a clean save.

### CDK Infrastructure Changes

#### Add Claude 3 Haiku to Bedrock Model Permissions

The existing `text_generation` Lambda already has Bedrock invoke permissions for Llama 70B, Claude 3 Sonnet, and Titan Embed. For the validation feature, add Claude 3 Haiku (`anthropic.claude-3-haiku-20240307-v1:0`) to the `dbLambdaRole`'s existing Bedrock policy statement. This model is confirmed available in ca-central-1 for in-region inference.

In `api-gateway-stack.ts`, extend the existing Bedrock InvokeModel resources array:

```
Resources: [
  "arn:aws:bedrock:{region}::foundation-model/meta.llama3-70b-instruct-v1:0",
  "arn:aws:bedrock:{region}::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
  "arn:aws:bedrock:{region}::foundation-model/amazon.titan-embed-text-v2:0",
  "arn:aws:bedrock:{region}::foundation-model/anthropic.claude-3-haiku-20240307-v1:0"  // NEW
]
```

Per IAM security policy: no action wildcards, specific model ARN only.

### SSM Parameter for Validation Model ID

Add a new SSM parameter to store the validation model identifier:

```
Parameter path: /AILA/{environment}/ValidationModelId
Value: "anthropic.claude-3-haiku-20240307-v1:0"
```

Pass to the instructorFunction as environment variable `VALIDATION_MODEL_ID`.

Add SSM read permission to `dbLambdaRole` scoped to this parameter path:

```
Actions: ["ssm:GetParameter"]
Resources: ["arn:aws:ssm:{region}:{account}:parameter/AILA/{environment}/ValidationModelId"]
```

This allows switching the validation model without redeploying the Lambda code.

### Environment Variable Addition

Add to the instructorFunction's environment:
- `VALIDATION_MODEL_ID` — resolved from SSM at deploy time (or read at runtime)
- `REGION` — for Bedrock client instantiation (already available in most Lambdas)

### No New Lambda

The validation logic lives inside the existing `instructorFunction` as a new route case. No new Lambda, no new API Gateway resource beyond the new route `/instructor/validate_prompt` with POST method.

### API Gateway Route

Add a new resource and POST method to the existing REST API under the `/instructor` resource:

```
POST /instructor/validate_prompt → instructorFunction (existing integration)
```

Uses the same authorizer as other instructor routes.

### IAM Test Addition

Add assertions to `cdk/test/iam-policies.test.ts`:

- Verify `dbLambdaRole` has `bedrock:InvokeModel` scoped to the four specific model ARNs (Llama 70B, Claude 3 Sonnet, Titan Embed, Claude 3 Haiku)
- Verify no `bedrock:*` action wildcards exist on any role
- Verify SSM access for the validation model parameter is scoped to the specific path

---

## Testing Strategy

| Requirement | Design Sections |
|---|---|
| **Req 1**: Validate Course Prompt vs System-Level | §3 (API), §4 (System Prompt Constant), §5 (LLM Prompt), §7 (Backend) |
| **Req 2**: Validate Module Prompt vs System + Course | §3 (API scope=module), §5 (LLM Prompt), §7 (Backend validateModulePrompt) |
| **Req 3**: Cross-Validate Course vs All Modules | §8 (Batch Validation), §5 (module_prompts_section in template) |
| **Req 4**: Visual Conflict Display | §9 (Frontend Design — highlighting, module conflicts section) |
| **Req 5**: Iterative Re-Validation | §9 (Frontend — re-enable button on edit, replace previous report) |
| **Req 6**: Advisory Override (Never Blocking) | §7 (conflict_metadata storage), §9 (Override Dialog, save always enabled) |
| **Req 7**: Persistent Conflict Warning | §6 (DB schema — conflict_metadata column), §9 (Alert on page load) |
| **Req 8**: Fast Validation Model + Determinism | §5 (temp 0), §7 (Bedrock call config), §11 (SSM param for model ID) |
| **Req 9**: Conflict Report Structured Output | §3 (Response schema), §5 (JSON output format in prompt), §7 (schema validation) |
| **Req 10**: Conflict Detection Accuracy | §5 (Classification anchors + confidence guidelines in prompt template) |

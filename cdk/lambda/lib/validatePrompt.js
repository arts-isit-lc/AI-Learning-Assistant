const { SYSTEM_LEVEL_PROMPT } = require("./constants/systemPrompt.js");
const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require("@aws-sdk/client-bedrock-runtime");

const VALIDATION_MODEL_ID =
  process.env.VALIDATION_MODEL_ID ||
  "anthropic.claude-3-haiku-20240307-v1:0";
const REGION = process.env.REGION || "ca-central-1";
const BEDROCK_TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 2000;
const BATCH_SIZE = 10;

const bedrockClient = new BedrockRuntimeClient({ region: REGION });

/**
 * Main entry point for prompt conflict validation.
 * @param {object} params
 * @param {string} params.prompt - The prompt text being validated
 * @param {string} params.scope - "course" or "module"
 * @param {string} params.course_id - The course UUID
 * @param {string} [params.module_id] - Module UUID (required if scope=module)
 * @param {object} params.sqlConnection - postgres.js tagged template connection
 * @returns {Promise<object>} Conflict_Report
 */
async function validatePrompt({ prompt, scope, course_id, module_id, sqlConnection }) {
  // Handle empty/whitespace prompts
  if (!prompt || !prompt.trim()) {
    return buildReport("validation_skipped", [], scope, "No validation performed: prompt is empty.");
  }

  if (scope === "course") {
    const modulePrompts = await fetchModulePrompts(course_id, sqlConnection);
    return await validateCoursePrompt(prompt, modulePrompts);
  } else {
    const coursePrompt = await fetchCoursePrompt(course_id, sqlConnection);
    return await validateModulePrompt(prompt, coursePrompt, module_id, sqlConnection);
  }
}

/**
 * Fetch all non-empty module prompts for a course, ordered by concept_number then module_number.
 */
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

/**
 * Fetch the course-level system_prompt for a given course.
 */
async function fetchCoursePrompt(course_id, sqlConnection) {
  const rows = await sqlConnection`
    SELECT system_prompt FROM "Courses" WHERE course_id = ${course_id};
  `;
  return rows[0]?.system_prompt || "";
}

/**
 * Validate a course prompt against the system prompt and all module prompts.
 * Batches module prompts in groups of BATCH_SIZE.
 */
async function validateCoursePrompt(coursePrompt, modulePrompts) {
  const allConflicts = [];
  const unvalidatedModules = [];

  // Step 1: Validate course prompt against system prompt (critical)
  try {
    const systemResult = await callBedrockValidation(
      buildLLMPrompt(coursePrompt, "", [], "course")
    );
    if (systemResult.conflicts && systemResult.conflicts.length > 0) {
      allConflicts.push(...systemResult.conflicts);
    }
  } catch (err) {
    console.log(JSON.stringify({
      level: "ERROR",
      service: "instructor-function",
      event: "validation_system_check_failed",
      error: err.message,
      timestamp: new Date().toISOString(),
    }));
    return buildReport("validation_failed", [], "course", "System prompt validation failed. You may save your prompt without validation.");
  }

  // Step 2: Validate course prompt against module prompts in batches
  if (modulePrompts.length > 0) {
    const batches = [];
    for (let i = 0; i < modulePrompts.length; i += BATCH_SIZE) {
      batches.push(modulePrompts.slice(i, i + BATCH_SIZE));
    }

    for (const batch of batches) {
      try {
        const batchResult = await callBedrockValidation(
          buildLLMPrompt(coursePrompt, "", batch, "course")
        );
        if (batchResult.conflicts && batchResult.conflicts.length > 0) {
          allConflicts.push(...batchResult.conflicts);
        }
      } catch (err) {
        console.log(JSON.stringify({
          level: "WARNING",
          service: "instructor-function",
          event: "validation_batch_failed",
          modules: batch.map((m) => m.module_name),
          error: err.message,
          timestamp: new Date().toISOString(),
        }));
        for (const mod of batch) {
          unvalidatedModules.push({
            module_name: mod.module_name,
            reason: err.message || "Batch validation timeout",
          });
        }
      }
    }
  }

  // Determine status
  const hasConflicts = allConflicts.length > 0;
  const hasUnvalidated = unvalidatedModules.length > 0;

  let status = "clean";
  if (hasConflicts && hasUnvalidated) status = "partial_results";
  else if (hasConflicts) status = "conflicts_found";
  else if (hasUnvalidated) status = "partial_results";

  const summary = hasConflicts
    ? `${allConflicts.length} conflict(s) found.`
    : hasUnvalidated
      ? `No conflicts in validated modules. ${unvalidatedModules.length} module(s) could not be validated.`
      : "No conflicts detected. All prompts are consistent with the hierarchy.";

  return {
    validation_status: status,
    conflicts: allConflicts,
    ...(hasUnvalidated && { unvalidated_modules: unvalidatedModules }),
    summary,
    has_conflicts: hasConflicts,
    validated_at: new Date().toISOString(),
    validation_scope: "course",
    model_version: VALIDATION_MODEL_ID,
  };
}

/**
 * Validate a module prompt against the system prompt and course prompt.
 */
async function validateModulePrompt(modulePrompt, coursePrompt, module_id, sqlConnection) {
  // Get module name for reporting
  let moduleName = "Unknown Module";
  try {
    const rows = await sqlConnection`
      SELECT module_name FROM "Course_Modules" WHERE module_id = ${module_id};
    `;
    if (rows[0]) moduleName = rows[0].module_name;
  } catch (err) {
    // Non-critical, continue with unknown name
  }

  try {
    const modulePromptFormatted = [{ module_name: moduleName, module_prompt: modulePrompt, module_number: 0 }];
    const result = await callBedrockValidation(
      buildLLMPrompt("", coursePrompt, modulePromptFormatted, "module")
    );

    const conflicts = result.conflicts || [];
    const hasConflicts = conflicts.length > 0;

    return {
      validation_status: hasConflicts ? "conflicts_found" : "clean",
      conflicts,
      summary: result.summary || (hasConflicts
        ? `${conflicts.length} conflict(s) found.`
        : "No conflicts detected. All prompts are consistent with the hierarchy."),
      has_conflicts: hasConflicts,
      validated_at: new Date().toISOString(),
      validation_scope: "module",
      model_version: VALIDATION_MODEL_ID,
    };
  } catch (err) {
    console.log(JSON.stringify({
      level: "ERROR",
      service: "instructor-function",
      event: "validation_module_failed",
      module_id,
      error: err.message,
      timestamp: new Date().toISOString(),
    }));
    return buildReport("validation_failed", [], "module", "Validation is temporarily unavailable. You may save your prompt without validation.");
  }
}

/**
 * Build the full LLM prompt from the template.
 */
function buildLLMPrompt(editedPrompt, coursePrompt, modulePrompts, scope) {
  let modulePromptsSection = "None provided.";

  if (modulePrompts.length > 0) {
    modulePromptsSection = modulePrompts
      .map((m) => `Module (module_name: "${m.module_name}"):\n${m.module_prompt}`)
      .join("\n\n");
  }

  // For course scope: the editedPrompt IS the course prompt
  // For module scope: the editedPrompt is inside modulePrompts, coursePrompt is separate
  const effectiveCoursePrompt = scope === "course" ? editedPrompt : (coursePrompt || "None provided.");

  return `You are a prompt conflict analyzer for an educational AI system. Your job is to identify semantic contradictions between prompts in a strict hierarchy.

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
- MEDIUM (0.5-0.8): Implicit tension or likely-but-not-certain contradiction
- LOW (<0.5): Possible tension but ambiguous; could be complementary

## Inputs:

### SYSTEM_LEVEL_PROMPT:
${SYSTEM_LEVEL_PROMPT}

### COURSE_PROMPT:
${effectiveCoursePrompt}

### MODULE_PROMPTS:
${modulePromptsSection}

## Task:
Analyze the ${scope} prompt against all higher-level prompts (and lower-level prompts if scope is "course"). For each genuine conflict found, extract the specific conflicting text from each prompt (max 500 chars each).

## Output Format:
Respond with ONLY valid JSON matching this exact schema — no markdown, no explanation outside the JSON:

{
  "conflicts": [
    {
      "type": "HARD_CONTRADICTION | BEHAVIORAL_INCOMPATIBILITY | CONSTRAINT_COLLISION | HIERARCHY_VIOLATION",
      "confidence": 0.0,
      "prompt_a_source": "system_level_prompt | course_prompt | module_prompt:module_name",
      "prompt_b_source": "system_level_prompt | course_prompt | module_prompt:module_name",
      "prompt_a_text": "exact conflicting excerpt from prompt A (max 500 chars)",
      "prompt_b_text": "exact conflicting excerpt from prompt B (max 500 chars)",
      "dominant_source": "system_level_prompt | course_prompt",
      "explanation": "plain-language explanation of why these conflict (max 300 chars)"
    }
  ],
  "summary": "brief overall summary (max 300 chars)"
}

If no conflicts exist, return: {"conflicts": [], "summary": "No conflicts detected. All prompts are consistent with the hierarchy."}`;
}

/**
 * Call Bedrock Claude Haiku with the validation prompt. Includes timeout and retry logic.
 */
async function callBedrockValidation(llmPrompt) {
  const invokeWithTimeout = async () => {
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
      const response = await bedrockClient.send(command, {
        abortSignal: controller.signal,
      });
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
    // Retry once after delay
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      const result = await invokeWithTimeout();
      validateSchema(result);
      return result;
    } catch (secondErr) {
      throw new Error(
        `Validation failed after retry: ${secondErr.message}`
      );
    }
  }
}

/**
 * Validate that the LLM response conforms to the expected Conflict_Report schema.
 */
function validateSchema(result) {
  if (!result || typeof result !== "object") {
    throw new Error("Response is not a valid JSON object");
  }
  if (!Array.isArray(result.conflicts)) {
    throw new Error("Response missing 'conflicts' array");
  }
  const validTypes = [
    "HARD_CONTRADICTION",
    "BEHAVIORAL_INCOMPATIBILITY",
    "CONSTRAINT_COLLISION",
    "HIERARCHY_VIOLATION",
  ];
  for (const conflict of result.conflicts) {
    const requiredFields = [
      "type",
      "confidence",
      "prompt_a_source",
      "prompt_b_source",
      "prompt_a_text",
      "prompt_b_text",
      "dominant_source",
      "explanation",
    ];
    for (const field of requiredFields) {
      if (!(field in conflict)) {
        throw new Error(`Conflict missing required field: ${field}`);
      }
    }
    if (!validTypes.includes(conflict.type)) {
      throw new Error(`Invalid conflict type: ${conflict.type}`);
    }
    if (
      typeof conflict.confidence !== "number" ||
      conflict.confidence < 0 ||
      conflict.confidence > 1
    ) {
      throw new Error(`Invalid confidence score: ${conflict.confidence}`);
    }
  }
}

/**
 * Build a standard Conflict_Report response object.
 */
function buildReport(status, conflicts, scope, summary) {
  return {
    validation_status: status,
    conflicts,
    summary,
    has_conflicts: conflicts.length > 0,
    validated_at: new Date().toISOString(),
    validation_scope: scope,
    model_version: VALIDATION_MODEL_ID,
  };
}

module.exports = { validatePrompt };

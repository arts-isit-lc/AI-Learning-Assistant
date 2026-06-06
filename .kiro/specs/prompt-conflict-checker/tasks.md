# Implementation Plan:

## Overview

Implement the Prompt Conflict Checker feature that validates instructor prompts against the system-level prompt and each other, showing conflicting text with explanations in the PromptSettings UI. Uses Claude 3 Haiku via Bedrock for fast conflict detection.

## Tasks

- [ ] 1. Extract System-Level Prompt to Shared Constants: Create `cdk/lambda/lib/constants/systemPrompt.js` with the SYSTEM_LEVEL_PROMPT constant exported. Create `cdk/text_generation/src/constants/system_prompt.py` with the same text. Update `chat.py` `get_response_streaming()` to import from the new constant instead of inline string. Add maintenance constraint comments in both files. Verify with `npx tsc --noEmit`. (Req 1, Req 2)
- [ ] 2. Database Schema — Add conflict_metadata Columns: Add migration logic to `cdk/lambda/initializer/initializer.py` to add `conflict_metadata jsonb DEFAULT NULL` column to the `Courses` table following existing column-addition pattern with EXISTS check. Add same column to `Course_Modules` table. Ensure idempotent migration. (Req 6.5, Req 7)
- [ ] 3. CDK — Add Claude 3 Haiku to Bedrock Permissions and SSM Parameter: In `api-gateway-stack.ts`, add `anthropic.claude-3-haiku-20240307-v1:0` to existing Bedrock InvokeModel resources array. Create SSM StringParameter `/AILA/${environment}/ValidationModelId`. Add `VALIDATION_MODEL_ID` env var to instructorFunction. Add scoped SSM read permission. Add `POST /instructor/validate_prompt` route to OpenAPI definition. Run `npx tsc --noEmit`. (Req 8, Req 9)
- [ ] 4. Backend — Create validatePrompt.js Module: Create `cdk/lambda/lib/validatePrompt.js` with functions: validatePrompt (main entry), fetchModulePrompts, fetchCoursePrompt, buildLLMPrompt (from design template), callBedrockValidation (InvokeModelCommand, temp 0, max_tokens 4096), validateSchema. Implement 10s timeout with AbortController and single retry after 2s delay. Handle empty prompts as validation_skipped. (Req 1, Req 2, Req 8, Req 9, Req 10)
- [ ] 5. Backend — Batch Validation Logic for Course-Scope: Implement validateCoursePrompt in validatePrompt.js — first validates course vs system prompt, then chunks modules into batches of 10, processes sequentially, marks failed batches as unvalidated. Implement validateModulePrompt — validates against system prompt and course prompt. Order conflicts by module_number ascending. Build Conflict_Report with correct validation_status. (Req 3, Req 9)
- [ ] 6. Backend — Add Route Handler to instructorFunction.js: Add `case "POST /instructor/validate_prompt":` with input validation (course_id, instructor_email, prompt, scope, module_id). Import and call validatePrompt(). Return validation_failed on unrecoverable error (never 500). Add structured logging. (Req 1, Req 2, Req 8.4)
- [ ] 7. Backend — Modify PUT /instructor/prompt for Conflict Metadata Storage: Modify existing PUT to accept optional conflict_metadata in body. Update SQL to include conflict_metadata column. Log override events at INFO level. Modify GET /instructor/get_prompt to return conflict_metadata. Modify PUT /instructor/edit_module similarly for module-level. (Req 6.4, Req 6.5, Req 7)
- [ ] 8. Frontend — Add Check for Conflicts Button and API Call: Add state (conflictReport, isValidating, showLowConfidence, storedConflicts) to PromptSettings.jsx. Add MUI Button variant="outlined" next to Save. Implement handleValidate() calling POST /instructor/validate_prompt. Show CircularProgress during validation. Read conflict_metadata on page load from get_prompt response. (Req 5.1, Req 5.2, Req 7.3)
- [ ] 9. Frontend — Display Conflict Highlights and Warning Banner: Render read-only Box with highlighted spans (backgroundColor error.light) when conflicts exist. Wrap spans in MUI Tooltip with counterpart text and explanation. Show non-dismissible Alert severity="warning" with conflict count. Show persistent Alert on page load from stored conflicts. Show Alert severity="info" when validation_failed. Filter LOW confidence by default with toggle button. (Req 4.1, Req 4.2, Req 7.1, Req 8.4, Req 10.5)
- [ ] 10. Frontend — Module Prompt Conflicts Section: Add Paper section below course prompt with "Module Prompt Conflicts" header. Filter conflicts for module_prompt sources. Render MUI Accordion per module (AccordionSummary with name + Chip for type, AccordionDetails with excerpts + explanation). Order by module_number. Hide when no module conflicts. (Req 4.3, Req 4.4, Req 4.5, Req 4.6)
- [ ] 11. Frontend — Override Flow and Save Behavior: Modify handleSave() to check for unresolved conflicts. Show MUI Dialog with override confirmation. On "Save Anyway" include conflict_metadata in PUT body. On clean save send conflict_metadata null. Keep Save button always enabled. Clear persistent warning on clean re-validation + save. (Req 6.1, Req 6.2, Req 6.3, Req 6.6, Req 7.2)
- [ ] 12. CDK Tests — IAM Policy Assertions for Haiku Model: Add assertions to iam-policies.test.ts verifying dbLambdaRole has bedrock:InvokeModel scoped to four model ARNs (Llama 70B, Claude 3 Sonnet, Titan Embed, Claude 3 Haiku). Verify no bedrock:* wildcards. Verify scoped SSM GetParameter for ValidationModelId. Run npm test. (Req 8, IAM Security Policy)

## Task Dependency Graph

```json
{
  "waves": [
    [1, 2, 3],
    [4, 12],
    [5],
    [6],
    [7],
    [8],
    [9],
    [10],
    [11]
  ]
}
```

## Notes

- Tasks 1, 2, 3 can be done in parallel (no dependencies between them)
- Tasks 4-6 are sequential (each builds on the previous)
- Task 7 depends on Task 2 (DB columns must exist) and Task 6 (route handler context)
- Tasks 8-11 are sequential frontend work, all depend on Task 7 (backend API must be complete)
- Task 12 depends on Task 3 (CDK changes must be in place to test)
- Claude 3 Haiku model ID: `anthropic.claude-3-haiku-20240307-v1:0` (confirmed available in ca-central-1)

# Requirements Document

## Introduction

The AI Learning Assistant allows instructors to customize chatbot behavior through course-level and module-level prompts. These prompts are concatenated with fixed system-level instructions (Socratic method, stay on topic, do not summarize readings, completion criteria) to form the final system prompt sent to the LLM. Currently, no validation exists to detect conflicts between instructor-written prompts and the system-level instructions or between course and module prompts. When conflicts exist, the LLM receives contradictory instructions and behavior degrades silently. This feature introduces a prompt conflict detection system that validates instructor prompts, identifies conflicting text with explanations, and supports an iterative advisory workflow while never blocking the instructor from saving.

## Glossary

- **Conflict_Checker**: The backend service component that uses an LLM to analyze prompts for conflicts. It exposes a single validation function parameterized by scope (course-level or module-level)
- **System_Level_Prompt**: The fixed, hardcoded instructions in `chat.py` that define core chatbot behavior (Socratic method, stay on topic, do not summarize readings, completion criteria). This is the immutable single source of truth that instructor prompts must not contradict. The System_Level_Prompt is strictly non-overridable: any instruction at course or module level that contradicts it is always classified as a conflict, regardless of intent or framing
- **Prompt_Hierarchy**: The strict precedence order: System_Level_Prompt > Course_Prompt > Module_Prompt. A lower-level prompt cannot weaken, override, or negate constraints established by a higher-level prompt. Conflicts are always resolved in favor of the higher-level prompt
- **Course_Prompt**: The instructor-written prompt stored in the `system_prompt` column of the `Courses` table, applied to all modules in a course
- **Module_Prompt**: The instructor-written prompt stored in the `module_prompt` column of the `Course_Modules` table, applied to a specific module
- **Conflict**: A semantic contradiction between two prompts, classified into one of four types: HARD_CONTRADICTION, BEHAVIORAL_INCOMPATIBILITY, CONSTRAINT_COLLISION, or HIERARCHY_VIOLATION
- **HARD_CONTRADICTION**: A direct logical negation where one prompt instructs the LLM to do something that another prompt explicitly prohibits (e.g., "Always summarize readings" vs "Do not summarize readings"). Classification anchor: one prompt uses "must", "always", or "never" and the other uses the opposite directive on the same behavior
- **BEHAVIORAL_INCOMPATIBILITY**: A conflict where two prompts enforce incompatible interaction modes that cannot both be dominant (e.g., "Give direct explanations" vs "Only respond with Socratic questions")
- **CONSTRAINT_COLLISION**: A conflict where output rules from two prompts cannot be satisfied simultaneously (e.g., "max 3 sentences" vs "always include explanation + reasoning + question")
- **HIERARCHY_VIOLATION**: A conflict where a lower-level prompt (module or course) explicitly overrides or contradicts a higher-level prompt's rules
- **Validation_Request**: A request sent to the Conflict_Checker containing the prompt being edited, its scope (course or module), and identifiers for fetching all related prompts
- **Validation_Status**: An enum indicating the outcome of a validation request. Values: `clean` (validation completed, no conflicts found), `conflicts_found` (validation completed, one or more conflicts detected), `validation_failed` (Validation_Model unavailable or errored after retry), `validation_skipped` (prompt was empty or validation was not triggered), `partial_results` (some batches succeeded but others failed during cross-validation)
- **Conflict_Report**: The structured JSON response from the Conflict_Checker containing identified conflicts with the specific conflicting text extracted from each prompt, a plain-language explanation of why they conflict, and a Validation_Status indicating the outcome category
- **Confidence_Score**: A numeric value between 0.0 and 1.0 indicating the Conflict_Checker's certainty that a detected conflict is a genuine contradiction. HIGH (above 0.8), MEDIUM (0.5 to 0.8), LOW (below 0.5)
- **Override**: The action of an instructor saving a prompt despite known conflicts, after acknowledging the warning
- **Validation_Model**: A fast, inexpensive LLM (Haiku-class) used exclusively for conflict detection calls at temperature 0, separate from the main conversational model
- **Prompt_Editor_UI**: The frontend interface where instructors write and edit course-level or module-level prompts (PromptSettings.jsx, InstructorNewModule.jsx, InstructorEditCourse.jsx)
- **Batch_Validation_Rule**: The shared execution constraint for cross-validation of multiple prompts. Batch size = 10 prompts per LLM call. Max time per batch = 10 seconds. Total max time for all batches = 60 seconds. On batch failure (timeout or model error): mark affected prompts as unvalidated with failure reason, continue processing remaining batches, set Validation_Status to `partial_results`

## Requirements

### Requirement 1: Validate Course Prompt Against System-Level Prompt

**User Story:** As an instructor, I want to know when my course-level prompt conflicts with the system-level instructions, so that I can fix contradictions before they cause degraded chatbot behavior.

#### Acceptance Criteria

1. WHEN an instructor submits a Course_Prompt for validation, THE Conflict_Checker SHALL compare the Course_Prompt against the System_Level_Prompt and return a Conflict_Report within 10 seconds for prompts up to 1000 characters in length
2. WHEN the Conflict_Checker identifies one or more conflicts between the Course_Prompt and the System_Level_Prompt, THE Conflict_Report SHALL include all detected conflicts, where each conflict entry contains the conflict type (HARD_CONTRADICTION, BEHAVIORAL_INCOMPATIBILITY, CONSTRAINT_COLLISION, or HIERARCHY_VIOLATION), the specific conflicting text extracted from the Course_Prompt, the specific conflicting text extracted from the System_Level_Prompt, a plain-language explanation of why these two excerpts conflict (at most 300 characters), a Confidence_Score, and `dominant_source` set to "system_level_prompt"
3. WHEN the Conflict_Checker identifies no conflicts between the Course_Prompt and the System_Level_Prompt, THE Conflict_Report SHALL indicate that no conflicts were found with an empty conflicts array and Validation_Status set to `clean`
4. IF an instructor submits a Course_Prompt that is empty or contains only whitespace, THEN THE Conflict_Checker SHALL return a Conflict_Report with an empty conflicts array, Validation_Status set to `validation_skipped`, and a summary indicating that no validation was performed due to empty input

### Requirement 2: Validate Module Prompt Against System-Level Prompt and Course Prompt

**User Story:** As an instructor, I want to know when my module-level prompt conflicts with the system-level instructions or the course prompt, so that I can maintain consistency across the prompt hierarchy.

#### Acceptance Criteria

1. WHEN an instructor submits a Module_Prompt for validation, THE Conflict_Checker SHALL compare the Module_Prompt against both the System_Level_Prompt and the Course_Prompt for the parent course and return a Conflict_Report within 10 seconds
2. WHEN the Conflict_Checker identifies a conflict between the Module_Prompt and the System_Level_Prompt, THE Conflict_Report SHALL include the conflict type, a Confidence_Score, the specific conflicting text from the Module_Prompt, the specific conflicting text from the System_Level_Prompt, a plain-language explanation of why they conflict, and `dominant_source` set to "system_level_prompt"
3. WHEN the Conflict_Checker identifies a conflict between the Module_Prompt and the Course_Prompt, THE Conflict_Report SHALL include the conflict type, a Confidence_Score, the specific conflicting text from each prompt, a plain-language explanation of why they conflict, and `dominant_source` set to "course_prompt" (per Prompt_Hierarchy)
4. WHEN the Conflict_Checker identifies no conflicts between the Module_Prompt and either the System_Level_Prompt or the Course_Prompt, THE Conflict_Report SHALL indicate that no conflicts were found with an empty conflicts array, `has_conflicts` set to false, and Validation_Status set to `clean`
5. IF the parent course has no Course_Prompt (empty or null), THEN THE Conflict_Checker SHALL validate the Module_Prompt against the System_Level_Prompt only and skip the Course_Prompt comparison

### Requirement 3: Cross-Validate Course Prompt Against All Module Prompts

**User Story:** As an instructor, I want to know when my course-level prompt conflicts with any of the module prompts in that course, so that I can resolve inconsistencies across the entire course.

#### Acceptance Criteria

1. WHEN an instructor submits a Course_Prompt for validation, THE Conflict_Checker SHALL compare the Course_Prompt against every Module_Prompt in the same course, following the Batch_Validation_Rule for execution constraints
2. WHEN the Conflict_Checker identifies a conflict between the Course_Prompt and one or more Module_Prompts, THE Conflict_Report SHALL list each conflicting Module_Prompt by module name, include the conflict type, Confidence_Score, the specific conflicting text from each prompt, a plain-language explanation of why they conflict, and `dominant_source` indicating which prompt takes precedence per the Prompt_Hierarchy
3. THE Conflict_Report SHALL order conflicts by module_number ascending, providing a deterministic ordering across repeated validations of identical inputs
4. IF any batch fails during cross-validation, THE Conflict_Checker SHALL mark the affected modules as unvalidated in the report with the failure reason, continue processing remaining batches, and set Validation_Status to `partial_results`
5. IF the course contains zero Module_Prompts, THEN THE Conflict_Checker SHALL return a Conflict_Report with an empty conflicts array, Validation_Status set to `clean`, and a summary indicating no module prompts exist to validate against

### Requirement 4: Visual Conflict Display on Settings Page

**User Story:** As an instructor, I want to see conflicting parts of my prompts highlighted directly in the settings page with clear explanations, so that I can quickly understand what needs to change.

#### Acceptance Criteria

1. WHEN the Conflict_Report for a Course_Prompt contains one or more conflicts, THE Prompt_Editor_UI SHALL visually highlight the specific conflicting text within the Course_Prompt text field (e.g., inline background highlight or underline) so the instructor can see exactly which part of their prompt is problematic
2. FOR each highlighted conflict in the Course_Prompt, THE Prompt_Editor_UI SHALL display a tooltip or inline annotation showing the corresponding conflicting text from the System_Level_Prompt and the plain-language explanation of why they conflict
3. BELOW the Course_Prompt editor on the PromptSettings page, THE Prompt_Editor_UI SHALL display a "Module Prompt Conflicts" section listing every Module_Prompt in the course that conflicts with either the System_Level_Prompt or the Course_Prompt
4. FOR each conflicting Module_Prompt shown in the "Module Prompt Conflicts" section, THE Prompt_Editor_UI SHALL display: the module name, the specific conflicting text from the Module_Prompt (highlighted), the specific text it conflicts with (from the System_Level_Prompt or Course_Prompt), the conflict type, and the plain-language explanation
5. WHEN no Module_Prompts in the course have conflicts, THE "Module Prompt Conflicts" section SHALL either be hidden or display a message indicating all module prompts are consistent
6. THE "Module Prompt Conflicts" section SHALL order modules by module_number ascending, grouping conflicts per module so the instructor can address them one module at a time

### Requirement 5: Iterative Re-Validation

**User Story:** As an instructor, I want to edit my prompt and re-validate it after seeing conflicts, so that I can iteratively refine my prompt until it is conflict-free.

#### Acceptance Criteria

1. WHEN an instructor modifies a prompt after receiving a Conflict_Report, THE Prompt_Editor_UI SHALL enable the validation trigger control, allowing the instructor to submit the modified prompt for a new validation without restriction on the number of re-validation attempts
2. WHEN a re-validation is triggered, THE Prompt_Editor_UI SHALL display a loading indicator and disable the validation trigger control until the Conflict_Checker responds or the 10-second timeout elapses
3. WHEN a re-validation is triggered, THE Conflict_Checker SHALL perform the same full validation as the initial request using the same validation scope (course or module) and return an updated Conflict_Report that replaces the previous Conflict_Report in the UI
4. WHEN a re-validation finds no conflicts (Validation_Status = `clean`), THE Prompt_Editor_UI SHALL remove any previously displayed conflict highlights and the "Module Prompt Conflicts" section, and display a visible confirmation indicating all prompts are consistent
5. IF a re-validation returns one or more conflicts, THEN THE Prompt_Editor_UI SHALL update the highlighted conflicts in the Course_Prompt and the "Module Prompt Conflicts" section, replacing the previous report entirely

### Requirement 6: Advisory Override (Never Blocking)

**User Story:** As an instructor, I want to save my prompt even when conflicts are detected, so that I am never blocked from customizing my course.

#### Acceptance Criteria

1. WHILE a Conflict_Report indicates one or more conflicts, THE Prompt_Editor_UI SHALL display a visible warning banner stating the number of detected conflicts and that the prompt may cause degraded chatbot behavior
2. WHILE a Conflict_Report indicates one or more conflicts, THE Prompt_Editor_UI SHALL allow the instructor to save the prompt by activating a separate confirmation control distinct from the primary save control, requiring a single explicit acknowledgment before the save executes
3. THE Prompt_Editor_UI SHALL allow the instructor to save a prompt without triggering validation at all, and WHEN validation is bypassed, THE backend SHALL store Validation_Status as `validation_skipped` and log the event as "validation_bypassed"
4. WHEN an instructor saves a prompt without resolving conflicts, THE backend SHALL log the override event including: instructor email, course ID, module ID (if applicable), timestamp, number of conflicts ignored, conflict types and confidence scores
5. WHEN an instructor saves a prompt without resolving conflicts, THE backend SHALL store the conflict metadata alongside the prompt so that the persistent warning state can be retrieved on subsequent page loads
6. WHILE validation is in progress, THE Prompt_Editor_UI SHALL keep the save control enabled so that the instructor can save the prompt at any time without waiting for validation to complete

### Requirement 7: Persistent Conflict Warning

**User Story:** As an instructor, I want to see a persistent warning on prompts that were saved with known conflicts, so that I am reminded to revisit and fix them.

#### Acceptance Criteria

1. WHEN an instructor opens a Prompt_Editor_UI for a prompt that was previously saved with an override, THE Prompt_Editor_UI SHALL display a non-dismissible warning banner that includes the number of stored unresolved conflicts and their conflict types, and SHALL remain visible while the editor is open regardless of scrolling or other user interactions
2. WHEN an instructor triggers re-validation and the resulting Conflict_Report has Validation_Status = `clean`, and the instructor saves the prompt, THE Prompt_Editor_UI SHALL remove the persistent warning banner and clear the stored conflict metadata
3. THE Prompt_Editor_UI SHALL display a re-validate button on any prompt that has stored conflict metadata, allowing the instructor to trigger a new validation to check whether conflicts still exist
4. IF an instructor triggers re-validation on a previously overridden prompt and the resulting Conflict_Report still contains one or more HIGH or MEDIUM confidence conflicts, THEN THE Prompt_Editor_UI SHALL update the warning banner to reflect the current conflict count and types from the new Conflict_Report and update the stored conflict metadata

### Requirement 8: Use Fast Validation Model and Deterministic Output

**User Story:** As a system operator, I want conflict detection to use a fast, inexpensive LLM model with deterministic structured output, so that validation is responsive, cost-effective, and consistent.

#### Acceptance Criteria

1. THE Conflict_Checker SHALL use the Validation_Model (Haiku-class) at temperature 0 for all conflict detection calls
2. THE Conflict_Checker SHALL complete a single validation request within 10 seconds for prompts where the edited prompt is up to 1000 characters in length
3. IF the edited prompt exceeds 1000 characters, THEN THE Conflict_Checker SHALL either complete validation within 30 seconds or return a Conflict_Report with Validation_Status = `validation_failed` and a summary indicating that the prompt exceeds the supported length for timely validation, and allow the instructor to save without validation
4. IF the Validation_Model is unavailable or returns an error, THEN THE Conflict_Checker SHALL retry the request once after a 2-second delay, and if the retry also fails, return a Conflict_Report with Validation_Status = `validation_failed`, an empty conflicts array, and a summary indicating validation is temporarily unavailable. THE Prompt_Editor_UI SHALL display a visible "Validation unavailable" indicator when this occurs
5. THE Conflict_Checker SHALL return responses in a structured JSON schema conforming to the Conflict_Report format, producing structurally equivalent Conflict_Reports (same conflicts array entries, types, and confidence scores) for identical inputs and model version across repeated invocations
6. THE Conflict_Report SHALL include a `model_version` field containing the Validation_Model identifier used for the validation call, enabling reproducibility tracking across model updates

### Requirement 9: Conflict Report Structured Output Format

**User Story:** As a frontend developer, I want the Conflict_Report to follow a defined JSON schema, so that the UI can reliably parse and display conflict information.

#### Acceptance Criteria

1. THE Conflict_Checker SHALL return a Conflict_Report conforming to this structure: an object with `validation_status` (one of: "clean", "conflicts_found", "validation_failed", "validation_skipped", "partial_results"); a `conflicts` array (each entry containing `type` as one of HARD_CONTRADICTION, BEHAVIORAL_INCOMPATIBILITY, CONSTRAINT_COLLISION, or HIERARCHY_VIOLATION; `confidence` as a numeric value between 0.0 and 1.0; `prompt_a_source` and `prompt_b_source` each as one of "system_level_prompt", "course_prompt", or "module_prompt:{module_name}"; `prompt_a_text` and `prompt_b_text` as strings of at most 500 characters each containing the specific conflicting excerpt; `dominant_source` as one of "system_level_prompt" or "course_prompt"; and `explanation` as a plain-language string of at most 300 characters explaining why the two excerpts conflict); a `summary` string of at most 300 characters; a `has_conflicts` boolean; a `validated_at` ISO 8601 UTC timestamp; a `validation_scope` field set to either "course" or "module"; and a `model_version` string
2. WHEN Validation_Status is `clean` or `validation_skipped`, THE Conflict_Report SHALL return an empty `conflicts` array, `has_conflicts` set to false, and a `summary` string stating the appropriate status message
3. WHEN Validation_Status is `validation_failed`, THE Conflict_Report SHALL return an empty `conflicts` array, `has_conflicts` set to false, and a `summary` explaining why validation could not be completed
4. WHEN Validation_Status is `partial_results`, THE Conflict_Report SHALL include an `unvalidated_modules` array listing module names and failure reasons for modules that could not be validated
5. IF the Conflict_Checker produces a response that does not conform to the defined JSON schema, THEN THE Conflict_Checker SHALL retry the generation once, and if the retry also fails, return a response with Validation_Status = `validation_failed`, an empty `conflicts` array, and a `summary` indicating that validation could not be completed due to a formatting error

### Requirement 10: Conflict Detection Accuracy

**User Story:** As an instructor, I want the conflict detection to identify genuine contradictions without excessive false positives, so that I can trust the validation results.

#### Acceptance Criteria

1. THE Conflict_Checker SHALL classify each detected conflict into exactly one type: HARD_CONTRADICTION, BEHAVIORAL_INCOMPATIBILITY, CONSTRAINT_COLLISION, or HIERARCHY_VIOLATION. IF a detected conflict cannot be classified into exactly one type, THEN THE Conflict_Checker SHALL assign the type with the highest Confidence_Score and include the alternative classification in the explanation field
2. THE Conflict_Checker SHALL assign a Confidence_Score between 0.0 and 1.0 (inclusive) to each detected conflict, where HIGH confidence is above 0.8, MEDIUM confidence is 0.5 to 0.8, and LOW confidence is below 0.5
3. THE Conflict_Checker SHALL classify an instruction as complementary (not a conflict) when it adds constraints, topics, or behaviors that do not negate, prohibit, or make impossible any instruction in the compared prompt, and SHALL report only instructions that negate, prohibit, or make simultaneously impossible another instruction
4. THE Conflict_Checker SHALL apply the following classification anchor for HARD_CONTRADICTION: if one prompt uses imperative language ("must", "always", "never", "do not") and another prompt uses the opposite directive on the same behavior or topic, it SHALL be classified as HARD_CONTRADICTION with HIGH confidence
5. THE Prompt_Editor_UI SHALL display only HIGH and MEDIUM confidence conflicts by default, with an option to show LOW confidence conflicts

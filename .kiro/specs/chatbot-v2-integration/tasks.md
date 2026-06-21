# Implementation Plan: Chatbot V2 Integration

## Overview

Implement a new Docker-based Lambda function (`chatbotV2Function`) that combines the V2 multimodal RAG retrieval pipeline with a structured learning conversation engine. The implementation follows a pure-logic-first approach: build and test state management, concept tracking, evaluation parsing, mode selection, and prompt construction without AWS dependencies, then layer in AWS integration modules (retrieval, streaming, guardrails, history), wire the handler, and finally deploy via CDK infrastructure.

Key architectural principles: completion is engagement-based (interaction count + concept coverage + engagement score), mastery is a separate analytics layer, stages drive conversation depth not gating, and the application controls all decisions while the LLM generates constrained natural language.

## Tasks

- [x] 1. Set up project structure and core data models
  - [x] 1.1 Create directory structure and boilerplate files
    - Create `cdk/chatbot_v2/` directory with `Dockerfile`, `requirements.txt`, and `src/` subdirectory
    - Create `src/constants/` directory with `modes.py` and `models.py`
    - Populate `requirements.txt` with: boto3, botocore, psycopg2-binary, httpx, aws-xray-sdk, aws-lambda-powertools
    - Populate `Dockerfile` per the design (Python 3.11 base, postgresql-devel build deps, multi-stage cleanup)
    - Populate `src/constants/models.py` with RESPONSE_MODEL_ID, RESPONSE_MAX_TOKENS, EVAL_MODEL_ID, EVAL_MAX_TOKENS, MIN_INTERACTIONS_FOR_COMPLETION, MIN_CONCEPTS_DISCUSSED_FOR_COMPLETION, MIN_ENGAGEMENT_SCORE_FOR_COMPLETION, ENGAGEMENT_CORRECT_INCREMENT, ENGAGEMENT_PARTIAL_WITH_CONCEPTS_INCREMENT, ENGAGEMENT_SCORE_CAP, MASTERY_DEMONSTRATION_RATIO
    - _Requirements: 1.1, 1.5_

  - [x] 1.2 Implement SessionState, ConceptProgress, and EvaluationResult data models
    - Create `src/state_machine.py` with `ConceptProgress` dataclass (level, exposures, demonstrations) and `SessionState` dataclass (all fields per design: session_id, stage, module_complete, completion_message_sent, interactions, engagement_score, concept_progress map, concepts_exposed, concepts_discussed, concepts_demonstrated, module_concepts, correct_count, partial_count, incorrect_count, consecutive_failures, consecutive_correct, hint_level, hint_count, state_version)
    - Define `Stage` and `ConceptLevel` type aliases
    - Create `src/evaluation.py` with `EvaluationResult` dataclass (correct, partial, confidence, concepts_demonstrated, concepts_misunderstood) and `DEFAULT_EVALUATION` constant
    - Implement `create_default_state(session_id)` returning initial state with all zeros, empty maps and lists, completion_message_sent=False, module_concepts=[] (populated separately from Course_Modules.generated_topics), state_version=0
    - Implement `serialize_state(state)` and `deserialize_state(item)` for DynamoDB marshalling (handle nested ConceptProgress serialization, module_concepts list, completion_message_sent boolean, state_version for optimistic concurrency)
    - _Requirements: 2.1, 2.2, 2.8, 4.2, 12.1_

- [x] 2. Implement pure logic modules (no AWS dependencies)
  - [x] 2.1 Implement state machine core logic
    - Implement `update_state(state, evaluation)` — increment interactions by 1, increment exactly one of correct_count/partial_count/incorrect_count, manage consecutive_failures (reset on correct, increment otherwise), manage consecutive_correct (increment on correct, reset otherwise), update engagement_score: +0.2 if correct (capped at 1.0), +0.1 if partial AND len(concepts_demonstrated) > 0 (capped at 1.0), +0.0 otherwise; never modify module_complete
    - Implement `check_stage_advancement(state)` — evaluate thresholds per design table (prior_knowledge→comprehension at correct≥2, comprehension→application at correct≥5 AND consecutive_correct≥3, application→mastery at correct≥8); on advancement reset consecutive_failures=0 and hint_level=0
    - Implement `check_module_completion(state)` — returns True iff interactions >= MIN_INTERACTIONS AND len(concepts_discussed) >= MIN_CONCEPTS AND engagement_score >= MIN_ENGAGEMENT_SCORE (default 0.5); does NOT reference stage, correct_count, consecutive_failures, or mastery
    - Implement `calculate_mastery_profile(state)` — returns dict mapping concept_id to float(0.0-1.0) based on demonstrations/exposures ratio; pure analytics, no side effects on state
    - Implement `calculate_coverage(state)` — returns len(concepts_discussed) / len(module_concepts); returns 0.0 if module_concepts is empty (avoids division by zero); pure analytics function
    - Enforce single-stage-per-interaction invariant
    - _Requirements: 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 8.1, 8.2, 8.3, 8.4, 8.5, 8.9, 12.7, 12.8, 12.9_

  - [x] 2.2 Implement concept tracker module
    - Create `src/concept_tracker.py` with LEVEL_ORDER list and MASTERY_THRESHOLD_RATIO constant
    - Implement `introduce_concepts(state, concepts)` — add new concepts to concepts_exposed (exposure = assistant message mentioned concept), create concept_progress entries at level "introduced" with exposures=1, increment exposures for existing concepts, idempotent for membership
    - Implement `discuss_concepts(state, concepts)` — add new concepts to concepts_discussed (discussed = concept appeared in BOTH assistant AND student messages), advance level to at least "discussed", idempotent for membership
    - Implement `demonstrate_concepts(state, concepts)` — add new concepts to concepts_demonstrated, increment demonstrations count, advance level to "demonstrated", check if mastery threshold met (demonstrations/exposures >= MASTERY_THRESHOLD_RATIO)
    - Implement `record_misunderstandings(state, concepts)` — increment exposures without decrementing demonstrations or affecting engagement_score/module_complete
    - Implement `advance_concept_level(progress, target)` — advance level to at least target, never regress (introduced < discussed < demonstrated < mastery)
    - _Requirements: 4.4, 4.5, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [ ]* 2.3 Write property tests for state machine (Properties 1, 2, 3, 4, 17, 18)
    - **Property 1: State update correctness** — generate arbitrary valid SessionState and EvaluationResult, assert exactly one counter incremented, consecutive_failures correct, consecutive_correct correct, interactions incremented by 1, engagement_score updates correctly (+0.2 correct capped at 1.0, +0.1 partial with concepts capped at 1.0, +0.0 otherwise), module_complete never modified
    - **Property 2: Module completion is purely engagement-based** — generate states with various combinations of interactions, concepts_discussed, engagement_score, stages, and correct_counts; assert completion depends ONLY on interactions >= 5 AND len(concepts_discussed) >= 3 AND engagement_score >= 0.5
    - **Property 3: Stage advancement correctness** — generate states at all stage levels, assert thresholds match design table, resets occur on advancement
    - **Property 4: Single-stage-per-interaction invariant** — assert at most one stage advanced per interaction
    - **Property 17: Engagement score calculation correctness** — assert +0.2 for correct (capped at 1.0), +0.1 for partial with concepts_demonstrated > 0 (capped at 1.0), unchanged otherwise; engagement_score never exceeds 1.0
    - **Property 18: Coverage calculation correctness** — assert calculate_coverage returns len(concepts_discussed)/len(module_concepts) for non-empty module_concepts, 0.0 for empty, result in [0.0, 1.0] when concepts_discussed is subset of module_concepts
    - **Validates: Requirements 2.3, 2.4, 3.1–3.8, 8.1–8.5, 8.9, 12.8, 12.9**

  - [ ]* 2.4 Write property tests for concept tracker (Property 6)
    - **Property 6: Concept progress level advancement** — generate arbitrary SessionState with concept_progress and concept lists
    - Assert introduce_concepts adds to concepts_exposed without duplicates, creates entries at "introduced"
    - Assert discuss_concepts advances level to at least "discussed", never regresses
    - Assert demonstrate_concepts increments demonstrations, advances to "demonstrated", triggers mastery at threshold
    - Assert record_misunderstandings increments exposures without decrementing demonstrations or affecting engagement/completion
    - Assert no operation ever regresses a concept's level
    - **Validates: Requirements 4.4, 4.5, 12.1, 12.3, 12.4, 12.5, 12.6**

  - [x] 2.5 Implement mode selector
    - Create `src/mode_selector.py` with `select_mode(state, evaluation, advanced)` function
    - Implement full decision table (evaluated in priority order): post_completion (completion_message_sent==True — highest priority), complete (module_complete==True AND completion_message_sent==False), greet (interactions==0), advance (correct AND advanced), assess (correct AND NOT advanced), hint_nudge (partial AND hint_level==0), hint_scaffold (partial AND hint_level>=1), explain (incorrect AND consecutive_failures>=3), hint_scaffold (incorrect AND consecutive_failures<3 AND hint_level<2), explain fallback
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.10_

  - [ ]* 2.6 Write property tests for mode selector (Properties 7, 16)
    - **Property 7: Mode selection correctness** — generate all combinations of state (module_complete, completion_message_sent, interactions, hint_level, consecutive_failures) and evaluation inputs (correct, partial, None); assert mode output matches decision table, with "post_completion" always taking highest priority when completion_message_sent==True, and "complete" taking priority when module_complete==True AND completion_message_sent==False
    - **Property 16: Post-completion mode prevents re-triggering congratulations** — generate states where completion_message_sent==True with arbitrary evaluation results and advanced flags; assert mode is always "post_completion" regardless of other state fields
    - **Validates: Requirements 5.1–5.8, 5.10, 8.10**

  - [x] 2.7 Implement prompt builder
    - Create `src/prompt_builder.py` with `build_system_prompt(mode, topic, context_vars, rag_context, guardrail_tags)` function
    - Create `src/constants/modes.py` with MODE_TEMPLATES dict (greet, assess, hint_nudge, hint_scaffold, explain, advance, complete, post_completion)
    - Build system prompt as: base instructor identity + mode template (with variable substitution) + topic context + RAG context + guardrail tags
    - Include "post_completion" template that allows continued exploration without re-congratulating
    - _Requirements: 5.9, 5.10_

  - [ ]* 2.8 Write property tests for prompt builder (Property 8)
    - **Property 8: Prompt construction completeness**
    - Generate arbitrary mode, topic, context_vars, rag_context, guardrail_tags
    - Assert output contains all five segments: instructor identity, mode instruction, topic, rag_context, guardrail_tags
    - **Validates: Requirements 5.9**

  - [x] 2.9 Implement evaluation response parsing
    - Add `parse_evaluation_response(response_text, module_concepts)` to `src/evaluation.py`
    - Parse JSON response into EvaluationResult with concepts_demonstrated and concepts_misunderstood lists
    - Filter any concepts not present in the module_concepts canonical list — discard non-canonical concepts
    - On any parse failure (invalid JSON, missing fields, type errors), return DEFAULT_EVALUATION
    - _Requirements: 4.2, 4.3, 4.7_

  - [ ]* 2.10 Write property tests for evaluation parsing (Property 5)
    - **Property 5: Evaluation response parsing round-trip**
    - Generate valid JSON with correct (bool), partial (bool), confidence (float 0.0-1.0), concepts_demonstrated (list[str]), concepts_misunderstood (list[str]) where all concepts are drawn from a generated module_concepts list
    - Assert parse_evaluation_response returns EvaluationResult with all fields matching JSON exactly
    - Assert concepts not in module_concepts are filtered out
    - Test malformed JSON returns DEFAULT_EVALUATION
    - **Validates: Requirements 4.2, 4.7**

  - [ ]* 2.11 Write property test for mastery profile independence (Property 15)
    - **Property 15: Mastery profile independence from completion**
    - Generate arbitrary SessionState with concept_progress containing various exposures/demonstrations
    - Assert calculate_mastery_profile returns dict[str, float] with values in [0.0, 1.0] computed as demonstrations/exposures
    - Assert calling calculate_mastery_profile has no side effects on state.module_complete or state.engagement_score
    - **Validates: Requirements 8.9, 12.7, 12.8**

- [x] 3. Checkpoint — Pure logic tests
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement AWS integration modules
  - [x] 4.1 Implement retrieval client
    - Create `src/retrieval_client.py` with `RetrievalResult` dataclass (answer, sources) and `invoke_retrieval()` function
    - Invoke ragRetrievalFunction via boto3 Lambda client (synchronous, RequestResponse)
    - Bound chat_history to last 4 turns before sending
    - Include `learning_context` parameter in payload: `{ stage, concepts_demonstrated, concepts_misunderstood }` from current session state — provides pedagogical context to the retrieval function for content prioritization
    - On success (statusCode 200): extract answer and sources into RetrievalResult
    - On error/timeout: log failure, return None (caller proceeds without RAG context)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 4.2 Write property test for history bounding (Property 9)
    - **Property 9: Chat history bounding for retrieval**
    - Generate history lists of varying lengths
    - Assert get_bounded_history(history, MAX_RETRIEVAL_TURNS) returns min(N, 4) most recent turns
    - **Validates: Requirements 6.5**

  - [x] 4.3 Implement streaming helper
    - Create `src/streaming.py` with `stream_response()`, `buffer_chunks()`, and `send_chunk()` functions
    - Implement `buffer_chunks(token_stream, chunk_size=80)` generator — emit chunks of ≥80 chars (except final)
    - Use Bedrock InvokeModelWithResponseStream for Claude 3 Sonnet
    - Buffer tokens to 80 chars, send via AppSync sendChatChunk mutation using httpx
    - Send final chunk with done=true on completion
    - On complete LLM failure (no tokens): return fallback message
    - AppSync failures are logged but do not interrupt generation
    - _Requirements: 7.1, 7.2, 7.3, 7.5_

  - [ ]* 4.4 Write property test for chunk buffering (Property 10)
    - **Property 10: Streaming chunk buffering**
    - Generate arbitrary token sequences
    - Assert all chunks except last have length >= 80, concatenation of all chunks equals concatenation of input tokens
    - **Validates: Requirements 7.2**

  - [x] 4.5 Implement guardrails integration
    - Create `src/guardrails.py` with `load_guardrail_config()`, `wrap_user_message()`, and `handle_guardrail_error()` functions
    - Load guardrail_id and version from SSM (cached on cold start)
    - Wrap user message in `<amazon-bedrock-guardrails-guardContent_{suffix}>` tags with 8-char random alphanumeric suffix
    - Classify guardrail errors: intervention (input/output) → safe redirect message, service error → None (retry without)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [ ]* 4.6 Write property test for guardrail wrapping (Property 12)
    - **Property 12: Guardrail tag wrapping format**
    - Generate arbitrary non-empty message strings
    - Assert output matches pattern with same 8-char alphanumeric suffix in open/close tags and unmodified message content
    - **Validates: Requirements 9.2**

  - [x] 4.7 Implement history manager
    - Create `src/history.py` with `load_chat_history()`, `get_bounded_history()`, and `persist_message_pair()` functions
    - Bound prompt history to last 10 turns (MAX_PROMPT_TURNS) for Response_Generator
    - Bound retrieval history to last 4 turns (MAX_RETRIEVAL_TURNS) for ragRetrievalFunction
    - Persist full message pairs (user + assistant) to existing Chat_History_Table pattern (SessionId partition key)
    - Best-effort persistence: log errors but don't raise
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [ ]* 4.8 Write property test for prompt history bounding (Property 14)
    - **Property 14: Conversation history bounding for prompt**
    - Generate history lists of varying lengths
    - Assert get_bounded_history(history, MAX_PROMPT_TURNS) returns min(N, 10) most recent turns
    - **Validates: Requirements 11.1, 11.2**

- [x] 5. Checkpoint — Integration module tests
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement Lambda handler orchestration
  - [x] 6.1 Implement evaluation engine Bedrock call
    - Add `evaluate_answer(bedrock_client, topic, stage, last_ai_question, student_answer, concepts, module_concepts)` to `src/evaluation.py`
    - Use EVALUATION_PROMPT template with Claude 3 Haiku via Bedrock InvokeModel
    - Pass module_concepts as canonical vocabulary in the evaluation prompt so the LLM only reports concepts from that list
    - Parse response via `parse_evaluation_response(response_text, module_concepts)` with post-processing filter; on any exception return DEFAULT_EVALUATION and log
    - Return EvaluationResult with concepts_demonstrated and concepts_misunderstood populated (only canonical concepts)
    - _Requirements: 4.1, 4.2, 4.3, 4.6, 4.7, 12.10_

  - [x] 6.2 Implement Lambda handler and request orchestration
    - Create `src/main.py` with Powertools Logger (service="chatbot-v2"), X-Ray bootstrap, and handler decorator (clear_state=True, log_uncaught_exceptions=True)
    - Parse request: extract course_id, session_id, module_id from query params; message_content from body
    - Validate required params — return HTTP 400 with missing param name if absent
    - Append correlation keys (session_id, course_id) to logger
    - Orchestration pipeline:
      1. Load session state (create default if new session)
      2. On new session: query Course_Modules.generated_topics for module_concepts, store in SessionState
      3. Evaluate answer (skip on first message — interactions==0); pass module_concepts to evaluator
      4. Update state via update_state() — engagement_score calculated per rules
      5. Update concept progress via concept_tracker (introduce from RAG context/assistant message, discuss when student engages, demonstrate/misunderstand from evaluation)
      6. Check module completion via check_module_completion() (interactions + concepts_discussed + engagement_score)
      7. Check stage advancement via check_stage_advancement()
      8. Select mode via select_mode() — post_completion has highest priority when completion_message_sent==True
      9. If mode=="complete", set completion_message_sent=True and query other module names
      10. Invoke retrieval (bounded to last 4 turns, include learning_context)
      11. Build system prompt (using post_completion template for returning completers)
      12. Stream response via Bedrock Sonnet + AppSync
      13. Persist chat history + session state (use optimistic concurrency: increment state_version, use DynamoDB conditional write where state_version = expected value, on ConditionalCheckFailedException reload state and retry once)
      14. Calculate mastery profile + coverage (post-response analytics)
    - Return structured response: session_name, llm_output, llm_verdict, session_state (stage, module_complete, engagement_score, concepts_demonstrated)
    - _Requirements: 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 5.10, 6.1, 7.4, 7.6, 8.5, 8.6, 8.7, 8.10, 10.4, 10.5, 10.6, 12.7, 12.9_

  - [ ]* 6.3 Write property test for input validation (Property 13)
    - **Property 13: Input validation for missing parameters**
    - Generate request events with various combinations of missing/empty params (course_id, session_id, module_id)
    - Assert HTTP 400 returned with correct missing param identification, no downstream processing
    - **Validates: Requirements 10.6**

  - [ ]* 6.4 Write property test for HTTP response format (Property 11)
    - **Property 11: HTTP response format completeness**
    - Generate valid processing results (session_name, llm_output, llm_verdict, session_state)
    - Assert response body contains all four fields with correct types: session_name (str), llm_output (str), llm_verdict (bool), session_state object with stage (str), module_complete (bool), engagement_score (float), concepts_demonstrated (list)
    - **Validates: Requirements 7.6**

  - [x] 6.5 Implement error handling and resilience
    - DB connection failure on module context retrieval → HTTP 503
    - Session_State_Table read failure → HTTP 503
    - Session_State_Table write failure → log error, still return response (best-effort)
    - Session_State_Table conditional write conflict (ConditionalCheckFailedException) → reload state, re-apply current interaction updates, retry write once; if retry also fails → log conflict, return response without persisting state (best-effort)
    - AppSync streaming failure → log, continue generation, include in HTTP body
    - Guardrail service error → retry without guardrails; if retry fails → HTTP 500
    - Unhandled exceptions → log full stack trace via logger.exception(), return HTTP 500 with generic message
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 2.7, 2.8_

  - [ ]* 6.6 Write unit tests for handler error scenarios
    - Test DB connection failure returns 503
    - Test state table read failure returns 503
    - Test state table write failure still returns 200 with response
    - Test guardrail retry logic
    - Test unhandled exception returns 500 with generic message
    - Mock all AWS clients
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [x] 7. Checkpoint — Handler orchestration tests
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement CDK infrastructure
  - [x] 8.1 Create Session_State_Table DynamoDB resource
    - Add new DynamoDB table to MultimodalRagStack: partition key "session_id" (String), PAY_PER_REQUEST billing, DESTROY removal policy
    - Use naming convention `${id}-sessionStateTable`
    - Export table as public readonly property for cross-stack access
    - _Requirements: 2.6_

  - [x] 8.2 Create chatbotV2Role IAM role with least-privilege permissions
    - Create dedicated per-function IAM role `${id}-chatbotV2Role`
    - Add inline policy with all permissions per design: Bedrock InvokeModel (Sonnet + Haiku), Lambda InvokeFunction (ragRetrievalFunction ARN), DynamoDB data ops (session state table + chat history table — specific ARNs), DynamoDB management (table wildcard for List/Create/Describe), Secrets Manager (secretPathUser ARN), SSM (AILA/* params), EC2 VPC networking (*), RDS Proxy connect (specific instance resource ID), CloudWatch Logs (scoped to function log group), X-Ray (*), AppSync GraphQL (sendChatChunk mutation), AWS Marketplace (Subscribe/Unsubscribe/ViewSubscriptions for Anthropic models)
    - Follow IAM Security Policy: no action wildcards, specific resource ARNs where supported, document inline comments for * resources
    - _Requirements: 1.1, 1.6_

  - [x] 8.3 Create chatbotV2Function Docker Lambda
    - Add DockerImageFunction: code from `./chatbot_v2`, x86_64 architecture, 1024MB memory, 120s timeout, active X-Ray tracing, environment-derived logRetention, functionName `${id}-chatbotV2Function`
    - Configure environment variables: REGION, RAG_RETRIEVAL_FUNCTION_ARN, SESSION_STATE_TABLE, CHAT_HISTORY_TABLE, DB_SECRET_ARN, DB_PROXY_ENDPOINT, APPSYNC_API_URL, GUARDRAIL_ID_PARAM, GUARDRAIL_VERSION_PARAM
    - Place in same VPC as existing Lambdas
    - Assign chatbotV2Role
    - _Requirements: 1.1, 1.3, 1.5_

  - [x] 8.4 Add API Gateway route for chatbot V2
    - Add `/chatbot-v2` resource to existing API Gateway in ApiGatewayStack
    - Add POST method with LambdaIntegration pointing to chatbotV2Function
    - Attach existing Cognito authorizer for authentication
    - Add OPTIONS method for CORS
    - Ensure existing text_generation route is unmodified
    - _Requirements: 1.2, 1.4_

  - [ ]* 8.5 Write CDK assertion tests for chatbot V2 infrastructure
    - Assert Session_State_Table has correct partition key and billing mode
    - Assert chatbotV2Role has all required policy statements with correct resource scoping
    - Assert chatbotV2Function has correct runtime, memory, timeout, tracing, functionName
    - Assert API Gateway has /chatbot-v2 POST route with Cognito auth
    - Assert no action wildcards in chatbotV2Role policies (per IAM security policy)
    - _Requirements: 1.1, 1.2, 1.6, 2.6_

- [x] 9. Final checkpoint — Full integration
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate all 18 universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Pure logic modules (state_machine, concept_tracker, mode_selector, prompt_builder) have zero AWS dependencies — test without mocks
- Integration modules (retrieval_client, streaming, guardrails, history) need mocked boto3 clients
- CDK infrastructure follows existing patterns in MultimodalRagStack and ApiGatewayStack
- IAM permissions follow the workspace IAM Security Policy (no action wildcards, specific ARNs)
- `check_module_completion()` and `calculate_mastery_profile()` are explicitly separate functions — completion never references mastery
- `calculate_coverage()` is a pure analytics function — len(concepts_discussed) / len(module_concepts)
- Concept tracker is a dedicated module separate from state_machine to isolate concept-level logic
- `completion_message_sent` flag ensures the "complete" congratulatory mode fires exactly once; subsequent interactions use "post_completion"
- `module_concepts` loaded from Course_Modules.generated_topics on session start; used as canonical vocabulary for evaluator and coverage calculation
- Engagement score: +0.2 correct, +0.1 partial with demonstrated concepts, +0.0 otherwise, capped at 1.0
- Concept exposure = assistant message mentions concept; discussed = BOTH assistant AND student reference it

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "2.2", "2.5", "2.7", "2.9"] },
    { "id": 3, "tasks": ["2.3", "2.4", "2.6", "2.8", "2.10", "2.11"] },
    { "id": 4, "tasks": ["4.1", "4.3", "4.5", "4.7"] },
    { "id": 5, "tasks": ["4.2", "4.4", "4.6", "4.8"] },
    { "id": 6, "tasks": ["6.1", "6.2"] },
    { "id": 7, "tasks": ["6.3", "6.4", "6.5"] },
    { "id": 8, "tasks": ["6.6"] },
    { "id": 9, "tasks": ["8.1", "8.2"] },
    { "id": 10, "tasks": ["8.3", "8.4"] },
    { "id": 11, "tasks": ["8.5"] }
  ]
}
```

# Requirements Document

## Introduction

This document defines the requirements for the Chatbot V2 Integration — a new Lambda function that combines V2 multimodal retrieval with a structured learning conversation engine. The core architectural principle is that **completion and mastery are decoupled**: completion represents meaningful engagement (the student participated, was exposed to concepts, thought through questions), while mastery is a separate analytics layer tracked per-concept in the background that never gates the student. The application layer controls conversation depth via learning stages, evaluates answers with rich concept-level feedback, and adapts difficulty to steer conversation quality — not to determine whether a student finishes. It integrates with the existing V2 `ragRetrievalFunction` via synchronous Lambda-to-Lambda invoke for context retrieval, uses a dedicated DynamoDB table for learning session state (including per-concept progress), and streams responses to the frontend via AppSync subscriptions.

## Glossary

- **Chatbot_V2_Lambda**: The new Lambda function that orchestrates the structured learning flow, deployed alongside the existing text_generation Lambda
- **State_Machine**: Application-layer logic that manages session state including stage progression (drives conversation depth), engagement tracking (drives completion), and concept-level progress (drives analytics)
- **Session_State**: A DynamoDB record storing the student's current learning stage, interaction counts, engagement score, concept progress map, and hint tracking for a given session
- **Evaluation_Engine**: A separate LLM call (Claude 3 Haiku) that assesses the student's answer and returns structured JSON evaluation including concepts demonstrated and concepts misunderstood
- **Response_Generator**: The primary LLM call (Claude 3 Sonnet) that generates a natural language response constrained by the mode selected by the application layer
- **Mode_Selector**: Application logic that determines the response mode (greet, assess, hint_nudge, hint_scaffold, explain, advance, complete) based on session state and evaluation results
- **RAG_Retrieval_Invoke**: Synchronous Lambda-to-Lambda invocation of the existing V2 ragRetrievalFunction to obtain retrieved context for the student's query
- **Session_State_Table**: A dedicated DynamoDB table (separate from chat history) that stores learning session state keyed by session_id
- **Chat_History_Table**: The existing DynamoDB table that stores conversation message history per session
- **AppSync_Streaming**: Real-time chunk delivery of LLM responses to the frontend via AppSync GraphQL mutations and subscriptions
- **Bedrock_Guardrails**: AWS Bedrock Guardrails service integration that filters inappropriate input and output content
- **Engagement_Score**: A numeric value (0.0–1.0) representing the student's meaningful participation in the session, calculated from substantive answers only (correct or partial with demonstrated concepts) — deflections and "I don't know" responses do not increase the score
- **Concepts_Exposed**: Concepts that appeared in the assistant's message (the bot mentioned the concept to the student)
- **Concepts_Discussed**: Concepts that appeared in BOTH assistant AND student messages (the student actively engaged with or referenced the concept)
- **Module_Concepts**: The canonical list of concept identifiers loaded from `Course_Modules.generated_topics` for the current module — used as the authoritative concept vocabulary for evaluation and coverage calculation
- **Concept_Progress**: A per-concept tracking structure recording exposure level (introduced, discussed, demonstrated, mastery), exposure count, and successful demonstration count
- **Module_Completion**: An engagement-based determination that the student has meaningfully participated in the module — distinct from mastery analytics
- **Mastery_Profile**: A per-concept analytics record showing mastery estimates, used for instructor dashboards and future recommendations — never gates the student

## Requirements

### Requirement 1: Lambda Deployment and Routing

**User Story:** As a system operator, I want the new chatbot Lambda deployed alongside the existing text_generation Lambda with traffic controlled via a new API Gateway route, so that I can gradually migrate students to the new flow without disrupting existing functionality.

#### Acceptance Criteria

1. THE Chatbot_V2_Lambda SHALL be deployed as a Docker-based Lambda function with a dedicated per-function IAM role, function name following `${id}-chatbotV2Function` convention, active X-Ray tracing, and environment-derived log retention
2. THE Chatbot_V2_Lambda SHALL be accessible via a new API Gateway route (separate from the existing text_generation route) that integrates with the existing Cognito authorizer for authentication
3. THE Chatbot_V2_Lambda SHALL operate in the same VPC as the existing text_generation Lambda with access to RDS Proxy via sslmode=require
4. WHEN the Chatbot_V2_Lambda is deployed, THE existing text_generation Lambda SHALL continue to function without modification on its existing route
5. THE Chatbot_V2_Lambda SHALL include Powertools Logger (service name "chatbot-v2"), X-Ray bootstrap, and the handler decorator with clear_state=True and log_uncaught_exceptions=True
6. THE Chatbot_V2_Lambda IAM role SHALL have permissions for: Bedrock InvokeModel (Claude 3 Sonnet, Claude 3 Haiku), Lambda InvokeFunction (ragRetrievalFunction ARN), DynamoDB operations on both Session_State_Table and Chat_History_Table, Secrets Manager (DB secret), AppSync mutations, SSM parameter reads, X-Ray, and CloudWatch Logs scoped to the function's log group

### Requirement 2: Session State Management

**User Story:** As a student, I want my learning progress to persist across messages within a session, so that the system adapts its teaching approach based on my engagement and demonstrated understanding.

#### Acceptance Criteria

1. WHEN a new session begins (first message with no existing state), THE Chatbot_V2_Lambda SHALL create a Session_State record with stage="prior_knowledge", module_complete=false, completion_message_sent=false, interactions=0, engagement_score=0.0, concept_progress={} (empty map), concepts_exposed=[] (empty list), concepts_discussed=[] (empty list), concepts_demonstrated=[] (empty list), module_concepts=[] (empty list, populated in criterion 2), hint_count=0, consecutive_failures=0, hint_level=0, and state_version=0 (int)
2. WHEN a new session begins, THE Chatbot_V2_Lambda SHALL query the Course_Modules table for the current module's `generated_topics` field and store the result as `module_concepts` in the Session_State — this canonical concept list SHALL be used for evaluation mapping and coverage calculation
3. WHEN a message is received for an existing session, THE Chatbot_V2_Lambda SHALL load the Session_State from the Session_State_Table before any evaluation or response generation
4. WHEN the Evaluation_Engine produces an evaluation result, THE State_Machine SHALL update the Session_State by: incrementing interactions, updating the engagement_score, updating concept_progress for each concept reported by the evaluator, and adjusting consecutive_failures (reset to 0 on correct, increment on incorrect)
5. WHEN the Session_State is updated, THE Chatbot_V2_Lambda SHALL persist the updated state to the Session_State_Table before returning the response to the caller
6. THE Session_State_Table SHALL be a DynamoDB table with partition key "session_id" (String type), PAY_PER_REQUEST billing mode, and DESTROY removal policy
7. IF the Session_State_Table is unreachable during state load, THEN THE Chatbot_V2_Lambda SHALL return HTTP 503 indicating the service is temporarily unavailable
8. WHEN the Chatbot_V2_Lambda persists the updated Session_State, THE system SHALL use optimistic concurrency control by including a `state_version` counter in the Session_State — on each write, the system SHALL increment state_version and use a DynamoDB conditional expression (`attribute_exists(session_id) AND state_version = :expected_version`) to prevent lost updates from concurrent requests. IF the conditional write fails (ConditionalCheckFailedException), THEN THE Chatbot_V2_Lambda SHALL reload the state from DynamoDB, re-apply the current interaction's updates on top of the freshly loaded state, and retry the write once — if the retry also fails, THE Chatbot_V2_Lambda SHALL log the conflict and return the response without persisting state (best-effort, consistent with write failure handling in Requirement 10 criterion 2)

### Requirement 3: Learning Stage Progression

**User Story:** As a student, I want the conversation to adapt in depth and difficulty as I demonstrate understanding, so that I receive appropriately challenging questions without being gated from completing the module.

#### Acceptance Criteria

1. THE State_Machine SHALL use learning stages (prior_knowledge, comprehension, application, mastery) to drive conversation depth and question difficulty — stages SHALL NOT gate module completion
2. WHEN the Evaluation_Engine reports correct answers demonstrating foundational understanding while in stage "prior_knowledge", THE State_Machine SHALL advance the stage to "comprehension" to increase question complexity
3. WHEN the Evaluation_Engine reports sustained correct answers demonstrating comprehension while in stage "comprehension", THE State_Machine SHALL advance the stage to "application" to introduce scenario-based questions
4. WHEN the Evaluation_Engine reports correct answers demonstrating applied understanding while in stage "application", THE State_Machine SHALL advance the stage to "mastery" to introduce edge cases and comparisons
5. WHEN a stage advancement occurs, THE State_Machine SHALL reset consecutive_failures to 0 and hint_level to 0 in the Session_State
6. THE State_Machine SHALL advance at most one stage per interaction — multiple successive advancements within a single request SHALL NOT occur
7. WHILE a student is struggling (high consecutive_failures), THE State_Machine SHALL provide more scaffolding, hints, and guided examples at the current stage — the student SHALL still be able to complete the module through engagement
8. WHILE a student is excelling (rapid correct answers), THE State_Machine SHALL advance stages faster and present harder questions and edge cases — both struggling and excelling students SHALL be able to complete the module

### Requirement 4: Answer Evaluation

**User Story:** As a student, I want my answers to be assessed with concept-level granularity, so that the system tracks which specific concepts I understand and which I need more help with.

#### Acceptance Criteria

1. WHEN a student message is received (not the first message in a session), THE Evaluation_Engine SHALL invoke Claude 3 Haiku with a structured evaluation prompt containing the topic, current stage, the previous AI question, the student's answer, and the session's `module_concepts` list as the canonical concept vocabulary
2. THE Evaluation_Engine SHALL return a structured JSON result containing: correct (boolean), partial (boolean), confidence (float 0.0-1.0), concepts_demonstrated (list of concept identifiers the student showed understanding of), and concepts_misunderstood (list of concept identifiers the student showed confusion about) — all concept identifiers SHALL be drawn from the canonical `module_concepts` list
3. IF the evaluation LLM call fails (timeout, throttling, or error response), THEN THE Evaluation_Engine SHALL return a default evaluation of {correct: false, partial: true, confidence: 0.5, concepts_demonstrated: [], concepts_misunderstood: []} and log the failure — the system SHALL continue processing without interruption
4. WHEN the evaluation reports concepts_demonstrated, THE State_Machine SHALL update the corresponding entries in concept_progress by incrementing their demonstration count and advancing their level if appropriate (introduced → discussed → demonstrated → mastery)
5. WHEN the evaluation reports concepts_misunderstood, THE State_Machine SHALL record the misunderstanding in concept_progress for the relevant concepts without penalizing the student's completion progress
6. THE Evaluation_Engine SHALL use a separate Bedrock InvokeModel call from the Response_Generator — evaluation and response generation SHALL NOT share a single LLM invocation
7. WHEN the Evaluation_Engine identifies a concept not present in the session's `module_concepts` list, THE Evaluation_Engine SHALL discard that concept from the evaluation result — only canonical concept identifiers SHALL appear in concepts_demonstrated or concepts_misunderstood

### Requirement 5: Mode Selection and Prompt Construction

**User Story:** As a student, I want the system to dynamically choose how to respond (question, hint, explanation, advancement) based on my performance, so that I receive appropriate scaffolding at each point in my learning.

#### Acceptance Criteria

1. WHEN the session has zero interactions (first message), THE Mode_Selector SHALL select mode "greet"
2. WHEN the evaluation indicates correct=true AND the State_Machine determines a stage advancement is appropriate, THE Mode_Selector SHALL select mode "advance"
3. WHEN the evaluation indicates correct=true AND no stage advancement occurs, THE Mode_Selector SHALL select mode "assess"
4. WHEN the evaluation indicates partial=true AND hint_level is 0, THE Mode_Selector SHALL select mode "hint_nudge" and increment hint_level to 1
5. WHEN the evaluation indicates partial=true AND hint_level is 1 or higher, THE Mode_Selector SHALL select mode "hint_scaffold" and increment hint_level
6. WHEN the evaluation indicates correct=false AND consecutive_failures is less than 3 AND hint_level is less than 2, THE Mode_Selector SHALL select mode "hint_scaffold"
7. WHEN the evaluation indicates correct=false AND consecutive_failures is 3 or more, THE Mode_Selector SHALL select mode "explain" and reset hint_level to 0
8. WHEN Module_Completion is detected (engagement threshold met) AND completion_message_sent is false, THE Mode_Selector SHALL select mode "complete" regardless of evaluation result
9. WHEN a mode is selected, THE Chatbot_V2_Lambda SHALL construct a system prompt containing: base instructor identity, the selected mode instruction template, topic context, retrieved RAG context, and Bedrock Guardrails tags — the LLM SHALL NOT determine the mode or teaching strategy itself
10. WHEN completion_message_sent is true (the "complete" mode has already been sent in a prior interaction), THE Mode_Selector SHALL select mode "post_completion" for all subsequent interactions — the "post_completion" mode SHALL allow continued exploration and questions without re-triggering congratulatory messages

### Requirement 6: V2 Retrieval Integration

**User Story:** As a student, I want my questions answered using the V2 multimodal retrieval pipeline, so that I get higher-quality context including images, formulas, and tables from course materials.

#### Acceptance Criteria

1. WHEN the Chatbot_V2_Lambda needs retrieval context, THE RAG_Retrieval_Invoke SHALL perform a synchronous Lambda-to-Lambda invoke of the ragRetrievalFunction with payload containing: query, session_id, course_id, allowed_file_ids, chat_history (last 4 turns), and learning_context (an object with stage, concepts_demonstrated, and concepts_misunderstood from the current session state)
2. WHEN the ragRetrievalFunction returns a successful response (statusCode 200), THE Chatbot_V2_Lambda SHALL extract the answer field as retrieved context and the sources field for attribution
3. IF the ragRetrievalFunction returns an error response (statusCode 503 or other non-200), THEN THE Chatbot_V2_Lambda SHALL proceed without retrieval context, using only conversation history and the mode prompt to generate a response — the system SHALL log the retrieval failure and continue
4. IF the Lambda invoke times out or throws an exception, THEN THE Chatbot_V2_Lambda SHALL treat the retrieval as unavailable and proceed with a fallback response generation without RAG context
5. THE Chatbot_V2_Lambda SHALL pass at most the last 4 conversation turns (user + assistant pairs) as chat_history to the ragRetrievalFunction to bound retrieval latency

### Requirement 7: Response Generation and Streaming

**User Story:** As a student, I want to see the chatbot's response appear in real-time as it is generated, so that I have immediate feedback and a responsive experience.

#### Acceptance Criteria

1. WHEN the mode is selected and retrieval context is available, THE Response_Generator SHALL invoke Claude 3 Sonnet with streaming enabled, using the constructed system prompt and the student's message
2. WHILE response tokens are being generated, THE Chatbot_V2_Lambda SHALL buffer chunks to 80 characters and send each buffer to the frontend via AppSync_Streaming mutation (sendChatChunk)
3. WHEN streaming completes, THE Chatbot_V2_Lambda SHALL send a final AppSync mutation with done=true to signal the end of the response
4. WHEN the full response is assembled, THE Chatbot_V2_Lambda SHALL persist the student message and assistant response to the Chat_History_Table
5. IF the Response_Generator LLM call fails completely (no tokens received), THEN THE Chatbot_V2_Lambda SHALL return a fallback message "I'm sorry, I wasn't able to generate a response. Please try again." via both AppSync streaming and the HTTP response body
6. THE Chatbot_V2_Lambda SHALL return an HTTP response containing: session_name, llm_output (full response text), llm_verdict (boolean indicating module completion), and session_state summary (stage, module_complete, engagement_score, concepts_demonstrated)

### Requirement 8: Module Completion Detection

**User Story:** As a student, I want the system to recognize when I have meaningfully engaged with the module and conclude the session, so that both students who struggled and students who excelled can complete through genuine participation.

#### Acceptance Criteria

1. THE State_Machine SHALL determine Module_Completion exclusively through engagement metrics — completion SHALL NOT require reaching any specific learning stage or mastery threshold
2. WHEN the student's interaction count is below a minimum threshold (configurable, default 5), THE State_Machine SHALL NOT mark the module as complete regardless of other metrics
3. WHEN the student has discussed fewer than a minimum number of concepts (configurable, default 3), THE State_Machine SHALL NOT mark the module as complete regardless of other metrics
4. WHEN the student's engagement_score is below 0.5, THE State_Machine SHALL NOT mark the module as complete regardless of other metrics — engagement_score SHALL only increase on substantive answers (correct or partial with demonstrated concepts) and SHALL NOT increase on deflections or "I don't know" responses
5. WHEN the student's interaction count meets or exceeds the minimum threshold AND the student has discussed at least the minimum number of concepts AND the engagement_score is at least 0.5, THE State_Machine SHALL mark module_complete=true in the Session_State
6. WHEN module_complete becomes true, THE Chatbot_V2_Lambda SHALL set llm_verdict to true in the response payload
7. WHEN mode "complete" is selected, THE Response_Generator SHALL generate a congratulatory closing message that summarizes the concepts the student engaged with and suggests other modules — the completion message SHALL NOT rely on the LLM producing any specific hardcoded phrase
8. WHEN llm_verdict is true, THE Chatbot_V2_Lambda SHALL query the database for other module names in the same course and include them as suggestions in the completion context provided to the Response_Generator
9. THE check_module_completion function and the calculate_mastery_profile function SHALL be separate functions with distinct responsibilities — completion logic SHALL NOT reference mastery calculations
10. WHEN the "complete" mode fires successfully, THE Chatbot_V2_Lambda SHALL set completion_message_sent=true in the Session_State — subsequent interactions SHALL use "post_completion" mode and SHALL NOT re-trigger the congratulatory completion message

### Requirement 9: Bedrock Guardrails Integration

**User Story:** As a system operator, I want inappropriate content to be filtered from both student input and chatbot output, so that the learning environment remains safe and on-topic.

#### Acceptance Criteria

1. WHEN Guardrail SSM parameters are configured, THE Chatbot_V2_Lambda SHALL load the guardrail_id and guardrail_version from SSM on cold start and cache them for the container lifetime
2. WHEN a student message is received, THE Chatbot_V2_Lambda SHALL wrap the user content in Bedrock Guardrail input tags with a per-request random alphanumeric suffix before passing it to the Response_Generator
3. IF a guardrail intervention occurs on input (content blocked), THEN THE Chatbot_V2_Lambda SHALL return a message indicating the topic cannot be discussed and redirect to course material — without exposing guardrail internals to the student
4. IF a guardrail intervention occurs on output (response blocked), THEN THE Chatbot_V2_Lambda SHALL return a message indicating the response was redirected back to course material
5. IF the Bedrock Guardrails service returns an error (not an intervention), THEN THE Chatbot_V2_Lambda SHALL retry the Response_Generator call once without guardrails and log the service error — if the retry also fails, return HTTP 500

### Requirement 10: Error Handling and Resilience

**User Story:** As a system operator, I want the chatbot to handle failures gracefully at each step without cascading errors, so that partial failures degrade the experience rather than crash the system.

#### Acceptance Criteria

1. IF the database connection fails during module context retrieval, THEN THE Chatbot_V2_Lambda SHALL return HTTP 503 with a message indicating the service is temporarily unavailable
2. IF the Session_State_Table write fails after response generation, THEN THE Chatbot_V2_Lambda SHALL still return the generated response to the student (best-effort state persistence) and log the write failure as an error
3. IF AppSync streaming fails for one or more chunks, THEN THE Chatbot_V2_Lambda SHALL continue generating the response and include the complete response in the HTTP response body — partial streaming failure SHALL NOT interrupt response generation
4. WHEN any unhandled exception occurs in the handler, THE Chatbot_V2_Lambda SHALL log the exception with full stack trace via logger.exception() and return HTTP 500 with a generic error message — the system SHALL NOT expose internal error details to the caller
5. THE Chatbot_V2_Lambda SHALL append correlation keys (session_id, course_id) to the logger immediately after extracting them from the request event
6. IF required request parameters (course_id, session_id, module_id) are missing, THEN THE Chatbot_V2_Lambda SHALL return HTTP 400 with a message specifying which parameter is missing

### Requirement 11: Conversation History Management

**User Story:** As a student, I want my conversation history to be bounded so that long sessions maintain response quality without degrading from context window saturation.

#### Acceptance Criteria

1. WHEN constructing the prompt for the Response_Generator, THE Chatbot_V2_Lambda SHALL include at most the last 10 conversation turns (user + assistant message pairs) from the Chat_History_Table
2. WHEN a session exceeds 10 conversation turns, THE Chatbot_V2_Lambda SHALL exclude older turns from the prompt context — older messages SHALL remain stored in the Chat_History_Table but SHALL NOT be sent to the LLM
3. WHEN the Chatbot_V2_Lambda persists a new message pair to the Chat_History_Table, THE system SHALL store the full message content including the student message and the complete assistant response
4. THE Chatbot_V2_Lambda SHALL use the existing DynamoDB chat history pattern (SessionId partition key) consistent with the current text_generation implementation

### Requirement 12: Concept Coverage and Mastery Analytics

**User Story:** As an instructor, I want to see which concepts each student was exposed to, discussed, and demonstrated understanding of, so that I can identify knowledge gaps across my class and tailor future instruction.

#### Acceptance Criteria

1. WHEN the Evaluation_Engine reports concepts in a student's answer, THE State_Machine SHALL update the concept_progress map with per-concept records containing: level (introduced, discussed, demonstrated, mastery), exposures count, and successful demonstrations count
2. THE State_Machine SHALL track three concept coverage lists in the Session_State: concepts_exposed (concepts the student encountered), concepts_discussed (concepts the student actively engaged with), and concepts_demonstrated (concepts the student showed correct understanding of)
3. WHEN a concept appears in an assistant message (the bot mentions it to the student), THE State_Machine SHALL add the concept to concepts_exposed and set its level to "introduced" in concept_progress — a concept is "exposed" when it appears in the assistant's output regardless of student engagement
4. WHEN a concept appears in BOTH an assistant message AND a student message (the student references, engages with, or demonstrates the concept), THE State_Machine SHALL add the concept to concepts_discussed and advance its level to at least "discussed" in concept_progress — a concept is only "discussed" when the student actively engages with it, not merely because the bot mentioned it
5. WHEN the Evaluation_Engine reports a concept in concepts_demonstrated for a correct answer, THE State_Machine SHALL add the concept to concepts_demonstrated, increment the concept's demonstrations count, and advance its level to "demonstrated" in concept_progress
6. WHEN a concept's demonstrations count reaches a sufficient threshold relative to exposures (configurable), THE State_Machine SHALL advance the concept's level to "mastery" in concept_progress
7. WHEN a session completes (module_complete=true), THE Chatbot_V2_Lambda SHALL compute and store a mastery analytics record containing: stage_reached, concepts_exposed, concepts_discussed, concepts_demonstrated, mastery_estimates (per-concept float 0.0-1.0), total_interactions, hint_count, completion_status, and coverage (len(concepts_discussed) / len(module_concepts))
8. THE mastery analytics record SHALL be stored for instructor dashboard consumption — mastery analytics SHALL NOT influence the module completion determination for the student
9. WHEN computing concept coverage, THE Chatbot_V2_Lambda SHALL calculate coverage as len(concepts_discussed) / len(module_concepts) using the canonical concept list loaded from Course_Modules — this provides instructors meaningful analytics showing which specific canonical concepts the student engaged with and which were missed
10. THE Evaluation_Engine SHALL receive the session's `module_concepts` list as the canonical concept vocabulary and SHALL only report concepts from that list in concepts_demonstrated and concepts_misunderstood

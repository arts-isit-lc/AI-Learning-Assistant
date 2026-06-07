# Implementation Plan: Bedrock Guardrails Integration

## Overview

Migrate content safety enforcement from inline prompt text to AWS Bedrock Guardrails. Implementation spans CDK infrastructure (guardrail resource, IAM, SSM), Lambda runtime (guardrail-aware invocation, input tagging, fallback handling), and observability (metric filter + alarm). TypeScript for CDK, Python for Lambda.

## Tasks

- [x] 1. Provision Bedrock Guardrail resource and SSM parameters in ApiGatewayStack
  - [ ] 1.1 Add CfnGuardrail resource with content filters, topic policies, word filters, and contextual grounding
    - Add `import * as bedrock from 'aws-cdk-lib/aws-bedrock'` to api-gateway-stack.ts
    - Create `CfnGuardrail` with name `${id}-TextGenGuardrail`
    - Configure `blockedInputMessaging` and `blockedOutputMessaging` per requirements
    - Add `contentPolicyConfig` with HATE, INSULTS, SEXUAL, VIOLENCE, MISCONDUCT (environment-aware strength) and PROMPT_ATTACK (HIGH input, NONE output)
    - Add `topicPolicyConfig` with MedicalLegalPsychologicalAdvice, PersonalInformationRequests, PromptDisclosure (each with 5+ examples)
    - Add `wordPolicyConfig` with managed PROFANITY list and custom wordsConfig
    - Add `contextualGroundingPolicyConfig` with GROUNDING and RELEVANCE thresholds at 0.7
    - Derive `filterStrength` from `isProd ? 'HIGH' : 'MEDIUM'`
    - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.2, 3.1, 3.2, 3.3, 3.4, 3.6, 4.1, 4.2, 5.1, 5.2, 9.1, 9.2, 9.3, 9.4_

  - [x] 1.2 Add CfnGuardrailVersion, SSM parameters, and Lambda environment variables
    - Create `CfnGuardrailVersion` referencing `guardrail.attrGuardrailId`
    - Call `guardrailVersion.addDependency(guardrail)`
    - Create SSM StringParameter at `/${id}/AILA/GuardrailId` with `guardrail.attrGuardrailId`
    - Create SSM StringParameter at `/${id}/AILA/GuardrailVersion` with `guardrailVersion.attrVersion`
    - Add `GUARDRAIL_ID_PARAM` and `GUARDRAIL_VERSION_PARAM` environment variables to `textGenLambdaDockerFunc`
    - _Requirements: 1.2, 1.5, 10.8_

  - [x] 1.3 Add IAM permissions for bedrock:ApplyGuardrail and ssm:GetParameter
    - Add `bedrock:ApplyGuardrail` PolicyStatement to the text generation Lambda role scoped to `arn:aws:bedrock:${region}:${account}:guardrail/${guardrail.attrGuardrailId}`
    - Add guardrail SSM parameter ARNs to existing SSM `ssm:GetParameter` PolicyStatement (or create new one)
    - No wildcards in actions or resources
    - _Requirements: 1.6, 6.1, 6.2, 6.3_

- [x] 2. Checkpoint - Verify CDK synthesis
  - Ensure `npx tsc --noEmit` passes and CDK code compiles with no type errors, ask the user if questions arise.

- [x] 3. Implement guardrail integration in Lambda runtime
  - [x] 3.1 Add guardrail SSM initialization to main.py
    - Add `GUARDRAIL_ID_PARAM` and `GUARDRAIL_VERSION_PARAM` env var reads
    - Add `_guardrail_id` and `_guardrail_version` module-level cache variables (None = not loaded, "" = failed)
    - Implement `initialize_guardrail_config()` that retrieves from SSM, caches values; on failure logs WARNING with parameter name and error, sets empty strings
    - Call `initialize_guardrail_config()` from `handler()` after `initialize_constants()`
    - _Requirements: 7.1, 7.5, 10.3_

  - [x] 3.2 Add input tagging function to helpers/chat.py
    - Implement `wrap_user_message_with_guardrail_tags(user_message: str) -> str`
    - Generate 8-character random alphanumeric `tagSuffix` using `secrets.choice`
    - Wrap user message in `<amazon-bedrock-guardrails-guardContent_{tagSuffix}>` tags
    - _Requirements: 7.7_

  - [x] 3.3 Modify get_bedrock_llm to accept guardrail parameters
    - Add `guardrail_id: str = ""` and `guardrail_version: str = ""` parameters
    - Include guardrail_id and guardrail_version in cache key
    - When both are non-empty, add `guardrails` dict with `guardrailIdentifier`, `guardrailVersion`, and `trace: True`
    - _Requirements: 7.2, 7.8, 7.9_

  - [x] 3.4 Modify get_response_streaming to remove inline guardrails and add input tagging
    - Remove the `guardrails` string variable and its inclusion in `system_prompt`
    - Retain all pedagogical instructions (instructor role, Socratic questioning, 5-interaction/300-word threshold, completion phrase)
    - Continue including `course_system_prompt` and `module_prompt` in system prompt
    - Call `wrap_user_message_with_guardrail_tags()` on the user query before passing to the chain
    - _Requirements: 7.7, 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 3.5 Implement guardrail error handling and fallback in handler
    - Wrap the LLM invocation in try/except for guardrail-specific errors
    - On guardrail service error: log ERROR with session_id, guardrail_id, exception type/message
    - Retry invocation without guardrail params (create new LLM instance without guardrails dict)
    - If fallback also fails: return HTTP 500
    - On guardrail intervention (input/output blocked): return HTTP 200 with `llm_output` = blocked message, `llm_verdict` = false
    - Log INFO for guardrail interventions with intervention type, session_id, course_id
    - _Requirements: 7.3, 7.4, 7.6, 10.1, 10.2, 10.4, 10.5_

  - [x] 3.6 Wire guardrail params through handler to get_bedrock_llm call
    - Pass `_guardrail_id` and `_guardrail_version` from main.py to `get_bedrock_llm()` call
    - Ensure empty strings (SSM failure) result in LLM created without guardrails dict
    - _Requirements: 7.1, 7.2, 10.5_

- [x] 4. Checkpoint - Verify Lambda code integrity
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Add observability alarm for guardrail failures
  - [x] 5.1 Add CloudWatch Metric Filter and Alarm in ObservabilityStack
    - Import `logs` from `aws-cdk-lib/aws-logs` (if not already imported)
    - Create MetricFilter on text generation Lambda log group matching structured JSON pattern for ERROR level guardrail failures
    - Use `logs.FilterPattern.any()` with JSON-based pattern matching (`$.level` = ERROR and `$.message` containing guardrail error indicator)
    - Create CloudWatch Alarm with threshold 1, evaluation period 1 minute, treat missing data as NOT_BREACHING
    - Add alarm action to publish to `criticalTopic` SNS
    - Pass `textGenFunctionName` to ObservabilityStack props (or use existing `containerLambdaNames`)
    - _Requirements: 10.6, 10.7_

- [x] 6. Write CDK assertion tests
  - [x] 6.1 Create guardrail-resource.test.ts for guardrail infrastructure assertions
    - Assert CfnGuardrail resource exists with correct name pattern
    - Assert content filter policies (all 6 types with correct strengths)
    - Assert topic policies (3 denied topics with correct definitions)
    - Assert word filter configuration (managed profanity + custom words)
    - Assert contextual grounding filter (0.7 thresholds)
    - Assert CfnGuardrailVersion exists and references guardrail
    - Assert SSM parameters created at correct paths
    - Assert environment-aware filter strengths (test both dev and prod templates)
    - _Requirements: 1.1, 1.2, 1.5, 2.1, 2.2, 3.1, 3.2, 3.3, 4.1, 5.1, 5.2, 9.1, 9.2, 9.3, 9.4_

  - [x] 6.2 Add IAM assertion tests to iam-policies.test.ts
    - Assert `bedrock:ApplyGuardrail` PolicyStatement exists with guardrail-scoped resource ARN
    - Assert no wildcard resources in the guardrail permission
    - Assert `ssm:GetParameter` includes guardrail parameter ARNs
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 6.3 Create observability.test.ts assertions for guardrail alarm
    - Assert metric filter exists on text generation Lambda log group
    - Assert CloudWatch Alarm exists with correct threshold and evaluation period
    - Assert alarm action targets SNS critical topic
    - _Requirements: 10.6, 10.7_

- [x] 7. Checkpoint - Run CDK tests
  - All 36 CDK tests pass (8 test suites).

- [ ] 8. Write Python unit tests and property tests
  - [ ]* 8.1 Write property test: Guardrails parameter dict is correctly constructed
    - **Property 1: Guardrails parameter dict is correctly constructed**
    - **Validates: Requirements 7.2**
    - Use Hypothesis to generate arbitrary non-empty guardrail_id and guardrail_version strings
    - Assert returned dict has exactly keys `guardrailIdentifier`, `guardrailVersion`, `trace`
    - Assert values match inputs and trace is True

  - [ ]* 8.2 Write property test: Input tags scope evaluation to user message only
    - **Property 3: Input tags scope evaluation to user message only**
    - **Validates: Requirements 7.7**
    - Use Hypothesis to generate arbitrary user messages (text strategy)
    - Assert output contains the user message between opening and closing tags
    - Assert tagSuffix is exactly 8 alphanumeric characters
    - Assert tags follow the `<amazon-bedrock-guardrails-guardContent_{suffix}>` format

  - [ ]* 8.3 Write property test: System prompt excludes inline guardrails and preserves pedagogical content
    - **Property 4: System prompt construction excludes inline guardrails and preserves pedagogical content**
    - **Validates: Requirements 8.1, 8.3, 8.4**
    - Use Hypothesis to generate topic, course_system_prompt, and module_prompt strings
    - Assert none of the inline guardrail phrases appear in constructed prompt
    - Assert course_system_prompt, module_prompt, instructor role, and completion threshold are present

  - [ ]* 8.4 Write property test: Guardrail intervention produces consistent response structure
    - **Property 2: Guardrail intervention produces consistent response structure**
    - **Validates: Requirements 7.3, 7.4**
    - Use Hypothesis to generate arbitrary blocked message strings
    - Assert response has HTTP 200, `llm_output` equals blocked message, `llm_verdict` is False

  - [ ]* 8.5 Write property test: Fallback invocation excludes guardrail parameters
    - **Property 5: Fallback invocation excludes guardrail parameters**
    - **Validates: Requirements 10.2, 10.5**
    - Mock guardrail service error, assert retry call does not include guardrailIdentifier or guardrailVersion

  - [ ]* 8.6 Write unit tests for guardrail initialization and error handling
    - Test SSM retrieval success caches values correctly
    - Test SSM retrieval failure logs WARNING and sets empty strings
    - Test fallback retry triggers on guardrail error and retries without params
    - _Requirements: 7.1, 7.5, 10.1, 10.2, 10.3, 10.4_

- [x] 9. Final checkpoint - Ensure all tests pass
  - All 36 CDK tests pass. Python tests (task 8) are optional.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties defined in the design document (Hypothesis library)
- Unit tests validate specific examples and edge cases
- CDK tests use `createTestStacks()` for ApiGatewayStack assertions and `createObservabilityTemplate()` for ObservabilityStack assertions
- The `langchain-aws` package is already pinned at `1.4.4` in requirements.txt — no change needed
- `logging.getLogger` in chat.py must be migrated to Powertools Logger when the file is touched (per Lambda coding standards)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "3.1", "3.2"] },
    { "id": 3, "tasks": ["3.3", "3.4"] },
    { "id": 4, "tasks": ["3.5", "3.6"] },
    { "id": 5, "tasks": ["5.1"] },
    { "id": 6, "tasks": ["6.1", "6.2", "6.3"] },
    { "id": 7, "tasks": ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"] }
  ]
}
```

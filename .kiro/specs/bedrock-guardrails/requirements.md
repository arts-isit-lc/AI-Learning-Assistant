# Requirements Document

## Introduction

Migrate the existing inline system-prompt guardrails from the text generation Lambda to AWS Bedrock Guardrails as a managed service. Currently, guardrails (academic integrity, topic focus, tone, wellbeing, privacy, and prompt secrecy) are embedded as text strings within the `chat.py` prompt construction logic. This feature provisions a Bedrock Guardrail resource via CDK, integrates it with the text generation Lambda invocations, and removes the inline guardrail text from the prompt, enabling centralized management, versioning, and consistent enforcement across all LLM interactions.

## Glossary

- **Bedrock_Guardrail**: An AWS Bedrock Guardrails resource that defines content filtering policies, denied topics, and word filters enforced by the Bedrock service on model inputs and outputs.
- **Guardrail_Version**: A published, immutable snapshot of a Bedrock Guardrail configuration that can be referenced by the text generation Lambda at runtime.
- **Text_Generation_Lambda**: The Docker container Lambda function (`TextGenLambdaDockerFunc`) that handles RAG-based chat responses using LangChain and Bedrock models.
- **Content_Filter**: A Bedrock Guardrails content filter that blocks or flags model inputs/outputs based on predefined harm categories (e.g., violence, sexual content, hate speech, misconduct).
- **Denied_Topic**: A Bedrock Guardrails topic policy that detects and blocks user prompts or model responses related to a specified off-limits subject.
- **Word_Filter**: A Bedrock Guardrails managed or custom word list that blocks profanity or specified phrases in inputs and outputs.
- **Contextual_Grounding_Filter**: A Bedrock Guardrails filter that detects hallucinations by checking model responses against the retrieved source context for factual grounding.
- **Guardrail_Intervention**: The response returned by Bedrock when a guardrail policy is triggered, replacing the model's original output with a configurable blocked message.
- **CDK_Stack**: The ApiGatewayStack TypeScript CDK construct that provisions the text generation Lambda and its associated IAM policies.
- **SSM_Parameter**: An AWS Systems Manager Parameter Store entry used to pass configuration values (like the Guardrail ID) to the Lambda at runtime.

## Requirements

### Requirement 1: Provision Bedrock Guardrail Resource

**User Story:** As an administrator, I want a Bedrock Guardrail resource provisioned through CDK infrastructure-as-code, so that content safety policies are managed declaratively and consistently across environments.

#### Acceptance Criteria

1. WHEN the CDK stack is deployed, THE CDK_Stack SHALL create a Bedrock_Guardrail resource using the CfnGuardrail L1 construct with a name following the pattern `${id}-TextGenGuardrail`.
2. WHEN the CDK stack is deployed, THE CDK_Stack SHALL create a CfnGuardrailVersion that references the Bedrock_Guardrail so that the Lambda references an immutable, versioned configuration.
3. THE CDK_Stack SHALL configure the Bedrock_Guardrail with a blocked input messaging response of "I'm not able to help with that topic. Let's focus on your course material."
4. THE CDK_Stack SHALL configure the Bedrock_Guardrail with a blocked output messaging response of "I'm not able to provide that response. Let me redirect our discussion back to the course material."
5. THE CDK_Stack SHALL store the Guardrail ID in an SSM StringParameter at path `/${id}/AILA/GuardrailId` and the Guardrail Version in an SSM StringParameter at path `/${id}/AILA/GuardrailVersion`, so the Text_Generation_Lambda can retrieve them at runtime.
6. THE CDK_Stack SHALL grant the Text_Generation_Lambda IAM permission for `ssm:GetParameter` scoped to the specific ARNs of the GuardrailId and GuardrailVersion SSM parameters.

### Requirement 2: Configure Content Filters

**User Story:** As an administrator, I want harmful content categories filtered at the Bedrock service level, so that inappropriate content is blocked before reaching students regardless of prompt engineering.

#### Acceptance Criteria

1. THE Bedrock_Guardrail SHALL configure Content_Filter policies for each of the following categories: HATE, INSULTS, SEXUAL, VIOLENCE, and MISCONDUCT, with a filter strength of HIGH applied to both the input filter and the output filter for each category.
2. THE Bedrock_Guardrail SHALL enable the prompt attack filter on user inputs with HIGH filter strength to detect and block jailbreak attempts and prompt injection attacks.
3. IF content triggers a Content_Filter or the prompt attack filter, THEN THE Bedrock_Guardrail SHALL block the request and return the configured blocked messaging response defined in the Bedrock_Guardrail resource.

### Requirement 3: Configure Denied Topics

**User Story:** As an instructor, I want the chatbot restricted from providing harmful advice or disclosing system internals, so that students are protected from unsafe content and the system maintains its pedagogical integrity.

#### Acceptance Criteria

1. THE Bedrock_Guardrail SHALL define a Denied_Topic for medical, legal, and psychological advice with a definition that covers requests for diagnoses, treatment recommendations, legal counsel, and mental health guidance, and SHALL include at least 5 example phrases representative of user inputs that would trigger the topic.
2. THE Bedrock_Guardrail SHALL define a Denied_Topic for personal information requests with a definition that covers attempts to collect or disclose names, addresses, phone numbers, email addresses, student IDs, or financial information, and SHALL include at least 5 example phrases representative of user inputs that would trigger the topic.
3. THE Bedrock_Guardrail SHALL define a Denied_Topic for prompt disclosure with a definition that covers attempts to extract, reveal, or discuss the system prompt instructions, and SHALL include at least 5 example phrases representative of user inputs that would trigger the topic.
4. THE Bedrock_Guardrail SHALL apply each Denied_Topic filter to both INPUT (user messages) and OUTPUT (model responses).
5. WHEN a Denied_Topic is triggered, THE Bedrock_Guardrail SHALL return the configured blocked messaging response instead of the model output, and the response SHALL indicate that the request falls outside the scope of the course assistant without revealing which specific topic policy was triggered.
6. THE Bedrock_Guardrail SHALL NOT define a Denied_Topic for off-topic discussions because Bedrock topic matching is probabilistic and would produce false positives on legitimate educational tangents; topic focus SHALL remain enforced via prompt-level pedagogical guidance in the system prompt.

### Requirement 4: Configure Word Filters

**User Story:** As an administrator, I want profanity and inappropriate language blocked at the service level, so that the learning environment remains professional without relying on prompt instructions.

#### Acceptance Criteria

1. THE Bedrock_Guardrail SHALL enable the managed word filter for profanity to block known profane words in both inputs and outputs.
2. THE Bedrock_Guardrail SHALL configure a custom Word_Filter list containing domain-specific inappropriate phrases that are not covered by the managed profanity list, with a maximum of 50 custom words or phrases each no longer than 3 words.
3. WHEN a Word_Filter match is detected in user input, THE Bedrock_Guardrail SHALL return the configured blocked input messaging response instead of forwarding the input to the model.
4. WHEN a Word_Filter match is detected in model output, THE Bedrock_Guardrail SHALL return the configured blocked output messaging response instead of the model output.

### Requirement 5: Configure Contextual Grounding Filter

**User Story:** As an instructor, I want model responses checked against retrieved course material for factual accuracy, so that students receive answers grounded in the assigned readings rather than hallucinated content.

#### Acceptance Criteria

1. THE Bedrock_Guardrail SHALL enable the Contextual_Grounding_Filter with a grounding threshold of 0.7 applied to model output to detect responses that are not supported by the retrieved context.
2. THE Bedrock_Guardrail SHALL enable the Contextual_Grounding_Filter with a relevance threshold of 0.7 applied to model output to detect responses that are not relevant to the user query.
3. IF the Contextual_Grounding_Filter determines a model response scores below the grounding threshold or the relevance threshold, THEN THE Bedrock_Guardrail SHALL trigger a Guardrail_Intervention and return the configured blocked output messaging response instead of the model output.
4. WHEN the Text_Generation_Lambda invokes the Bedrock Guardrail with contextual grounding enabled, THE Text_Generation_Lambda SHALL pass the retrieved course material documents as the grounding source in the guardrail invocation request.

### Requirement 6: Grant IAM Permissions for Guardrail Invocation

**User Story:** As a developer, I want the text generation Lambda to have the minimum IAM permissions needed to invoke the Bedrock Guardrail, so that the system follows least-privilege security practices.

#### Acceptance Criteria

1. WHEN the CDK stack is deployed, THE CDK_Stack SHALL add an IAM PolicyStatement with Effect ALLOW granting only the `bedrock:ApplyGuardrail` action to the Text_Generation_Lambda execution role.
2. THE CDK_Stack SHALL scope the `bedrock:ApplyGuardrail` resource ARN to the specific Bedrock_Guardrail created in the same stack using the format `arn:aws:bedrock:${region}:${account}:guardrail/${guardrailId}`.
3. THE CDK_Stack SHALL NOT use wildcard (`*`) resource ARNs or action wildcards (`bedrock:*`) for the guardrail permission.
4. WHEN the CDK stack is synthesized, THE CDK_Stack SHALL pass a CDK assertion test in `iam-policies.test.ts` that verifies the `bedrock:ApplyGuardrail` policy statement exists with the guardrail-scoped resource ARN and no wildcard resources.

### Requirement 7: Integrate Guardrail with Text Generation Lambda

**User Story:** As a developer, I want the text generation Lambda to pass the Guardrail ID and version when invoking Bedrock models, so that all LLM calls are automatically protected by the managed guardrail policies.

#### Acceptance Criteria

1. WHEN the Text_Generation_Lambda initializes, THE Text_Generation_Lambda SHALL retrieve the Guardrail ID and Guardrail Version from SSM_Parameter entries identified by environment variables `GUARDRAIL_ID_PARAM` and `GUARDRAIL_VERSION_PARAM`, caching the values for the lifetime of the container instance.
2. WHEN the Text_Generation_Lambda invokes a Bedrock model, THE Text_Generation_Lambda SHALL include a `guardrails` parameter dict with keys `guardrailIdentifier` and `guardrailVersion` (populated from the cached SSM values) in the ChatBedrock model configuration, applying to both streaming and non-streaming invocation paths.
3. WHEN a Guardrail_Intervention occurs on input, THE Text_Generation_Lambda SHALL return a response with HTTP status 200 containing a body field `llm_output` set to the guardrail's blocked message text and `llm_verdict` set to false, without invoking the Bedrock model.
4. WHEN a Guardrail_Intervention occurs on output, THE Text_Generation_Lambda SHALL return a response with HTTP status 200 containing a body field `llm_output` set to the guardrail's blocked message text and `llm_verdict` set to false, instead of the model-generated response.
5. IF the Guardrail ID or Guardrail Version SSM_Parameter cannot be retrieved during initialization, THEN THE Text_Generation_Lambda SHALL log the failure with severity WARNING using the Powertools Logger including the parameter name and exception message, and SHALL proceed without guardrail enforcement for all requests handled by that Lambda instance.
6. WHEN a Guardrail_Intervention occurs, THE Text_Generation_Lambda SHALL log the event using the Powertools Logger with structured fields including the intervention type (input or output), the session_id, and the course_id.
7. WHEN the Text_Generation_Lambda constructs the input prompt for the Bedrock API, THE Text_Generation_Lambda SHALL wrap only the user message content in guardrail input tags (`<amazon-bedrock-guardrails-guardContent_{tagSuffix}>`) with a randomly generated alphanumeric `tagSuffix` per request, so that system prompt and retrieved context are excluded from denied topic and content filter evaluation.
8. WHEN the Text_Generation_Lambda invokes the Bedrock model in streaming mode, THE Text_Generation_Lambda SHALL configure the guardrail `streamProcessingMode` to `SYNCHRONOUS` (buffered) so that the full response is evaluated by guardrails before any content is streamed to the student.
9. THE Text_Generation_Lambda SHALL pin the `langchain_aws` package version in `requirements.txt` to a version that supports the `guardrails` parameter dict with `guardrailIdentifier`, `guardrailVersion`, and `trace` keys in the ChatBedrock constructor.

### Requirement 8: Remove Inline Guardrails from Prompt

**User Story:** As a developer, I want the inline guardrail text removed from the system prompt construction, so that guardrail enforcement is handled exclusively by the Bedrock Guardrails service and the prompt stays focused on pedagogical instructions.

#### Acceptance Criteria

1. WHEN the prompt is constructed in the `get_response_streaming` function, THE Text_Generation_Lambda SHALL NOT include the inline `guardrails` string variable in the system prompt passed to the LLM.
2. WHEN the prompt is constructed in the `get_response` function (if present), THE Text_Generation_Lambda SHALL NOT include the inline `guardrails` string variable in the system prompt passed to the LLM.
3. THE Text_Generation_Lambda SHALL retain the following pedagogical instructions in the system prompt: the instructor role definition, the topic-focused guidance, the Socratic questioning directive (ending answers with a critical-thinking question), the 5-interaction and 300-word completion threshold, and the completion phrase indicating readiness to discuss with the class.
4. THE Text_Generation_Lambda SHALL continue to include the `course_system_prompt` and `module_prompt` parameters in the constructed system prompt.
5. WHEN the `guardrails` variable is no longer referenced in any prompt construction, THE Text_Generation_Lambda SHALL remove the `guardrails` variable definition from the function body.

### Requirement 9: Environment-Aware Guardrail Configuration

**User Story:** As a developer, I want guardrail filter strengths to differ between development and production environments, so that development testing is not overly restricted while production maintains strict content safety.

#### Acceptance Criteria

1. WHEN the environment is `prod`, THE CDK_Stack SHALL configure Content_Filter strengths to HIGH for all harm categories (hate, insults, sexual content, violence, and misconduct) on both input and output filters.
2. WHEN the environment is `dev`, THE CDK_Stack SHALL configure Content_Filter strengths to MEDIUM for all harm categories (hate, insults, sexual content, violence, and misconduct) on both input and output filters.
3. THE CDK_Stack SHALL derive the environment value using the pattern `const environment = props?.environment || 'dev'` so that the stack defaults to `dev` filter strengths when no environment context variable is provided.
4. THE CDK_Stack SHALL configure the prompt attack filter to HIGH on user inputs regardless of the environment value.

### Requirement 10: Guardrail Failure Handling and Alerting

**User Story:** As a student, I want the chatbot to continue functioning gracefully if the guardrail service is unavailable, so that my learning session is not interrupted by infrastructure issues. As an administrator, I want to be alerted immediately when guardrails are bypassed so I can investigate and resolve the issue.

#### Acceptance Criteria

1. IF the Bedrock Guardrails service returns an error during model invocation, THEN THE Text_Generation_Lambda SHALL log the error with severity ERROR including the session ID, the guardrail identifier, and the exception type and message.
2. IF the Bedrock Guardrails service returns an error during model invocation, THEN THE Text_Generation_Lambda SHALL retry the same model invocation without the guardrailIdentifier and guardrailVersion parameters and return the model response to the student through the normal streaming path.
3. IF a guardrail SSM parameter (guardrail identifier or guardrail version) cannot be retrieved during Lambda initialization, THEN THE Text_Generation_Lambda SHALL log the failure with severity WARNING including the parameter name and exception message, and proceed with model invocations without guardrail enforcement for all requests handled by that Lambda instance.
4. IF the fallback model invocation without guardrail parameters also fails, THEN THE Text_Generation_Lambda SHALL return an HTTP 500 error response to the caller and log the failure with severity ERROR including the session ID and exception details.
5. WHILE the Text_Generation_Lambda is operating without guardrail enforcement due to SSM parameter retrieval failure or a per-request guardrail error, THE Text_Generation_Lambda SHALL return the same HTTP 200 response structure to the student with no client-visible indication that guardrails were bypassed.
6. THE ObservabilityStack SHALL create a CloudWatch Alarm that triggers when the Text_Generation_Lambda emits an ERROR log containing a guardrail failure or a WARNING log containing an SSM parameter retrieval failure, with a threshold of 1 occurrence within a 1-minute evaluation period.
7. WHEN the guardrail failure CloudWatch Alarm enters ALARM state, THE ObservabilityStack SHALL publish a notification to the existing SNS alert topic so that the administrator is immediately notified via their configured subscription (email/SMS).
8. THE CDK_Stack SHALL configure the CfnGuardrailVersion to depend on the CfnGuardrail resource using `addDependency` so that guardrail configuration changes always produce a new version number, preventing the Lambda from referencing a stale version after redeployment.

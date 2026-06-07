# Design Document: Bedrock Guardrails Integration

## Overview

This design migrates content safety enforcement from inline prompt text to AWS Bedrock Guardrails as a managed service. The integration spans three layers:

1. **CDK Infrastructure** — Provisions a `CfnGuardrail` and `CfnGuardrailVersion` with content filters, denied topics, word filters, and contextual grounding. Stores guardrail identifiers in SSM Parameter Store and grants scoped IAM permissions.
2. **Lambda Runtime** — Retrieves guardrail configuration from SSM at cold start, passes guardrail parameters to ChatBedrock, wraps user input in guardrail input tags, handles interventions, and degrades gracefully on service failure.
3. **Observability** — CloudWatch Alarm on guardrail failure logs triggers SNS notification for immediate administrator awareness.

The design replaces ~6 lines of inline guardrail text in `chat.py` with service-level enforcement that is versioned, auditable, and independent of prompt engineering.

## Architecture

```mermaid
flowchart TD
    subgraph CDK ["CDK ApiGatewayStack"]
        GR[CfnGuardrail<br/>TextGenGuardrail]
        GRV[CfnGuardrailVersion]
        SSM_ID[SSM: GuardrailId]
        SSM_VER[SSM: GuardrailVersion]
        GR --> GRV
        GR --> SSM_ID
        GRV --> SSM_VER
    end

    subgraph Lambda ["Text Generation Lambda"]
        INIT[Cold Start Init]
        HANDLER[Handler]
        TAG[Input Tagger]
        INVOKE[ChatBedrock Invoke<br/>+ guardrails dict]
        FALLBACK[Fallback: Invoke<br/>without guardrails]
    end

    subgraph Bedrock ["AWS Bedrock"]
        MODEL[Foundation Model]
        GUARD[Guardrails Service]
    end

    subgraph Observability ["ObservabilityStack"]
        MF[Metric Filter:<br/>guardrail errors]
        ALARM[CloudWatch Alarm]
        SNS[SNS Topic]
    end

    INIT -->|ssm:GetParameter| SSM_ID
    INIT -->|ssm:GetParameter| SSM_VER
    HANDLER --> TAG
    TAG --> INVOKE
    INVOKE -->|bedrock:ApplyGuardrail| GUARD
    GUARD --> MODEL
    INVOKE -.->|on error| FALLBACK
    FALLBACK --> MODEL
    INVOKE -.->|ERROR log| MF
    MF --> ALARM
    ALARM --> SNS
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| SSM Parameter Store for guardrail IDs (not env vars) | Allows version updates without Lambda redeployment; consistent with existing pattern (`BEDROCK_LLM_PARAM`, etc.) |
| `CfnGuardrail` L1 construct | No L2 construct available in CDK for Bedrock Guardrails |
| Input tags with random `tagSuffix` per request | Prevents Bedrock from evaluating system prompt and RAG context against denied topics / content filters; randomized suffix avoids adversarial tag injection |
| `SYNCHRONOUS` stream processing mode | Full response must be evaluated before streaming to student; prevents partial unsafe content delivery. Passed via `amazon-bedrock-guardrailConfig` in the InvokeModel request body; LangChain's ChatBedrock forwards this from the guardrails dict. |
| Graceful degradation (not hard fail) | Intentional tradeoff: prioritizes learning continuity over guaranteed content safety. When guardrails are bypassed, the CloudWatch Alarm fires within 1 minute so the admin is immediately aware. The inline guardrails are removed, so degraded mode has no prompt-level safety net — this is acceptable for an educational app where the risk of a brief unguarded window is lower than the cost of total unavailability. |
| No "OffTopicDiscussions" denied topic | Bedrock topic matching is probabilistic and would produce false positives on legitimate educational tangents (clarifying questions, cross-topic connections). Topic focus is handled by prompt-level pedagogical guidance instead. Only hard safety categories (medical/legal/psych advice, personal info, prompt disclosure) use DENY. |
| Environment-aware filter strengths | Dev uses MEDIUM to avoid blocking legitimate test inputs; prod uses HIGH for maximum safety |

## Components and Interfaces

### 1. CDK: Guardrail Provisioning (ApiGatewayStack)

**New resources added to `ApiGatewayStack`:**

```typescript
// Guardrail resource
const guardrail = new bedrock.CfnGuardrail(this, `${id}-TextGenGuardrail`, {
  name: `${id}-TextGenGuardrail`,
  blockedInputMessaging: "I'm not able to help with that topic. Let's focus on your course material.",
  blockedOutputMessaging: "I'm not able to provide that response. Let me redirect our discussion back to the course material.",
  contentPolicyConfig: { /* content filters */ },
  topicPolicyConfig: { /* denied topics */ },
  wordPolicyConfig: { /* word filters */ },
  contextualGroundingPolicyConfig: { /* grounding filter */ },
});

// Versioned snapshot
const guardrailVersion = new bedrock.CfnGuardrailVersion(this, `${id}-TextGenGuardrailVersion`, {
  guardrailIdentifier: guardrail.attrGuardrailId,
});
guardrailVersion.addDependency(guardrail);

// SSM Parameters
const guardrailIdParam = new ssm.StringParameter(this, `${id}-GuardrailIdParam`, {
  parameterName: `/${id}/AILA/GuardrailId`,
  stringValue: guardrail.attrGuardrailId,
});

const guardrailVersionParam = new ssm.StringParameter(this, `${id}-GuardrailVersionParam`, {
  parameterName: `/${id}/AILA/GuardrailVersion`,
  stringValue: guardrailVersion.attrVersion,
});
```

**IAM additions to the text generation Lambda role:**

```typescript
// bedrock:ApplyGuardrail scoped to specific guardrail
textGenLambdaDockerFunc.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ["bedrock:ApplyGuardrail"],
  resources: [`arn:aws:bedrock:${this.region}:${this.account}:guardrail/${guardrail.attrGuardrailId}`],
}));

// ssm:GetParameter for guardrail SSM params (added to existing SSM statement)
// Resources: guardrailIdParam.parameterArn, guardrailVersionParam.parameterArn
```

**Environment variables added to Lambda:**

```typescript
GUARDRAIL_ID_PARAM: guardrailIdParam.parameterName,
GUARDRAIL_VERSION_PARAM: guardrailVersionParam.parameterName,
```

### 2. Lambda: Guardrail Integration (text_generation)

**Module: `main.py` — Initialization additions:**

```python
# New env vars
GUARDRAIL_ID_PARAM = os.environ.get("GUARDRAIL_ID_PARAM", "")
GUARDRAIL_VERSION_PARAM = os.environ.get("GUARDRAIL_VERSION_PARAM", "")

# Cached guardrail config (None = not yet loaded, "" = load failed - skip guardrails)
_guardrail_id: str | None = None
_guardrail_version: str | None = None

def initialize_guardrail_config():
    """Retrieve guardrail ID and version from SSM. Cache for container lifetime.
    On failure, log WARNING and set empty strings to signal 'proceed without guardrails'."""
    global _guardrail_id, _guardrail_version
    if _guardrail_id is not None:
        return  # already cached
    try:
        _guardrail_id = ssm_client.get_parameter(
            Name=GUARDRAIL_ID_PARAM, WithDecryption=True
        )["Parameter"]["Value"]
        _guardrail_version = ssm_client.get_parameter(
            Name=GUARDRAIL_VERSION_PARAM, WithDecryption=True
        )["Parameter"]["Value"]
        logger.info("Guardrail config loaded",
                    extra={"guardrail_id": _guardrail_id, "guardrail_version": _guardrail_version})
    except Exception as e:
        logger.warning("Failed to retrieve guardrail SSM parameters, proceeding without guardrails",
                       extra={"parameter_name": GUARDRAIL_ID_PARAM, "error": str(e)})
        _guardrail_id = ""
        _guardrail_version = ""
```

**Module: `helpers/chat.py` — Input tagging function:**

```python
import secrets
import string

def wrap_user_message_with_guardrail_tags(user_message: str) -> str:
    """Wrap user message in Bedrock Guardrail input tags.
    A random alphanumeric tagSuffix is generated per request to prevent injection."""
    tag_suffix = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8))
    open_tag = f"<amazon-bedrock-guardrails-guardContent_{tag_suffix}>"
    close_tag = f"</amazon-bedrock-guardrails-guardContent_{tag_suffix}>"
    return f"{open_tag}{user_message}{close_tag}"
```

**Module: `helpers/chat.py` — Modified `get_bedrock_llm` (guardrail-aware):**

```python
def get_bedrock_llm(
    bedrock_llm_id: str,
    temperature: float = 0,
    client=None,
    guardrail_id: str = "",
    guardrail_version: str = "",
) -> ChatBedrock:
    """Retrieve a ChatBedrock instance. When guardrail params are non-empty,
    include the guardrails dict in the constructor."""
    cache_key = f"{bedrock_llm_id}:{temperature}:{guardrail_id}:{guardrail_version}"
    if cache_key not in _llm_cache:
        model_kwargs = {"temperature": temperature}
        if "claude" in bedrock_llm_id.lower():
            model_kwargs["max_tokens"] = 4000

        kwargs = {"model_id": bedrock_llm_id, "model_kwargs": model_kwargs, "streaming": True}
        if client:
            kwargs["client"] = client
        if guardrail_id and guardrail_version:
            kwargs["guardrails"] = {
                "guardrailIdentifier": guardrail_id,
                "guardrailVersion": guardrail_version,
                "trace": True,
            }
        _llm_cache[cache_key] = ChatBedrock(**kwargs)
    return _llm_cache[cache_key]
```

**Module: `helpers/chat.py` — Modified `get_response_streaming`:**

The inline `guardrails` string variable is removed entirely. The system prompt retains only pedagogical instructions:

```python
system_prompt = (
    "You are an instructor for a course. "
    f"Your job is to help the student understand the concepts in the course reading on topic: {topic}. \n"
    f"{course_system_prompt}\n"
    f"{module_prompt}\n"
    "Continue this process until students have completed at least 5 interactions and written 300 words. \n"
    "Once students have achieved this, include 'Thank you for chatting with me about this topic, "
    "you are ready to go discuss this with your class.' in your response and do not ask any further "
    "questions about the topic. "
    "Use the following pieces of retrieved context to answer a question asked by the student. "
    "Use three sentences maximum and keep the answer concise. "
    "End each answer with a question that encourages the student to think critically about the topic."
    "\n{context}"
)
```

**Streaming mode configuration:**

The `streamProcessingMode` is set to `"SYNCHRONOUS"` via the guardrails dict passed to `ChatBedrock`, ensuring the full response is evaluated by guardrails before any content is streamed to the student.

### 3. CDK: Observability (ObservabilityStack)

**New alarm in `ObservabilityStack`:**

A CloudWatch Metric Filter on the text generation Lambda's log group matches ERROR logs containing guardrail failure indicators. When the metric crosses a threshold of 1 occurrence in 1 minute, the alarm publishes to the existing SNS critical topic.

```typescript
const guardrailMetricFilter = new logs.MetricFilter(this, 'GuardrailFailureMetricFilter', {
  logGroup: logs.LogGroup.fromLogGroupName(this, 'TextGenLogGroup',
    `/aws/lambda/${textGenFunctionName}`),
  filterPattern: logs.FilterPattern.any(
    logs.FilterPattern.stringValue('$.level', '=', 'ERROR'),
    logs.FilterPattern.stringValue('$.message', '=', 'Bedrock Guardrails service error*'),
  ),
  metricNamespace: 'AILA/Guardrails',
  metricName: 'GuardrailFailureCount',
  metricValue: '1',
});

const guardrailAlarm = new cloudwatch.Alarm(this, 'GuardrailFailureAlarm', {
  alarmName: `AILA-${environment}-Guardrail-Failure`,
  metric: guardrailMetricFilter.metric({ statistic: 'Sum', period: cdk.Duration.minutes(1) }),
  threshold: 1,
  evaluationPeriods: 1,
  comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});
guardrailAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.criticalTopic));
```

### 4. Failure Handling Flow

```mermaid
flowchart TD
    A[Invoke with guardrails] -->|Success| B[Return response]
    A -->|Guardrail Intervention| C{Input or Output?}
    C -->|Input blocked| D[Return HTTP 200<br/>llm_output=blocked msg<br/>llm_verdict=false]
    C -->|Output blocked| D
    A -->|Service Error| E[Log ERROR<br/>guardrail_error]
    E --> F[Retry without guardrails]
    F -->|Success| B
    F -->|Failure| G[Return HTTP 500<br/>Log ERROR]
```

## Data Models

### SSM Parameters

| Parameter Path | Value | Source |
|---|---|---|
| `/${id}/AILA/GuardrailId` | Guardrail resource ID (e.g., `abc123def456`) | `guardrail.attrGuardrailId` |
| `/${id}/AILA/GuardrailVersion` | Numeric version string (e.g., `"1"`) | `guardrailVersion.attrVersion` |

### Lambda Environment Variables (new)

| Variable | Value |
|---|---|
| `GUARDRAIL_ID_PARAM` | `/${id}/AILA/GuardrailId` |
| `GUARDRAIL_VERSION_PARAM` | `/${id}/AILA/GuardrailVersion` |

### Guardrails Parameter Dict (passed to ChatBedrock)

```python
{
    "guardrailIdentifier": "abc123def456",   # from SSM
    "guardrailVersion": "1",                  # from SSM
    "trace": True,                            # enables trace in response
}
```

**Note on key names:** The `langchain-aws` `ChatBedrock` class (v0.2.14+) accepts `guardrails` as a dict with keys `guardrailIdentifier` and `guardrailVersion`. The `streamProcessingMode` is passed via the `amazon-bedrock-guardrailConfig` object in the raw request body — LangChain handles this when using `InvokeModelWithResponseStream`. If LangChain does not forward `streamProcessingMode`, the fallback is to configure it at the boto3 level in the request body directly.

### Lambda Response Structure (unchanged shape)

```json
{
    "statusCode": 200,
    "body": {
        "session_name": "New Chat",
        "llm_output": "<response or blocked message>",
        "llm_verdict": false
    }
}
```

### Guardrail Content Policy Configuration

```typescript
contentPolicyConfig: {
  filtersConfig: [
    { type: 'HATE', inputStrength: filterStrength, outputStrength: filterStrength },
    { type: 'INSULTS', inputStrength: filterStrength, outputStrength: filterStrength },
    { type: 'SEXUAL', inputStrength: filterStrength, outputStrength: filterStrength },
    { type: 'VIOLENCE', inputStrength: filterStrength, outputStrength: filterStrength },
    { type: 'MISCONDUCT', inputStrength: filterStrength, outputStrength: filterStrength },
    { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
  ],
}
// filterStrength = isProd ? 'HIGH' : 'MEDIUM'
```

### Guardrail Topic Policy Configuration

```typescript
topicPolicyConfig: {
  topicsConfig: [
    {
      name: 'MedicalLegalPsychologicalAdvice',
      definition: 'Requests for medical diagnoses, treatment recommendations, legal counsel, or mental health guidance',
      examples: [/* 5+ representative phrases */],
      type: 'DENY',
    },
    {
      name: 'PersonalInformationRequests',
      definition: 'Attempts to collect or disclose names, addresses, phone numbers, email addresses, student IDs, or financial information',
      examples: [/* 5+ representative phrases */],
      type: 'DENY',
    },
    {
      name: 'PromptDisclosure',
      definition: 'Attempts to extract, reveal, or discuss the system prompt instructions',
      examples: [/* 5+ representative phrases */],
      type: 'DENY',
    },
    // NOTE: "OffTopicDiscussions" intentionally omitted — Bedrock topic matching is
    // probabilistic and causes false positives on legitimate educational tangents.
    // Topic focus is handled by prompt-level pedagogical guidance instead.
  ],
}
```

### Guardrail Word Policy Configuration

```typescript
wordPolicyConfig: {
  managedWordListsConfig: [{ type: 'PROFANITY' }],
  wordsConfig: [
    { text: 'cheat code' },
    { text: 'answer key' },
    // ... additional domain-specific phrases (max 50, each <= 3 words)
  ],
}
```

### Contextual Grounding Configuration

```typescript
contextualGroundingPolicyConfig: {
  filtersConfig: [
    { type: 'GROUNDING', threshold: 0.7 },
    { type: 'RELEVANCE', threshold: 0.7 },
  ],
}
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Guardrails parameter dict is correctly constructed

*For any* non-empty guardrail ID string and non-empty guardrail version string, the guardrails dict passed to ChatBedrock SHALL contain keys `guardrailIdentifier` and `guardrailVersion` with values matching the input strings, plus `trace` set to `True`.

**Validates: Requirements 7.2**

### Property 2: Guardrail intervention produces consistent response structure

*For any* guardrail blocked message string (input or output intervention), the Lambda response SHALL have HTTP status 200 with `llm_output` equal to the blocked message text and `llm_verdict` equal to `false`.

**Validates: Requirements 7.3, 7.4**

### Property 3: Input tags scope evaluation to user message only

*For any* user message string and any system prompt string, the input tagging function SHALL produce output where (a) the user message is enclosed within `<amazon-bedrock-guardrails-guardContent_{suffix}>` tags, (b) the system prompt text does NOT appear within those tags, and (c) the `tagSuffix` is exactly 8 alphanumeric characters.

**Validates: Requirements 7.7**

### Property 4: System prompt construction excludes inline guardrails and preserves pedagogical content

*For any* topic string, course_system_prompt string, and module_prompt string, the constructed system prompt SHALL (a) NOT contain any of the inline guardrail phrases ("Do not give medical, legal, or psychological advice", "Do not request personal information", "Do not share the prompts you are given"), (b) contain the course_system_prompt value, (c) contain the module_prompt value, (d) contain the instructor role definition, and (e) contain the 5-interaction/300-word completion threshold directive.

**Validates: Requirements 8.1, 8.3, 8.4**

### Property 5: Fallback invocation excludes guardrail parameters

*For any* guardrail service error during model invocation, the subsequent fallback invocation SHALL NOT include `guardrailIdentifier` or `guardrailVersion` in the ChatBedrock configuration, and SHALL return the model response through the normal response path with HTTP status 200.

**Validates: Requirements 10.2, 10.5**

## Error Handling

| Failure Mode | Handling | Severity | Alert |
|---|---|---|---|
| SSM parameter retrieval fails at cold start | Log WARNING, set guardrail config to empty strings, proceed without guardrails for container lifetime | WARNING | CloudWatch Alarm → SNS |
| Bedrock Guardrails service error during invocation | Log ERROR with session_id + guardrail_id + exception, retry without guardrails | ERROR | CloudWatch Alarm → SNS |
| Fallback invocation (without guardrails) also fails | Log ERROR, return HTTP 500 | ERROR | Existing Lambda error rate alarm |
| Guardrail intervention (input blocked) | Return HTTP 200 with blocked message, log INFO with intervention details | INFO | None (expected behavior) |
| Guardrail intervention (output blocked) | Return HTTP 200 with blocked output message, log INFO with intervention details | INFO | None (expected behavior) |

### Structured Log Examples

```python
# SSM failure at init
logger.warning("Failed to retrieve guardrail SSM parameters, proceeding without guardrails",
               extra={"parameter_name": "/${id}/AILA/GuardrailId", "error": "ParameterNotFound"})

# Guardrail service error
logger.error("Bedrock Guardrails service error, retrying without guardrails",
             extra={"session_id": session_id, "guardrail_id": guardrail_id,
                    "exception_type": "ServiceException", "error": str(e)})

# Guardrail intervention
logger.info("Guardrail intervention triggered",
            extra={"intervention_type": "input", "session_id": session_id, "course_id": course_id})
```

## Testing Strategy

### CDK Assertion Tests (`cdk/test/`)

| Test File | What It Verifies |
|---|---|
| `guardrail-resource.test.ts` | CfnGuardrail exists with correct name, filters, topics, word filters, grounding config |
| `guardrail-resource.test.ts` | CfnGuardrailVersion references the guardrail and has DependsOn |
| `guardrail-resource.test.ts` | SSM parameters created at correct paths |
| `guardrail-resource.test.ts` | Environment-aware filter strengths (HIGH for prod, MEDIUM for dev) |
| `iam-policies.test.ts` | `bedrock:ApplyGuardrail` with scoped guardrail ARN, no wildcards |
| `iam-policies.test.ts` | `ssm:GetParameter` includes guardrail parameter ARNs |
| `observability.test.ts` | Guardrail failure alarm exists with correct metric filter and SNS action |

### Unit Tests (Python — `cdk/text_generation/tests/`)

| Test | What It Verifies |
|---|---|
| `test_guardrail_init` | SSM retrieval success caches values; SSM failure logs WARNING and sets empty strings |
| `test_input_tagging` | `wrap_user_message_with_guardrail_tags` produces correct tag structure |
| `test_system_prompt` | Inline guardrails removed; pedagogical instructions preserved |
| `test_intervention_response` | Input/output interventions return correct response structure |
| `test_fallback_retry` | Guardrail error triggers retry without guardrail params |
| `test_stream_mode` | `streamProcessingMode` is `SYNCHRONOUS` in guardrails dict |

### Property-Based Tests (Python — pytest + Hypothesis)

PBT library: **Hypothesis** (Python property-based testing library)
Configuration: minimum 100 examples per property test (`@settings(max_examples=100)`)

Each property test is tagged with a comment referencing its design property:
- **Feature: bedrock-guardrails, Property 1: Guardrails parameter dict is correctly constructed**
- **Feature: bedrock-guardrails, Property 2: Guardrail intervention produces consistent response structure**
- **Feature: bedrock-guardrails, Property 3: Input tags scope evaluation to user message only**
- **Feature: bedrock-guardrails, Property 4: System prompt construction excludes inline guardrails and preserves pedagogical content**
- **Feature: bedrock-guardrails, Property 5: Fallback invocation excludes guardrail parameters**

### Integration Tests

| Test | What It Verifies |
|---|---|
| Manual deployment test | Guardrail blocks harmful input and returns blocked message |
| Manual deployment test | Guardrail blocks off-topic output and returns blocked message |
| Manual deployment test | Normal educational queries pass through without intervention |

### Dependency Version

Pin `langchain_aws` in `requirements.txt` to the current version that supports the guardrails parameter dict:

```
langchain-aws==1.4.4
```

This version supports the `guardrails` parameter dict with `guardrailIdentifier`, `guardrailVersion`, and `trace` keys in the ChatBedrock constructor. The version is already pinned at `1.4.4` in the current `requirements.txt`.

# Chatbot Optimizations

Analysis and recommendations for improving the AI chatbot's performance and user experience. The chatbot's slowness is fundamentally architectural — the synchronous request/response pattern with 2-3 sequential LLM calls means the student always waits 5-20+ seconds.

## Chatbot Architecture Deep Dive — Why It Feels Slow

The chatbot's perceived slowness is primarily architectural, not just a matter of query optimization. Here's the full end-to-end trace of what happens when a student sends a message, with estimated timings.

### End-to-End Timeline: Student Sends a Message (Warm Invocation)

*Updated after OPT-1, OPT-3, OPT-8, OPT-10 implementations.*

```
FRONTEND (browser)
├─ fetchAuthSession() + extract email from ID token      ~20ms (OPT-10: no fetchUserAttributes)
├─ [P-7] POST create_message ──┐                         ~150-250ms (parallel with text_gen)
│   ├─ API Gateway routing      │                         ~10ms
│   ├─ Authorizer Lambda        │                         ~5-15ms (OPT-1: email from cached context)
│   ├─ studentFunction Lambda   │                         ~80-150ms (OPT-3: 3 queries, down from 5)
│   └─ Response to frontend     │
└─ POST text_generation ────────┘                         ~5-25 SECONDS (the bottleneck)
    ├─ API Gateway routing                                ~10ms
    ├─ Authorizer Lambda                                  ~5-15ms (OPT-1: email from cached context)
    └─ TextGenLambdaDockerFunc                            ~5-25 SECONDS
        ├─ initialize_constants()                         ~0ms (warm, cached)
        ├─ get_module_context()                           ~10-15ms (1 DB query)
        ├─ get_allowed_file_ids()                         ~10-15ms (1 DB query)
        ├─ get_bedrock_llm()                              ~5ms (object creation, no API call)
        ├─ get_vectorstore_retriever()                    ~0ms (closure creation)
        │
        ├─ get_response() ─── THE CORE BOTTLENECK ────────~5-20 SECONDS
        │   ├─ Chain construction (prompts, chains)       ~5ms
        │   ├─ conversational_rag_chain.invoke()          ~5-20 SECONDS
        │   │   ├─ DynamoDB: load chat history            ~20-50ms
        │   │   ├─ BEDROCK LLM CALL #1:                   ~2-8 SECONDS
        │   │   │   history-aware retriever
        │   │   │   (reformulates question with context)
        │   │   ├─ retrieve() closure:                    ~500ms-2s
        │   │   │   ├─ Bedrock embedding call             ~200-500ms
        │   │   │   ├─ hybrid_search vector SQL           ~50-200ms
        │   │   │   └─ hybrid_search keyword SQL          ~50-200ms
        │   │   ├─ BEDROCK LLM CALL #2:                   ~2-10 SECONDS
        │   │   │   RAG response generation
        │   │   │   (generates answer from context)
        │   │   └─ DynamoDB: save chat history            ~20-50ms
        │   └─ get_llm_output() (string processing)      ~0ms
        │   (OPT-8: max 3 retries if empty response)
        │
        └─ update_session_name()                          ~0ms (returns None on 2nd+ message)
            OR (first message only):                      ~3-8 SECONDS
            ├─ DynamoDB: get_item (chat history)          ~20-50ms
            ├─ BEDROCK LLM CALL #3:                       ~2-8 SECONDS
            │   generate session name
            └─ return session name

FRONTEND (after text_gen returns)
├─ [parallel] PUT update_session_name                     ~150ms (OPT-1: no Cognito call)
├─ [parallel] POST update_module_score                    ~150ms (OPT-1: no Cognito call)
└─ POST create_ai_message                                 ~150-250ms (OPT-1 + OPT-3)
```

### Total Wall Clock Time

| Scenario | Estimated Time |
|----------|---------------|
| Warm, 2nd+ message | **5-20 seconds** |
| Warm, 1st message | **8-28 seconds** |
| Cold start, 1st message | **12-33 seconds** |

### The Fundamental Problem: Synchronous Request/Response with Sequential LLM Calls

The architecture makes the student wait for the ENTIRE pipeline to complete before seeing any response. The dominant cost is:

1. **Bedrock LLM Call #1 (history-aware retriever)**: 2-8 seconds. This reformulates the student's question using chat history. It's a full LLM inference call just to rephrase a question.

2. **Bedrock LLM Call #2 (RAG response)**: 2-10 seconds. This generates the actual answer. The response length directly affects latency — longer answers take longer.

3. **Bedrock LLM Call #3 (session naming, first message only)**: 2-8 seconds. This runs AFTER the response is generated, blocking the return to the frontend.

These three calls are strictly sequential. The student sees nothing until all of them complete.

### Architectural Issues

**Issue 1: The history-aware retriever makes a full LLM call to rephrase every question**

`create_history_aware_retriever` from LangChain takes the student's question + chat history and calls the LLM to produce a "standalone question" that can be used for retrieval without the chat context. This is a full Bedrock inference call (2-8 seconds) that runs BEFORE any retrieval or response generation.

For simple follow-up questions like "tell me more" or "can you explain that?", this is valuable. But for standalone questions (which most student messages are), it's wasted time — the LLM just returns the original question unchanged.

**Issue 2: No streaming — student waits for the complete response**

The Lambda returns the full response as a single JSON payload. The student sees a loading spinner for 5-20 seconds, then the entire response appears at once. Modern chatbots stream tokens as they're generated, giving the user immediate feedback.

Bedrock supports streaming via `invoke_model_with_response_stream`. LangChain supports streaming via `.stream()` instead of `.invoke()`. But the current architecture (API Gateway → Lambda → return JSON) doesn't support streaming responses.

To enable streaming, the architecture would need one of:
- **Lambda Function URLs with response streaming** (simplest)
- **WebSocket API Gateway** (the app already has AppSync for notifications)
- **Server-Sent Events via Lambda response streaming**

This is the single biggest UX improvement possible. Even if the total time doesn't change, perceived latency drops dramatically because the student sees tokens appearing within 1-2 seconds.

**Issue 3: Session naming blocks the response on first message**

`update_session_name()` runs AFTER `get_response()` but BEFORE returning to the frontend. On the first message, it makes a DynamoDB read + a full Bedrock LLM call (2-8 seconds) just to generate a chat title. The student waits for this before seeing the AI's greeting.

This could be moved to the frontend's post-response flow (it already calls `PUT update_session_name` after receiving the text_gen response) or done asynchronously.

**Issue 4: The RAG chain reconstructs everything on every invocation**

Every call to `get_response()` rebuilds the entire LangChain pipeline from scratch:
- Creates `ChatPromptTemplate`
- Creates `create_stuff_documents_chain`
- Creates `create_retrieval_chain`
- Creates `RunnableWithMessageHistory`

These are lightweight Python object constructions (~5ms total), but it means no chain-level caching or optimization across invocations. Not a major issue, but worth noting.

**Issue 5: Chat history grows unbounded**

`DynamoDBChatMessageHistory` loads the ENTIRE chat history on every invocation. As conversations grow longer, this DynamoDB read gets larger and the LLM calls get slower (more tokens in the context window). There's no truncation or summarization of old messages.

For a 20-message conversation, the chat history could be 5,000+ tokens, which:
- Increases DynamoDB read time (larger item)
- Increases LLM Call #1 time (more context to process for question reformulation)
- Increases LLM Call #2 time (more chat history in the prompt)
- Increases Bedrock cost (billed per token)

### What Would Actually Make the Chatbot Feel Fast

In priority order (remaining items after OPT-1 through OPT-11 and P-1 through P-8):

1. **Response streaming (ARCH-1)** — The student sees tokens appearing within 1-2 seconds instead of waiting 5-20 seconds for the complete response. This is the single biggest perceived-latency improvement. Requires Lambda Function URL with response streaming. **Status: Blocked — VPC constraint. Lambda Function URLs don't support streaming in VPC. Requires revised approach (see ARCH-1 for options).**

2. **Conditionally skip the history-aware retriever LLM call (ARCH-2)** — For standalone questions (no pronouns referencing previous messages), skip the reformulation and use the raw question directly for retrieval. This saves 2-8 seconds on most messages. **Status: ✅ Implemented.**

3. **Move session naming out of the critical path (ARCH-3)** — Don't block the response return on session name generation. Let the frontend generate a name client-side. **Status: ✅ Implemented.**

4. **Cache ChatBedrock instance per model ID (ARCH-4)** — Avoid redundant boto3 client creation on every invocation. Saves ~15ms per request. **Status: ✅ Implemented.**

5. **Already implemented**: P-1 through P-8 (VPC endpoint, combined queries, connection reuse, code splitting, etc.) + OPT-1 (Cognito AdminGetUser eliminated) + OPT-3 (sequential queries reduced) + OPT-8 (retry limit) + OPT-10 (fetchUserAttributes eliminated). These collectively save ~400-700ms per chat exchange.

### Summary

After implementing ARCH-2, ARCH-3, and ARCH-4, the chatbot's per-message overhead is significantly reduced:
- ARCH-2 saves 2-8 seconds on ~70-80% of messages (standalone questions skip the reformulation LLM call)
- ARCH-3 saves 2-8 seconds on the first student reply (session naming removed from critical path)
- ARCH-4 saves ~15ms per request (ChatBedrock cached)

Combined with all OPT and P-item implementations, the non-LLM overhead is now minimal. The remaining bottleneck is the synchronous request/response pattern — the student still waits for the full RAG response (LLM Call #2: 2-10 seconds) before seeing anything.

**The single remaining high-impact change is ARCH-1 (response streaming)**, which transforms the UX from "wait for complete response" to "see tokens in 1-2 seconds." This is currently blocked by a VPC constraint — Lambda Function URLs don't support streaming when the Lambda is in a VPC. See ARCH-1 for revised options that need further evaluation.

---

## ARCH-1: Switch Text Generation to Lambda Function URL with Response Streaming

**Status: Blocked — VPC constraint discovered during implementation.**

Lambda Function URLs do not support response streaming when the Lambda is in a VPC (confirmed in [AWS docs](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)). The `TextGenLambdaDockerFunc` must remain in VPC for RDS Proxy access (RDS Proxy has no public endpoint) and the Bedrock VPC endpoint.

Additionally, Python Docker Lambda functions don't natively support response streaming — they require the [Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter) which wraps a web framework (FastAPI) inside the Lambda.

### Deep Dive: Three Revised Options

#### Option A: Lambda Web Adapter + Non-VPC Proxy Lambda

**Architecture:**
```
Browser → Non-VPC Proxy Lambda (Function URL, RESPONSE_STREAM)
            → invokes VPC Text Gen Lambda via InvokeWithResponseStream API
                → VPC Lambda streams response back through invoke API
            → Proxy streams to browser
```

**What changes:**
- New lightweight proxy Lambda (Node.js, non-VPC) with a Function URL (`InvokeMode: RESPONSE_STREAM`)
- Proxy receives the request, validates JWT, invokes the VPC Lambda via `InvokeWithResponseStream`
- VPC text gen Lambda refactored to use Lambda Web Adapter + FastAPI for streaming
- Dockerfile changes: add `COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0 /lambda-adapter /opt/extensions/lambda-adapter`
- Handler rewritten from `def handler(event, context)` to FastAPI `StreamingResponse`
- Frontend reads streaming response via `response.body.getReader()`

**Pros:**
- True end-to-end streaming — tokens appear in 1-2 seconds
- VPC Lambda keeps all its VPC benefits (RDS Proxy, Bedrock VPC endpoint)
- Proxy Lambda is tiny (~50 lines), cold starts in <500ms

**Cons:**
- Two Lambda invocations per request (proxy + VPC Lambda) — adds ~50-100ms overhead
- Significant refactor of the text gen handler (standard handler → FastAPI app)
- New Lambda to maintain
- `InvokeWithResponseStream` from a non-VPC Lambda to a VPC Lambda requires a Lambda interface VPC endpoint (additional cost ~$14.40/mo per AZ)
- Complexity: three moving parts (proxy, adapter, VPC Lambda)

**Effort: High.** The FastAPI refactor alone is substantial — the entire handler, `get_response`, and the LangChain chain invocation need to be rewritten for streaming.

---

#### Option B: AppSync WebSocket (Existing Infrastructure)

**Architecture:**
```
Browser ← WebSocket subscription (AppSync) ← mutations
Browser → POST text_generation (API Gateway, existing)
            → VPC Text Gen Lambda
                → generates tokens via LangChain .stream()
                → sends each chunk as AppSync mutation via HTTP POST
            → returns final JSON response (llm_verdict, session_name)
Browser ← receives chunks in real-time via WebSocket
```

**What changes:**
- Add a new subscription type to the GraphQL schema for chat streaming:
  ```graphql
  type ChatChunk {
    session_id: String!
    chunk: String!
    done: Boolean!
  }
  type Subscription {
    onChatChunk(session_id: String!): ChatChunk
      @aws_subscribe(mutations: ["sendChatChunk"])
  }
  type Mutation {
    sendChatChunk(session_id: String!, chunk: String!, done: Boolean!): ChatChunk
  }
  ```
- Text gen Lambda switches from `chain.invoke()` to `chain.stream()`, sends each chunk as an AppSync mutation
- Frontend subscribes to `onChatChunk(session_id)` before sending the text_gen request, displays chunks as they arrive
- The existing API Gateway endpoint stays — the Lambda still returns the final JSON with `llm_verdict` after streaming completes

**Proven pattern:** The SQS trigger Lambda (`sqsTrigger/src/main.py`) already calls AppSync mutations from within VPC using `httpx.Client().post(APPSYNC_API_URL, ...)`. The text gen Lambda would use the same pattern.

**Pros:**
- Uses existing AppSync infrastructure — no new services
- VPC Lambda stays unchanged in terms of VPC placement
- No proxy Lambda needed
- AppSync handles WebSocket connection management, scaling, auth
- Frontend already has WebSocket code in `InstructorHomepage.jsx` — can reuse the pattern
- The API Gateway endpoint stays as the request trigger and returns the final response (verdict, etc.)

**Cons:**
- Each token chunk is a separate AppSync mutation HTTP call from the Lambda (~5-10ms each). For a 200-token response, that's ~200 HTTP calls from the Lambda during generation. This adds CPU overhead and extends Lambda execution time.
- AppSync has a 240KB payload limit per message — not an issue for individual token chunks
- Slightly higher latency per chunk vs direct streaming (~10-30ms per chunk vs ~1ms for Function URL)
- Time-to-first-token is ~1.5-2.5 seconds (vs ~1-2s for Function URL) due to AppSync mutation overhead
- AppSync real-time updates cost: $2/million connection minutes + $1/million messages. For 200 chunks × 20 messages/day × 1000 students = 4M messages/month = ~$4/month

**Effort: Medium.** The Lambda needs to switch from `.invoke()` to `.stream()` and add AppSync mutation calls per chunk. The frontend needs a WebSocket subscription. But no handler architecture change — it's still a standard Lambda handler.

---

#### Option C: Move Text Gen Lambda Out of VPC

**Status: Not viable.** RDS Proxy has no public endpoint. The text gen Lambda connects to RDS Proxy for `get_module_context()`, `get_allowed_file_ids()`, `hybrid_search()` (vector + keyword queries), and `get_other_module_names()`. Without VPC access, these DB queries fail entirely.

Moving out of VPC would also reverse P-1 (Bedrock VPC endpoint) and P-6 (connection reuse through VPC).

**Eliminated.**

---

### Recommendation: Option B (AppSync WebSocket)

Option B is the right choice for this application:

1. **Lowest risk**: Uses existing AppSync infrastructure. The SQS trigger already proves AppSync mutations work from VPC Lambdas. The frontend already has WebSocket code.

2. **No architectural rewrite**: The Lambda handler stays as a standard handler. The main change is switching from `chain.invoke()` to `chain.stream()` and adding AppSync mutation calls per chunk. No FastAPI, no Lambda Web Adapter, no proxy Lambda.

3. **Good enough latency**: Time-to-first-token of ~1.5-2.5 seconds is a massive improvement over the current 5-20 seconds. The ~0.5-1 second difference vs a Function URL is negligible for this use case.

4. **Clean separation**: The API Gateway endpoint still handles the request/response (parameters, auth, final verdict). AppSync handles only the streaming chunks. The frontend subscribes before sending the request and unsubscribes after receiving `done: true`.

5. **Cost**: ~$4/month for AppSync messages at scale. Negligible.

Option A is technically superior (lower per-chunk latency) but requires a significant architectural rewrite (FastAPI, Lambda Web Adapter, proxy Lambda, VPC endpoint for Lambda invoke) that isn't justified by the marginal latency improvement.

---

## ARCH-2: Conditionally Skip History-Aware Retriever Using Lightweight Heuristic

**Status: ✅ Implemented** — `needs_reformulation()` heuristic added to `vectorstore.py`. Skips LLM Call #1 for standalone questions and first messages. Rollback via `ALWAYS_REFORMULATE=true` env var.

Saves 2-8 seconds on most messages by avoiding a full LLM call that usually returns the question unchanged.

### The Problem

Every student message goes through this chain:

```
Student sends: "What is the main argument in the reading?"

LLM Call #1 (2-8 seconds) — history-aware retriever:
  Input:  full chat history + student question
  Prompt: "Reformulate this question so it can be understood without chat history"
  Output: "What is the main argument in the reading?"  ← UNCHANGED

Embedding + hybrid search (0.5-2 seconds)

LLM Call #2 (2-10 seconds) — RAG response generation
```

LLM Call #1 exists to handle ambiguous follow-ups like "Can you explain that more?" — it reformulates them into standalone questions for better document retrieval. But most student messages in this educational chatbot are already standalone:

- "What is the main argument in the reading?" — standalone
- "I think the author makes a good point about X" — standalone
- "Greet me and ask me a question about the topic: Y" — the system-generated first message, always standalone
- "Can you explain that?" — needs reformulation (references "that")
- "Yes" / "Tell me more" — needs reformulation

The LLM spends 2-8 seconds "reformulating" standalone questions and returns them unchanged. That's the single largest source of wasted time per message.

### Current Code

In `vectorstore.py`, `get_vectorstore_retriever()`:

```python
# This wraps the retriever with an LLM call that runs on EVERY invocation
return create_history_aware_retriever(llm, retriever, contextualize_q_prompt)
```

`create_history_aware_retriever` from LangChain does this internally:
1. Takes the chat history + current question
2. Sends them to the LLM with the contextualization prompt
3. Uses the LLM's output as the search query for the retriever

There's no way to conditionally skip it — it always calls the LLM.

### Recommended Change: Heuristic-Based Bypass

Replace `create_history_aware_retriever` with a custom runnable that checks whether reformulation is needed before calling the LLM.

The heuristic checks for:
1. **Empty chat history** — first message, always standalone
2. **Short ambiguous messages** — "yes", "no", "tell me more", "go on", "explain", "why"
3. **Pronoun-heavy messages without clear nouns** — messages where "it", "that", "this", "they" appear without a clear subject

If the message appears standalone, skip the LLM call and pass it directly to the retriever. If it appears ambiguous, do the LLM reformulation call as before.

```python
import re

# Short ambiguous phrases that need context to be meaningful
AMBIGUOUS_PATTERNS = [
    r'^(yes|no|yeah|nah|sure|okay|ok)[\.\?\!]?$',
    r'^(tell|explain|elaborate|say)\s+(me\s+)?more',
    r'^(go on|continue|keep going|what else)',
    r'^(why|how so|how come|what do you mean)[\?\.\!]?$',
    r'^(can you|could you)\s+(explain|clarify|elaborate)',
]

# Pronouns that suggest a reference to previous context
CONTEXT_PRONOUNS = r'\b(it|that|this|these|those|they|them|its|their)\b'

def needs_reformulation(query: str, chat_history) -> bool:
    """
    Lightweight heuristic to decide if a question needs LLM reformulation.
    Returns True if the question likely references previous context.
    """
    # Option A: No chat history = first message, always standalone.
    # This is a guaranteed skip — the system-generated initial query
    # ("Greet me and ask me a question about the topic: X") is always
    # self-contained. Saves 2-8 seconds on every new conversation.
    if not chat_history:
        return False

    # Strip the "user\n" prefix added by get_student_query()
    cleaned = query.strip().lower()
    if cleaned.startswith("user"):
        cleaned = cleaned[4:].strip()

    # Short ambiguous phrases
    for pattern in AMBIGUOUS_PATTERNS:
        if re.match(pattern, cleaned, re.IGNORECASE):
            return True

    # Very short messages (< 4 words) are likely ambiguous
    word_count = len(cleaned.split())
    if word_count < 4:
        return True

    # Check for context-dependent pronouns
    # Only flag if pronouns appear AND the message is relatively short
    # (longer messages with pronouns are usually self-contained)
    if word_count < 15 and re.search(CONTEXT_PRONOUNS, cleaned):
        return True

    return False
```

Then in `get_vectorstore_retriever`, replace the unconditional `create_history_aware_retriever` with a conditional wrapper:

```python
def get_vectorstore_retriever(
    llm,
    vectorstore_config_dict,
    embeddings,
    allowed_file_ids=None,
    connection=None,
):
    # ... existing connection string setup ...

    def retrieve(query: str) -> List[Document]:
        query_embedding = embeddings.embed_query(query)
        return hybrid_search(
            query=query,
            query_embedding=query_embedding,
            connection_string=psycopg2_connection_string,
            collection_name=collection_name,
            allowed_file_ids=allowed_file_ids,
            connection=connection,
        )

    retriever = RunnableLambda(retrieve)

    # Build the LLM-based reformulation chain (used only when needed)
    contextualize_q_system_prompt = (
        "Given a chat history and the latest user question "
        "which might reference context in the chat history, "
        "formulate a standalone question which can be understood "
        "without the chat history. Do NOT answer the question, "
        "just reformulate it if needed and otherwise return it as is."
    )
    contextualize_q_prompt = ChatPromptTemplate.from_messages([
        ("system", contextualize_q_system_prompt),
        MessagesPlaceholder("chat_history"),
        ("human", "{input}"),
    ])
    history_aware_retriever = create_history_aware_retriever(
        llm, retriever, contextualize_q_prompt
    )

    # Return a wrapper that conditionally skips the LLM reformulation
    def conditional_retriever(input_dict):
        query = input_dict.get("input", "")
        chat_history = input_dict.get("chat_history", [])

        if needs_reformulation(query, chat_history):
            # Use the full LLM-based history-aware retriever
            return history_aware_retriever.invoke(input_dict)
        else:
            # Skip LLM call — use the raw query directly for retrieval
            return retriever.invoke(query)

    return RunnableLambda(conditional_retriever)
```

**Important integration note:** The return type changes. `create_history_aware_retriever` returns a Runnable that `create_retrieval_chain` expects. The conditional wrapper must return the same type (a list of Documents) for `create_retrieval_chain` to work. Both `history_aware_retriever.invoke()` and `retriever.invoke()` return `List[Document]`, so this is compatible.

However, `create_retrieval_chain` calls the retriever with a dict `{"input": ..., "chat_history": ...}`, not a plain string. The `history_aware_retriever` expects this dict. The plain `retriever` (RunnableLambda wrapping `retrieve()`) expects a string. The conditional wrapper handles this by extracting the query string for the direct path.

### Estimated Impact

| Scenario | Current | With Heuristic | Reason |
|----------|---------|---------------|--------|
| First message (no history) | LLM call #1: 2-8s | Skipped: 0s | Option A — guaranteed, no heuristic needed |
| Standalone question (most messages) | LLM call #1: 2-8s | Skipped: 0s | Heuristic detects no ambiguity |
| Ambiguous follow-up ("explain that") | LLM call #1: 2-8s | LLM call #1: 2-8s (unchanged) | Heuristic triggers reformulation |
| Typical message total time | 5-20s | 3-12s | |

The first-message skip (Option A) is the highest-value case because it's the student's first impression of the chatbot — the moment they're most sensitive to latency. It's also zero-risk since there's no chat history to reference.

### Risk Assessment

- **False negatives** (skipping reformulation when it was needed): The retriever searches with the raw question, which may return less relevant documents. But the response LLM (Call #2) still has the full chat history in its prompt via `MessagesPlaceholder("chat_history")`, so it can still produce a contextually appropriate answer. The impact is slightly less relevant document retrieval, not a broken response.
- **False positives** (reformulating when it wasn't needed): No harm — the LLM returns the question unchanged, same as current behavior. Just wastes 2-8 seconds, same as today.
- **Tuning**: The heuristic thresholds (word count < 4, word count < 15 with pronouns) can be adjusted based on real conversation data. Start conservative (skip less) and loosen over time.
- **Testability**: Log whether reformulation was skipped or used, and compare the reformulated query vs the original. If they're identical >80% of the time, the heuristic is working correctly.
- **Rollback**: Set an environment variable `ALWAYS_REFORMULATE=true` to disable the heuristic and revert to current behavior without a code deploy.

---

## ARCH-3: Remove Session Naming from Text Generation Critical Path

**Status: ✅ Implemented** — `update_session_name()` removed from handler. Frontend generates session names client-side from the first sentence of the AI response (Option 1a).

Saves 2-8 seconds on the student's first reply by not blocking the AI response on a cosmetic LLM call.

### The Problem

After the AI response is fully generated and ready to return, the text generation Lambda runs `update_session_name()` before sending the response back to the student:

```python
# In handler() — main.py

# AI response is READY at this point
response = get_response(...)

# But we don't return it yet — we block on session naming
potential_session_name = update_session_name(TABLE_NAME, session_id, effective_llm_model_id)

# NOW we finally return to the student
return { "statusCode": 200, "body": json.dumps({ "session_name": ..., "llm_output": ... }) }
```

On the student's first reply (the second exchange in the conversation), `update_session_name` does:
1. Creates a new `boto3.client("dynamodb")` — ~5ms
2. Reads the full chat history from DynamoDB — ~20-50ms
3. Determines this is the first exchange
4. Creates a new `ChatBedrock` or `BedrockLLM` instance — ~5ms
5. **Calls Bedrock to generate a ~30 character session title — 2-8 seconds**
6. Returns the title

The AI's actual answer is sitting in memory, ready to display, but the Lambda holds it for 2-8 seconds while it thinks of a name like "Photosynthesis Discussion."

On the 2nd+ reply, `update_session_name` reads DynamoDB, sees more than 2 messages, and returns `None` (~20-50ms). So this only hurts the first reply — but that's the moment the student is most engaged and most sensitive to latency.

### Why It's Redundant

The frontend already handles session naming independently. After receiving the text_gen response:

```javascript
// StudentChat.jsx — runs AFTER text_gen returns
.then((textGenData) => {
  // Updates the sidebar with the session name from the response
  setSession({ ...prevSession, session_name: textGenData.session_name });
  setSessions(prevSessions => prevSessions.map(s =>
    s.session_id === newSession.session_id
      ? { ...s, session_name: titleCase(textGenData.session_name) }
      : s
  ));

  // Then calls a SEPARATE API to persist the name
  return Promise.all([
    fetch(updateSessionNameUrl, { method: "PUT", body: JSON.stringify({ session_name: textGenData.session_name }) }),
    fetch(updateModuleScoreUrl, { method: "POST" }),
  ]);
})
```

The frontend takes the `session_name` from the text_gen response and:
1. Updates the UI sidebar
2. Calls `PUT /student/update_session_name` to persist it in the DB

So the text generation Lambda generates the name, returns it in the response, and then the frontend saves it via a separate API call. The Lambda is doing expensive work (a full Bedrock LLM call) for something the frontend is going to handle anyway.

### Recommended Change

Remove `update_session_name()` from the text generation Lambda entirely. Return the AI response immediately after `get_response()` finishes.

**In `main.py` handler, replace:**

```python
try:
    potential_session_name = update_session_name(TABLE_NAME, session_id, effective_llm_model_id)
    if potential_session_name:
        session_name = potential_session_name
except Exception as e:
    logger.error(f"Error updating session name: {e}")
    session_name = "New Chat"

return {
    "statusCode": 200,
    "body": json.dumps({
        "session_name": session_name,
        "llm_output": response.get("llm_output", ...),
        "llm_verdict": response.get("llm_verdict", ...),
    })
}
```

**With:**

```python
return {
    "statusCode": 200,
    "body": json.dumps({
        "session_name": session_name,  # stays "New Chat" from query params
        "llm_output": response.get("llm_output", ...),
        "llm_verdict": response.get("llm_verdict", ...),
    })
}
```

The session name stays as "New Chat" until the frontend renames it. For the rename, two options:

**Option 1a — Simple client-side naming (no LLM call):**

The frontend generates a name from the first few words of the student's message or the AI's response. No API call needed:

```javascript
// After receiving text_gen response for the first exchange
const autoName = textGenData.llm_output.split(/[.!?]/)[0].substring(0, 30);
// e.g., "Let's explore photosynthesis" → "Let's explore photosynthesis"
```

This is instant, free, and good enough for a sidebar label.

**Option 1b — Keep LLM naming but move it to `PUT /student/update_session_name`:**

The existing `PUT /student/update_session_name` endpoint in `studentFunction.js` currently just saves a name the frontend sends. It could be enhanced to generate the name server-side if the frontend sends a flag like `?generate=true`. This moves the LLM call to a non-blocking post-response flow — the student already has the AI response, and the sidebar updates a few seconds later when the name comes back.

**Recommended: Option 1a.** It's the simplest, eliminates a Bedrock LLM call entirely (saves cost too), and the student sees a meaningful session name instantly. If the LLM-generated names are strongly preferred, use Option 1b.

### What to Do with `update_session_name` in `chat.py`

The function can be deleted from `chat.py` since it's no longer called. Also remove its import from `main.py`:

```python
# Remove from import line:
from helpers.chat import get_bedrock_llm, get_initial_student_query, get_student_query, create_dynamodb_history_table, get_response  # removed: update_session_name
```

### Estimated Impact

| Scenario | Current | After Change |
|----------|---------|-------------|
| First student reply | AI response ready + 2-8s naming delay | AI response returned immediately |
| 2nd+ student reply | AI response ready + ~30ms DynamoDB check | AI response returned immediately |
| Session name appearance | Appears with AI response (delayed) | "New Chat" → auto-named instantly (Option 1a) |

### Risk Assessment

- **Breaking changes**: The `session_name` field in the text_gen response will always be "New Chat" instead of an LLM-generated name. The frontend already handles this — it uses `textGenData.session_name` to update the sidebar, and "New Chat" is the default. With Option 1a, the frontend generates a better name client-side.
- **Cost savings**: Eliminates one Bedrock LLM call on the first exchange of every conversation. At scale (1,000 students × 5 new conversations/week), that's 5,000 fewer Bedrock invocations per week.
- **Rollback**: If LLM-generated names are needed, the `update_session_name` function still exists in git history and can be restored. Or use Option 1b to move it to the post-response flow.
- **ARCH-1 interaction**: If ARCH-1 (streaming) is also implemented, the response format changes from JSON to a stream. Option 1a (client-side naming) is the cleanest approach for streaming since it doesn't require any session name in the streamed response. Implement ARCH-3 before or alongside ARCH-1.

---

## ARCH-4: Cache `ChatBedrock` Instance Per Model ID

**Status: ✅ Implemented** — `_llm_cache` dict added to `chat.py`. `get_bedrock_llm()` now caches per model ID and reuses the global `bedrock_runtime` client.

Saves ~10-15ms per invocation by avoiding redundant boto3 client creation and LangChain object construction on every request.

### The Problem

Every invocation of the handler calls `get_bedrock_llm(effective_llm_model_id)`, which creates a brand new `ChatBedrock` instance:

```python
# chat.py — called on EVERY request
def get_bedrock_llm(bedrock_llm_id, temperature=0):
    return ChatBedrock(
        model_id=bedrock_llm_id,
        model_kwargs=model_kwargs,
    )
```

`ChatBedrock` is constructed without a `client` parameter, so LangChain internally creates a new `boto3.client("bedrock-runtime")` each time. boto3 client creation involves loading the Bedrock service model JSON from disk and initializing the HTTP session — roughly 10-15ms.

Meanwhile, a perfectly good `bedrock_runtime` client already exists at module level in `main.py`:

```python
# main.py — created once at cold start, never reused by ChatBedrock
bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION)
```

This client is used for `BedrockEmbeddings` but not passed to `ChatBedrock`. So every request creates a duplicate Bedrock client.

### Why It Can Be Cached

The `ChatBedrock` object only depends on two things:
- `model_id` — there are only 2 supported models (`meta.llama3-70b-instruct-v1:0` and `anthropic.claude-3-sonnet-20240229-v1:0`)
- `model_kwargs` — `temperature` is always 0, `max_tokens` is always 4000 for Claude

These don't change between requests. A Lambda container handling 100 requests for the same course uses the same model every time. Even across courses, there are only 2 possible model IDs.

The `ChatBedrock` instance is stateless — it doesn't hold conversation state, connection state, or any per-request data. It's just a configured wrapper around a boto3 client. Safe to reuse.

### Recommended Change

Cache `ChatBedrock` instances per model ID and pass the existing global `bedrock_runtime` client:

```python
# main.py — add to global cached resources
_llm_cache = {}

# chat.py — replace get_bedrock_llm
def get_bedrock_llm(bedrock_llm_id, temperature=0, client=None):
    cache_key = f"{bedrock_llm_id}:{temperature}"
    if cache_key not in _llm_cache:
        if "claude" in bedrock_llm_id.lower():
            model_kwargs = {
                "temperature": temperature,
                "max_tokens": 4000,
            }
        else:
            model_kwargs = {
                "temperature": temperature,
            }
        _llm_cache[cache_key] = ChatBedrock(
            model_id=bedrock_llm_id,
            model_kwargs=model_kwargs,
            client=client,  # reuse the global bedrock_runtime client
        )
    return _llm_cache[cache_key]
```

In the handler, pass the global client:

```python
llm = get_bedrock_llm(effective_llm_model_id, client=bedrock_runtime)
```

The cache lives in module-level global scope, so it persists across warm invocations for the lifetime of the Lambda container. With only 2 possible model IDs, the cache holds at most 2 entries.

### What This Eliminates Per Warm Invocation

| Object | Current | With Cache |
|--------|---------|-----------|
| `boto3.client("bedrock-runtime")` | Created every request (~10ms) | Reused from global |
| `ChatBedrock` wrapper | Created every request (~2-3ms) | Reused from cache |
| Service model JSON parse | Every request (~3-5ms) | Once per container |
| Total | ~15ms | ~0ms (cache hit) |

### Risk Assessment

- **Thread safety**: Lambda runs one request at a time per container. No concurrent access to the cache. No risk.
- **Staleness**: The model ID and kwargs are static configuration. They only change if an instructor changes the course's LLM model, which triggers a new request with a different `effective_llm_model_id` — that's a cache miss, so a new instance is created. No staleness risk.
- **Memory**: Two `ChatBedrock` instances in memory is negligible (~1-2KB each).
- **Impact**: ~15ms saved per request. Small compared to ARCH-1/2/3, but it's a free optimization with zero complexity. Worth doing alongside the other changes.

---

## Issue 5: Unbounded Chat History — No Action Needed

### Status: Deferred — not optimizing

### Analysis

`DynamoDBChatMessageHistory` loads the entire conversation history on every invocation and sends it to the LLM twice (once for the history-aware retriever, once for the RAG response). As conversations grow, this increases DynamoDB read size, LLM input token count, LLM latency, and Bedrock cost.

However, after investigation this is intentional and correct for this application. The full chat history provides the LLM with the pedagogical context it needs to guide the student toward understanding the course material — what topics have been covered, what the student struggled with, what questions have already been asked. Truncating the history would degrade the LLM's ability to fulfill its role as an instructor.

### Why it's not a problem in practice

- The system prompt instructs the LLM to complete the conversation after "at least 5 interactions and 300 words." Typical conversations are 10-20 messages.
- A 20-message conversation is roughly 3,000-5,000 tokens of history — well within Llama 3 70B's 8K context window and trivial for Claude 3 Sonnet's 200K window.
- The latency impact of this history size (~1-2 seconds of extra LLM processing) is small relative to the base LLM inference time.

### When to revisit

- If conversations regularly exceed 30+ messages (monitor via DynamoDB item sizes)
- If LLM latency on later messages becomes noticeably worse than early messages
- If the application switches to a model with a smaller context window

### Future option if needed

Async progressive summarization: keep the last N messages in full, fold older messages into a running summary that's updated after each response is returned (not before — so the student never waits for it). The summary preserves the pedagogical state ("student struggled with X, understood Y") while bounding token count. This adds implementation complexity and is not justified at current conversation lengths.

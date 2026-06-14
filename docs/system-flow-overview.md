# How AILA Works: From File Upload to Chatbot Response

A simplified explanation of how the AI Learning Assistant processes course materials and answers student questions.

---

## The Big Picture

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│  INSTRUCTOR  │       │   PROCESS    │       │    STORE     │       │   STUDENT    │
│  uploads a   │──────▶│   the file   │──────▶│  searchable  │──────▶│  asks a      │
│  PDF/PPTX    │       │  into chunks │       │   pieces     │       │  question    │
└──────────────┘       └──────────────┘       └──────────────┘       └──────────────┘
```

Think of it like a library:
1. **The instructor donates a book** (uploads a file)
2. **The librarian catalogs it** (the system breaks it into searchable pieces)
3. **The pieces go on the shelves** (stored in a searchable database)
4. **A student asks a question** and the AI librarian finds the right pages, reads them, and explains the answer in plain language

---

## Step-by-Step Flow

### 1. Instructor Uploads a File

```
┌─────────────────────────────────────────────────────────────┐
│                    INSTRUCTOR'S BROWSER                       │
│                                                              │
│   1. Instructor selects a PDF, PPTX, or DOCX file           │
│   2. Browser asks the server: "Where should I put this?"     │
│   3. Server says: "Here's a temporary upload link"           │
│   4. Browser uploads the file directly to cloud storage      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │   S3 BUCKET       │
                    │   (Cloud Storage) │
                    │                   │
                    │   Organized as:   │
                    │   /course/        │
                    │     /module/      │
                    │       /file.pdf   │
                    └───────────────────┘
```

**What's happening:** The instructor picks files from their computer. The system gives them a secure, time-limited upload link. The file goes straight to Amazon S3 (cloud storage) — it never passes through our servers, which keeps things fast and secure.

---

### 2. File Processing Begins Automatically

```
┌───────────────────┐         ┌─────────────────────────────────┐
│   S3 BUCKET       │         │     DATA INGESTION LAMBDA        │
│                   │ ──────▶ │     (Automatic File Processor)   │
│  "New file        │  event  │                                  │
│   detected!"      │         │  1. Download the file            │
│                   │         │  2. Read each page               │
│                   │         │  3. Extract the text (OCR if     │
│                   │         │     the page is a scanned image) │
│                   │         │  4. Break text into meaningful   │
│                   │         │     chunks                       │
│                   │         │  5. Convert chunks into numbers  │
│                   │         │     (embeddings) for search      │
│                   │         │  6. Store everything in the      │
│                   │         │     search database              │
└───────────────────┘         └─────────────────────────────────┘
```

**What's happening:** The moment a file lands in storage, the system automatically wakes up a processor. This processor:

- **Reads the file** page by page using PyMuPDF (a PDF reading library)
- **Falls back to OCR** (optical character recognition) if a page is mostly images or scanned text
- **Splits the text into chunks** using "semantic chunking" — it groups sentences that talk about the same idea together, rather than splitting at a fixed character count
- **Extracts topics** by asking a lightweight AI (Claude Haiku) "What are the main topics in this document?" — this helps the chatbot stay focused
- **Registers the file** in the database so it shows up in the student's file list

---

### 3. Creating Searchable Embeddings

```
┌──────────────────────────────────────────────────────────────┐
│                     EMBEDDING PROCESS                          │
│                                                               │
│   Text chunk:                                                 │
│   "Photosynthesis converts sunlight into chemical energy      │
│    stored in glucose molecules..."                            │
│                                                               │
│                          │                                    │
│                          ▼                                    │
│                                                               │
│   ┌─────────────────────────────────────────┐                │
│   │  Amazon Titan Embeddings Model          │                │
│   │  (Converts text → 1024 numbers)         │                │
│   └─────────────────────────────────────────┘                │
│                          │                                    │
│                          ▼                                    │
│                                                               │
│   Vector: [0.023, -0.841, 0.152, 0.447, ... 1024 numbers]   │
│                                                               │
│   This number sequence captures the MEANING of the text.     │
│   Similar concepts → similar number sequences.               │
│                                                               │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
              ┌───────────────────────┐
              │    pgvector Database   │
              │    (Vector Search DB)  │
              │                        │
              │  Stores:               │
              │  • The text chunk      │
              │  • The number vector   │
              │  • Which file it's from│
              │  • Which page          │
              │  • Which module        │
              └───────────────────────┘
```

**What's happening:** Each chunk of text is converted into a list of 1024 numbers (called an "embedding" or "vector"). These numbers represent the *meaning* of the text. The key insight: text about similar topics produces similar numbers, so later we can find relevant content by comparing numbers — even if the student uses completely different words than the textbook.

---

### 4. Student Asks a Question

```
┌─────────────────────────────────────────────────────────────┐
│                    STUDENT'S BROWSER                          │
│                                                              │
│   Student types: "How does photosynthesis work?"             │
│                                                              │
│   1. Message is sent to the backend                          │
│   2. Student sees a typing indicator (...)                   │
│   3. AI response streams in word by word in real-time        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                ┌──────────────────────────┐
                │  TEXT GENERATION LAMBDA   │
                │  (The Brain)             │
                └──────────────────────────┘
```

**What's happening:** The student's question travels to a backend processor called the Text Generation Lambda. This is where the magic happens — it orchestrates the entire search and response process.

---

### 5. Finding Relevant Content (Retrieval)

```
┌─────────────────────────────────────────────────────────────────┐
│                        HYBRID SEARCH                              │
│                                                                   │
│   Student's question: "How does photosynthesis work?"            │
│                                                                   │
│   ┌─────────────────────┐    ┌──────────────────────────┐       │
│   │   VECTOR SEARCH     │    │    KEYWORD SEARCH         │       │
│   │   (Meaning-based)   │    │    (Word-matching)        │       │
│   │                     │    │                            │       │
│   │ Finds chunks with   │    │ Finds chunks containing   │       │
│   │ SIMILAR meaning,    │    │ the exact words            │       │
│   │ even if different    │    │ "photosynthesis" or       │       │
│   │ words are used       │    │ related terms             │       │
│   │                     │    │                            │       │
│   │ Weight: 70%         │    │ Weight: 30%               │       │
│   └─────────────────────┘    └──────────────────────────┘       │
│                     │                      │                      │
│                     └──────────┬───────────┘                     │
│                                │                                  │
│                                ▼                                  │
│                     ┌─────────────────────┐                      │
│                     │   COMBINED RESULTS   │                      │
│                     │   Best 6 chunks      │                      │
│                     │   from course files   │                      │
│                     └─────────────────────┘                      │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

**What's happening:** The system searches for relevant content in two ways simultaneously:

1. **Vector search (70% weight):** Converts the question to numbers and finds chunks with similar number patterns — this catches conceptual matches even when wording differs
2. **Keyword search (30% weight):** Traditional word matching — catches exact terminology

The results are blended together, and the best 6 chunks are selected. Importantly, the search is restricted to only the files in the student's enrolled module — they can't accidentally see content from other courses.

---

### 6. Generating the Answer

```
┌──────────────────────────────────────────────────────────────────┐
│                     ANSWER GENERATION                              │
│                                                                    │
│   ┌─────────────────────────────────────────────────────────┐    │
│   │  PROMPT ASSEMBLY                                         │    │
│   │                                                          │    │
│   │  System instructions:                                    │    │
│   │  "You are a helpful teaching assistant for [topic].      │    │
│   │   Help the student understand the concepts.              │    │
│   │   Use the following course material as context..."       │    │
│   │                                                          │    │
│   │  + Retrieved chunks from course files                    │    │
│   │  + Conversation history (what was said before)           │    │
│   │  + The student's current question                        │    │
│   │  + Instructor's custom prompt (if any)                   │    │
│   │  + Module topic information                              │    │
│   └─────────────────────────────────────────────────────────┘    │
│                              │                                     │
│                              ▼                                     │
│              ┌──────────────────────────────┐                     │
│              │     LARGE LANGUAGE MODEL      │                     │
│              │     (Claude / Llama)          │                     │
│              │                               │                     │
│              │  Reads the context + question │                     │
│              │  Generates an explanation     │                     │
│              │  grounded in course material  │                     │
│              └──────────────────────────────┘                     │
│                              │                                     │
│                              ▼                                     │
│                 Answer streams back to student                     │
│                 word by word in real-time                          │
│                                                                    │
└──────────────────────────────────────────────────────────────────┘
```

**What's happening:** The system assembles everything into a single prompt:
- Instructions telling the AI how to behave (be helpful, stay on topic, use Socratic method)
- The relevant chunks it found from course files
- The full conversation history (so follow-up questions make sense)
- The instructor's custom teaching prompt (optional personality/focus)

This all goes to a large language model (Claude or Llama, configurable per course). The AI generates a response grounded in the actual course material — not general internet knowledge. The response streams back to the student word-by-word for a responsive experience.

---

### 7. Real-Time Streaming

```
┌────────────┐        ┌──────────────┐        ┌─────────────────┐
│  LAMBDA    │──────▶ │   APPSYNC    │──────▶ │  STUDENT'S      │
│  (AI)      │ chunk  │   (WebSocket │ chunk  │  BROWSER        │
│            │──────▶ │    relay)    │──────▶ │                 │
│  Generates │ chunk  │              │ chunk  │  Words appear   │
│  word by   │──────▶ │              │──────▶ │  one by one     │
│  word      │  done  │              │  done  │  like typing    │
└────────────┘        └──────────────┘        └─────────────────┘
```

**What's happening:** Instead of waiting for the entire answer to be generated (which could take 10+ seconds), the system sends each piece as it's ready. The student sees words appearing progressively — similar to watching someone type. This uses AWS AppSync's WebSocket connection for instant delivery.

---

## Key Safety Features

| Feature | What It Does |
|---------|-------------|
| **Content Guardrails** | Amazon Bedrock Guardrails filter inappropriate questions and responses |
| **Module Isolation** | Students can only search content from their enrolled modules |
| **No Hallucination** | The AI is instructed to only answer using provided course material |
| **Secure Uploads** | Pre-signed URLs expire quickly; files are encrypted at rest |
| **Access Verification** | Every request checks the student's enrollment before responding |
| **Conversation Memory** | Chat history stored in DynamoDB so follow-up questions work naturally |

---

## Technology Summary

| Layer | Technology | Role |
|-------|-----------|------|
| Frontend | React + Vite | Student and instructor interfaces |
| Auth | Amazon Cognito | Login, roles (admin/instructor/student) |
| API | API Gateway + Lambda | Request routing and processing |
| File Storage | Amazon S3 | Course material files |
| AI Models | Amazon Bedrock (Claude, Llama, Titan) | Text generation + embeddings |
| Vector Database | PostgreSQL + pgvector | Semantic search over course content |
| Real-time | AWS AppSync (WebSocket) | Streaming AI responses |
| Chat History | Amazon DynamoDB | Conversation memory |
| Queue | Amazon SQS | Background tasks (chat log exports) |

---

## Diagram: Complete End-to-End Flow

```
    INSTRUCTOR                                              STUDENT
        │                                                      │
        │  Upload PDF                                          │
        ▼                                                      │
  ┌───────────┐                                                │
  │   S3      │◀── Pre-signed URL ◀── API Gateway              │
  │  Bucket   │                                                │
  └─────┬─────┘                                                │
        │                                                      │
        │  S3 Event (automatic)                                │
        ▼                                                      │
  ┌─────────────────┐                                          │
  │  Data Ingestion │                                          │
  │  Lambda         │                                          │
  │                 │                                          │
  │  • Read pages   │                                          │
  │  • Extract text │                                          │
  │  • Chunk text   │                                          │
  │  • Get topics   │                                          │
  └────────┬────────┘                                          │
           │                                                   │
           │  Embed chunks                                     │
           ▼                                                   │
  ┌─────────────────┐        ┌──────────────────┐             │
  │  Amazon Bedrock │        │  pgvector DB     │             │
  │  Titan Embed    │──────▶ │  (vectors +      │             │
  │  (text → nums)  │        │   text stored)   │             │
  └─────────────────┘        └────────┬─────────┘             │
                                      │                        │
                                      │  Search               │
                                      │                        │
                              ┌───────┴────────┐    Ask       │
                              │ Text Generation│◀─────────────┘
                              │ Lambda         │
                              │                │
                              │ • Search DB    │
                              │ • Build prompt │
                              │ • Call LLM     │
                              │ • Stream back  │
                              └───────┬────────┘
                                      │
                                      │  Stream via WebSocket
                                      ▼
                              ┌────────────────┐
                              │  Student sees  │
                              │  AI response   │
                              │  word by word  │
                              └────────────────┘
```

---

## Frequently Asked Questions

**Q: Can students see other courses' materials?**
No. Every search is filtered to only the student's enrolled module files.

**Q: What happens if the AI gives a wrong answer?**
The AI is instructed to only answer using the provided course material. If it can't find relevant content, it says so rather than guessing. Bedrock Guardrails provide an additional safety layer.

**Q: How long does it take for uploaded files to become searchable?**
Typically 30–60 seconds for a standard PDF. Large files with many scanned pages (requiring OCR) may take a few minutes.

**Q: What file types are supported?**
PDF, DOCX, PPTX, TXT, XLSX, XPS, MOBI, and CBZ.

**Q: Can the instructor control how the AI behaves?**
Yes. Instructors set a system prompt per course and an optional module-level prompt to guide the AI's teaching style and focus areas. They can also choose which LLM model the chatbot uses.

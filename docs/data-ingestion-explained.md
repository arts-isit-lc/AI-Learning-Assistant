# How AILA Reads Uploaded Files — Explained Simply

This document explains what happens the moment an instructor uploads a file, how AILA reads every supported file type, and how it saves what it finds. It's written for anyone — no programming background required.

> Want the technical version with exact data shapes and storage paths? See [Data Ingestion Pipeline](./data-ingestion-pipeline.md).

---

## The one-sentence version

> When a file is uploaded, AILA hands it to a **specialist reader** for that file type, which pulls out the text, pictures, tables, and formulas; tidies them up; and files everything away neatly so the rest of the system can understand and search it later.

This first step is called **ingestion** — think of it as the "reading and filing" stage. (What happens *after* — understanding images, making everything searchable, answering questions — is covered in [Multimodal RAG V2 — Explained Simply](./multimodal-rag-v2-explained.md).)

---

## Why this matters

The old approach treated every file the same way: open it, scrape out the plain text, and dump it in a pile. Diagrams were ignored, tables turned to mush, and formulas came out as gibberish. If one page was broken, the whole file failed.

The new approach is like hiring a **team of specialists** instead of one generalist:

```
        ┌──────────────────────────────────────────────────────┐
        │             "What kind of file is this?"              │
        └───────────────────────────┬──────────────────────────┘
                                     │
   ┌──────┬──────┬──────┬──────┬─────┴─────┬──────┬──────┬───────┐
   ▼      ▼      ▼      ▼      ▼           ▼      ▼      ▼       ▼
 ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────────┐ ┌─────┐ ┌────┐ ┌────┐ ┌───────┐
 │PDF │ │PPTX│ │DOCX│ │HTML│ │ Images │ │LaTeX│ │CSV │ │JSON│ │  ...  │
 └────┘ └────┘ └────┘ └────┘ └────────┘ └─────┘ └────┘ └────┘ └───────┘
  Each specialist knows how to read its own format properly.
```

Each specialist knows the quirks of its format — where the slides are in a PowerPoint, how a Word table is laid out, how a formula is written in LaTeX — so nothing gets lost or scrambled.

---

## The four kinds of content AILA looks for

No matter what file comes in, every specialist reader is looking for the same four kinds of "content pieces":

```
┌───────────────┐  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│     TEXT      │  │     IMAGE     │  │     TABLE     │  │    FORMULA    │
│  paragraphs,  │  │  photos,      │  │  data grids,  │  │  equations,   │
│  headings,    │  │  diagrams,    │  │  rows &       │  │  math         │
│  bullet points│  │  charts       │  │  columns      │  │  expressions  │
└───────────────┘  └───────────────┘  └───────────────┘  └───────────────┘
```

Each piece is also tagged with **where it came from** — which page, which slide, or which section of the document — so later on the system can say "this is from page 7" or "this diagram is on slide 12."

---

## The whole journey, start to finish

```
   Instructor uploads a file
            │
            ▼
   ┌─────────────────────┐
   │  1. A file arrives   │   AILA notices the moment the file lands.
   └──────────┬──────────┘
              ▼
   ┌─────────────────────┐
   │  2. Pick a reader    │   "It's a PDF" → send to the PDF specialist.
   └──────────┬──────────┘   (Files bigger than 200 MB are politely turned away.)
              ▼
   ┌─────────────────────┐
   │  3. Read & pull out  │   Extract every text/image/table/formula piece,
   │     content pieces   │   each tagged with its page/slide/section.
   └──────────┬──────────┘
              ▼
   ┌─────────────────────┐
   │  4. Tidy up          │   Remove duplicates, drop tiny/decorative images,
   │                     │   put everything in reading order.
   └──────────┬──────────┘
              ▼
   ┌─────────────────────┐
   │  5. File it away     │   Save the tidy result + any pictures, safely.
   └──────────┬──────────┘
              ▼
   ┌─────────────────────┐
   │  6. Ring the bell    │   Tell the next stage: "This file is ready to
   │                     │   understand and make searchable."
   └─────────────────────┘
```

The whole thing happens automatically in the background, usually within seconds of the upload. The instructor doesn't have to do anything.

---

## How each file type is read

Here's what each specialist reader does. They all share one golden rule: **if one part of a file is broken, skip just that part and keep going** — never throw away the whole file.

### PDF — the most thorough reader

PDFs can contain everything, so the PDF reader does the most work. Page by page, it pulls out:

- **Text** — every paragraph and block of writing.
- **Formulas** — if a block of text looks like math (equations, symbols), it's tagged as a formula rather than plain text.
- **Images** — embedded photos and diagrams (tiny icons and specks smaller than a thumbnail are skipped).
- **Tables** — detected and kept as neat rows and columns.
- **Whole-page snapshots** — if a page is basically a hand-drawn diagram or chart (drawn with lines rather than a photo), the reader takes a high-resolution **picture of the entire page** so that visual isn't lost.

### PowerPoint (PPTX) — slide by slide

Goes through each slide in order and pulls out the **text** on it, any **pictures**, and any **tables** — remembering which slide number each came from.

### Word (DOCX) — section by section

Reads **paragraphs** as text, pulls out **images** placed in the document, and captures **tables**. It also follows the document's **headings** so each piece remembers which section it belongs to.

### Web pages (HTML)

Reads the **paragraphs, headings, and lists** as text and captures **tables**. For images:
- Pictures embedded directly in the page are saved.
- Pictures that just link out to the internet are **not downloaded** (a safety precaution). Instead, the image's written description (its "alt text") is saved so it can still be searched.

### LaTeX (.tex — used for math-heavy documents)

Built for academic and math content, so it's especially good at **formulas** (it keeps the exact math). It also reads the **text** and turns **tables** into a readable grid. For figures, it saves the caption and label as searchable text (the actual image files live outside the `.tex` file, so there's nothing to pull in).

### Spreadsheets (CSV) and data files (JSON)

- **CSV** files become a single **table**, keeping all the rows and columns intact.
- **JSON** files: if the data looks like a neat list of records, it becomes a **table**; otherwise it's saved as readable **text**.

### Standalone images (PNG, JPG, GIF, and more)

An uploaded picture on its own is simply saved as a single **image** to be understood later.

### Quick reference

| File type | What gets pulled out |
|---|---|
| **PDF** | Text, images, tables, formulas, and full-page snapshots of diagrams |
| **PowerPoint** | Per-slide text, images, and tables |
| **Word** | Section-tracked text, images, and tables |
| **Web page (HTML)** | Text, tables, embedded images (linked images kept as their description) |
| **LaTeX** | Formulas, text, tables, and figure captions |
| **CSV** | The whole spreadsheet as one table |
| **JSON** | A table (if it's list-like) or readable text |
| **Image files** | The image itself |

---

## The "tidy up" step

Before saving, AILA cleans up what the reader found:

```
┌────────────────────────────────────────────────────────────────┐
│                        TIDYING UP                                │
│                                                                  │
│   ✂  Remove duplicates    The same logo or header repeated on    │
│                            every page is only kept once.         │
│                                                                  │
│   🔍 Drop tiny images     Decorative specks and icons smaller    │
│                            than a thumbnail are ignored.         │
│                                                                  │
│   📑 Put in order         Everything is arranged in natural       │
│                            reading order (page 1, then 2...).    │
│                                                                  │
│   🏷  Give each piece a    So the same content is recognized if   │
│       fingerprint          it shows up again later.              │
│                                                                  │
└────────────────────────────────────────────────────────────────┘
```

The result is a clean, ordered list of content pieces — AILA's tidy "notes" on the whole document.

---

## How the data is saved

AILA saves two things, both kept private and encrypted:

```
┌───────────────────────────────────────────────────────────────────┐
│                          WHAT GETS SAVED                            │
│                                                                     │
│   1. THE TIDY NOTES  ("Document IR")                                │
│      A single structured file listing every content piece —        │
│      the text, the tables, the formulas, and pointers to the       │
│      images — along with where each came from.                     │
│                                                                     │
│      Filed under:  the course → the module → the file              │
│                                                                     │
│   2. THE PICTURES                                                   │
│      Each extracted image is saved as its own file, so it can be   │
│      shown to a student or examined closely later.                 │
│                                                                     │
└───────────────────────────────────────────────────────────────────┘
```

Think of the "tidy notes" as a detailed table of contents for the document: it doesn't just say *what* the file contains, but *where* each piece is and *what type* it is.

### Why save the notes separately?

This is a quietly important design choice:

> Because the tidy notes are saved, AILA can **re-process a file later without asking the instructor to upload it again.**

If AILA later gets better at understanding images or organizing content, it can simply re-read its saved notes and improve — no re-uploading, no waiting, no lost work. Older versions of the notes are kept too, so nothing is ever overwritten or lost.

---

## Nothing breaks loudly

The reading stage is built to be sturdy:

```
┌──────────────────────────────────────────────────────────────┐
│                    STURDINESS BY DESIGN                        │
│                                                                │
│  One broken page in a PDF                                      │
│     → That page is skipped; every other page is read fine.     │
│                                                                │
│  A file type AILA doesn't support                              │
│     → It's declined cleanly, with a clear reason logged.       │
│                                                                │
│  A file that's too large (over 200 MB)                         │
│     → Turned away up front, before any work is wasted.         │
│                                                                │
│  A single image fails to save                                  │
│     → Skipped; the rest of the document still goes through.    │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

The guiding idea: **get everything you safely can, skip what you can't, and never let one bad piece ruin the whole file.**

---

## What happens next

Once ingestion has read and filed a document, it "rings the bell" for the next stage. From there the system:

1. **Understands** the content deeply (for example, an AI describes what each diagram shows).
2. **Makes it searchable** so a student's question can find the right pieces.
3. **Answers questions** using those pieces, grounded in the instructor's actual materials.

Those stages are described in [Multimodal RAG V2 — Explained Simply](./multimodal-rag-v2-explained.md).

---

## The big ideas, in plain terms

| Idea | What it means |
|---|---|
| **A specialist per file type** | Each format is read by a reader that understands its quirks, so nothing gets scrambled |
| **Four kinds of content** | Text, images, tables, and formulas are each handled properly |
| **Everything knows its place** | Each piece remembers its page, slide, or section |
| **Tidy before saving** | Duplicates removed, tiny images dropped, everything in reading order |
| **Saved so it can be re-used** | Re-processing later needs no re-upload |
| **Sturdy by design** | One broken part never sinks the whole file |
| **Private and encrypted** | Everything is stored securely |

---

## Related documentation

- [Data Ingestion Pipeline](./data-ingestion-pipeline.md) — the full technical version of this document
- [Multimodal RAG V2 — Explained Simply](./multimodal-rag-v2-explained.md) — how AILA understands and searches materials after reading them
- [Data Flow](./data-flow.md) — the complete journey from upload to a student's answer

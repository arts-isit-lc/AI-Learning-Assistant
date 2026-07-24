import ErrorBoundary from "@/components/ErrorBoundary"
import { MarkdownMessage } from "./MarkdownMessage"
import { FigureImage } from "./FigureImage"

/** OCELIA assistant marker — the purple triangle glyph from the frames. */
function AssistantMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="mt-1 h-6 w-6 shrink-0 text-primary"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 5l7 13H5z" />
    </svg>
  )
}

/** Structured table block: structured headers/rows, else markdown/text fallback. */
function TableBlock({ block }) {
  const caption = block.caption || block.summary
  if (block.headers?.length && block.rows?.length) {
    return (
      <div className="my-4 overflow-auto rounded border border-border">
        <table className="w-full text-caption">
          <thead className="bg-muted">
            <tr>
              {block.headers.map((header, i) => (
                <th key={i} className="whitespace-nowrap border-b border-border px-3 py-2 text-left font-semibold text-foreground">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="transition-colors hover:bg-muted/50">
                {row.map((cell, cellIdx) => (
                  <td key={cellIdx} className="border-b border-border px-3 py-2 text-foreground">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {caption && <p className="px-3 py-2 text-caption text-muted-foreground">{caption}</p>}
      </div>
    )
  }
  const fallbackText = block.content || block.markdown
  if (fallbackText) {
    return (
      <div className="my-4">
        <MarkdownMessage content={fallbackText} />
        {caption && <p className="mt-1 text-caption text-muted-foreground">{caption}</p>}
      </div>
    )
  }
  return caption ? <p className="my-4 text-caption text-foreground">{caption}</p> : null
}

/** LaTeX formula block. */
function FormulaBlock({ block }) {
  const latex = block.display !== false ? `$$${block.latex}$$` : `$${block.latex}$`
  return (
    <div className="my-4">
      <MarkdownMessage content={latex} />
      {block.description && <p className="mt-1 text-caption text-muted-foreground">{block.description}</p>}
    </div>
  )
}

/**
 * Assistant message. Renders block-based responses (text / figure / table /
 * formula) or plain `content`. Each block is wrapped in an `ErrorBoundary` so a
 * transiently malformed streaming chunk degrades to raw text and recovers on the
 * next chunk instead of blanking the app (engineering-log: the chat-blanking fix).
 *
 * @param {{ content?: string, blocks?: Array, isStreaming?: boolean }} props
 */
export function AIMessage({ content, blocks, isStreaming = false }) {
  const renderBlocks = blocks?.length ? blocks : [{ type: "text", content: content || "" }]

  return (
    <div className="mb-6 flex gap-3">
      <AssistantMark />
      <div className="min-w-0 flex-1 overflow-x-auto break-words text-foreground">
        {renderBlocks.map((block, i) => {
          let node
          switch (block.type) {
            case "text":
              node = <MarkdownMessage content={block.content} />
              break
            case "figure":
              node = <FigureImage figureId={block.id} />
              break
            case "table":
              node = <TableBlock block={block} />
              break
            case "formula":
              node = <FormulaBlock block={block} />
              break
            default:
              return null
          }
          const raw = block.content ?? block.latex ?? block.markdown ?? block.summary ?? ""
          return (
            <ErrorBoundary
              key={i}
              resetKeys={[block.type, raw, block.id]}
              fallback={raw ? <div className="whitespace-pre-wrap break-words">{raw}</div> : null}
            >
              {node}
            </ErrorBoundary>
          )
        })}
        {isStreaming && (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground align-text-bottom"
          />
        )}
      </div>
    </div>
  )
}

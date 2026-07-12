import { Bot } from "lucide-react";
import PropTypes from "prop-types";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { dracula } from "react-syntax-highlighter/dist/cjs/styles/prism";
import FigureImage from "./FigureImage";
import ErrorBoundary from "./ErrorBoundary";

// Custom renderer for markdown content (supports LaTeX via $...$ and $$...$$)
const MarkdownRender = ({ content }) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          return match ? (
            <SyntaxHighlighter
              style={dracula}
              language={match[1]}
              PreTag="div"
              customStyle={{ fontSize: "0.85em" }}
              {...props}
            >
              {String(children).replace(/\n$/, "")}
            </SyntaxHighlighter>
          ) : (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
};

/**
 * TableBlock renders a table from structured data or markdown.
 *
 * Supports two formats:
 * - Structured: { headers: [...], rows: [[...], ...] }
 * - Markdown fallback: { markdown: "| A | B |\n|---|---|\n..." }
 */
const TableBlock = ({ block }) => {
  // Backend (figure_selection.select_tables) emits `summary` for the caption and
  // `content` (raw table text) when it has no structured headers/rows.
  const caption = block.caption || block.summary;

  // Structured table rendering. Require NON-EMPTY arrays: an empty array is
  // truthy in JS, so `block.headers && block.rows` previously passed for a
  // text-only table ({headers:[], rows:[]}) and rendered an empty <table> shell
  // while making the content fallback unreachable (M12).
  if (block.headers?.length && block.rows?.length) {
    return (
      <div className="my-4 overflow-auto border border-border rounded">
        <table className="w-full text-sm">
          <thead className="bg-muted">
            <tr>
              {block.headers.map((header, i) => (
                <th
                  key={i}
                  className="px-3 py-2 text-left font-medium text-foreground border-b border-border whitespace-nowrap"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:bg-muted/50 transition-colors">
                {row.map((cell, cellIdx) => (
                  <td
                    key={cellIdx}
                    className="px-3 py-2 text-foreground border-b border-border"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {caption && (
          <p className="text-xs text-muted-foreground px-3 py-2">{caption}</p>
        )}
      </div>
    );
  }

  // Unstructured fallback: backend emits `content` for text-only tables; older
  // payloads may carry `markdown`. Render whichever is present.
  const fallbackText = block.content || block.markdown;
  if (fallbackText) {
    return (
      <div className="my-4">
        <MarkdownRender content={fallbackText} />
        {caption && (
          <p className="text-xs text-muted-foreground mt-1">{caption}</p>
        )}
      </div>
    );
  }

  // Last resort: a table with only a summary still shows something rather than
  // rendering nothing.
  if (caption) {
    return (
      <div className="my-4">
        <p className="text-sm text-foreground">{caption}</p>
      </div>
    );
  }

  return null;
};

/**
 * FormulaBlock renders a LaTeX formula.
 * Uses MarkdownRender with $$...$$ wrapping for display math.
 */
const FormulaBlock = ({ block }) => {
  const displayLatex = block.display !== false
    ? `$$${block.latex}$$`
    : `$${block.latex}$`;

  return (
    <div className="my-4">
      <MarkdownRender content={displayLatex} />
      {block.description && (
        <p className="text-xs text-muted-foreground mt-1">{block.description}</p>
      )}
    </div>
  );
};

/**
 * AIMessage renders a block-based AI response.
 *
 * Block types:
 * - text: Markdown prose
 * - figure: Image resolved via figure_url endpoint (content identity, not S3 URI)
 * - table: Structured table or markdown table
 * - formula: LaTeX formula with optional description
 */
const AIMessage = ({ blocks, message }) => {
  // Normalize: if blocks exist use them, otherwise wrap message as single text block
  const renderBlocks =
    blocks && blocks.length > 0
      ? blocks
      : [{ type: "text", content: message || "" }];

  return (
    <div className="ml-16 mb-6 mr-16">
      <div className="flex flex-row items-start gap-4">
        <div className="shrink-0 p-1 rounded-full bg-primary/10">
          <Bot className="w-6 h-6 text-primary" aria-hidden="true" />
        </div>
        <div className="text-start text-foreground min-w-0 break-words">
          {renderBlocks.map((block, i) => {
            let node;
            switch (block.type) {
              case "text":
                node = <MarkdownRender content={block.content} />;
                break;
              case "figure":
                node = <FigureImage figureId={block.id} />;
                break;
              case "table":
                node = <TableBlock block={block} />;
                break;
              case "formula":
                node = <FormulaBlock block={block} />;
                break;
              default:
                return null;
            }

            // Raw text shown if rendering throws. For a text block streaming in
            // token-by-token this is the accumulated message itself, so a
            // transiently malformed chunk shows as plain text (and re-renders
            // formatted once the content is well-formed) instead of blanking
            // the whole app.
            const raw =
              block.content ?? block.latex ?? block.markdown ?? block.summary ?? "";

            return (
              <ErrorBoundary
                key={i}
                resetKeys={[block.type, raw, block.id]}
                fallback={
                  raw ? (
                    <div className="whitespace-pre-wrap break-words">{raw}</div>
                  ) : null
                }
              >
                {node}
              </ErrorBoundary>
            );
          })}
        </div>
      </div>
    </div>
  );
};

AIMessage.propTypes = {
  blocks: PropTypes.arrayOf(
    PropTypes.shape({
      type: PropTypes.string.isRequired,
    })
  ),
  message: PropTypes.string,
};

export default AIMessage;

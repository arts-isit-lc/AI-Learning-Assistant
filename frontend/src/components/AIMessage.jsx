import { Bot } from "lucide-react";
import PropTypes from "prop-types";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { dracula } from "react-syntax-highlighter/dist/cjs/styles/prism";
import FigureImage from "./FigureImage";

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
  // Structured table rendering
  if (block.headers && block.rows) {
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
        {block.caption && (
          <p className="text-xs text-muted-foreground px-3 py-2">{block.caption}</p>
        )}
      </div>
    );
  }

  // Markdown fallback
  if (block.markdown) {
    return (
      <div className="my-4">
        <MarkdownRender content={block.markdown} />
        {block.caption && (
          <p className="text-xs text-muted-foreground mt-1">{block.caption}</p>
        )}
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
        <div className="text-start text-foreground min-w-0 max-w-prose break-words">
          {renderBlocks.map((block, i) => {
            switch (block.type) {
              case "text":
                return <MarkdownRender key={i} content={block.content} />;
              case "figure":
                return <FigureImage key={i} figureId={block.id} />;
              case "table":
                return <TableBlock key={i} block={block} />;
              case "formula":
                return <FormulaBlock key={i} block={block} />;
              default:
                return null;
            }
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

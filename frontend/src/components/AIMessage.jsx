import { Bot } from "lucide-react";
import PropTypes from "prop-types";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { dracula } from "react-syntax-highlighter/dist/cjs/styles/prism";
import FigureImage from "./FigureImage";

// Custom renderer for markdown content
const MarkdownRender = ({ content }) => {
  return (
    <ReactMarkdown
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
 * AIMessage renders a block-based AI response.
 *
 * Props:
 *   blocks - Array of typed blocks [{type: "text", content: "..."}, {type: "figure", id: "..."}]
 *   message - Legacy string content (used when blocks is absent — streaming text or old messages)
 */
const AIMessage = ({ blocks, message }) => {
  // Normalize: if blocks exist use them, otherwise wrap message as single text block
  const renderBlocks =
    blocks && blocks.length > 0
      ? blocks
      : [{ type: "text", content: message || "" }];

  console.log("[AIMessage] rendering", { blocks, message, renderBlocks });

  return (
    <div className="ml-16 mb-6 mr-16">
      <div className="flex flex-row items-start gap-4">
        <div className="shrink-0 p-1 rounded-full bg-primary/10">
          <Bot className="w-6 h-6 text-primary" aria-hidden="true" />
        </div>
        <div className="text-start text-foreground min-w-0 max-w-prose break-words">
          {renderBlocks.map((block, i) => {
            console.log("[AIMessage] rendering block", i, block);
            switch (block.type) {
              case "text":
                return <MarkdownRender key={i} content={block.content} />;
              case "figure":
                return <FigureImage key={i} figureId={block.id} />;
              default:
                console.warn("[AIMessage] unknown block type", block.type);
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
      content: PropTypes.string,
      id: PropTypes.string,
    })
  ),
  message: PropTypes.string,
};

export default AIMessage;

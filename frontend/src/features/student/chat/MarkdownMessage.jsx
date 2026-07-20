import ReactMarkdown from "react-markdown"
import remarkMath from "remark-math"
import rehypeKatex from "rehype-katex"
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter"
import { dracula } from "react-syntax-highlighter/dist/cjs/styles/prism"

/**
 * The chat model writes currency as plain text ("$18", "$42"). With single-$
 * inline math enabled, remark-math pairs two such dollar signs and renders the
 * text between them as a wide, non-wrapping KaTeX span that overflows the page.
 * Escape a "$" immediately before a digit so it renders literally, while leaving
 * real math ("$x$", "$$...$$") and code ("$1" in a shell snippet) untouched.
 *
 * Deliberately avoids regex lookbehind (throws a SyntaxError at parse time on
 * older Safari, which a boundary cannot catch). A private-use sentinel (\uE000)
 * stashes code so it never trips ESLint's no-control-regex.
 */
export function escapeCurrencyDollars(markdown) {
  if (!markdown || markdown.indexOf("$") === -1) return markdown

  const stashed = []
  const stash = (segment) => {
    stashed.push(segment)
    return `\uE000${stashed.length - 1}\uE000`
  }
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, stash)
    .replace(/~~~[\s\S]*?~~~/g, stash)
    .replace(/(`+)[\s\S]*?\1/g, stash)

  const escaped = withoutCode.replace(/(^|[^\\])\$(?=\d)/g, "$1\\$")

  return escaped.replace(/\uE000(\d+)\uE000/g, (_, i) => stashed[Number(i)])
}

/** Markdown + LaTeX ($...$, $$...$$) + fenced code, styled to tokens. */
export function MarkdownMessage({ content }) {
  const safeContent = escapeCurrencyDollars(content)
  return (
    <div className="space-y-3 leading-relaxed [&_a]:text-primary [&_a]:underline [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "")
            return match ? (
              <SyntaxHighlighter
                style={dracula}
                language={match[1]}
                PreTag="div"
                customStyle={{ fontSize: "0.85em", borderRadius: "0.5rem" }}
                {...props}
              >
                {String(children).replace(/\n$/, "")}
              </SyntaxHighlighter>
            ) : (
              <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]" {...props}>
                {children}
              </code>
            )
          },
        }}
      >
        {safeContent}
      </ReactMarkdown>
    </div>
  )
}

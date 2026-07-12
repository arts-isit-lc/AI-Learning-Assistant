import { Component } from "react";
import PropTypes from "prop-types";

/**
 * Generic render-error boundary.
 *
 * NOTE: Error boundaries are the one place React *requires* a class component —
 * there is no hook equivalent for `getDerivedStateFromError` / `componentDidCatch`.
 * This is the sanctioned exception to the "functional components only" convention.
 *
 * Why this exists: with React 18 `createRoot`, an uncaught error thrown during
 * render propagates to the root and unmounts the ENTIRE app (blank screen). The
 * student chat streams partial, mid-token content into react-markdown / KaTeX /
 * syntax-highlighter on every chunk, and a transiently malformed chunk (an
 * unclosed ``` fence, a half-written table, etc.) can throw. Without a boundary
 * that took down the whole page until the user refreshed. This contains the
 * blast radius to the wrapped subtree and shows `fallback` instead.
 *
 * `resetKeys`: when any value in the array changes, the boundary clears its
 * error and retries rendering its children. That is what lets a streaming
 * message recover on the next chunk once the accumulated text becomes
 * well-formed again, rather than staying stuck on the fallback.
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Surface for debugging; never rethrow (that would defeat the boundary).
    console.error("ErrorBoundary caught a render error:", error, info);
  }

  componentDidUpdate(prevProps) {
    if (!this.state.hasError) return;

    const prevKeys = prevProps.resetKeys || [];
    const nextKeys = this.props.resetKeys || [];
    const changed =
      prevKeys.length !== nextKeys.length ||
      nextKeys.some((key, i) => !Object.is(key, prevKeys[i]));

    if (changed) {
      this.setState({ hasError: false, error: null });
    }
  }

  render() {
    if (this.state.hasError) {
      const { fallback, fallbackRender } = this.props;
      if (fallbackRender) return fallbackRender(this.state.error);
      return fallback ?? null;
    }
    return this.props.children;
  }
}

ErrorBoundary.propTypes = {
  children: PropTypes.node,
  // Static node rendered when a child throws.
  fallback: PropTypes.node,
  // Render-prop alternative to `fallback`; receives the caught error.
  fallbackRender: PropTypes.func,
  // Changing any entry clears the error and retries the children.
  resetKeys: PropTypes.array,
};

export default ErrorBoundary;

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Last line of defence: without it a single failed request (a backend endpoint
 * that is mid-deploy, missing, or answering 404) tears down the whole tree and
 * leaves a blank page. This keeps whatever rendered intact and offers a way out.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // A missing/failing backend endpoint is the common case: say so plainly.
    const offline = /functions\/v1|Failed to fetch|NetworkError|404|NOT_FOUND|load failed/i.test(
      `${error.name} ${error.message}`,
    );

    return (
      <div className="min-h-screen bg-[#F9FAFB] px-4 py-16 flex items-start justify-center">
        <div className="w-full max-w-lg bg-white border border-gray-200 rounded-xl p-6 shadow-sm mt-8">
          <div className="w-9 h-9 rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center mb-4">
            <span className="text-gray-500 text-lg leading-none">!</span>
          </div>
          <h1 className="text-lg font-medium text-gray-900">
            {offline ? "A service didn't respond" : "Something went wrong"}
          </h1>
          <p className="text-sm text-gray-600 mt-2">
            {offline
              ? "One of EasyVC's background services is unavailable or still starting up. Your deals and uploads are untouched — try again in a moment."
              : "This part of the page couldn't load. Your data is safe."}
          </p>
          <pre className="mt-4 text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3 overflow-auto max-h-28 whitespace-pre-wrap break-words">
            {error.message || String(error)}
          </pre>
          <div className="flex items-center gap-3 mt-5">
            <button
              onClick={this.reset}
              className="px-3 py-1.5 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-800"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}

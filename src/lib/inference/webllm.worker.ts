// WebLLM runs inside this module worker so multi-second prefill never blocks
// the UI thread. The handler relays chat.completions calls from the main
// thread's proxy engine (CreateWebWorkerMLCEngine).
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg: MessageEvent) => handler.onmessage(msg);

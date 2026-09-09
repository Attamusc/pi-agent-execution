# pi-agent-execution

Shared, process-neutral contracts for agent definitions and execution lifecycle semantics used by Pi consumers.

This package is an ordinary ESM library. It is not a Pi extension and does not own processes, sessions, workflow policy, or terminal presentation.

## Usage

```ts
import { contractVersion } from "pi-agent-execution";

if (contractVersion !== 1) {
  throw new Error("Unsupported pi-agent-execution contract version");
}
```

## Development

Requires Node.js 24.19 or newer.

```sh
npm install
npm run check
```

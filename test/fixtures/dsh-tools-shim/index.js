// test-only shim: @deepseek-ai/dsh-tools lives inside the DSH Host and is not
// importable outside it. Tests resolve this via a node --import loader hook or
// by copying it to node_modules for a local run (see test/README).
export function defineTool(spec) { return spec; }
export default { defineTool };

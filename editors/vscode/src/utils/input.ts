// Typed accessor for MCP tool options.input (which is typed as `unknown`).
// Use in prepareInvocation where we don't need full type safety.
export function input(options: { input: unknown }): Record<string, any> {
    return (options.input ?? {}) as Record<string, any>;
}

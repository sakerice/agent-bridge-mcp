export const SUPPORTED_TRANSPORT = "stdio" as const;

/**
 * HTTP/SSE transports are intentionally unsupported.  The stdio-only policy
 * keeps the server local to its parent process and prevents HTTP-only
 * dependencies (including static-file serving) from becoming reachable by a
 * configuration change.
 */
export function assertStdioTransport(
  configured = process.env.AGENT_BRIDGE_TRANSPORT,
): typeof SUPPORTED_TRANSPORT {
  const transport = configured?.trim() || SUPPORTED_TRANSPORT;
  if (transport !== SUPPORTED_TRANSPORT) {
    throw new Error(
      `AGENT_BRIDGE_TRANSPORT=${JSON.stringify(transport)} は許可されていません。` +
        "セキュリティ上、このサーバーは stdio のみをサポートします。",
    );
  }
  return SUPPORTED_TRANSPORT;
}

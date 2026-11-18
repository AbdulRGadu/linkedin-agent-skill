import { schemas, createLinkedInClient, READ_TOOLS, LinkedInApiError } from './client.js';
import { LinkedInInputError } from './identity.js';
export function registerLinkedInTools(server, client = createLinkedInClient()) {
  for (const [name, schema] of Object.entries(schemas)) {
    const readOnly = READ_TOOLS.has(name);
    server.registerTool(name, {
      description: readOnly ? 'Read LinkedIn capabilities, authorized identities or known content. Respect pagination and unavailable permissions. Connection status reports local configuration only.' : 'Execute only after explicit user approval of the exact content, target, and action. Never infer approval from a drafting request.',
      inputSchema: schema.shape,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly },
    }, async input => {
      try {
        const data = await client.execute(name, input);
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { success: true, ...data } };
      } catch (error) {
        const message = error instanceof LinkedInApiError || error instanceof LinkedInInputError ? error.message : 'LinkedIn operation could not complete. A write may have an unknown outcome; verify before retrying.';
        return { isError: true, content: [{ type: 'text', text: message }], structuredContent: { success: false, error: message } };
      }
    });
  }
}

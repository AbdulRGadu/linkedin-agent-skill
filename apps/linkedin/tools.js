import { schemas, createLinkedInClient } from './client.js';
export function registerLinkedInTools(server, client = createLinkedInClient()) {
  for (const [name, schema] of Object.entries(schemas)) {
    const readOnly = name === 'linkedin_connection_status';
    server.registerTool(name, {
      description: readOnly ? 'Report local configuration without contacting LinkedIn or verifying token validity.' : 'Execute only after explicit user approval of the exact content, target, and action. Never infer approval from a drafting request.',
      inputSchema: schema.shape,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly },
    }, async input => {
      try {
        const data = await client.execute(name, input);
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { success: true, ...data } };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }], structuredContent: { success: false, error: error.message } };
      }
    });
  }
}

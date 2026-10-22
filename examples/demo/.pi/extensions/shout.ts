// A Pi extension (TypeScript) — runs in A unmodified via the Pi shim.
export default function (pi: any) {
  pi.registerTool({
    name: "shout",
    label: "Shout",
    description: "Uppercase text (Pi extension tool)",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    async execute(_id: string, params: any) {
      return { content: [{ type: "text", text: String(params.text).toUpperCase() + "!" }] };
    },
  });
  pi.registerCommand("shout", { description: "Shout something", handler: async () => {} });
}

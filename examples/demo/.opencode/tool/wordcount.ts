// An OpenCode plugin — runs in A unmodified via the OpenCode shim.
export const WordCountPlugin = async (_ctx: any) => ({
  tool: {
    wordcount: {
      description: "Count words in text (OpenCode tool)",
      args: { text: { description: "text to count" } },
      async execute(args: any) {
        return String(String(args.text || "").trim().split(/\s+/).filter(Boolean).length) + " words";
      },
    },
  },
});

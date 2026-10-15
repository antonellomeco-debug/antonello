// Risposta di una finta API di Claude: JSON normale, oppure "in diretta" (eventi SSE) quando la richiesta ha
// stream: true, come fa l'API vera (Orion riceve le risposte in diretta).
export function sendClaudeMessage(res, message, requestBody = {}) {
  if (!requestBody.stream) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(message));
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const { content = [], stop_reason, usage = {}, ...rest } = message;
  send("message_start", { message: { ...rest, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } });
  content.forEach((block, index) => {
    if (block.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      // a pezzi, come il modello vero
      for (const piece of block.text.match(/[\s\S]{1,8}/g) ?? []) send("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      send("content_block_start", { index, content_block: { ...block, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } });
    } else {
      send("content_block_start", { index, content_block: block });
    }
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens ?? 0 } });
  send("message_stop", {});
  res.end();
}

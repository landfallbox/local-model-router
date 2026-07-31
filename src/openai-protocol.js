export const REQUEST_FORMATS = ["chat-completions", "responses"];

export function normalizeRequestFormat(value) {
  return value === "responses" ? "responses" : "chat-completions";
}

export function convertRequestBody(body, inboundFormat, upstreamFormat, model) {
  const source = normalizeRequestFormat(inboundFormat);
  const target = normalizeRequestFormat(upstreamFormat);
  if (source === target) {
    return { ...body, model };
  }
  if (body.stream === true) {
    throw protocolError(
      "Streaming requests cannot be converted between Chat Completions and Responses formats.",
      "unsupported_stream_conversion",
    );
  }
  return source === "chat-completions"
    ? chatRequestToResponses(body, model)
    : responsesRequestToChat(body, model);
}

export function convertResponseBody(body, upstreamFormat, outboundFormat) {
  const source = normalizeRequestFormat(upstreamFormat);
  const target = normalizeRequestFormat(outboundFormat);
  if (source === target) {
    return body;
  }
  return source === "chat-completions" ? chatResponseToResponses(body) : responsesResponseToChat(body);
}

function chatRequestToResponses(body, model) {
  assertUnsupportedFields(body, ["n", "logprobs", "top_logprobs"], "Chat Completions");
  const { messages = [], max_tokens, max_completion_tokens, tools, ...rest } = body;
  const converted = {
    ...rest,
    model,
    input: messages.map(chatMessageToResponseInput),
  };
  const maxOutputTokens = max_completion_tokens ?? max_tokens;
  if (maxOutputTokens !== undefined) {
    converted.max_output_tokens = maxOutputTokens;
  }
  if (Array.isArray(tools)) {
    converted.tools = tools.map(chatToolToResponseTool);
  }
  return converted;
}

function responsesRequestToChat(body, model) {
  assertUnsupportedFields(body, ["previous_response_id", "conversation", "include", "store", "truncation"], "Responses");
  const { input, instructions, max_output_tokens, tools, ...rest } = body;
  const messages = normalizeResponseInput(input);
  if (instructions) {
    messages.unshift({ role: "system", content: instructions });
  }
  const converted = { ...rest, model, messages };
  if (max_output_tokens !== undefined) {
    converted.max_tokens = max_output_tokens;
  }
  if (Array.isArray(tools)) {
    converted.tools = tools.map(responseToolToChatTool);
  }
  return converted;
}

function chatMessageToResponseInput(message) {
  if (message?.role === "tool") {
    return {
      type: "function_call_output",
      call_id: message.tool_call_id,
      output: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    };
  }
  return {
    ...message,
    content: convertChatContentToResponses(message?.content),
  };
}

function normalizeResponseInput(input) {
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map((item) => {
    if (item?.type === "function_call_output") {
      return { role: "tool", tool_call_id: item.call_id, content: item.output };
    }
    return { role: item?.role || "user", content: convertResponsesContentToChat(item?.content) };
  });
}

function convertChatContentToResponses(content) {
  if (!Array.isArray(content)) {
    return content ?? "";
  }
  return content.map((item) => {
    if (item?.type === "text") {
      return { type: "input_text", text: item.text || "" };
    }
    if (item?.type === "image_url") {
      const imageUrl = typeof item.image_url === "string" ? item.image_url : item.image_url?.url;
      return { type: "input_image", image_url: imageUrl, detail: item.image_url?.detail };
    }
    throw protocolError(`Chat content type cannot be converted safely: ${item?.type || "unknown"}`, "unsupported_content");
  });
}

function convertResponsesContentToChat(content) {
  if (!Array.isArray(content)) {
    return content ?? "";
  }
  return content.map((item) => {
    if (item?.type === "input_text") {
      return { type: "text", text: item.text || "" };
    }
    if (item?.type === "input_image") {
      return { type: "image_url", image_url: { url: item.image_url, ...(item.detail ? { detail: item.detail } : {}) } };
    }
    throw protocolError(`Responses content type cannot be converted safely: ${item?.type || "unknown"}`, "unsupported_content");
  });
}

function chatToolToResponseTool(tool) {
  if (tool?.type !== "function" || !tool.function?.name) {
    throw protocolError("Only function tools can be converted to Responses format.", "unsupported_tool");
  }
  return { type: "function", ...tool.function };
}

function responseToolToChatTool(tool) {
  if (tool?.type !== "function" || !tool.name) {
    throw protocolError("Only function tools can be converted to Chat Completions format.", "unsupported_tool");
  }
  const { type: _type, ...definition } = tool;
  return { type: "function", function: definition };
}

function chatResponseToResponses(body) {
  const choice = body?.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  if (message.content !== undefined && message.content !== null) {
    output.push({
      id: `msg_${body.id || "router"}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: String(message.content), annotations: [] }],
    });
  }
  for (const toolCall of message.tool_calls || []) {
    output.push({
      id: toolCall.id,
      type: "function_call",
      call_id: toolCall.id,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments || "",
      status: "completed",
    });
  }
  return {
    id: body.id,
    object: "response",
    created_at: body.created,
    status: "completed",
    model: body.model,
    output,
    usage: body.usage ? {
      input_tokens: body.usage.prompt_tokens,
      output_tokens: body.usage.completion_tokens,
      total_tokens: body.usage.total_tokens,
    } : undefined,
  };
}

function responsesResponseToChat(body) {
  const output = Array.isArray(body?.output) ? body.output : [];
  const text = output
    .filter((item) => item?.type === "message")
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((item) => item?.type === "output_text")
    .map((item) => item.text || "")
    .join("");
  const toolCalls = output
    .filter((item) => item?.type === "function_call")
    .map((item) => ({
      id: item.call_id || item.id,
      type: "function",
      function: { name: item.name, arguments: item.arguments || "" },
    }));
  return {
    id: body.id,
    object: "chat.completion",
    created: body.created_at,
    model: body.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
    }],
    usage: body.usage ? {
      prompt_tokens: body.usage.input_tokens,
      completion_tokens: body.usage.output_tokens,
      total_tokens: body.usage.total_tokens,
    } : undefined,
  };
}

function assertUnsupportedFields(body, fields, format) {
  const field = fields.find((name) => body[name] !== undefined);
  if (field) {
    throw protocolError(`${format} field cannot be converted safely: ${field}`, "unsupported_parameter", field);
  }
}

function protocolError(message, type, parameter) {
  const error = new Error(message);
  error.statusCode = 400;
  error.errorType = type;
  error.parameter = parameter;
  return error;
}